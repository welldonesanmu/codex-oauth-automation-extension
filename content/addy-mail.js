// content/addy-mail.js — Content script for Addy.io alias generation

console.log('[MultiPage:addy-mail] Content script loaded on', location.href);

const ADDY_FETCH_REUSE_MAX_AGE_MS = 45000;
const ADDY_FETCH_REQUEST_TIMEOUT_MS = 45000;

function nextAddyRequestId() {
  window.__MULTIPAGE_ADDY_FETCH_SEQ__ = (window.__MULTIPAGE_ADDY_FETCH_SEQ__ || 0) + 1;
  return window.__MULTIPAGE_ADDY_FETCH_SEQ__;
}

function throwIfAddyRequestInvalid(requestId = null) {
  throwIfStopped();
  if (requestId !== null && window.__MULTIPAGE_ADDY_ACTIVE_REQUEST_ID__ !== requestId) {
    throw new Error('Addy.io 请求已被新的生成任务替换。');
  }
}

function withAddyRequestTimeout(promise, timeoutMs, requestId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (window.__MULTIPAGE_ADDY_ACTIVE_REQUEST_ID__ === requestId) {
        window.__MULTIPAGE_ADDY_ACTIVE_REQUEST_ID__ = null;
      }
      reject(new Error('Addy.io 生成请求执行超时。'));
    }, timeoutMs);

    promise.then(resolve).catch(reject).finally(() => clearTimeout(timer));
  });
}

if (!window.__MULTIPAGE_ADDY_LISTENER_READY__) {
  window.__MULTIPAGE_ADDY_LISTENER_READY__ = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== 'FETCH_GENERATED_EMAIL') return;

    const requestKey = JSON.stringify({
      generateNew: message?.payload?.generateNew !== false,
      addyRecipients: String(message?.payload?.addyRecipients || ''),
      addyAliasDomain: String(message?.payload?.addyAliasDomain || ''),
    });
    const now = Date.now();
    const inFlightRequest = window.__MULTIPAGE_ADDY_FETCH_IN_FLIGHT__;
    const canReuseInFlight = inFlightRequest?.key === requestKey
      && inFlightRequest.promise
      && (now - Number(inFlightRequest.startedAt || 0) < ADDY_FETCH_REUSE_MAX_AGE_MS)
      && (!Number.isInteger(inFlightRequest.requestId) || window.__MULTIPAGE_ADDY_ACTIVE_REQUEST_ID__ === inFlightRequest.requestId);
    if (canReuseInFlight) {
      debugLog('Addy fetch request reused while previous request is still running', {
        requestKey,
        url: location.href,
        requestId: inFlightRequest.requestId,
      });
      inFlightRequest.promise.then((result) => {
        sendResponse(result);
      }).catch((err) => {
        if (isStopError(err)) {
          log('Addy.io：已被用户停止。', 'warn');
          sendResponse({ stopped: true, error: err.message });
          return;
        }
        sendResponse({ error: err.message });
      });
      return true;
    }
    if (inFlightRequest?.promise) {
      debugLog('Addy stale in-flight request dropped before starting new one', {
        requestKey,
        previousRequestId: inFlightRequest.requestId,
        url: location.href,
      });
    }

    setCurrentCommandContext(message);
    resetStopState();
    const requestId = nextAddyRequestId();
    window.__MULTIPAGE_ADDY_ACTIVE_REQUEST_ID__ = requestId;
    const promise = withAddyRequestTimeout(fetchAddyAlias(message.payload, { requestId }), ADDY_FETCH_REQUEST_TIMEOUT_MS, requestId);
    window.__MULTIPAGE_ADDY_FETCH_IN_FLIGHT__ = {
      key: requestKey,
      promise,
      requestId,
      startedAt: now,
    };

    promise.then((result) => {
      sendResponse(result);
    }).catch((err) => {
      if (isStopError(err)) {
        log('Addy.io：已被用户停止。', 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      sendResponse({ error: err.message });
    }).finally(() => {
      if (window.__MULTIPAGE_ADDY_FETCH_IN_FLIGHT__?.promise === promise) {
        window.__MULTIPAGE_ADDY_FETCH_IN_FLIGHT__ = null;
      }
      if (window.__MULTIPAGE_ADDY_ACTIVE_REQUEST_ID__ === requestId) {
        window.__MULTIPAGE_ADDY_ACTIVE_REQUEST_ID__ = null;
      }
    });

    return true;
  });
}

