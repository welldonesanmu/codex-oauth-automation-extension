// content/mail-163.js — Content script for 163 Mail (steps 4, 7)
// Injected on: mail.163.com
//
// DOM structure:
// Mail item: div[sign="letter"] with aria-label="你的 ChatGPT 代码为 479637 发件人 ： OpenAI ..."
// Sender: .nui-user (e.g., "OpenAI")
// Subject: span.da0 (e.g., "你的 ChatGPT 代码为 479637")
// Delete actions: hover trash icon on the row, or checkbox + toolbar delete button

const MAIL163_PREFIX = '[MultiPage:mail-163]';
const isTopFrame = window === window.top;

console.log(MAIL163_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

// Only operate in the top frame
if (!isTopFrame) {
  console.log(MAIL163_PREFIX, 'Skipping child frame');
} else {

// Track codes we've already seen — persisted in chrome.storage.session to survive script re-injection
let seenCodes = new Set();
const MAIL163_WAKE_INTERVAL_MS = 10 * 60 * 1000;
const MAIL163_LAST_WAKE_AT_KEY = 'mail163LastWakeAt';

async function loadSeenCodes() {
  try {
    const data = await chrome.storage.session.get('seenCodes');
    if (data.seenCodes && Array.isArray(data.seenCodes)) {
      seenCodes = new Set(data.seenCodes);
      console.log(MAIL163_PREFIX, `Loaded ${seenCodes.size} previously seen codes`);
    }
  } catch (err) {
    console.warn(MAIL163_PREFIX, 'Session storage unavailable, using in-memory seen codes:', err?.message || err);
  }
}

// Load previously seen codes on startup
loadSeenCodes();

async function persistSeenCodes() {
  try {
    await chrome.storage.session.set({ seenCodes: [...seenCodes] });
  } catch (err) {
    console.warn(MAIL163_PREFIX, 'Could not persist seen codes, continuing in-memory only:', err?.message || err);
  }
}

// ============================================================
// Message Handler (top frame only)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POLL_EMAIL') {
    setCurrentCommandContext(message);
    resetStopState();
    handlePollEmail(message.step, message.payload).then(result => {
      sendResponse(result);
    }).catch(err => {
      if (isStopError(err)) {
        log(`步骤 ${message.step}：已被用户停止。`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      log(`步骤 ${message.step}：邮箱轮询失败：${err.message}`, 'warn');
      sendResponse({ error: err.message });
    });
    return true;
  }
});

// ============================================================
// Find mail items
// ============================================================

function findMailItems() {
  return document.querySelectorAll('div[sign="letter"]');
}

function getInboxEntry() {
  return document.querySelector('.nui-tree-item-text[title="收件箱"]');
}

function getPageActivationTarget() {
  return document.querySelector('.js-component-component.ra0.mD0')
    || document.querySelector('.js-component-component.ra0')
    || document.querySelector('.mD0')
    || document.querySelector('#dvContainer')
    || document.body;
}

function getSerializableRect(el) {
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    centerX: rect.left + (rect.width / 2),
    centerY: rect.top + (rect.height / 2),
  };
}

async function getMail163LastWakeAt() {
  try {
    const data = await chrome.storage.session.get(MAIL163_LAST_WAKE_AT_KEY);
    const value = Number(data[MAIL163_LAST_WAKE_AT_KEY] || 0);
    return Number.isFinite(value) ? value : 0;
  } catch (err) {
    console.warn(MAIL163_PREFIX, 'Could not read last wake timestamp:', err?.message || err);
    return 0;
  }
}

async function setMail163LastWakeAt(timestamp) {
  try {
    await chrome.storage.session.set({ [MAIL163_LAST_WAKE_AT_KEY]: timestamp });
  } catch (err) {
    console.warn(MAIL163_PREFIX, 'Could not persist last wake timestamp:', err?.message || err);
  }
}

