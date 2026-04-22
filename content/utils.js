// content/utils.js — Shared utilities for all content scripts

const SCRIPT_SOURCE = (() => {
  if (window.__MULTIPAGE_SOURCE) return window.__MULTIPAGE_SOURCE;
  const url = location.href;
  const hostname = location.hostname;
  if (url.includes('auth0.openai.com') || url.includes('auth.openai.com') || url.includes('accounts.openai.com') || url.includes('chatgpt.com')) return 'signup-page';
  if (hostname === 'mail.qq.com' || hostname === 'wx.mail.qq.com') return 'qq-mail';
  if (hostname === 'mail.163.com' || hostname.endsWith('.mail.163.com')) return 'mail-163';
  if (url.includes('duckduckgo.com/email/settings/autofill')) return 'duck-mail';
  if (hostname === 'app.simplelogin.io') return 'simplelogin-mail';
  if (hostname === 'app.addy.io') return 'addy-mail';
  // VPS panel — detected dynamically since URL is configurable
  return 'vps-panel';
})();

const LOG_PREFIX = `[MultiPage:${SCRIPT_SOURCE}]`;
const STOP_ERROR_MESSAGE = '流程已被用户停止。';
let flowStopped = false;
let currentCommandAutoRunAttemptId = null;

if (!window.__MULTIPAGE_UTILS_LISTENER_READY__) {
  window.__MULTIPAGE_UTILS_LISTENER_READY__ = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'STOP_FLOW') {
      setCurrentCommandContext(message);
      flowStopped = true;
      console.warn(LOG_PREFIX, STOP_ERROR_MESSAGE);
      return;
    }

    if (message.type === 'PING') {
      sendResponse({
        ok: true,
        source: SCRIPT_SOURCE,
      });
    }
  });
}

function resetStopState() {
  flowStopped = false;
}

function setCurrentCommandContext(message = null) {
  currentCommandAutoRunAttemptId = Number.isInteger(message?.autoRunAttemptId)
    ? message.autoRunAttemptId
    : null;
}

function withCurrentCommandContext(message) {
  if (!Number.isInteger(currentCommandAutoRunAttemptId)) {
    return message;
  }
  return {
    ...message,
    autoRunAttemptId: currentCommandAutoRunAttemptId,
  };
}

function isStopError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return message === STOP_ERROR_MESSAGE;
}

function throwIfStopped() {
  if (flowStopped) {
    throw new Error(STOP_ERROR_MESSAGE);
  }
}

/**
 * Wait for a DOM element to appear.
 * @param {string} selector - CSS selector
 * @param {number} timeout - Max wait time in ms (default 10000)
 * @returns {Promise<Element>}
 */
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    throwIfStopped();

    const existing = document.querySelector(selector);
    if (existing) {
      console.log(LOG_PREFIX, `立即找到元素: ${selector}`);
      log(`已找到元素：${selector}`);
      resolve(existing);
      return;
    }

    console.log(LOG_PREFIX, `等待元素: ${selector}（超时 ${timeout}ms）`);
    log(`正在等待选择器：${selector}...`);

    let settled = false;
    let stopTimer = null;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(stopTimer);
    };

    const observer = new MutationObserver(() => {
      if (flowStopped) {
        cleanup();
        reject(new Error(STOP_ERROR_MESSAGE));
        return;
      }
      const el = document.querySelector(selector);
      if (el) {
        cleanup();
        console.log(LOG_PREFIX, `等待后找到元素: ${selector}`);
        log(`已找到元素：${selector}`);
        resolve(el);
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });

    const timer = setTimeout(() => {
      cleanup();
      const msg = `在 ${location.href} 等待 ${selector} 超时，已超过 ${timeout}ms`;
      console.error(LOG_PREFIX, msg);
      reject(new Error(msg));
    }, timeout);

    const pollStop = () => {
      if (settled) return;
      if (flowStopped) {
        cleanup();
        reject(new Error(STOP_ERROR_MESSAGE));
        return;
      }
      stopTimer = setTimeout(pollStop, 100);
    };
    pollStop();
  });
}

/**
 * Wait for an element matching a text pattern among multiple candidates.
 * @param {string} containerSelector - Selector for candidate elements
 * @param {RegExp} textPattern - Regex to match against textContent
 * @param {number} timeout - Max wait time in ms
 * @returns {Promise<Element>}
 */