function normalizeAlias(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeAddyText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractAddyAliasFromText(value) {
  const matches = String(value || '').match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/ig) || [];
  for (const match of matches) {
    const normalized = normalizeAlias(match);
    if (normalized && !normalized.endsWith('@duck.com')) {
      return normalized;
    }
  }
  return '';
}

function isAddyElementVisible(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getAddyButtonLabel(button) {
  return normalizeAddyText(`${button?.textContent || ''} ${button?.getAttribute?.('aria-label') || ''} ${button?.title || ''}`).toLowerCase();
}

async function readAddyClipboardAlias(options = {}) {
  const { logFailures = false } = options;
  if (!navigator.clipboard?.readText) {
    if (logFailures) {
      debugLog('Addy clipboard API unavailable', { url: location.href });
    }
    return '';
  }

  try {
    return extractAddyAliasFromText(await navigator.clipboard.readText());
  } catch (err) {
    if (logFailures) {
      debugLog('Addy clipboard read failed', { message: err?.message || String(err) });
    }
    return '';
  }
}

function collectAliasCandidates() {
  const results = new Set();
  const text = document.body?.innerText || '';
  const textMatches = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/ig) || [];
  for (const value of textMatches) {
    const normalized = normalizeAlias(value);
    if (normalized && !normalized.endsWith('@duck.com')) {
      results.add(normalized);
    }
  }

  document.querySelectorAll('input, textarea, [data-email], [data-address], [data-testid]').forEach((el) => {
    const candidates = [
      el.value,
      el.getAttribute('value'),
      el.getAttribute('data-email'),
      el.getAttribute('data-address'),
      el.textContent,
    ];
    for (const candidate of candidates) {
      const normalized = normalizeAlias(candidate);
      if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(normalized) && !normalized.endsWith('@duck.com')) {
        results.add(normalized);
      }
    }
  });

  return [...results];
}

function readCurrentAddyAlias() {
  const candidates = collectAliasCandidates();
  return candidates[candidates.length - 1] || '';
}

function snapshotAddyState() {
  return {
    url: location.href,
    currentAlias: readCurrentAddyAlias(),
    buttons: collectButtonDebugInfo(),
    emailsInText: collectTextEmailDebugInfo(),
    fields: collectFieldDebugInfo(),
  };
}

function isCreateNewAliasButton(button) {
  const label = getAddyButtonLabel(button);
  return /create new alias|generate new alias|new alias|generate alias/.test(label) || /^create alias$/.test(label);
}

function isConfirmCreateAliasButton(button) {
  return /^create alias$/.test(getAddyButtonLabel(button));
}

function isCopyAliasButton(button) {
  return /^copy$/.test(getAddyButtonLabel(button));
}

function isCloseAliasButton(button) {
  return /^close$/.test(getAddyButtonLabel(button));
}

function isAddySuccessContainer(container) {
  const text = normalizeAddyText(container?.textContent || '');
  return /your new alias is/i.test(text) || (Boolean(extractAddyAliasFromText(text)) && /\bcopy\b/i.test(text) && /\bclose\b/i.test(text));
}

function getAddyDialogContainer(element) {
  if (!element) return null;
  return element.closest('[role="dialog"], [aria-modal="true"], .modal, [class*="dialog" i], [class*="modal" i], [data-state="open"]');
}

function getAddyButtonContext(button) {
  const dialog = getAddyDialogContainer(button);
  const form = button?.closest?.('form') || null;
  const card = button?.closest?.('[class*="card" i], [class*="panel" i], [class*="sheet" i], [class*="popover" i], [class*="dropdown" i]') || null;
  const container = dialog || form || card || button?.parentElement || null;
  const text = normalizeAddyText(container?.textContent || '');
  return { dialog, form, card, container, text };
}

function isAddyButtonInSuccessContainer(button) {
  const context = getAddyButtonContext(button);
  return isAddySuccessContainer(context.dialog) || isAddySuccessContainer(context.container);
}

function findVisibleAddyButtons(matcher, scope = document) {
  return Array.from(scope.querySelectorAll('button, a, [role="button"]')).filter((button) => (
    isAddyElementVisible(button) && matcher(button)
  ));
}

function findVisibleAddyButton(matcher, scope = document) {
  return findVisibleAddyButtons(matcher, scope)[0] || null;
}