async function maybeActivateMail163Page(step, reason = '页面疑似休眠，尝试激活', options = {}) {
  const { force = false } = options;
  const now = Date.now();
  const lastWakeAt = await getMail163LastWakeAt();
  const nextWakeInMs = MAIL163_WAKE_INTERVAL_MS - (now - lastWakeAt);

  if (!force && lastWakeAt && nextWakeInMs > 0) {
    log(`步骤 ${step}：暂不执行 163 保活点击，距离下次保活窗口还有 ${Math.ceil(nextWakeInMs / 60000)} 分钟。`, 'info');
    return false;
  }

  const activationTarget = getPageActivationTarget();
  if (!activationTarget) {
    log(`步骤 ${step}：${reason}，但未找到可点击的 163 页面区域。`, 'warn');
    return false;
  }

  window.focus?.();
  activationTarget.scrollIntoView({ block: 'center', inline: 'center' });
  activationTarget.focus?.();
  activationTarget.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true }));
  activationTarget.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
  activationTarget.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
  activationTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
  activationTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, buttons: 0 }));
  activationTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  await sleep(300);

  const rect = getSerializableRect(activationTarget);
  if (!rect) {
    log(`步骤 ${step}：163 页面保活仅执行了 DOM 点击，因为无法获取坐标。`, 'warn');
    await setMail163LastWakeAt(now);
    return true;
  }

  try {
    await chrome.runtime.sendMessage({
      type: 'DEBUGGER_CLICK_CURRENT_TAB',
      source: 'mail-163',
      payload: { rect },
    });
    await setMail163LastWakeAt(now);
    log(`步骤 ${step}：已执行 163 页面保活点击（${reason}）。`, 'warn');
    await sleep(500);
    return true;
  } catch (err) {
    log(`步骤 ${step}：163 页面保活点击失败：${err.message}`, 'warn');
    return false;
  }
}

function getCurrentMailIds() {
  const ids = new Set();
  findMailItems().forEach(item => {
    const id = item.getAttribute('id') || '';
    if (id) ids.add(id);
  });
  return ids;
}

function normalizeMinuteTimestamp(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  const date = new Date(timestamp);
  date.setSeconds(0, 0);
  return date.getTime();
}

function parseMail163Timestamp(rawText) {
  const text = (rawText || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  let match = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})/);
  if (match) {
    const [, year, month, day, hour, minute] = match;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      0,
      0
    ).getTime();
  }

  match = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (match) {
    const [, hour, minute] = match;
    const now = new Date();
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      Number(hour),
      Number(minute),
      0,
      0
    ).getTime();
  }

  return null;
}

function getMailTimestamp(item) {
  const candidates = [];
  const timeCell = item.querySelector('.e00[title], [title*="年"][title*=":"]');
  if (timeCell?.getAttribute('title')) candidates.push(timeCell.getAttribute('title'));
  if (timeCell?.textContent) candidates.push(timeCell.textContent);

  const titledNodes = item.querySelectorAll('[title]');
  titledNodes.forEach((node) => {
    const title = node.getAttribute('title');
    if (title) candidates.push(title);
  });

  for (const candidate of candidates) {
    const parsed = parseMail163Timestamp(candidate);
    if (parsed) return parsed;
  }

  return null;
}

function scheduleEmailCleanup(item, step) {
  setTimeout(() => {
    Promise.resolve(deleteEmail(item, step)).catch(() => {
      // Cleanup is best effort only and must never affect the main verification flow.
    });
  }, 0);
}

// ============================================================
// Email Polling
// ============================================================