function waitForElementByText(containerSelector, textPattern, timeout = 10000) {
  return new Promise((resolve, reject) => {
    throwIfStopped();

    function search() {
      const candidates = document.querySelectorAll(containerSelector);
      for (const el of candidates) {
        if (textPattern.test(el.textContent)) {
          return el;
        }
      }
      return null;
    }

    const existing = search();
    if (existing) {
      console.log(LOG_PREFIX, `立即按文本找到元素: ${containerSelector} 匹配 ${textPattern}`);
      log(`已按文本找到元素：${textPattern}`);
      resolve(existing);
      return;
    }

    console.log(LOG_PREFIX, `等待文本匹配: ${containerSelector} / ${textPattern}`);
    log(`正在等待包含文本的元素：${textPattern}...`);

    let settled = false;
    let stopTimer = null;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(stopTimer);
    };

    const observer = new MutationObserver(() => {
      if (flowStopped) {
        cleanup();
        reject(new Error(STOP_ERROR_MESSAGE));
        return;
      }
      const el = search();
      if (el) {
        cleanup();
        console.log(LOG_PREFIX, `等待后按文本找到元素: ${textPattern}`);
        log(`已按文本找到元素：${textPattern}`);
        resolve(el);
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });

    const timer = setTimeout(() => {
      cleanup();
      const msg = `在 ${location.href} 的 ${containerSelector} 中等待文本 "${textPattern}" 超时，已超过 ${timeout}ms`;
      console.error(LOG_PREFIX, msg);
      reject(new Error(msg));
    }, timeout);

    const pollStop = () => {
      if (settled) return;
      if (flowStopped) {
        cleanup();
        reject(new Error(STOP_ERROR_MESSAGE));
        return;
      }
      stopTimer = setTimeout(pollStop, 100);
    };
    pollStop();
  });
}

/**
 * React-compatible form filling.
 * Sets value via native setter and dispatches input + change events.
 * @param {HTMLInputElement} el
 * @param {string} value
 */
function fillInput(el, value) {
  throwIfStopped();
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  ).set;
  nativeInputValueSetter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  console.log(LOG_PREFIX, `已填写输入框 ${el.name || el.id || el.type}: ${value}`);
  log(`已填写输入框 [${el.name || el.id || el.type || '未知'}]`);
}

/**
 * Fill a select element by setting its value and triggering change.
 * @param {HTMLSelectElement} el
 * @param {string} value
 */
function fillSelect(el, value) {
  throwIfStopped();
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  console.log(LOG_PREFIX, `已在 ${el.name || el.id} 中选择值: ${value}`);
  log(`已选择 [${el.name || el.id || '未知'}] = ${value}`);
}

/**
 * Send a log message to Side Panel via Background.
 * @param {string} message
 * @param {string} level - 'info' | 'ok' | 'warn' | 'error'
 */
function log(message, level = 'info') {
  chrome.runtime.sendMessage(withCurrentCommandContext({
    type: 'LOG',
    source: SCRIPT_SOURCE,
    step: null,
    payload: { message, level, timestamp: Date.now() },
    error: null,
  }));
}

function formatDebugLogValue(value, maxLength = 500) {
  try {
    const json = JSON.stringify(value);
    if (!json) return '';
    return json.length > maxLength ? `${json.slice(0, maxLength - 3)}...` : json;
  } catch (err) {
    return String(err?.message || err || value).slice(0, maxLength);
  }
}

function debugLog(message, details) {
  if (details === undefined) {
    console.log(LOG_PREFIX, `[DEBUG] ${message}`);
    log(`[调试] ${message}`);
    return;
  }

  console.log(LOG_PREFIX, `[DEBUG] ${message}`, details);
  const formatted = formatDebugLogValue(details);
  log(`[调试] ${message}${formatted ? `｜${formatted}` : ''}`);
}

function collectButtonDebugInfo(limit = 10) {
  return Array.from(document.querySelectorAll('button, a, [role="button"]'))
    .map((el, index) => ({
      index,
      tag: el.tagName,
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      aria: (el.getAttribute('aria-label') || '').trim().slice(0, 80),
      title: (el.getAttribute('title') || '').trim().slice(0, 80),
      className: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
    }))
    .filter((item) => item.text || item.aria || item.title)
    .slice(0, limit);
}

function collectTextEmailDebugInfo(limit = 10) {
  const text = document.body?.innerText || '';
  const matches = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/ig) || [];
  return [...new Set(matches.map((value) => String(value || '').trim().toLowerCase()))].slice(0, limit);
}