function isAddyButtonBusy(button) {
  if (!button) return true;
  const className = String(button.className || '');
  const dataState = String(button.getAttribute('data-state') || '').trim().toLowerCase();
  const dataLoading = String(button.getAttribute('data-loading') || '').trim().toLowerCase();
  const text = getAddyButtonLabel(button);
  return Boolean(
    button.disabled
    || button.matches?.(':disabled')
    || button.getAttribute('aria-disabled') === 'true'
    || button.getAttribute('aria-busy') === 'true'
    || dataState === 'loading'
    || dataState === 'submitting'
    || dataState === 'busy'
    || dataLoading === 'true'
    || /\b(is-loading|loading-spinner|btn-loading)\b/i.test(className)
    || /\bcreating\b/i.test(text)
  );
}

async function waitForAddyButtonStable(button, options = {}) {
  const { timeoutMs = 12000, stableMs = 1200, requestId = null } = options;
  const start = Date.now();
  let stableSince = 0;
  while (Date.now() - start < timeoutMs) {
    throwIfAddyRequestInvalid(requestId);
    const stillConnected = Boolean(button?.isConnected);
    const visible = isAddyElementVisible(button);
    const busy = isAddyButtonBusy(button);
    if (stillConnected && visible && !busy) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= stableMs) {
        debugLog('Addy button stable', {
          elapsedMs: Date.now() - start,
          stableMs,
          text: normalizeAddyText(button?.textContent || ''),
          className: button?.className || '',
        });
        return button;
      }
    } else {
      stableSince = 0;
    }
    await sleep(150);
  }
  debugLog('Addy button stable wait timeout', {
    elapsedMs: Date.now() - start,
    text: normalizeAddyText(button?.textContent || ''),
    className: button?.className || '',
    connected: Boolean(button?.isConnected),
    visible: isAddyElementVisible(button),
    busy: isAddyButtonBusy(button),
  });
  throw new Error('等待 Addy.io 按钮稳定超时。');
}

function scoreAddyEntryCreateAliasButton(button) {
  const label = getAddyButtonLabel(button);
  const context = getAddyButtonContext(button);
  let score = 0;
  if (/create new alias/.test(label)) score += 1400;
  if (/^create alias$/.test(label)) score += 1200;
  if (/generate new alias|generate alias|new alias/.test(label)) score += 900;
  if (!context.dialog) score += 1000;
  if (context.form) score -= 150;
  if (isAddySuccessContainer(context.container) || isAddySuccessContainer(context.dialog)) score -= 3000;
  return score;
}

function findAddyEntryCreateAliasButton() {
  const candidates = findVisibleAddyButtons(isCreateNewAliasButton).filter((button) => !isAddyButtonInSuccessContainer(button));
  candidates.sort((a, b) => scoreAddyEntryCreateAliasButton(b) - scoreAddyEntryCreateAliasButton(a));
  return candidates[0] || null;
}

function scoreAddyConfirmCreateAliasButton(button, entryButton = null) {
  const context = getAddyButtonContext(button);
  let score = 0;
  if (button === entryButton) score -= 3000;
  if (context.dialog) score += 1600;
  if (context.form) score += 300;
  if (context.container?.querySelector?.('input, select, textarea')) score += 180;
  if (isAddySuccessContainer(context.container) || isAddySuccessContainer(context.dialog)) score -= 3000;
  return score;
}

function findAddyConfirmCreateAliasButton(entryButton = null) {
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal, [class*="dialog" i], [class*="modal" i], [data-state="open"]')).filter((dialog) => (
    isAddyElementVisible(dialog) && !isAddySuccessContainer(dialog)
  ));

  for (const dialog of dialogs) {
    const candidates = findVisibleAddyButtons(isConfirmCreateAliasButton, dialog).filter((button) => button !== entryButton);
    candidates.sort((a, b) => scoreAddyConfirmCreateAliasButton(b, entryButton) - scoreAddyConfirmCreateAliasButton(a, entryButton));
    if (candidates[0]) return candidates[0];
  }

  const candidates = findVisibleAddyButtons(isConfirmCreateAliasButton).filter((button) => (
    button !== entryButton && !isAddyButtonInSuccessContainer(button)
  ));
  candidates.sort((a, b) => scoreAddyConfirmCreateAliasButton(b, entryButton) - scoreAddyConfirmCreateAliasButton(a, entryButton));
  return candidates[0] || null;
}