async function handlePollEmail(step, payload) {
  const { senderFilters, subjectFilters, maxAttempts, intervalMs, excludeCodes = [], filterAfterTimestamp = 0 } = payload;
  const excludedCodeSet = new Set(excludeCodes.filter(Boolean));
  const filterAfterMinute = normalizeMinuteTimestamp(Number(filterAfterTimestamp) || 0);

  log(`步骤 ${step}：开始轮询 163 邮箱（最多 ${maxAttempts} 次）`);
  if (filterAfterMinute) {
    log(`步骤 ${step}：仅尝试 ${new Date(filterAfterMinute).toLocaleString('zh-CN', { hour12: false })} 及之后时间的邮件。`);
  }

  // Click inbox in sidebar to ensure we're in inbox view
  log(`步骤 ${step}：正在等待侧边栏加载...`);
  try {
    const inboxLink = await waitForElement('.nui-tree-item-text[title="收件箱"]', 5000);
    inboxLink.click();
    log(`步骤 ${step}：已点击收件箱`);
  } catch {
    log(`步骤 ${step}：未找到收件箱入口，先尝试执行一次 163 页面保活点击...`, 'warn');
    await maybeActivateMail163Page(step, '初次未找到收件箱入口');
  }

  // Wait for mail list to appear
  log(`步骤 ${step}：正在等待邮件列表加载...`);
  let items = [];
  for (let i = 0; i < 20; i++) {
    items = findMailItems();
    if (items.length > 0) break;

    if (i === 5 || i === 12) {
      await maybeActivateMail163Page(step, '邮件列表长时间未出现');
      const inboxLink = getInboxEntry();
      if (inboxLink) {
        inboxLink.click();
        await sleep(500);
      }
    }

    await sleep(500);
  }

  if (items.length === 0) {
    await refreshInbox();
    await sleep(2000);
    items = findMailItems();
  }

  if (items.length === 0) {
    await maybeActivateMail163Page(step, '刷新后邮件列表仍为空', { force: true });
    const inboxLink = getInboxEntry();
    if (inboxLink) {
      inboxLink.click();
      await sleep(800);
    }
    await refreshInbox();
    await sleep(2000);
    items = findMailItems();
  }

  if (items.length === 0) {
    throw new Error('163 邮箱列表未加载完成，请确认当前已打开收件箱；若页面休眠，请手动点一下 163 页面后重试。');
  }

  log(`步骤 ${step}：邮件列表已加载，共 ${items.length} 封邮件`);

  // Snapshot existing mail IDs
  const existingMailIds = getCurrentMailIds();
  log(`步骤 ${step}：已记录当前 ${existingMailIds.size} 封旧邮件快照`);

  const FALLBACK_AFTER = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`步骤 ${step}：正在轮询 163 邮箱，第 ${attempt}/${maxAttempts} 次`);

    if (attempt > 1) {
      await refreshInbox();
      await sleep(1000);
    }

    let allItems = findMailItems();
    if (allItems.length === 0) {
      await maybeActivateMail163Page(step, `第 ${attempt} 次轮询时邮件列表为空`);
      const inboxLink = getInboxEntry();
      if (inboxLink) {
        inboxLink.click();
        await sleep(500);
      }
      await refreshInbox();
      await sleep(1000);
      allItems = findMailItems();
    }
    const useFallback = attempt > FALLBACK_AFTER;

    for (const item of allItems) {
      const id = item.getAttribute('id') || '';
      const mailTimestamp = getMailTimestamp(item);
      const mailMinute = normalizeMinuteTimestamp(mailTimestamp || 0);
      const passesTimeFilter = !filterAfterMinute || (mailMinute && mailMinute >= filterAfterMinute);
      const shouldBypassOldSnapshot = Boolean(filterAfterMinute && passesTimeFilter && mailMinute > 0);

      if (!passesTimeFilter) {
        continue;
      }

      if (!useFallback && !shouldBypassOldSnapshot && existingMailIds.has(id)) continue;

      const senderEl = item.querySelector('.nui-user');
      const sender = senderEl ? senderEl.textContent.toLowerCase() : '';

      const subjectEl = item.querySelector('span.da0');
      const subject = subjectEl ? subjectEl.textContent : '';

      const ariaLabel = (item.getAttribute('aria-label') || '').toLowerCase();

      const senderMatch = senderFilters.some(f => sender.includes(f.toLowerCase()) || ariaLabel.includes(f.toLowerCase()));
      const subjectMatch = subjectFilters.some(f => subject.toLowerCase().includes(f.toLowerCase()) || ariaLabel.includes(f.toLowerCase()));

      if (senderMatch || subjectMatch) {
        const code = extractVerificationCode(subject + ' ' + ariaLabel);
        if (code && excludedCodeSet.has(code)) {
          log(`步骤 ${step}：跳过排除的验证码：${code}`, 'info');
        } else if (code && !seenCodes.has(code)) {
          seenCodes.add(code);
          persistSeenCodes();
          const source = useFallback && existingMailIds.has(id) ? '回退匹配邮件' : '新邮件';
          const timeLabel = mailTimestamp ? `，时间：${new Date(mailTimestamp).toLocaleString('zh-CN', { hour12: false })}` : '';
          log(`步骤 ${step}：已找到验证码：${code}（来源：${source}${timeLabel}，主题：${subject.slice(0, 40)}）`, 'ok');

          // Trigger cleanup only as a best-effort side effect.
          scheduleEmailCleanup(item, step);

          return { ok: true, code, emailTimestamp: Date.now(), mailId: id };
        } else if (code && seenCodes.has(code)) {
          log(`步骤 ${step}：跳过已处理过的验证码：${code}`, 'info');
        }
      }
    }

    if (attempt === FALLBACK_AFTER + 1) {
      log(`步骤 ${step}：连续 ${FALLBACK_AFTER} 次未发现新邮件，开始回退到首封匹配邮件`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `${(maxAttempts * intervalMs / 1000).toFixed(0)} 秒后仍未在 163 邮箱中找到新的匹配邮件。` +
    '请手动检查收件箱。'
  );
}

