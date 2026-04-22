// content/simplelogin-mail.js — Content script for SimpleLogin alias generation

console.log('[MultiPage:simplelogin-mail] Content script loaded on', location.href);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'FETCH_GENERATED_EMAIL') return;

  setCurrentCommandContext(message);
  resetStopState();
  fetchSimpleLoginAlias(message.payload).then((result) => {
    sendResponse(result);
  }).catch((err) => {
    clearSimpleLoginGenerationState();
    if (isStopError(err)) {
      log('SimpleLogin：已被用户停止。', 'warn');
      sendResponse({ stopped: true, error: err.message });
      return;
    }
    sendResponse({ error: err.message });
  });

  return true;
});

const SIMPLELOGIN_EXCLUDED_EMAILS = new Set(['noreply@simplelogin.io']);
const SIMPLELOGIN_GENERATION_STATE_KEY = '__multipage_simplelogin_generation_state__';
const SIMPLELOGIN_GENERATION_STATE_TTL_MS = 2 * 60 * 1000;

function normalizeSimpleLoginEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function getSimpleLoginGenerationState() {
  try {
    const raw = sessionStorage.getItem(SIMPLELOGIN_GENERATION_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const updatedAt = Number(parsed.updatedAt) || 0;
    if (!updatedAt || Date.now() - updatedAt > SIMPLELOGIN_GENERATION_STATE_TTL_MS) {
      sessionStorage.removeItem(SIMPLELOGIN_GENERATION_STATE_KEY);
      return null;
    }
    return parsed;
  } catch (err) {
    debugLog('SimpleLogin generation state read failed', { message: err?.message || String(err) });
    return null;
  }
}

function setSimpleLoginGenerationState(patch = {}) {
  const nextState = {
    ...(getSimpleLoginGenerationState() || {}),
    ...patch,
    updatedAt: Date.now(),
  };
  try {
    sessionStorage.setItem(SIMPLELOGIN_GENERATION_STATE_KEY, JSON.stringify(nextState));
  } catch (err) {
    debugLog('SimpleLogin generation state write failed', { message: err?.message || String(err), patch });
  }
  return nextState;
}

function clearSimpleLoginGenerationState() {
  try {
    sessionStorage.removeItem(SIMPLELOGIN_GENERATION_STATE_KEY);
  } catch (err) {
    debugLog('SimpleLogin generation state clear failed', { message: err?.message || String(err) });
  }
}

function collectSimpleLoginAliases() {
  const results = [];
  const seen = new Set();
  const push = (candidate) => {
    const normalized = normalizeSimpleLoginEmail(candidate);
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(normalized)) return;
    if (SIMPLELOGIN_EXCLUDED_EMAILS.has(normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    results.push(normalized);
  };

  document.querySelectorAll('[data-clipboard-text], [data-alias-email]').forEach((el) => {
    push(el.getAttribute('data-clipboard-text'));
    push(el.getAttribute('data-alias-email'));
  });

  document.querySelectorAll('[id^="alias-container-"] a[href^="mailto:"]').forEach((el) => {
    const href = el.getAttribute('href') || '';
    push(decodeURIComponent(href.replace(/^mailto:/i, '').split('?')[0] || ''));
  });

  if (!results.length) {
    document.querySelectorAll('[id^="alias-container-"]').forEach((card) => {
      const matches = String(getSimpleLoginElementText(card) || '').match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/ig) || [];
      for (const match of matches) push(match);
    });
  }

  return results;
}

function readSimpleLoginAlias() {
  const aliases = collectSimpleLoginAliases();
  return aliases[0] || '';
}

function getAliasActionButtonLabel(button) {
  return `${button.textContent || ''} ${button.getAttribute('aria-label') || ''} ${button.title || ''}`
    .trim()
    .toLowerCase();
}

function isRandomAliasButton(button) {
  return /random alias/.test(getAliasActionButtonLabel(button));
}

function findAliasActionButton() {
  const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
  return buttons.find(isRandomAliasButton) || null;
}

function snapshotSimpleLoginState() {
  return {
    url: location.href,
    currentAlias: readSimpleLoginAlias(),
    aliases: collectSimpleLoginAliases().slice(0, 10),
    buttons: collectButtonDebugInfo(20),
    emails: collectTextEmailDebugInfo(),
  };
}

function escapeSimpleLoginRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getSimpleLoginElementText(element) {
  if (!element) return '';
  return [
    element.value,
    element.getAttribute?.('value'),
    element.getAttribute?.('data-email'),
    element.getAttribute?.('data-address'),
    element.getAttribute?.('aria-label'),
    element.getAttribute?.('title'),
    element.textContent,
  ].filter(Boolean).join(' ');
}

function normalizeSimpleLoginText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isSimpleLoginElementVisible(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isSimpleLoginClickableElement(element) {
  if (!element) return false;
  if (element.matches?.('button, a, summary, [role="button"], [role="menuitem"], [role="option"], [role="link"]')) {
    return true;
  }
  if (typeof element.onclick === 'function') return true;
  const tabIndex = Number(element.getAttribute?.('tabindex'));
  return Number.isFinite(tabIndex) && tabIndex >= 0;
}

function findSimpleLoginClickableAncestor(element) {
  let current = element;
  while (current && current !== document.body) {
    if (isSimpleLoginClickableElement(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function findSimpleLoginAliasElement(alias) {
  const normalizedAlias = normalizeSimpleLoginEmail(alias);
  if (!normalizedAlias) return null;

  const clipboardElement = Array.from(document.querySelectorAll('[data-clipboard-text]')).find((el) => (
    normalizeSimpleLoginEmail(el.getAttribute('data-clipboard-text')) === normalizedAlias
  ));
  if (clipboardElement) return clipboardElement;

  const dataElement = Array.from(document.querySelectorAll('[data-alias-email], [data-email], [data-address]')).find((el) => {
    const values = [
      el.getAttribute('data-alias-email'),
      el.getAttribute('data-email'),
      el.getAttribute('data-address'),
    ];
    return values.some((value) => normalizeSimpleLoginEmail(value) === normalizedAlias);
  });
  if (dataElement) return dataElement;

  const mailtoElement = Array.from(document.querySelectorAll('a[href^="mailto:"]')).find((el) => {
    const href = el.getAttribute('href') || '';
    return normalizeSimpleLoginEmail(decodeURIComponent(href.replace(/^mailto:/i, '').split('?')[0] || '')) === normalizedAlias;
  });
  if (mailtoElement) return mailtoElement;

  const selectors = '[data-email], [data-address], input, textarea, table td, table th, [class*="alias" i], [class*="email" i], [class*="address" i], [data-testid], div, span, p';
  return Array.from(document.querySelectorAll(selectors)).find((el) => getSimpleLoginElementText(el).toLowerCase().includes(normalizedAlias)) || null;
}

function getSimpleLoginCollapseTargetId(button) {
  if (!button) return '';
  const href = String(button.getAttribute('href') || button.getAttribute('data-target') || '').trim();
  const hrefMatch = href.match(/^#(.+)$/);
  if (hrefMatch) return hrefMatch[1];
  return String(button.getAttribute('aria-controls') || '').trim();
}

function getSimpleLoginAliasCardInfo(alias) {
  const normalizedAlias = normalizeSimpleLoginEmail(alias);
  const deleteCandidates = Array.from(document.querySelectorAll('span[onclick*="confirmDeleteAlias"], button[onclick*="confirmDeleteAlias"], a[onclick*="confirmDeleteAlias"]'));
  const deleteTrigger = deleteCandidates.find((el) => (
    normalizeSimpleLoginEmail(el.getAttribute('data-alias-email')) === normalizedAlias
  )) || null;
  const aliasElement = findSimpleLoginAliasElement(alias) || deleteTrigger || null;
  const card = (deleteTrigger && deleteTrigger.closest('[id^="alias-container-"]'))
    || (aliasElement && aliasElement.closest('[id^="alias-container-"]'))
    || null;
  const cardIdMatch = String(card?.id || '').match(/^alias-container-(.+)$/);
  const moreButtonCandidates = card
    ? Array.from(card.querySelectorAll('a[data-toggle="collapse"], button[data-toggle="collapse"], [role="button"][data-toggle="collapse"]'))
    : [];
  const moreButton = moreButtonCandidates.find((button) => /\bmore\b/i.test(normalizeSimpleLoginText(button.textContent || '')))
    || moreButtonCandidates[0]
    || null;
  const collapseTargetId = getSimpleLoginCollapseTargetId(moreButton)
    || (deleteTrigger?.getAttribute('data-alias') ? `alias-${deleteTrigger.getAttribute('data-alias')}` : '')
    || (cardIdMatch?.[1] ? `alias-${cardIdMatch[1]}` : '');
  const collapseElement = (collapseTargetId && document.getElementById(collapseTargetId))
    || (deleteTrigger && deleteTrigger.closest('.collapse'))
    || null;

  return {
    aliasElement,
    card,
    moreButton,
    deleteTrigger,
    aliasId: String(deleteTrigger?.getAttribute('data-alias') || cardIdMatch?.[1] || ''),
    collapseTargetId,
    collapseElement,
  };
}

function isSimpleLoginCollapseExpanded(collapseElement, button) {
  if (!collapseElement) {
    return button?.getAttribute('aria-expanded') === 'true';
  }
  return collapseElement.classList.contains('show')
    || button?.getAttribute('aria-expanded') === 'true'
    || isSimpleLoginElementVisible(collapseElement);
}

function getSimpleLoginAliasCardDebugInfo(alias) {
  const info = getSimpleLoginAliasCardInfo(alias);
  return {
    alias,
    aliasFound: Boolean(info.aliasElement),
    cardId: info.card?.id || '',
    moreButtonText: normalizeSimpleLoginText(info.moreButton?.textContent || ''),
    moreButtonHref: info.moreButton?.getAttribute('href') || info.moreButton?.getAttribute('data-target') || '',
    moreButtonExpanded: info.moreButton?.getAttribute('aria-expanded') || '',
    collapseTargetId: info.collapseTargetId || '',
    collapseVisible: Boolean(info.collapseElement && isSimpleLoginCollapseExpanded(info.collapseElement, info.moreButton)),
    collapseClassName: info.collapseElement?.className || '',
    deleteTriggerText: normalizeSimpleLoginText(getSimpleLoginElementText(info.deleteTrigger)),
    deleteTriggerVisible: Boolean(info.deleteTrigger && isSimpleLoginElementVisible(info.deleteTrigger)),
    deleteTriggerClassName: info.deleteTrigger?.className || '',
  };
}

function isSimpleLoginExcludedActionButton(button) {
  const label = getAliasActionButtonLabel(button);
  return /help|docs|github|forum|support|upgrade|random alias|new custom alias|custom alias|create alias|move to trash|delete/i.test(label);
}

function scoreSimpleLoginMoreButton(button, aliasRect, depth = 0) {
  if (!button || isSimpleLoginExcludedActionButton(button)) return Number.NEGATIVE_INFINITY;

  const rect = button.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return Number.NEGATIVE_INFINITY;

  const label = getAliasActionButtonLabel(button);
  const text = (button.textContent || '').trim();
  const className = String(button.className || '').toLowerCase();
  const ariaHasPopup = String(button.getAttribute('aria-haspopup') || '').toLowerCase();
  const role = String(button.getAttribute('role') || '').toLowerCase();
  const centerY = rect.top + rect.height / 2;
  const aliasCenterY = aliasRect.top + aliasRect.height / 2;
  const verticalDelta = Math.abs(centerY - aliasCenterY);
  const horizontalDelta = rect.left - aliasRect.right;

  let score = 0;
  if (/\bmore\b|ellipsis|kebab|⋯|…/.test(label)) score += 1200;
  if (button.getAttribute('data-toggle') === 'collapse') score += 900;
  if (String(button.getAttribute('href') || '').trim().startsWith('#alias-')) score += 700;
  if (!label) score += 220;
  if (text.length <= 2) score += 120;
  if (ariaHasPopup === 'true' || role === 'menu' || role === 'button') score += 80;
  if (/icon|menu|action|option|more|ellipsis|kebab|collapse/.test(className)) score += 160;
  if (rect.left >= aliasRect.right - 24) score += 180;
  if (verticalDelta <= Math.max(aliasRect.height, rect.height) * 1.4) score += 260;
  score -= Math.min(200, verticalDelta);
  if (horizontalDelta >= -24) score += Math.max(0, 120 - Math.abs(horizontalDelta));
  score -= depth * 35;

  return score;
}

function getSimpleLoginMoreButtonDebugEntry(candidate) {
  return {
    score: Math.round(candidate.score),
    depth: candidate.depth,
    text: (candidate.button.textContent || '').trim(),
    aria: candidate.button.getAttribute('aria-label') || '',
    title: candidate.button.title || '',
    href: candidate.button.getAttribute('href') || candidate.button.getAttribute('data-target') || '',
    expanded: candidate.button.getAttribute('aria-expanded') || '',
    className: candidate.button.className || '',
  };
}

function findSimpleLoginAliasMoreButton(alias) {
  const cardInfo = getSimpleLoginAliasCardInfo(alias);
  if (cardInfo.moreButton) {
    return {
      aliasElement: cardInfo.aliasElement,
      button: cardInfo.moreButton,
      container: cardInfo.card || cardInfo.aliasElement?.parentElement || null,
      collapseElement: cardInfo.collapseElement,
      collapseTargetId: cardInfo.collapseTargetId,
      deleteTrigger: cardInfo.deleteTrigger,
      candidates: [{
        score: 9999,
        depth: 0,
        button: cardInfo.moreButton,
      }].map(getSimpleLoginMoreButtonDebugEntry),
    };
  }

  const aliasElement = cardInfo.aliasElement;
  if (!aliasElement) {
    return { aliasElement: null, button: null, candidates: [] };
  }

  const aliasRect = aliasElement.getBoundingClientRect();
  const candidates = [];
  let current = aliasElement;
  let depth = 0;

  while (current && current !== document.body && depth <= 7) {
    const buttons = Array.from(current.querySelectorAll('button, a, [role="button"]'));
    for (const button of buttons) {
      const score = scoreSimpleLoginMoreButton(button, aliasRect, depth);
      if (Number.isFinite(score)) {
        candidates.push({ button, score, depth, container: current });
      }
    }
    if (candidates.some((candidate) => candidate.depth === depth && candidate.score >= 250)) {
      break;
    }
    current = current.parentElement;
    depth += 1;
  }

  if (!candidates.length) {
    const globalButtons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    for (const button of globalButtons) {
      const score = scoreSimpleLoginMoreButton(button, aliasRect, 99);
      if (Number.isFinite(score)) {
        candidates.push({ button, score, depth: 99, container: document.body });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] || null;
  return {
    aliasElement,
    button: best?.button || null,
    container: best?.container || aliasElement.parentElement || null,
    collapseElement: cardInfo.collapseElement,
    collapseTargetId: cardInfo.collapseTargetId,
    deleteTrigger: cardInfo.deleteTrigger,
    candidates: candidates.slice(0, 8).map(getSimpleLoginMoreButtonDebugEntry),
  };
}

function createSimpleLoginDeleteActionMatch(element, source) {
  const clickable = findSimpleLoginClickableAncestor(element) || element;
  return {
    element: clickable,
    source,
    text: normalizeSimpleLoginText(getSimpleLoginElementText(clickable)),
    aria: clickable.getAttribute?.('aria-label') || '',
    title: clickable.title || '',
    className: clickable.className || '',
    dataAlias: clickable.getAttribute?.('data-alias') || element.getAttribute?.('data-alias') || '',
    dataAliasEmail: clickable.getAttribute?.('data-alias-email') || element.getAttribute?.('data-alias-email') || '',
  };
}

function findSimpleLoginDeleteAction(alias) {
  const normalizedAlias = normalizeSimpleLoginEmail(alias);
  const cardInfo = getSimpleLoginAliasCardInfo(alias);
  const exactSelector = 'span[onclick*="confirmDeleteAlias"], button[onclick*="confirmDeleteAlias"], a[onclick*="confirmDeleteAlias"]';
  const scopes = [cardInfo.collapseElement, cardInfo.card, document].filter(Boolean);

  for (const scope of scopes) {
    const exactCandidates = Array.from(scope.querySelectorAll(exactSelector));
    const exactMatch = exactCandidates.find((candidate) => {
      if (!isSimpleLoginElementVisible(candidate)) return false;
      return normalizeSimpleLoginEmail(candidate.getAttribute('data-alias-email')) === normalizedAlias;
    }) || exactCandidates.find((candidate) => isSimpleLoginElementVisible(candidate));
    if (exactMatch) {
      return createSimpleLoginDeleteActionMatch(exactMatch, 'confirmDeleteAlias');
    }
  }

  for (const scope of scopes) {
    const candidates = Array.from(scope.querySelectorAll('button, a, [role="button"], [role="menuitem"], li, div, span'));
    for (const candidate of candidates) {
      if (!isSimpleLoginElementVisible(candidate)) continue;
      const text = normalizeSimpleLoginText(getSimpleLoginElementText(candidate)).toUpperCase();
      if (!/^DELETE$/.test(text)) continue;
      return createSimpleLoginDeleteActionMatch(candidate, 'text-fallback');
    }
  }

  return null;
}

async function waitForSimpleLoginDeleteAction(alias, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    throwIfStopped();
    const match = findSimpleLoginDeleteAction(alias);
    if (match?.element) {
      debugLog('SimpleLogin delete action located', {
        alias,
        elapsedMs: Date.now() - start,
        source: match.source,
        text: match.text,
        aria: match.aria,
        title: match.title,
        className: match.className,
        dataAlias: match.dataAlias,
        dataAliasEmail: match.dataAliasEmail,
      });
      return match.element;
    }
    await sleep(150);
  }

  debugLog('SimpleLogin delete action timeout', {
    alias,
    elapsedMs: timeoutMs,
    aliasCard: getSimpleLoginAliasCardDebugInfo(alias),
    buttons: collectButtonDebugInfo(30),
    bodyPreview: (document.body?.innerText || '').slice(0, 1000),
  });
  throw new Error(`等待 SimpleLogin 删除操作超时：${alias}`);
}

async function waitForSimpleLoginTrashConfirmation(alias, timeoutMs = 20000) {
  const start = Date.now();
  const aliasPattern = new RegExp(`Alias\\s+${escapeSimpleLoginRegExp(alias)}\\s+has been moved to the trash`, 'i');
  const fallbackPattern = /has been moved to the trash/i;
  const initialText = document.body?.innerText || '';

  while (Date.now() - start < timeoutMs) {
    throwIfStopped();
    const text = document.body?.innerText || '';
    if (aliasPattern.test(text) || (text !== initialText && fallbackPattern.test(text))) {
      debugLog('SimpleLogin trash confirmation observed', { alias, elapsedMs: Date.now() - start });
      return;
    }
    await sleep(200);
  }

  debugLog('SimpleLogin trash confirmation timeout', {
    alias,
    elapsedMs: Date.now() - start,
    bodyPreview: (document.body?.innerText || '').slice(0, 500),
  });
  throw new Error(`等待 SimpleLogin 删除确认超时：${alias}`);
}

async function waitForSimpleLoginDashboardReady(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    throwIfStopped();
    const button = findAliasActionButton();
    if (button) {
      debugLog('SimpleLogin dashboard ready', {
        elapsedMs: Date.now() - start,
        randomAliasText: normalizeSimpleLoginText(button.textContent || ''),
        randomAliasClassName: button.className || '',
      });
      return button;
    }
    await sleep(200);
  }

  debugLog('SimpleLogin dashboard ready timeout', snapshotSimpleLoginState());
  throw new Error('等待 SimpleLogin 仪表盘恢复超时。');
}

async function waitForSimpleLoginAliasActionsExpanded(alias, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    throwIfStopped();
    const info = getSimpleLoginAliasCardInfo(alias);
    const expanded = isSimpleLoginCollapseExpanded(info.collapseElement, info.moreButton);
    const deleteVisible = Boolean(info.deleteTrigger && isSimpleLoginElementVisible(info.deleteTrigger));
    if (deleteVisible || (expanded && info.collapseElement)) {
      debugLog('SimpleLogin alias actions expanded', {
        alias,
        elapsedMs: Date.now() - start,
        cardId: info.card?.id || '',
        collapseTargetId: info.collapseTargetId || '',
        expanded,
        deleteVisible,
        deleteTriggerText: normalizeSimpleLoginText(getSimpleLoginElementText(info.deleteTrigger)),
      });
      return info;
    }
    await sleep(150);
  }

  debugLog('SimpleLogin alias actions expand timeout', {
    alias,
    elapsedMs: timeoutMs,
    aliasCard: getSimpleLoginAliasCardDebugInfo(alias),
  });
  throw new Error(`等待 SimpleLogin 别名操作面板展开超时：${alias}`);
}

async function deleteExistingSimpleLoginAliasBeforeGenerate() {
  const aliases = collectSimpleLoginAliases();
  const aliasToDelete = aliases[aliases.length - 1] || '';
  if (!aliasToDelete) {
    debugLog('SimpleLogin delete skipped because no alias found', snapshotSimpleLoginState());
    return null;
  }

  const state = getSimpleLoginGenerationState();
  if (state?.deletedAlias && !state?.deleteCompleted) {
    debugLog('SimpleLogin delete already in progress, waiting for dashboard restore', state);
    await waitForSimpleLoginDashboardReady(20000);
    setSimpleLoginGenerationState({
      deletedAlias: state.deletedAlias,
      deleteCompleted: true,
      randomAliasClicked: false,
      sourceUrl: location.href,
    });
    log(`SimpleLogin：已删除旧别名 ${state.deletedAlias}`);
    return state.deletedAlias;
  }
  if (state?.deletedAlias && state?.deleteCompleted) {
    debugLog('SimpleLogin delete already completed for current generation', state);
    return state.deletedAlias;
  }

  const initialCardInfo = getSimpleLoginAliasCardInfo(aliasToDelete);
  const { aliasElement, button, container, candidates } = findSimpleLoginAliasMoreButton(aliasToDelete);
  const deleteAlreadyVisible = Boolean(initialCardInfo.deleteTrigger && isSimpleLoginElementVisible(initialCardInfo.deleteTrigger));
  const alreadyExpanded = isSimpleLoginCollapseExpanded(initialCardInfo.collapseElement, initialCardInfo.moreButton);
  if (!button && !deleteAlreadyVisible) {
    debugLog('SimpleLogin more button missing for alias', {
      aliasToDelete,
      aliasFound: Boolean(aliasElement),
      containerTag: container?.tagName || '',
      aliasCard: getSimpleLoginAliasCardDebugInfo(aliasToDelete),
      candidates,
      snapshot: snapshotSimpleLoginState(),
    });
    throw new Error(`未找到 SimpleLogin 邮箱 ${aliasToDelete} 的 More 按钮。`);
  }

  debugLog('SimpleLogin delete target selected', {
    aliasToDelete,
    moreButtonText: (button?.textContent || '').trim(),
    moreButtonAria: button?.getAttribute('aria-label') || '',
    moreButtonTitle: button?.title || '',
    moreButtonClassName: button?.className || '',
    alreadyExpanded,
    deleteAlreadyVisible,
    aliasCard: getSimpleLoginAliasCardDebugInfo(aliasToDelete),
    candidates,
  });

  if (!deleteAlreadyVisible && button && !alreadyExpanded) {
    button.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await humanPause(200, 500);
    simulateClick(button);
    await waitForSimpleLoginAliasActionsExpanded(aliasToDelete, 15000);
  }

  const deleteButton = await waitForSimpleLoginDeleteAction(aliasToDelete, 15000);
  debugLog('SimpleLogin delete button found', {
    aliasToDelete,
    text: normalizeSimpleLoginText(getSimpleLoginElementText(deleteButton)),
    aria: deleteButton.getAttribute('aria-label') || '',
    title: deleteButton.title || '',
    className: deleteButton.className || '',
  });
  deleteButton.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await humanPause(150, 350);
  simulateClick(deleteButton);

  const moveToTrashButton = await waitForElementByText('button, a, [role="button"]', /move\s+to\s+trash/i, 15000);
  debugLog('SimpleLogin move-to-trash button found', {
    aliasToDelete,
    text: (moveToTrashButton.textContent || '').trim(),
    aria: moveToTrashButton.getAttribute('aria-label') || '',
    title: moveToTrashButton.title || '',
    className: moveToTrashButton.className || '',
  });
  await humanPause(150, 350);
  setSimpleLoginGenerationState({
    deletedAlias: aliasToDelete,
    deleteCompleted: false,
    randomAliasClicked: false,
    sourceUrl: location.href,
  });
  simulateClick(moveToTrashButton);

  await waitForSimpleLoginTrashConfirmation(aliasToDelete);
  await waitForSimpleLoginDashboardReady(20000);
  setSimpleLoginGenerationState({
    deletedAlias: aliasToDelete,
    deleteCompleted: true,
    randomAliasClicked: false,
    sourceUrl: location.href,
  });
  log(`SimpleLogin：已删除旧别名 ${aliasToDelete}`);
  return state?.deletedAlias || aliasToDelete;
}

async function readSimpleLoginClipboardAlias(options = {}) {
  const { logFailures = false } = options;
  if (!navigator.clipboard?.readText) {
    if (logFailures) {
      debugLog('SimpleLogin clipboard API unavailable', { url: location.href });
    }
    return '';
  }

  try {
    const text = await navigator.clipboard.readText();
    const matches = String(text || '').match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/ig) || [];
    for (const match of matches) {
      const normalized = normalizeSimpleLoginEmail(match);
      if (!SIMPLELOGIN_EXCLUDED_EMAILS.has(normalized)) {
        return normalized;
      }
    }
    return '';
  } catch (err) {
    if (logFailures) {
      debugLog('SimpleLogin clipboard read failed', { message: err?.message || String(err) });
    }
    return '';
  }
}

async function waitForAliasChange(previousAliases = [], previousClipboardAlias = '', timeoutMs = 30000) {
  const baselineAliases = new Set((previousAliases || []).map(normalizeSimpleLoginEmail).filter(Boolean));
  const start = Date.now();
  let lastSnapshot = '';
  let clipboardFailuresLogged = false;
  while (Date.now() - start < timeoutMs) {
    throwIfStopped();

    const clipboardAlias = await readSimpleLoginClipboardAlias({ logFailures: !clipboardFailuresLogged });
    if (clipboardAlias && !baselineAliases.has(clipboardAlias) && clipboardAlias !== previousClipboardAlias) {
      debugLog('SimpleLogin alias from clipboard', {
        previousAliases: [...baselineAliases],
        previousClipboardAlias,
        clipboardAlias,
        elapsedMs: Date.now() - start,
      });
      return clipboardAlias;
    }
    if (!clipboardAlias) {
      clipboardFailuresLogged = true;
    }

    const aliases = collectSimpleLoginAliases();
    const nextAlias = aliases.find((alias) => !baselineAliases.has(alias)) || '';
    const snapshotKey = aliases.join('|');
    if (nextAlias) {
      debugLog('SimpleLogin alias changed', {
        previousAliases: [...baselineAliases],
        nextAlias,
        elapsedMs: Date.now() - start,
        aliases,
      });
      return nextAlias;
    }
    if (snapshotKey && snapshotKey !== lastSnapshot) {
      lastSnapshot = snapshotKey;
      debugLog('SimpleLogin alias snapshot', { elapsedMs: Date.now() - start, aliases, clipboardAlias });
    }
    await sleep(200);
  }
  debugLog('SimpleLogin alias wait timeout', {
    ...snapshotSimpleLoginState(),
    previousAliases: [...baselineAliases],
    previousClipboardAlias,
  });
  throw new Error('等待 SimpleLogin 新别名出现超时。');
}

async function clickAliasActionButton() {
  const button = await waitForSimpleLoginDashboardReady(20000);
  debugLog('SimpleLogin random alias button found', {
    text: (button.textContent || '').trim(),
    aria: button.getAttribute('aria-label') || '',
    title: button.title || '',
    className: button.className || '',
  });
  button.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await humanPause(250, 650);
  simulateClick(button);
}

async function fetchSimpleLoginAlias(payload = {}) {
  const { generateNew = true } = payload;
  const persistedState = getSimpleLoginGenerationState();
  log(`SimpleLogin：正在${generateNew ? '生成' : '读取'}别名...`);
  debugLog('SimpleLogin fetch start', { url: location.href, generateNew, persistedState });

  await waitForElement('body', 20000);
  debugLog('SimpleLogin initial snapshot', snapshotSimpleLoginState());
  const existingAliases = collectSimpleLoginAliases();
  const currentAlias = existingAliases[0] || '';
  const clipboardAliasBeforeClick = await readSimpleLoginClipboardAlias();
  if (currentAlias && !generateNew) {
    clearSimpleLoginGenerationState();
    log(`SimpleLogin：已发现现有别名 ${currentAlias}`);
    return { email: currentAlias, generated: false };
  }

  if (!generateNew && currentAlias) {
    clearSimpleLoginGenerationState();
    return { email: currentAlias, generated: false };
  }

  const stateAfterDelete = getSimpleLoginGenerationState();
  if (stateAfterDelete?.deletedAlias || stateAfterDelete?.deleteCompleted) {
    debugLog('SimpleLogin reuse existing generation state without deleting alias', stateAfterDelete);
  }

  const shouldClickRandomAlias = !stateAfterDelete?.randomAliasClicked;
  if (shouldClickRandomAlias) {
    await clickAliasActionButton();
    setSimpleLoginGenerationState({
      deletedAlias: stateAfterDelete?.deletedAlias || '',
      deleteCompleted: Boolean(stateAfterDelete?.deleteCompleted),
      randomAliasClicked: true,
      sourceUrl: location.href,
    });
  } else {
    debugLog('SimpleLogin random alias click skipped because it already happened', stateAfterDelete);
  }

  try {
    const nextAlias = await waitForAliasChange(existingAliases, clipboardAliasBeforeClick);
    clearSimpleLoginGenerationState();
    debugLog('SimpleLogin final snapshot', {
      previousAliases: existingAliases,
      previousAlias: currentAlias,
      previousClipboardAlias: clipboardAliasBeforeClick,
      nextAlias,
      aliases: collectSimpleLoginAliases().slice(0, 10),
      emails: collectTextEmailDebugInfo(),
    });
    log(`SimpleLogin：别名已就绪 ${nextAlias}`, 'ok');
    return { email: nextAlias, generated: true };
  } catch (err) {
    clearSimpleLoginGenerationState();
    throw err;
  }
}