function collectFieldDebugInfo(limit = 10) {
  return Array.from(document.querySelectorAll('input, textarea, [data-email], [data-address], [data-testid]'))
    .map((el, index) => ({
      index,
      tag: el.tagName,
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      id: el.getAttribute('id') || '',
      value: String(el.value || el.getAttribute('value') || '').trim().slice(0, 120),
      dataEmail: String(el.getAttribute('data-email') || '').trim().slice(0, 120),
      dataAddress: String(el.getAttribute('data-address') || '').trim().slice(0, 120),
      testid: String(el.getAttribute('data-testid') || '').trim().slice(0, 120),
    }))
    .filter((item) => item.value || item.dataEmail || item.dataAddress || item.testid)
    .slice(0, limit);
}

function reportTrace(kind, payload = {}) {
  chrome.runtime.sendMessage(withCurrentCommandContext({
    type: 'TRACE_EVENT',
    source: SCRIPT_SOURCE,
    step: null,
    payload: {
      kind,
      url: location.href,
      title: document.title || '',
      timestamp: Date.now(),
      ...payload,
    },
    error: null,
  })).catch(() => {});
}

/**
 * Report that this content script is loaded and ready.
 */
function reportReady() {
  console.log(LOG_PREFIX, '内容脚本已就绪');
  const message = {
    type: 'CONTENT_SCRIPT_READY',
    source: SCRIPT_SOURCE,
    step: null,
    payload: {},
    error: null,
  };
  Promise.resolve(chrome.runtime.sendMessage(message))
    .then((response) => {
      console.log(LOG_PREFIX, 'CONTENT_SCRIPT_READY sent successfully', { response, url: location.href });
    })
    .catch((err) => {
      console.error(LOG_PREFIX, 'CONTENT_SCRIPT_READY send failed', err?.message || err, { url: location.href });
    });
}

/**
 * Report step completion.
 * @param {number} step
 * @param {Object} data - Step output data
 */
function reportComplete(step, data = {}) {
  console.log(LOG_PREFIX, `步骤 ${step} 已完成`, data);
  log(`步骤 ${step} 已成功完成`, 'ok');
  const message = withCurrentCommandContext({
    type: 'STEP_COMPLETE',
    source: SCRIPT_SOURCE,
    step,
    payload: data,
    error: null,
  });
  Promise.resolve(chrome.runtime.sendMessage(message))
    .then((response) => {
      console.log(LOG_PREFIX, `STEP_COMPLETE sent successfully for step ${step}`, {
        response,
        url: location.href,
        payloadKeys: Object.keys(data || {}),
      });
    })
    .catch((err) => {
      console.error(LOG_PREFIX, `STEP_COMPLETE send failed for step ${step}`, err?.message || err, {
        url: location.href,
        payloadKeys: Object.keys(data || {}),
      });
    });
}

/**
 * Report step error.
 * @param {number} step
 * @param {string} errorMessage
 */
function reportError(step, errorMessage) {
  console.error(LOG_PREFIX, `步骤 ${step} 失败: ${errorMessage}`);
  log(`步骤 ${step} 失败：${errorMessage}`, 'error');
  const message = withCurrentCommandContext({
    type: 'STEP_ERROR',
    source: SCRIPT_SOURCE,
    step,
    payload: {},
    error: errorMessage,
  });
  Promise.resolve(chrome.runtime.sendMessage(message))
    .then((response) => {
      console.log(LOG_PREFIX, `STEP_ERROR sent successfully for step ${step}`, {
        response,
        url: location.href,
        errorMessage,
      });
    })
    .catch((err) => {
      console.error(LOG_PREFIX, `STEP_ERROR send failed for step ${step}`, err?.message || err, {
        url: location.href,
        errorMessage,
      });
    });
}

/**
 * Simulate a click with proper event dispatching.
 * @param {Element} el
 */
function simulateClick(el) {
  throwIfStopped();
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  console.log(LOG_PREFIX, `已点击: ${el.tagName} ${el.textContent?.slice(0, 30) || ''}`);
  log(`已点击 [${el.tagName}] "${el.textContent?.trim().slice(0, 30) || ''}"`);
}

/**
 * Wait a specified number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    function tick() {
      if (flowStopped) {
        reject(new Error(STOP_ERROR_MESSAGE));
        return;
      }
      if (Date.now() - start >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(100, Math.max(25, ms - (Date.now() - start))));
    }

    tick();
  });
}

async function humanPause(min = 250, max = 850) {
  const duration = Math.floor(Math.random() * (max - min + 1)) + min;
  await sleep(duration);
}

// Auto-report ready on load
// Skip ready signal from child iframes of mail pages to avoid overwriting the top frame's registration
const _isMailChildFrame = (SCRIPT_SOURCE === 'qq-mail' || SCRIPT_SOURCE === 'mail-163') && window !== window.top;
if (!_isMailChildFrame) {
  reportReady();
}
