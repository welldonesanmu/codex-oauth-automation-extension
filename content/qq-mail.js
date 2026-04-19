// content/qq-mail.js — Content script for QQ Mail (steps 4, 7)
// Injected on: mail.qq.com, wx.mail.qq.com
// NOTE: all_frames: true
//
// Strategy for avoiding stale codes:
// 1. On poll start, snapshot all existing mail IDs as "old"
// 2. On each poll cycle, refresh inbox and look for NEW items (not in snapshot)
// 3. Only extract codes from NEW items that match sender/subject filters

const QQ_MAIL_PREFIX = '[MultiPage:qq-mail]';
const isTopFrame = window === window.top;

console.log(QQ_MAIL_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

// ============================================================
// Message Handler
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POLL_EMAIL') {
    if (!isTopFrame) {
      sendResponse({ ok: false, reason: 'wrong-frame' });
      return;
    }
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
    return true; // async response
  }
});

// ============================================================
// Get all current mail IDs from the list
// ============================================================

function getCurrentMailIds() {
  const ids = new Set();
  document.querySelectorAll('.mail-list-page-item[data-mailid]').forEach(item => {
    ids.add(item.getAttribute('data-mailid'));
  });
  return ids;
}

function getQqSnapshotStorageKey(payload = {}) {
  const step = Number(payload.step) || 0;
  const filterAfterTimestamp = Number(payload.filterAfterTimestamp || 0) || 0;
  return `qqMailSnapshot:${step}:${filterAfterTimestamp}`;
}

async function loadPersistedMailSnapshot(payload = {}) {
  const key = getQqSnapshotStorageKey(payload);
  try {
    const data = await chrome.storage.session.get(key);
    const rawIds = Array.isArray(data[key]) ? data[key] : [];
    return new Set(rawIds.filter(Boolean));
  } catch (err) {
    console.warn(QQ_MAIL_PREFIX, 'Failed to load persisted mail snapshot:', err?.message || err);
    return new Set();
  }
}

async function persistMailSnapshot(payload = {}, mailIds) {
  const key = getQqSnapshotStorageKey(payload);
  try {
    await chrome.storage.session.set({ [key]: [...new Set(mailIds || [])] });
  } catch (err) {
    console.warn(QQ_MAIL_PREFIX, 'Failed to persist mail snapshot:', err?.message || err);
  }
}

async function clearPersistedMailSnapshot(payload = {}) {
  const key = getQqSnapshotStorageKey(payload);
  try {
    await chrome.storage.session.remove(key);
  } catch (err) {
    console.warn(QQ_MAIL_PREFIX, 'Failed to clear persisted mail snapshot:', err?.message || err);
  }
}

// ============================================================
// Email Polling
// ============================================================

async function handlePollEmail(step, payload) {
  const {
    senderFilters,
    subjectFilters,
    maxAttempts,
    intervalMs,
    excludeCodes = [],
    filterAfterTimestamp = 0,
  } = payload;
  const excludedCodeSet = new Set(excludeCodes.filter(Boolean));

  log(`步骤 ${step}：开始轮询邮箱（最多 ${maxAttempts} 次，每 ${intervalMs / 1000} 秒一次）`);

  // Wait for mail list to load
  try {
    await waitForElement('.mail-list-page-item', 10000);
    log(`步骤 ${step}：邮件列表已加载`);
  } catch {
    throw new Error('邮件列表未加载完成，请确认 QQ 邮箱已打开收件箱。');
  }

  // Step 1: Snapshot existing mail IDs BEFORE we start waiting for new email
  let existingMailIds = await loadPersistedMailSnapshot({ step, filterAfterTimestamp });
  if (existingMailIds.size > 0) {
    log(`步骤 ${step}：已恢复 ${existingMailIds.size} 封旧邮件快照（跨刷新保持）。`);
  } else {
    existingMailIds = getCurrentMailIds();
    await persistMailSnapshot({ step, filterAfterTimestamp }, existingMailIds);
    log(`步骤 ${step}：已将当前 ${existingMailIds.size} 封邮件标记为旧邮件快照`);
  }

  // Fallback after just 3 attempts (~10s). In practice, the email is usually
  // already in the list but has the same mailid (page was already open).
  const FALLBACK_AFTER = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`步骤 ${step}：正在轮询 QQ 邮箱，第 ${attempt}/${maxAttempts} 次`);

    // Refresh inbox (skip on first attempt, list is fresh)
    if (attempt > 1) {
      const refreshed = await refreshInbox(step);
      if (refreshed === 'reload-required') {
        return { ok: false, reloadRequired: true };
      }
      await sleep(800);
    }

    const allItems = document.querySelectorAll('.mail-list-page-item[data-mailid]');
    const useFallback = attempt > FALLBACK_AFTER;

    // Phase 1 (attempt 1~3): only look at NEW emails (not in snapshot)
    // Phase 2 (attempt 4+): fallback to first matching email in list
    for (const item of allItems) {
      const mailId = item.getAttribute('data-mailid');

      if (!useFallback && existingMailIds.has(mailId)) continue;

      const sender = (item.querySelector('.cmp-account-nick')?.textContent || '').toLowerCase();
      const subject = (item.querySelector('.mail-subject')?.textContent || '').toLowerCase();
      const digest = item.querySelector('.mail-digest')?.textContent || '';

      const senderMatch = senderFilters.some(f => sender.includes(f.toLowerCase()));
      const subjectMatch = subjectFilters.some(f => subject.includes(f.toLowerCase()));

      if (senderMatch || subjectMatch) {
        const code = extractVerificationCode(subject + ' ' + digest);
        if (code) {
          if (excludedCodeSet.has(code)) {
            log(`步骤 ${step}：跳过排除的验证码：${code}`, 'info');
            continue;
          }
          const source = useFallback && existingMailIds.has(mailId) ? '回退首封匹配邮件' : '新邮件';
          log(`步骤 ${step}：已找到验证码：${code}（来源：${source}，主题：${subject.slice(0, 40)}）`, 'ok');
          await clearPersistedMailSnapshot({ step, filterAfterTimestamp });
          return { ok: true, code, emailTimestamp: Date.now(), mailId };
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

  await clearPersistedMailSnapshot({ step, filterAfterTimestamp });
  throw new Error(
    `${(maxAttempts * intervalMs / 1000).toFixed(0)} 秒后仍未找到新的匹配邮件。` +
    '请手动检查 QQ 邮箱，邮件可能延迟到达或进入垃圾箱。'
  );
}

// ============================================================
// Inbox Refresh
// ============================================================

async function refreshInbox(step) {
  // Strategy 1: Click any visible refresh button
  const refreshBtn = document.querySelector('[class*="refresh"], [title*="刷新"]');
  if (refreshBtn) {
    simulateClick(refreshBtn);
    console.log(QQ_MAIL_PREFIX, 'Clicked refresh button');
    await sleep(500);
    return 'refreshed';
  }

  log(`步骤 ${step}：点击收件箱不会真正刷新邮件，改由后台直接刷新 QQ 页面。`, 'warn');
  return 'reload-required';
}

// ============================================================
// Verification Code Extraction
// ============================================================

function extractVerificationCode(text) {
  // Pattern 1: Chinese format "代码为 370794" or "验证码...370794"
  const matchCn = text.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  // Pattern 2: English format "code is 370794" or "code: 370794"
  const matchEn = text.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  // Pattern 3: standalone 6-digit number (first occurrence)
  const match6 = text.match(/\b(\d{6})\b/);
  if (match6) return match6[1];

  return null;
}