// ============================================================
// Delete Email via Hover Trash / Toolbar Fallback
// ============================================================

async function deleteEmail(item, step) {
  try {
    log(`步骤 ${step}：正在删除邮件...`);

    // Strategy 1: Click the trash icon inside the mail item
    // Each mail item has: <b class="nui-ico nui-ico-delete" title="删除邮件" sign="trash">
    // These icons appear on hover, so we trigger mouseover first
    item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await sleep(300);

    const trashIcon = item.querySelector('[sign="trash"], .nui-ico-delete, [title="删除邮件"]');
    if (trashIcon) {
      trashIcon.click();
      log(`步骤 ${step}：已点击删除图标`, 'ok');
      await sleep(1500);

      // Check if item disappeared (confirm deletion)
      const stillExists = document.getElementById(item.id);
      if (!stillExists || stillExists.style.display === 'none') {
        log(`步骤 ${step}：邮件已成功删除`);
      } else {
        log(`步骤 ${step}：邮件可能尚未删除，列表中仍可见`, 'warn');
      }
      return;
    }

    // Strategy 2: Select checkbox then click toolbar delete button
    log(`步骤 ${step}：未找到删除图标，尝试使用复选框加工具栏删除...`);
    const checkbox = item.querySelector('[sign="checkbox"], .nui-chk');
    if (checkbox) {
      checkbox.click();
      await sleep(300);

      // Click toolbar delete button
      const toolbarBtns = document.querySelectorAll('.nui-btn .nui-btn-text');
      for (const btn of toolbarBtns) {
        if (btn.textContent.replace(/\s/g, '').includes('删除')) {
          btn.closest('.nui-btn').click();
          log(`步骤 ${step}：已点击工具栏删除`, 'ok');
          await sleep(1500);
          return;
        }
      }
    }

    log(`步骤 ${step}：无法删除邮件（未找到删除按钮）`, 'warn');
  } catch (err) {
    log(`步骤 ${step}：删除邮件失败：${err.message}`, 'warn');
  }
}

// ============================================================
// Inbox Refresh
// ============================================================

async function refreshInbox() {
  // Try toolbar "刷 新" button
  const toolbarBtns = document.querySelectorAll('.nui-btn .nui-btn-text');
  for (const btn of toolbarBtns) {
    if (btn.textContent.replace(/\s/g, '') === '刷新') {
      btn.closest('.nui-btn').click();
      console.log(MAIL163_PREFIX, 'Clicked "刷新" button');
      await sleep(800);
      return;
    }
  }

  // Fallback: click sidebar "收 信"
  const shouXinBtns = document.querySelectorAll('.ra0');
  for (const btn of shouXinBtns) {
    if (btn.textContent.replace(/\s/g, '').includes('收信')) {
      btn.click();
      console.log(MAIL163_PREFIX, 'Clicked "收信" button');
      await sleep(800);
      return;
    }
  }

  console.log(MAIL163_PREFIX, 'Could not find refresh button');
}

// ============================================================
// Verification Code Extraction
// ============================================================

function extractVerificationCode(text) {
  const matchCn = text.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  const matchEn = text.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  const match6 = text.match(/\b(\d{6})\b/);
  if (match6) return match6[1];

  return null;
}

} // end of isTopFrame else block