function findAddySuccessCopyState() {
  const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter((button) => (
    isAddyElementVisible(button) && isCopyAliasButton(button)
  ));
  const candidates = [];

  for (const button of buttons) {
    let current = button;
    let depth = 0;
    while (current && current !== document.body && depth <= 8) {
      const text = normalizeAddyText(current.textContent || '');
      const alias = extractAddyAliasFromText(text);
      const mentionsNewAlias = /your new alias is/i.test(text);
      if (mentionsNewAlias || alias) {
        candidates.push({
          button,
          container: current,
          alias,
          depth,
          score: (mentionsNewAlias ? 1000 : 0) + (alias ? 400 : 0) - depth * 10,
        });
      }
      current = current.parentElement;
      depth += 1;
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function getAddyFieldDescriptorText(el) {
  return normalizeAddyText([
    el?.getAttribute?.('aria-label'),
    el?.getAttribute?.('placeholder'),
    el?.getAttribute?.('name'),
    el?.getAttribute?.('id'),
    el?.labels ? Array.from(el.labels).map((label) => label.textContent || '').join(' ') : '',
    el?.closest?.('label, [role="group"], [class*="field" i], [class*="input" i], [class*="select" i], [class*="combobox" i]')?.textContent || '',
  ].join(' ')).toLowerCase();
}

function isAddyRecipientsField(el) {
  if (!el || !isAddyElementVisible(el)) return false;
  return /recipients?/.test(getAddyFieldDescriptorText(el));
}

function isAddyAliasDomainField(el) {
  if (!el || !isAddyElementVisible(el)) return false;
  const text = getAddyFieldDescriptorText(el);
  return /(alias\s*domain|domain)/.test(text) && !/recipient/.test(text);
}

function findAddyRecipientsInput(container) {
  if (!container?.querySelectorAll) return null;
  const selectors = [
    'input',
    'textarea',
    '[role="combobox"] input',
    'input[aria-autocomplete]',
  ];
  for (const selector of selectors) {
    const match = Array.from(container.querySelectorAll(selector)).find((el) => isAddyRecipientsField(el));
    if (match) {
      return match;
    }
  }
  return null;
}

function findAddyAliasDomainField(container) {
  if (!container?.querySelectorAll) return null;
  const selectors = [
    'select',
    'input',
    'textarea',
    '[role="combobox"]',
    '[role="combobox"] input',
    'input[aria-autocomplete]',
    'button[aria-haspopup="listbox"]',
    'button[aria-haspopup="menu"]',
  ];
  for (const selector of selectors) {
    const match = Array.from(container.querySelectorAll(selector)).find((el) => isAddyAliasDomainField(el));
    if (match) {
      return match;
    }
  }
  return null;
}

function getAddyOptionCandidateText(el) {
  return normalizeAddyText([
    el?.textContent || '',
    el?.getAttribute?.('aria-label') || '',
    el?.getAttribute?.('data-value') || '',
    el?.title || '',
    el?.getAttribute?.('value') || '',
  ].join(' '));
}

function normalizeAddyAliasDomainValue(value) {
  return normalizeAddyText(value).toLowerCase();
}

function collectAddyAliasDomainCandidates(value) {
  const normalized = normalizeAddyAliasDomainValue(value);
  const candidates = new Set();
  if (normalized) {
    candidates.add(normalized);
  }
  const domainMatches = normalized.match(/\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/g) || [];
  for (const match of domainMatches) {
    candidates.add(match);
  }
  return [...candidates];
}

function hasExactAddyAliasDomainMatch(value, aliasDomain) {
  const target = normalizeAddyAliasDomainValue(aliasDomain);
  if (!target) return true;
  return collectAddyAliasDomainCandidates(value).includes(target);
}

function getAddyRecipientCandidateText(el) {
  return getAddyOptionCandidateText(el);
}

function scoreAddyRecipientsOption(el, field, recipientText) {
  if (!el || el === field || el.contains?.(field) || field?.contains?.(el)) return -Infinity;
  if (!(el instanceof HTMLElement) || !isAddyElementVisible(el)) return -Infinity;

  const text = getAddyRecipientCandidateText(el);
  const normalizedText = text.toLowerCase();
  const target = normalizeAddyText(recipientText).toLowerCase();
  if (!target || !normalizedText.includes(target)) return -Infinity;

  const role = String(el.getAttribute('role') || '').toLowerCase();
  const tagName = String(el.tagName || '').toLowerCase();
  let score = 0;
  if (normalizedText === target) score += 4000;
  if ((normalizeAddyText(el.textContent || '').toLowerCase()) === target) score += 2000;
  if (role === 'option') score += 1200;
  if (role === 'button' || role === 'menuitem') score += 700;
  if (['button', 'li', 'a'].includes(tagName)) score += 500;
  if (el.getAttribute('aria-selected') === 'false') score += 200;
  if (el.getAttribute('aria-selected') === 'true') score += 500;
  if (text.length <= target.length + 8) score += 300;

  const fieldRect = field?.getBoundingClientRect?.();
  const optionRect = el.getBoundingClientRect();
  if (fieldRect && optionRect) {
    if (optionRect.top >= fieldRect.bottom - 6) score += 800;
    if (Math.abs(optionRect.left - fieldRect.left) <= 80) score += 250;
    score -= Math.min(600, Math.abs(optionRect.top - fieldRect.bottom));
  }

  score -= Math.min(500, (el.querySelectorAll?.('*').length || 0) * 10);
  return score;
}

function findAddyRecipientsOption(container, field, recipients) {
  if (!container?.querySelectorAll) return null;
  const candidates = Array.from(container.querySelectorAll('*'))
    .map((el) => ({ el, score: scoreAddyRecipientsOption(el, field, recipients) }))
    .filter((item) => Number.isFinite(item.score) && item.score > -Infinity)
    .sort((left, right) => right.score - left.score);
  return candidates[0]?.el || null;
}

async function clickAddyRecipientsOption(container, field, recipients, requestId = null, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    throwIfAddyRequestInvalid(requestId);
    const option = findAddyRecipientsOption(container, field, recipients);
    if (option) {
      debugLog('Addy recipients option found', {
        elapsedMs: Date.now() - start,
        text: normalizeAddyText(option.textContent || ''),
        role: option.getAttribute('role') || '',
        className: option.className || '',
      });
      option.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      await humanPause(150, 350);
      simulateClick(option);
      await sleep(250);
      return option;
    }
    await sleep(150);
  }

  debugLog('Addy recipients option missing', {
    recipients: String(recipients || ''),
    contextText: normalizeAddyText(container?.textContent || ''),
    fields: collectFieldDebugInfo(),
  });
  throw new Error('Addy.io Recipients 已输入，但未找到下方可点击的匹配邮箱。');
}

async function fillAddyRecipients(confirmButton, recipients, requestId = null) {
  const rawRecipients = String(recipients ?? '');
  if (!rawRecipients) return;

  throwIfAddyRequestInvalid(requestId);
  const context = getAddyButtonContext(confirmButton);
  const container = context.dialog || context.form || context.container;
  const field = findAddyRecipientsInput(container);
  if (!field) {
    debugLog('Addy recipients field missing', {
      recipients: rawRecipients,
      contextText: normalizeAddyText(container?.textContent || ''),
      fields: collectFieldDebugInfo(),
    });
    throw new Error('已配置 Addy.io Recipients，但未找到对应输入框。');
  }

  field.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await humanPause(250, 600);
  fillInput(field, rawRecipients);
  await sleep(250);

  const currentValue = normalizeAddyText(field.value || field.textContent || '');
  if (!currentValue || !currentValue.includes(normalizeAddyText(rawRecipients))) {
    debugLog('Addy recipients fill verification failed', {
      recipients: rawRecipients,
      currentValue,
      contextText: normalizeAddyText(container?.textContent || ''),
    });
    throw new Error('Addy.io Recipients 填写后未通过校验。');
  }

  await clickAddyRecipientsOption(container, field, rawRecipients, requestId);

  const containerText = normalizeAddyText(container?.textContent || '').toLowerCase();
  const normalizedRecipients = normalizeAddyText(rawRecipients).toLowerCase();
  if (!containerText.includes(normalizedRecipients)) {
    debugLog('Addy recipients selection verification failed', {
      recipients: rawRecipients,
      contextText: normalizeAddyText(container?.textContent || ''),
      fields: collectFieldDebugInfo(),
    });
    throw new Error('Addy.io Recipients 点击匹配项后未通过校验。');
  }

  log(`Addy.io：已填写并选中 Recipients：${rawRecipients}`);
}

function scoreAddyAliasDomainOption(el, field, aliasDomain) {
  if (!el || el === field || el.contains?.(field) || field?.contains?.(el)) return -Infinity;
  if (!(el instanceof HTMLElement) || !isAddyElementVisible(el)) return -Infinity;

  const text = getAddyOptionCandidateText(el);
  const normalizedText = normalizeAddyAliasDomainValue(text);
  const normalizedVisibleText = normalizeAddyAliasDomainValue(el.textContent || '');
  const target = normalizeAddyAliasDomainValue(aliasDomain);
  if (!target || !hasExactAddyAliasDomainMatch(text, aliasDomain)) return -Infinity;

  const role = String(el.getAttribute('role') || '').toLowerCase();
  const tagName = String(el.tagName || '').toLowerCase();
  let score = 0;
  if (normalizedText === target) score += 5000;
  else score += 2600;
  if (normalizedVisibleText === target) score += 2400;
  if (hasExactAddyAliasDomainMatch(el.textContent || '', aliasDomain)) score += 1200;
  if (role === 'option') score += 1400;
  if (role === 'button' || role === 'menuitem') score += 900;
  if (['button', 'li', 'a', 'option'].includes(tagName)) score += 650;
  if (text.length <= target.length + 6) score += 400;

  const fieldRect = field?.getBoundingClientRect?.();
  const optionRect = el.getBoundingClientRect();
  if (fieldRect && optionRect) {
    if (optionRect.top >= fieldRect.bottom - 12) score += 900;
    if (Math.abs(optionRect.left - fieldRect.left) <= 120) score += 300;
    score -= Math.min(700, Math.abs(optionRect.top - fieldRect.bottom));
  }

  score -= Math.min(500, (el.querySelectorAll?.('*').length || 0) * 10);
  return score;
}

function findAddyAliasDomainOption(field, aliasDomain, container = null) {
  const scopes = [];
  if (container?.querySelectorAll) scopes.push(container);
  if (!scopes.includes(document)) scopes.push(document);

  const candidates = [];
  for (const scope of scopes) {
    for (const el of Array.from(scope.querySelectorAll('*'))) {
      const score = scoreAddyAliasDomainOption(el, field, aliasDomain);
      if (Number.isFinite(score) && score > -Infinity) {
        candidates.push({ el, score });
      }
    }
  }

  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.el || null;
}

async function clickAddyAliasDomainOption(field, aliasDomain, container = null, requestId = null, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    throwIfAddyRequestInvalid(requestId);
    const option = findAddyAliasDomainOption(field, aliasDomain, container);
    if (option) {
      debugLog('Addy alias-domain option found', {
        elapsedMs: Date.now() - start,
        text: normalizeAddyText(option.textContent || ''),
        role: option.getAttribute('role') || '',
        className: option.className || '',
      });
      option.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      await humanPause(150, 350);
      simulateClick(option);
      await sleep(250);
      return option;
    }
    await sleep(150);
  }

  debugLog('Addy alias-domain option missing', {
    aliasDomain: String(aliasDomain || ''),
    contextText: normalizeAddyText(container?.textContent || document.body?.textContent || ''),
    fields: collectFieldDebugInfo(),
  });
  throw new Error('Addy.io Alias Domain 已输入，但未找到可点击的匹配域名。');
}

function collectAddyAliasDomainSelectionEvidence(field, container) {
  const values = new Set();
  const push = (candidate) => {
    const normalized = normalizeAddyText(candidate);
    if (normalized) {
      values.add(normalized);
    }
  };

  const isTextEntryField = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement;
  if (!isTextEntryField) {
    push(field?.textContent);
  }
  push(field?.getAttribute?.('data-value'));
  push(field?.getAttribute?.('aria-valuetext'));
  push(field?.getAttribute?.('data-selected-value'));

  const activeDescendantId = String(field?.getAttribute?.('aria-activedescendant') || '').trim();
  if (activeDescendantId) {
    const activeDescendant = document.getElementById(activeDescendantId);
    push(activeDescendant?.textContent || '');
    push(activeDescendant?.getAttribute?.('aria-label') || '');
    push(activeDescendant?.getAttribute?.('data-value') || '');
    push(activeDescendant?.getAttribute?.('value') || '');
  }

  const controlledIds = String(field?.getAttribute?.('aria-controls') || '').trim().split(/\s+/).filter(Boolean);
  for (const controlledId of controlledIds) {
    const controlled = document.getElementById(controlledId);
    if (!controlled) continue;
    if (controlled.querySelectorAll) {
      Array.from(controlled.querySelectorAll('[aria-selected="true"], [aria-checked="true"], [data-state="checked"], [data-selected="true"], option:checked')).forEach((el) => {
        push(el.textContent || '');
        push(el.getAttribute?.('aria-label') || '');
        push(el.getAttribute?.('data-value') || '');
        push(el.getAttribute?.('value') || '');
      });
    }
  }

  const fieldScope = field?.closest?.('label, [role="group"], [class*="field" i], [class*="input" i], [class*="select" i], [class*="combobox" i]') || container || null;
  if (fieldScope?.querySelectorAll) {
    Array.from(fieldScope.querySelectorAll('[aria-selected="true"], [aria-checked="true"], [data-state="checked"], [data-selected="true"], option:checked')).forEach((el) => {
      push(el.textContent || '');
      push(el.getAttribute?.('aria-label') || '');
      push(el.getAttribute?.('data-value') || '');
      push(el.getAttribute?.('value') || '');
    });
  }

  return [...values];
}

function isSelectedAliasDomain(field, container, aliasDomain) {
  const target = normalizeAddyAliasDomainValue(aliasDomain);
  if (!target) return true;

  if (field instanceof HTMLSelectElement) {
    const selectedOption = field.options[field.selectedIndex];
    return hasExactAddyAliasDomainMatch(`${selectedOption?.text || ''} ${selectedOption?.value || ''}`, aliasDomain);
  }

  return collectAddyAliasDomainSelectionEvidence(field, container).some((value) => (
    hasExactAddyAliasDomainMatch(value, aliasDomain)
  ));
}

async function fillAddyAliasDomain(confirmButton, aliasDomain, requestId = null) {
  const rawAliasDomain = String(aliasDomain ?? '');
  if (!rawAliasDomain) return;

  throwIfAddyRequestInvalid(requestId);
  const context = getAddyButtonContext(confirmButton);
  const container = context.dialog || context.form || context.container;
  const field = findAddyAliasDomainField(container);
  if (!field) {
    debugLog('Addy alias-domain field missing', {
      aliasDomain: rawAliasDomain,
      contextText: normalizeAddyText(container?.textContent || ''),
      fields: collectFieldDebugInfo(),
    });
    throw new Error('已配置 Addy.io Alias Domain，但未找到对应字段。');
  }

  field.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await humanPause(250, 600);

  if (field instanceof HTMLSelectElement) {
    const matchedOption = Array.from(field.options).find((option) => (
      hasExactAddyAliasDomainMatch(`${option.text || ''} ${option.value || ''}`, rawAliasDomain)
    ));
    if (!matchedOption) {
      debugLog('Addy alias-domain select option missing', {
        aliasDomain: rawAliasDomain,
        options: Array.from(field.options).map((option) => normalizeAddyText(option.text || option.value || '')),
      });
      throw new Error('已配置 Addy.io Alias Domain，但下拉框中未找到匹配域名。');
    }
    fillSelect(field, matchedOption.value);
    await sleep(250);
  } else {
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      fillInput(field, rawAliasDomain);
    } else {
      simulateClick(field);
    }
    await sleep(250);
    if (!(field instanceof HTMLSelectElement) && !isSelectedAliasDomain(field, container, rawAliasDomain)) {
      await clickAddyAliasDomainOption(field, rawAliasDomain, container, requestId);
    }
  }

  if (!isSelectedAliasDomain(field, container, rawAliasDomain)) {
    debugLog('Addy alias-domain selection verification failed', {
      aliasDomain: rawAliasDomain,
      contextText: normalizeAddyText(container?.textContent || ''),
      fields: collectFieldDebugInfo(),
    });
    throw new Error('Addy.io Alias Domain 选择后未通过校验。');
  }

  log(`Addy.io：已选中 Alias Domain：${rawAliasDomain}`);
}

async function clickAddyButton(button, debugLabel) {
  if (!button) {
    throw new Error(`缺少按钮：${debugLabel}`);
  }
  debugLog(debugLabel, {
    text: normalizeAddyText(button.textContent || ''),
    aria: button.getAttribute('aria-label') || '',
    title: button.title || '',
    className: button.className || '',
  });
  button.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await humanPause(250, 650);
  simulateClick(button);
}

async function clickAddyConfirmCreateAliasButton(button) {
  await waitForAddyButtonStable(button, { timeoutMs: 15000, stableMs: 1500 });
  await clickAddyButton(button, 'Addy modal create-alias button found');
}

async function clickCreateNewAliasButton() {
  const button = findAddyEntryCreateAliasButton();
  if (!button) {
    debugLog('Addy create-new-alias button missing', snapshotAddyState());
    throw new Error('未找到 Addy.io 的 Create Alias 按钮，请先登录并打开 aliases 页面。');
  }
  await clickAddyButton(button, 'Addy create-new-alias button found');
  return button;
}

async function waitForConfirmCreateAliasButton(entryButton, timeoutMs = 15000, requestId = null) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    throwIfAddyRequestInvalid(requestId);
    const button = findAddyConfirmCreateAliasButton(entryButton);
    if (button) {
      debugLog('Addy confirm-create-alias button found', {
        elapsedMs: Date.now() - start,
        text: normalizeAddyText(button.textContent || ''),
        className: button.className || '',
      });
      return button;
    }
    await sleep(150);
  }
  debugLog('Addy confirm-create-alias button timeout', snapshotAddyState());
  throw new Error('等待 Addy.io 弹窗中的 Create Alias 按钮超时。');
}

async function waitForAddySuccessCopyState(timeoutMs = 20000, requestId = null) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    throwIfAddyRequestInvalid(requestId);
    const state = findAddySuccessCopyState();
    if (state?.button) {
      debugLog('Addy success dialog found', {
        elapsedMs: Date.now() - start,
        alias: state.alias,
        text: normalizeAddyText(state.container?.textContent || ''),
      });
      return state;
    }
    await sleep(150);
  }
  debugLog('Addy success dialog timeout', snapshotAddyState());
  throw new Error('等待 Addy.io 新别名结果弹窗超时。');
}

async function waitForAddyClipboardAlias(expectedAlias = '', previousAlias = '', timeoutMs = 5000, requestId = null) {
  const start = Date.now();
  let failuresLogged = false;
  while (Date.now() - start < timeoutMs) {
    throwIfAddyRequestInvalid(requestId);
    const alias = await readAddyClipboardAlias({ logFailures: !failuresLogged });
    if (alias) {
      failuresLogged = true;
      if ((!expectedAlias || alias === expectedAlias) && (!previousAlias || alias !== previousAlias)) {
        debugLog('Addy alias from clipboard', { expectedAlias, previousAlias, alias, elapsedMs: Date.now() - start });
        return alias;
      }
    }
    await sleep(150);
  }
  return '';
}

async function maybeCloseAddySuccessDialog(container) {
  const closeButton = container ? findVisibleAddyButton(isCloseAliasButton, container) : null;
  if (!closeButton) return;
  await clickAddyButton(closeButton, 'Addy success dialog close button found');
}

async function waitForAliasChange(previousEmail = '', timeoutMs = 30000, requestId = null) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    throwIfAddyRequestInvalid(requestId);
    const nextEmail = readCurrentAddyAlias();
    if (nextEmail && (!previousEmail || nextEmail !== previousEmail)) {
      debugLog('Addy alias changed', { previousEmail, nextEmail, elapsedMs: Date.now() - start });
      return nextEmail;
    }
    await sleep(200);
  }
  debugLog('Addy alias wait timeout', snapshotAddyState());
  throw new Error('等待 Addy.io 新别名出现超时。');
}

async function fetchAddyAlias(payload = {}, options = {}) {
  const { generateNew = true, addyRecipients = '', addyAliasDomain = '' } = payload;
  const requestId = Number.isInteger(options.requestId) ? options.requestId : null;
  log(`Addy.io：正在${generateNew ? '生成' : '读取'}别名...`);
  debugLog('Addy fetch start', {
    url: location.href,
    generateNew,
    addyRecipients: String(addyRecipients || ''),
    addyAliasDomain: String(addyAliasDomain || ''),
  });

  const currentAlias = readCurrentAddyAlias();
  debugLog('Addy initial snapshot', snapshotAddyState());
  if (currentAlias && !generateNew) {
    log(`Addy.io：已发现现有别名 ${currentAlias}`);
    return { email: currentAlias, generated: false };
  }

  await waitForElement('body', 20000);
  throwIfAddyRequestInvalid(requestId);

  if (!generateNew && currentAlias) {
    return { email: currentAlias, generated: false };
  }

  const entryButton = await clickCreateNewAliasButton();
  const confirmButton = await waitForConfirmCreateAliasButton(entryButton, 15000, requestId);
  await fillAddyAliasDomain(confirmButton, addyAliasDomain, requestId);
  await fillAddyRecipients(confirmButton, addyRecipients, requestId);
  await clickAddyConfirmCreateAliasButton(confirmButton);

  const successState = await waitForAddySuccessCopyState(20000, requestId);
  await clickAddyButton(successState.button, 'Addy success dialog copy button found');
  const clipboardAlias = await waitForAddyClipboardAlias(successState.alias, currentAlias, 5000, requestId);
  const nextAlias = clipboardAlias || successState.alias || await waitForAliasChange(currentAlias, 30000, requestId);
  await maybeCloseAddySuccessDialog(successState.container);

  debugLog('Addy final snapshot', {
    previousAlias: currentAlias,
    modalAlias: successState.alias,
    clipboardAlias,
    nextAlias,
    fields: collectFieldDebugInfo(),
  });
  log(`Addy.io：别名已就绪 ${nextAlias}`, 'ok');
  return { email: nextAlias, generated: true };
}
