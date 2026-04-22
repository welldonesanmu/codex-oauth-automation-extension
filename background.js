// background.js — Service Worker: orchestration, state, tab management, message routing

importScripts('data/names.js');
importScripts('data/step-definitions.js');

const LOG_PREFIX = '[MultiPage:bg]';
const DUCK_AUTOFILL_URL = 'https://duckduckgo.com/email/settings/autofill';
const SIMPLELOGIN_APP_URL = 'https://app.simplelogin.io/dashboard/';
const ADDY_APP_URL = 'https://app.addy.io/aliases';
const EMAIL_GENERATION_SERVICE_DEFAULT = 'duckmail';
const EMAIL_GENERATION_SERVICES = ['duckmail', 'simplelogin', 'addy'];
const STOP_ERROR_MESSAGE = '流程已被用户停止。';
const HUMAN_STEP_DELAY_MIN = 700;
const HUMAN_STEP_DELAY_MAX = 2200;
const STEP8_RESTART_MAX_ROUNDS = 8;
const SHARED_STEP_DEFINITIONS = self.MultiPageStepDefinitions?.getSteps?.() || [];
const STEP_IDS = SHARED_STEP_DEFINITIONS
  .map((definition) => Number(definition?.id))
  .filter(Number.isFinite)
  .sort((left, right) => left - right);
const MAX_FLOW_STEP = STEP_IDS[STEP_IDS.length - 1] || 10;
const FINAL_OAUTH_CHAIN_START_STEP = 7;
const STEP_DEFAULT_STATUSES = Object.fromEntries(STEP_IDS.map((stepId) => [stepId, 'pending']));
const PRE_LOGIN_COOKIE_CLEAR_DOMAINS = [
  'chatgpt.com',
  'chat.openai.com',
  'openai.com',
  'auth.openai.com',
  'auth0.openai.com',
  'accounts.openai.com',
];
const PRE_LOGIN_COOKIE_CLEAR_ORIGINS = [
  'https://chatgpt.com',
  'https://chat.openai.com',
  'https://auth.openai.com',
  'https://auth0.openai.com',
  'https://accounts.openai.com',
  'https://openai.com',
];
const STEP6_PRE_LOGIN_COOKIE_CLEAR_DELAY_MS = 6000;

initializeSessionStorageAccess();

// ============================================================
// 状态管理（chrome.storage.session + chrome.storage.local）
// ============================================================

const PERSISTED_SETTING_DEFAULTS = {
  vpsUrl: '',
  vpsPassword: '',
  customPassword: '',
  autoRunSkipFailures: false,
  mailProvider: '163',
  emailGenerationService: EMAIL_GENERATION_SERVICE_DEFAULT,
};

const PERSISTED_SETTING_KEYS = Object.keys(PERSISTED_SETTING_DEFAULTS);

const DEFAULT_STATE = {
  currentStep: 0, // 当前流程执行到的步骤编号。
  stepStatuses: { ...STEP_DEFAULT_STATUSES },
  oauthUrl: null, // 运行时抓取到的 OAuth 地址，不要手动预填。
  oauthSourceTabId: null, // 产生当前 OAuth 链路的 CPA 标签页。
  email: null, // 运行时邮箱，由程序自动获取并写入，不能手动预填。
  password: null, // 运行时实际密码，由 customPassword 或程序自动生成后写入。
  accounts: [], // 已生成账号记录：{ email, password, createdAt }。
  lastEmailTimestamp: null, // 最近一次获取到邮箱数据的运行时时间戳。
  lastSignupCode: null, // 注册验证码，运行时由程序自动读取并写入。
  lastLoginCode: null, // 登录验证码，运行时由程序自动读取并写入。
  localhostUrl: null, // 运行时捕获到的 localhost 回调地址，不要手动预填。
  authPageState: null, // 记录认证页当前已知的终态：logged_in_home / consent / callback。
  flowStartTime: null, // 当前流程开始时间。
  tabRegistry: {}, // 程序维护的标签页注册表。
  sourceLastUrls: {}, // 各来源页面最近一次打开的地址记录。
  logs: [], // 侧边栏展示的运行日志。
  ...PERSISTED_SETTING_DEFAULTS, // 合并 chrome.storage.local 中持久化保存的用户配置。
  autoRunning: false, // 当前是否处于自动运行中。
  autoRunPhase: 'idle', // 当前自动运行阶段。
  autoRunCurrentRun: 0, // 自动运行当前执行到第几轮。
  autoRunTotalRuns: 1, // 自动运行计划总轮数。
  autoRunAttemptRun: 0, // 当前轮次的重试序号。
};

async function getPersistedSettings() {
  const stored = await chrome.storage.local.get(PERSISTED_SETTING_KEYS);
  return {
    ...PERSISTED_SETTING_DEFAULTS,
    ...stored,
    autoRunSkipFailures: Boolean(stored.autoRunSkipFailures ?? PERSISTED_SETTING_DEFAULTS.autoRunSkipFailures),
  };
}

async function getState() {
  const [state, persistedSettings] = await Promise.all([
    chrome.storage.session.get(null),
    getPersistedSettings(),
  ]);
  return { ...DEFAULT_STATE, ...persistedSettings, ...state };
}

async function initializeSessionStorageAccess() {
  try {
    if (chrome.storage?.session?.setAccessLevel) {
      await chrome.storage.session.setAccessLevel({
        accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
      });
      console.log(LOG_PREFIX, 'Enabled storage.session for content scripts');
    }
  } catch (err) {
    console.warn(LOG_PREFIX, 'Failed to enable storage.session for content scripts:', err?.message || err);
  }
}

async function setState(updates) {
  console.log(LOG_PREFIX, 'storage.set:', JSON.stringify(updates).slice(0, 200));
  await chrome.storage.session.set(updates);
}

async function setPersistentSettings(updates) {
  const persistedUpdates = {};
  for (const key of PERSISTED_SETTING_KEYS) {
    if (updates[key] !== undefined) {
      persistedUpdates[key] = key === 'autoRunSkipFailures'
        ? Boolean(updates[key])
        : updates[key];
    }
  }

  if (Object.keys(persistedUpdates).length > 0) {
    await chrome.storage.local.set(persistedUpdates);
  }
}

function broadcastDataUpdate(payload) {
  chrome.runtime.sendMessage({
    type: 'DATA_UPDATED',
    payload,
  }).catch(() => { });
}

async function setEmailState(email) {
  await setState({ email });
  broadcastDataUpdate({ email });
  if (email) {
    await resumeAutoRunIfWaitingForEmail();
  }
}

async function setPasswordState(password) {
  await setState({ password });
  broadcastDataUpdate({ password });
}

async function resetState() {
  console.log(LOG_PREFIX, 'Resetting all state');
  // Preserve settings and persistent data across resets
  const [prev, persistedSettings] = await Promise.all([
    chrome.storage.session.get([
      'seenCodes',
      'accounts',
      'tabRegistry',
      'sourceLastUrls',
    ]),
    getPersistedSettings(),
  ]);
  await chrome.storage.session.clear();
  await chrome.storage.session.set({
    ...DEFAULT_STATE,
    ...persistedSettings,
    seenCodes: prev.seenCodes || [],
    accounts: prev.accounts || [],
    tabRegistry: prev.tabRegistry || {},
    sourceLastUrls: prev.sourceLastUrls || {},
  });
}

/**
 * Generate a random password: 14 chars, mix of uppercase, lowercase, digits, symbols.
 */
function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*?';
  const all = upper + lower + digits + symbols;

  // Ensure at least one of each type
  let pw = '';
  pw += upper[Math.floor(Math.random() * upper.length)];
  pw += lower[Math.floor(Math.random() * lower.length)];
  pw += digits[Math.floor(Math.random() * digits.length)];
  pw += symbols[Math.floor(Math.random() * symbols.length)];

  // Fill remaining 10 chars
  for (let i = 0; i < 10; i++) {
    pw += all[Math.floor(Math.random() * all.length)];
  }

  // Shuffle
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

// ============================================================
// Tab Registry
// ============================================================

async function getTabRegistry() {
  const state = await getState();
  return state.tabRegistry || {};
}

async function registerTab(source, tabId) {
  const registry = await getTabRegistry();
  registry[source] = { tabId, ready: true };
  await setState({ tabRegistry: registry });
  console.log(LOG_PREFIX, `Tab registered: ${source} -> ${tabId}`);
}

async function isTabAlive(source) {
  const registry = await getTabRegistry();
  const entry = registry[source];
  if (!entry) return false;
  try {
    await chrome.tabs.get(entry.tabId);
    return true;
  } catch {
    // Tab no longer exists — clean up registry
    registry[source] = null;
    await setState({ tabRegistry: registry });
    return false;
  }
}

async function getTabId(source) {
  const registry = await getTabRegistry();
  return registry[source]?.tabId || null;
}

function parseUrlSafely(rawUrl) {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function isSignupPageHost(hostname = '') {
  return ['auth0.openai.com', 'auth.openai.com', 'accounts.openai.com', 'chatgpt.com'].includes(hostname);
}

function is163MailHost(hostname = '') {
  return hostname === 'mail.163.com'
    || hostname.endsWith('.mail.163.com');
}

function isLocalhostOAuthCallbackUrl(rawUrl) {
  const parsed = parseUrlSafely(rawUrl);
  if (!parsed) return false;
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (!['localhost', '127.0.0.1', '192.168.2.1'].includes(parsed.hostname)) return false;
  if (parsed.pathname !== '/auth/callback') return false;

  const code = (parsed.searchParams.get('code') || '').trim();
  const state = (parsed.searchParams.get('state') || '').trim();
  return Boolean(code && state);
}

function buildLocalhostCleanupPrefix(rawUrl) {
  if (!isLocalhostOAuthCallbackUrl(rawUrl)) return '';

  const parsed = parseUrlSafely(rawUrl);
  return parsed ? `${parsed.origin}/auth` : '';
}

function normalizeEmailGenerationService(service) {
  const value = String(service || '').trim().toLowerCase();
  return EMAIL_GENERATION_SERVICES.includes(value) ? value : EMAIL_GENERATION_SERVICE_DEFAULT;
}

function getEmailGenerationServiceLabel(service) {
  const normalized = normalizeEmailGenerationService(service);
  if (normalized === 'simplelogin') return 'SimpleLogin';
  if (normalized === 'addy') return 'Addy.io';
  return 'Duck 邮箱';
}

function isDuckMailGenerationService(service) {
  return normalizeEmailGenerationService(service) === 'duckmail';
}

function getEmailGenerationServiceConfig(service) {
  const normalized = normalizeEmailGenerationService(service);
  if (normalized === 'simplelogin') {
    return {
      service: normalized,
      source: 'simplelogin-mail',
      url: SIMPLELOGIN_APP_URL,
      label: 'SimpleLogin',
      logLabel: 'SimpleLogin',
    };
  }
  if (normalized === 'addy') {
    return {
      service: normalized,
      source: 'addy-mail',
      url: ADDY_APP_URL,
      label: 'Addy.io',
      logLabel: 'Addy.io',
    };
  }
  return {
    service: 'duckmail',
    source: 'duck-mail',
    url: DUCK_AUTOFILL_URL,
    label: 'Duck 邮箱',
    logLabel: 'Duck 邮箱',
  };
}

function matchesSourceUrlFamily(source, candidateUrl, referenceUrl) {
  const candidate = parseUrlSafely(candidateUrl);
  if (!candidate) return false;

  const reference = parseUrlSafely(referenceUrl);

  switch (source) {
    case 'signup-page':
      return isSignupPageHost(candidate.hostname);
    case 'duck-mail':
      return candidate.hostname === 'duckduckgo.com' && candidate.pathname.startsWith('/email/');
    case 'simplelogin-mail':
      return candidate.hostname === 'app.simplelogin.io' && candidate.pathname.startsWith('/dashboard');
    case 'addy-mail':
      return candidate.hostname === 'app.addy.io' && candidate.pathname.startsWith('/aliases');
    case 'qq-mail':
      return candidate.hostname === 'mail.qq.com' || candidate.hostname === 'wx.mail.qq.com';
    case 'mail-163':
      return is163MailHost(candidate.hostname);
    case 'vps-panel':
      return Boolean(reference)
        && candidate.origin === reference.origin
        && candidate.pathname === reference.pathname;
    default:
      return false;
  }
}

async function rememberSourceLastUrl(source, url) {
  if (!source || !url) return;
  const state = await getState();
  const sourceLastUrls = { ...(state.sourceLastUrls || {}) };
  sourceLastUrls[source] = url;
  await setState({ sourceLastUrls });
}

async function closeConflictingTabsForSource(source, currentUrl, options = {}) {
  const { excludeTabIds = [] } = options;
  const excluded = new Set(excludeTabIds.filter(id => Number.isInteger(id)));
  const state = await getState();
  const lastUrl = state.sourceLastUrls?.[source];
  const referenceUrls = [currentUrl, lastUrl].filter(Boolean);

  if (!referenceUrls.length) return;

  const tabs = await chrome.tabs.query({});
  const matchedIds = tabs
    .filter((tab) => Number.isInteger(tab.id) && !excluded.has(tab.id))
    .filter((tab) => referenceUrls.some((refUrl) => matchesSourceUrlFamily(source, tab.url, refUrl)))
    .map(tab => tab.id);

  if (!matchedIds.length) return;

  await chrome.tabs.remove(matchedIds).catch(() => { });

  const registry = await getTabRegistry();
  if (registry[source]?.tabId && matchedIds.includes(registry[source].tabId)) {
    registry[source] = null;
    await setState({ tabRegistry: registry });
  }

  await addLog(`已关闭 ${matchedIds.length} 个旧的${getSourceLabel(source)}标签页。`, 'info');
}

async function closeTabsByUrlPrefix(prefix, options = {}) {
  if (!prefix) return 0;

  const { excludeTabIds = [] } = options;
  const excluded = new Set(excludeTabIds.filter(id => Number.isInteger(id)));
  const tabs = await chrome.tabs.query({});
  const matchedIds = tabs
    .filter((tab) => Number.isInteger(tab.id) && !excluded.has(tab.id))
    .filter((tab) => typeof tab.url === 'string' && tab.url.startsWith(prefix))
    .map((tab) => tab.id);

  if (!matchedIds.length) return 0;

  await chrome.tabs.remove(matchedIds).catch(() => { });
  await addLog(`已关闭 ${matchedIds.length} 个匹配 ${prefix} 的 localhost 残留标签页。`, 'info');
  return matchedIds.length;
}

async function pingContentScriptOnTab(tabId) {
  if (!Number.isInteger(tabId)) return null;

  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: 'PING',
      source: 'background',
      payload: {},
    });
  } catch {
    return null;
  }
}

async function waitForTabUrlFamily(source, tabId, referenceUrl, options = {}) {
  const { timeoutMs = 15000, retryDelayMs = 400 } = options;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (matchesSourceUrlFamily(source, tab.url, referenceUrl)) {
        return tab;
      }
    } catch {
      return null;
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  return null;
}

async function ensureContentScriptReadyOnTab(source, tabId, options = {}) {
  const {
    inject = null,
    injectSource = null,
    timeoutMs = 30000,
    retryDelayMs = 700,
    logMessage = '',
  } = options;

  const start = Date.now();
  let lastError = null;
  let logged = false;
  let attempt = 0;

  console.log(
    LOG_PREFIX,
    `[ensureContentScriptReadyOnTab] start ${source} tab=${tabId}, timeout=${timeoutMs}ms, inject=${Array.isArray(inject) ? inject.join(',') : 'none'}`
  );

  while (Date.now() - start < timeoutMs) {
    attempt += 1;
    const pong = await pingContentScriptOnTab(tabId);
    if (pong?.ok && (!pong.source || pong.source === source)) {
      console.log(
        LOG_PREFIX,
        `[ensureContentScriptReadyOnTab] ready ${source} tab=${tabId} on attempt ${attempt} after ${Date.now() - start}ms`
      );
      await registerTab(source, tabId);
      return;
    }

    if (!inject || !inject.length) {
      if (logMessage && !logged) {
        console.warn(
          LOG_PREFIX,
          `[ensureContentScriptReadyOnTab] ${source} tab=${tabId} still not ready after ${Date.now() - start}ms`
        );
        await addLog(logMessage, 'warn');
        logged = true;
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      continue;
    }

    const registry = await getTabRegistry();
    if (registry[source]) {
      registry[source].ready = false;
      await setState({ tabRegistry: registry });
    }

    try {
      if (injectSource) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (injectedSource) => {
            window.__MULTIPAGE_SOURCE = injectedSource;
          },
          args: [injectSource],
        });
      }

      await chrome.scripting.executeScript({
        target: { tabId },
        files: inject,
      });
    } catch (err) {
      lastError = err;
      console.warn(
        LOG_PREFIX,
        `[ensureContentScriptReadyOnTab] inject attempt ${attempt} failed for ${source} tab=${tabId}: ${err?.message || err}`
      );
    }

    const pongAfterInject = await pingContentScriptOnTab(tabId);
    if (pongAfterInject?.ok && (!pongAfterInject.source || pongAfterInject.source === source)) {
      console.log(
        LOG_PREFIX,
        `[ensureContentScriptReadyOnTab] ready after inject ${source} tab=${tabId} on attempt ${attempt} after ${Date.now() - start}ms`
      );
      await registerTab(source, tabId);
      return;
    }

    if (logMessage && !logged) {
      console.warn(
        LOG_PREFIX,
        `[ensureContentScriptReadyOnTab] ${source} tab=${tabId} still not ready after ${Date.now() - start}ms`
      );
      await addLog(logMessage, 'warn');
      logged = true;
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  throw lastError || new Error(`${getSourceLabel(source)} 内容脚本长时间未就绪。`);
}

// ============================================================
// Command Queue (for content scripts not yet ready)
// ============================================================

const pendingCommands = new Map(); // source -> { message, resolve, reject, timer }

function getContentScriptResponseTimeoutMs(message) {
  if (!message || typeof message !== 'object') {
    return 30000;
  }

  if (message.type === 'POLL_EMAIL') {
    const maxAttempts = Math.max(1, Number(message.payload?.maxAttempts) || 1);
    const intervalMs = Math.max(0, Number(message.payload?.intervalMs) || 0);
    return Math.max(45000, maxAttempts * intervalMs + 25000);
  }

  if (message.type === 'FILL_CODE') {
    return Number(message.step) === 8 ? 45000 : 30000;
  }

  if (message.type === 'PREPARE_SIGNUP_VERIFICATION') {
    return 45000;
  }

  if (message.type === 'EXECUTE_STEP' && Number(message.step) === 2) {
    return 45000;
  }

  if (message.type === 'FETCH_GENERATED_EMAIL' || message.type === 'FETCH_DUCK_EMAIL') {
    return message.payload?.generateNew === false ? 45000 : 90000;
  }

  return 30000;
}

function getMessageDebugLabel(source, message, tabId = null) {
  const parts = [source || 'unknown', message?.type || 'UNKNOWN'];
  if (Number.isInteger(message?.step)) {
    parts.push(`step=${message.step}`);
  }
  if (Number.isInteger(tabId)) {
    parts.push(`tab=${tabId}`);
  }
  return parts.join(' ');
}

function summarizeMessageResultForDebug(result) {
  if (result === undefined) return 'undefined';
  if (result === null) return 'null';
  if (typeof result !== 'object') return JSON.stringify(result);

  const summary = {};
  for (const key of ['ok', 'error', 'stopped', 'source', 'step']) {
    if (key in result) summary[key] = result[key];
  }
  if (result.payload && typeof result.payload === 'object') {
    summary.payloadKeys = Object.keys(result.payload);
  }
  return JSON.stringify(summary);
}

function sendTabMessageWithTimeout(tabId, source, message, responseTimeoutMs = getContentScriptResponseTimeoutMs(message)) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const startedAt = Date.now();
    const debugLabel = getMessageDebugLabel(source, message, tabId);

    console.log(LOG_PREFIX, `[sendTabMessageWithTimeout] dispatch ${debugLabel}, timeout=${responseTimeoutMs}ms`);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const seconds = Math.ceil(responseTimeoutMs / 1000);
      console.warn(LOG_PREFIX, `[sendTabMessageWithTimeout] timeout ${debugLabel} after ${Date.now() - startedAt}ms`);
      reject(new Error(`Content script on ${source} did not respond in ${seconds}s. Try refreshing the tab and retry.`));
    }, responseTimeoutMs);

    chrome.tabs.sendMessage(tabId, message)
      .then((value) => {
        const elapsed = Date.now() - startedAt;
        if (settled) {
          console.warn(
            LOG_PREFIX,
            `[sendTabMessageWithTimeout] late response ignored for ${debugLabel} after ${elapsed}ms: ${summarizeMessageResultForDebug(value)}`
          );
          return;
        }

        settled = true;
        clearTimeout(timer);
        console.log(
          LOG_PREFIX,
          `[sendTabMessageWithTimeout] response ${debugLabel} after ${elapsed}ms: ${summarizeMessageResultForDebug(value)}`
        );
        resolve(value);
      })
      .catch((error) => {
        const elapsed = Date.now() - startedAt;
        const errorMessage = error?.message || String(error);
        if (settled) {
          console.warn(
            LOG_PREFIX,
            `[sendTabMessageWithTimeout] late rejection ignored for ${debugLabel} after ${elapsed}ms: ${errorMessage}`
          );
          return;
        }

        settled = true;
        clearTimeout(timer);
        console.warn(
          LOG_PREFIX,
          `[sendTabMessageWithTimeout] rejection ${debugLabel} after ${elapsed}ms: ${errorMessage}`
        );
        reject(error);
      });
  });
}

function queueCommand(source, message, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(source);
      const err = `Content script on ${source} did not respond in ${timeout / 1000}s. Try refreshing the tab and retry.`;
      console.error(LOG_PREFIX, err);
      reject(new Error(err));
    }, timeout);
    pendingCommands.set(source, { message, resolve, reject, timer });
    console.log(LOG_PREFIX, `Command queued for ${source} (waiting for ready)`);
  });
}

function flushCommand(source, tabId) {
  const pending = pendingCommands.get(source);
  if (pending) {
    clearTimeout(pending.timer);
    pendingCommands.delete(source);
    sendTabMessageWithTimeout(tabId, source, pending.message).then(pending.resolve).catch(pending.reject);
    console.log(LOG_PREFIX, `Flushed queued command to ${source} (tab ${tabId})`);
  }
}

function cancelPendingCommands(reason = STOP_ERROR_MESSAGE) {
  for (const [source, pending] of pendingCommands.entries()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    pendingCommands.delete(source);
    console.log(LOG_PREFIX, `Cancelled queued command for ${source}`);
  }
}

// ============================================================
// Reuse or create tab
// ============================================================

async function reuseOrCreateTab(source, url, options = {}) {
  const shouldActivate = options.activate !== false;
  const alive = await isTabAlive(source);
  if (alive) {
    const tabId = await getTabId(source);
    await closeConflictingTabsForSource(source, url, { excludeTabIds: [tabId] });
    const currentTab = await chrome.tabs.get(tabId);
    const sameUrl = currentTab.url === url;
    const shouldReloadOnReuse = sameUrl && options.reloadIfSameUrl;

    const registry = await getTabRegistry();
    if (sameUrl) {
      if (shouldActivate) {
        await chrome.tabs.update(tabId, { active: true });
      }
      console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}) on same URL`);

      if (shouldReloadOnReuse) {
        if (registry[source]) registry[source].ready = false;
        await setState({ tabRegistry: registry });
        await chrome.tabs.reload(tabId);

        await new Promise((resolve) => {
          const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
          const listener = (tid, info) => {
            if (tid === tabId && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              clearTimeout(timer);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
        });
      }

      // For dynamically injected pages like the VPS panel, re-inject immediately.
      if (options.inject) {
        if (registry[source]) registry[source].ready = false;
        await setState({ tabRegistry: registry });
        if (options.injectSource) {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (injectedSource) => {
              window.__MULTIPAGE_SOURCE = injectedSource;
            },
            args: [options.injectSource],
          });
        }
        await chrome.scripting.executeScript({
          target: { tabId },
          files: options.inject,
        });
        await new Promise(r => setTimeout(r, 500));
      }

      await rememberSourceLastUrl(source, url);
      return tabId;
    }

    // Mark as not ready BEFORE navigating — so READY signal from new page is captured correctly
    if (registry[source]) registry[source].ready = false;
    await setState({ tabRegistry: registry });

    // Navigate existing tab to new URL
    await chrome.tabs.update(tabId, shouldActivate ? { url, active: true } : { url });
    console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}), navigated to ${url.slice(0, 60)}`);

    // Wait for page load complete (with 30s timeout)
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tid, info) => {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    // If dynamic injection needed (VPS panel), re-inject after navigation
    if (options.inject) {
      if (options.injectSource) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (injectedSource) => {
            window.__MULTIPAGE_SOURCE = injectedSource;
          },
          args: [options.injectSource],
        });
      }
      await chrome.scripting.executeScript({
        target: { tabId },
        files: options.inject,
      });
    }

    // Wait a bit for content script to inject and send READY
    await new Promise(r => setTimeout(r, 500));

    await rememberSourceLastUrl(source, url);
    return tabId;
  }

  // Create new tab
  await closeConflictingTabsForSource(source, url);
  const tab = await chrome.tabs.create({ url, active: shouldActivate });
  console.log(LOG_PREFIX, `Created new tab ${source} (${tab.id})`);

  // If dynamic injection needed (VPS panel), inject scripts after load
  if (options.inject) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    if (options.injectSource) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (injectedSource) => {
          window.__MULTIPAGE_SOURCE = injectedSource;
        },
        args: [options.injectSource],
      });
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: options.inject,
    });
  }

  await rememberSourceLastUrl(source, url);
  return tab.id;
}

// ============================================================
// Send command to content script (with readiness check)
// ============================================================

async function sendToContentScript(source, message, options = {}) {
  const messageWithSession = withActiveAutoRunAttemptSession(message);
  const { responseTimeoutMs = getContentScriptResponseTimeoutMs(messageWithSession) } = options;
  const registry = await getTabRegistry();
  const entry = registry[source];

  if (!entry || !entry.ready) {
    console.log(LOG_PREFIX, `${source} not ready, queuing command`);
    return queueCommand(source, messageWithSession, Math.max(15000, responseTimeoutMs));
  }

  // Verify tab is still alive
  const alive = await isTabAlive(source);
  if (!alive) {
    // Tab was closed — queue the command, it will be sent when tab is reopened
    console.log(LOG_PREFIX, `${source} tab was closed, queuing command`);
    return queueCommand(source, messageWithSession, Math.max(15000, responseTimeoutMs));
  }

  console.log(LOG_PREFIX, `Sending to ${source} (tab ${entry.tabId}):`, messageWithSession.type);
  return sendTabMessageWithTimeout(entry.tabId, source, messageWithSession, responseTimeoutMs);
}

async function sendToContentScriptResilient(source, message, options = {}) {
  const {
    timeoutMs = 30000,
    retryDelayMs = 600,
    logMessage = '',
    responseTimeoutMs,
    reinjectOnRetry = null,
  } = options;
  const start = Date.now();
  let lastError = null;
  let logged = false;
  let attempt = 0;
  const debugLabel = getMessageDebugLabel(source, message);

  console.log(
    LOG_PREFIX,
    `[sendToContentScriptResilient] start ${debugLabel}, totalTimeout=${timeoutMs}ms, retryDelay=${retryDelayMs}ms`
  );

  while (Date.now() - start < timeoutMs) {
    throwIfStopped();
    attempt += 1;

    try {
      console.log(
        LOG_PREFIX,
        `[sendToContentScriptResilient] attempt ${attempt} -> ${debugLabel}, elapsed=${Date.now() - start}ms`
      );
      const result = await sendToContentScript(
        source,
        message,
        Number.isFinite(responseTimeoutMs) ? { responseTimeoutMs } : {}
      );
      console.log(
        LOG_PREFIX,
        `[sendToContentScriptResilient] success ${debugLabel} on attempt ${attempt} after ${Date.now() - start}ms`
      );
      return result;
    } catch (err) {
      const retryable = isRetryableContentScriptTransportError(err);
      console.warn(
        LOG_PREFIX,
        `[sendToContentScriptResilient] attempt ${attempt} failed for ${debugLabel}, retryable=${retryable}, elapsed=${Date.now() - start}ms: ${err?.message || err}`
      );
      if (!retryable) {
        throw err;
      }

      lastError = err;
      if (logMessage && !logged) {
        await addLog(logMessage, 'warn');
        logged = true;
      }

      if (reinjectOnRetry?.url && Array.isArray(reinjectOnRetry.inject) && reinjectOnRetry.inject.length) {
        try {
          await reuseOrCreateTab(source, reinjectOnRetry.url, {
            inject: reinjectOnRetry.inject,
            injectSource: reinjectOnRetry.injectSource,
            reloadIfSameUrl: true,
            activate: reinjectOnRetry.activate !== false,
          });
        } catch (reinjectError) {
          console.warn(
            LOG_PREFIX,
            `[sendToContentScriptResilient] reinject failed for ${debugLabel}: ${reinjectError?.message || reinjectError}`
          );
        }
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw lastError || new Error(`等待 ${getSourceLabel(source)} 重新就绪超时。`);
}

async function sendToMailContentScriptResilient(mail, message, options = {}) {
  const defaultResponseTimeoutMs = getContentScriptResponseTimeoutMs(message);
  const responseTimeoutMs = Math.max(1000, Number(options.responseTimeoutMs) || defaultResponseTimeoutMs);
  const timeoutMs = Math.max(
    responseTimeoutMs,
    Number(options.timeoutMs) || (responseTimeoutMs + VERIFICATION_MAIL_RECOVERY_GRACE_MS)
  );
  const maxRecoveryAttempts = Math.max(0, Number(options.maxRecoveryAttempts) || 2);
  const start = Date.now();
  let lastError = null;
  let recoveries = 0;
  let logged = false;

  while (Date.now() - start < timeoutMs) {
    throwIfStopped();

    try {
      return await sendToContentScript(mail.source, message, { responseTimeoutMs });
    } catch (err) {
      if (!isRetryableContentScriptTransportError(err)) {
        throw err;
      }

      lastError = err;
      if (!logged) {
        await addLog(`步骤 ${message.step}：${mail.label} 页面通信异常，正在尝试让邮箱页重新就绪...`, 'warn');
        logged = true;
      }

      if (recoveries >= maxRecoveryAttempts) {
        break;
      }

      recoveries += 1;
      await reuseOrCreateTab(mail.source, mail.url, {
        inject: mail.inject,
        injectSource: mail.injectSource,
        reloadIfSameUrl: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }

  throw lastError || new Error(`${mail.label} 页面未能重新就绪。`);
}

// ============================================================
// Logging
// ============================================================

function bumpAutoRunSessionId() {
  autoRunSessionId += 1;
  return autoRunSessionId;
}

function isCurrentAutoRunSession(sessionId) {
  return sessionId === autoRunSessionId;
}

function bumpAutoRunAttemptSessionId() {
  autoRunAttemptSessionId += 1;
  activeAutoRunAttemptSessionId = autoRunAttemptSessionId;
  return activeAutoRunAttemptSessionId;
}

function clearActiveAutoRunAttemptSession() {
  activeAutoRunAttemptSessionId = null;
}

function isCurrentAutoRunAttemptSession(sessionId) {
  return Number.isInteger(sessionId)
    && Number.isInteger(activeAutoRunAttemptSessionId)
    && sessionId === activeAutoRunAttemptSessionId;
}

function shouldIgnoreAutoRunAttemptMessage(message) {
  return Number.isInteger(message?.autoRunAttemptId)
    && !isCurrentAutoRunAttemptSession(message.autoRunAttemptId);
}

function withActiveAutoRunAttemptSession(message) {
  if (!Number.isInteger(activeAutoRunAttemptSessionId)) {
    return message;
  }
  return {
    ...message,
    autoRunAttemptId: activeAutoRunAttemptSessionId,
  };
}

async function addLog(message, level = 'info') {
  const state = await getState();
  const logs = state.logs || [];
  const entry = { message, level, timestamp: Date.now() };
  logs.push(entry);
  // Keep last 500 logs
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  await setState({ logs });
  // Broadcast to side panel
  chrome.runtime.sendMessage({ type: 'LOG_ENTRY', payload: entry }).catch(() => { });
}

function getSourceLabel(source) {
  const labels = {
    'sidepanel': '侧边栏',
    'signup-page': '认证页',
    'vps-panel': 'CPA 面板',
    'qq-mail': 'QQ 邮箱',
    'mail-163': '163 邮箱',
    'duck-mail': 'Duck 邮箱',
    'simplelogin-mail': 'SimpleLogin',
    'addy-mail': 'Addy.io',
  };
  return labels[source] || source || '未知来源';
}

// ============================================================
// Step Status Management
// ============================================================

async function setStepStatus(step, status) {
  const state = await getState();
  const statuses = { ...state.stepStatuses };
  statuses[step] = status;
  await setState({ stepStatuses: statuses, currentStep: step });
  // Broadcast to side panel
  chrome.runtime.sendMessage({
    type: 'STEP_STATUS_CHANGED',
    payload: { step, status },
  }).catch(() => { });
}

function isStopError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return message === STOP_ERROR_MESSAGE;
}

function isRetryableContentScriptTransportError(error) {
  const message = String(typeof error === 'string' ? error : error?.message || '');
  return /back\/forward cache|message channel is closed|Receiving end does not exist|port closed before a response was received|A listener indicated an asynchronous response|did not respond in \d+s/i.test(message);
}

function getErrorMessage(error) {
  return String(typeof error === 'string' ? error : error?.message || '');
}

function isVerificationMailPollingError(error) {
  const message = getErrorMessage(error);
  return /未在 .*邮箱中找到新的匹配邮件|邮箱轮询结束，但未获取到验证码|无法获取新的(?:注册|登录)验证码|页面未能重新就绪|页面通信异常|did not respond in \d+s/i.test(message);
}

function isRestartCurrentAttemptError(error) {
  const message = String(typeof error === 'string' ? error : error?.message || '');
  return /当前邮箱已存在，需要重新开始新一轮|当前流程已进入手机号页面，需要重新开始新一轮|邮箱自动获取失败，需要重新开始新一轮|认证页进入了手机号页面|点击“继续”后页面跳到了手机号页面|当前页面已进入手机号页面，不是 OAuth 授权同意页/.test(message);
}

function isStep10OAuthTimeoutError(error) {
  const message = String(typeof error === 'string' ? error : error?.message || '');
  return /STEP9_OAUTH_TIMEOUT::|STEP10_OAUTH_TIMEOUT::|认证失败:\s*Timeout waiting for OAuth callback/i.test(message);
}

function isStepDoneStatus(status) {
  return status === 'completed' || status === 'manual_completed' || status === 'skipped';
}

function getFirstUnfinishedStep(statuses = {}) {
  for (const step of STEP_IDS) {
    if (!isStepDoneStatus(statuses[step] || 'pending')) {
      return step;
    }
  }
  return null;
}

function hasSavedProgress(statuses = {}) {
  return Object.values({ ...STEP_DEFAULT_STATUSES, ...statuses }).some((status) => status !== 'pending');
}

function getDownstreamStateResets(step) {
  if (step <= 1) {
    return {
      oauthUrl: null,
      oauthSourceTabId: null,
      flowStartTime: null,
      password: null,
      lastEmailTimestamp: null,
      lastSignupCode: null,
      lastLoginCode: null,
      localhostUrl: null,
      authPageState: null,
    };
  }
  if (step === 2) {
    return {
      password: null,
      lastEmailTimestamp: null,
      lastSignupCode: null,
      lastLoginCode: null,
      localhostUrl: null,
      authPageState: null,
      oauthSourceTabId: null,
    };
  }
  if (step === 3 || step === 4) {
    return {
      lastEmailTimestamp: null,
      lastSignupCode: null,
      lastLoginCode: null,
      localhostUrl: null,
      authPageState: null,
      oauthSourceTabId: null,
    };
  }
  if (step >= 5 && step <= 8) {
    return {
      lastLoginCode: null,
      localhostUrl: null,
      authPageState: null,
      oauthSourceTabId: null,
    };
  }
  if (step === 9) {
    return {
      localhostUrl: null,
      authPageState: null,
      oauthSourceTabId: null,
    };
  }
  return {};
}

async function invalidateDownstreamAfterStepRestart(step, options = {}) {
  const { logLabel = `步骤 ${step} 重新执行` } = options;
  const state = await getState();
  const statuses = { ...(state.stepStatuses || {}) };
  const changedSteps = [];

  for (let downstream = step + 1; downstream <= MAX_FLOW_STEP; downstream++) {
    if (statuses[downstream] !== 'pending') {
      statuses[downstream] = 'pending';
      changedSteps.push(downstream);
    }
  }

  if (changedSteps.length) {
    await setState({ stepStatuses: statuses });
    for (const downstream of changedSteps) {
      chrome.runtime.sendMessage({
        type: 'STEP_STATUS_CHANGED',
        payload: { step: downstream, status: 'pending' },
      }).catch(() => { });
    }
    await addLog(`${logLabel}，已重置后续步骤状态：${changedSteps.join(', ')}`, 'warn');
  }

  const resets = getDownstreamStateResets(step);
  if (Object.keys(resets).length) {
    await setState(resets);
    broadcastDataUpdate(resets);
  }
}

function clearStopRequest() {
  stopRequested = false;
}

function getAutoRunStatusPayload(phase, payload = {}) {
  const currentRun = payload.currentRun ?? autoRunCurrentRun;
  const totalRuns = payload.totalRuns ?? autoRunTotalRuns;
  const attemptRun = payload.attemptRun ?? autoRunAttemptRun;
  const autoRunning = phase === 'running' || phase === 'waiting_email' || phase === 'retrying';

  return {
    autoRunning,
    autoRunPhase: phase,
    autoRunCurrentRun: currentRun,
    autoRunTotalRuns: totalRuns,
    autoRunAttemptRun: attemptRun,
  };
}

async function broadcastAutoRunStatus(phase, payload = {}) {
  const statusPayload = {
    phase,
    currentRun: payload.currentRun ?? autoRunCurrentRun,
    totalRuns: payload.totalRuns ?? autoRunTotalRuns,
    attemptRun: payload.attemptRun ?? autoRunAttemptRun,
  };

  await setState(getAutoRunStatusPayload(phase, statusPayload));
  chrome.runtime.sendMessage({
    type: 'AUTO_RUN_STATUS',
    payload: statusPayload,
  }).catch(() => { });
}

function isAutoRunLockedState(state) {
  return Boolean(state.autoRunning) && (state.autoRunPhase === 'running' || state.autoRunPhase === 'retrying');
}

function isAutoRunPausedState(state) {
  return Boolean(state.autoRunning) && state.autoRunPhase === 'waiting_email';
}

async function ensureManualInteractionAllowed(actionLabel) {
  const state = await getState();

  if (isAutoRunLockedState(state)) {
    throw new Error(`自动流程运行中，请先停止后再${actionLabel}。`);
  }
  if (isAutoRunPausedState(state)) {
    throw new Error(`自动流程当前已暂停。请点击“继续”，或先确认接管自动流程后再${actionLabel}。`);
  }

  return state;
}

async function skipStep(step) {
  const state = await ensureManualInteractionAllowed('跳过步骤');

  if (!Number.isInteger(step) || step < 1 || step > 9) {
    throw new Error(`无效步骤：${step}`);
  }

  const statuses = { ...(state.stepStatuses || {}) };
  const currentStatus = statuses[step];
  if (currentStatus === 'running') {
    throw new Error(`步骤 ${step} 正在运行中，不能跳过。`);
  }
  if (isStepDoneStatus(currentStatus)) {
    throw new Error(`步骤 ${step} 已完成，无需再跳过。`);
  }

  if (step > 1) {
    const prevStatus = statuses[step - 1];
    if (!isStepDoneStatus(prevStatus)) {
      throw new Error(`请先完成步骤 ${step - 1}，再跳过步骤 ${step}。`);
    }
  }

  await setStepStatus(step, 'skipped');
  await addLog(`步骤 ${step} 已跳过`, 'warn');

  return { ok: true, step, status: 'skipped' };
}

function throwIfStopped() {
  if (stopRequested) {
    throw new Error(STOP_ERROR_MESSAGE);
  }
}

async function sleepWithStop(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    throwIfStopped();
    await new Promise(r => setTimeout(r, Math.min(100, ms - (Date.now() - start))));
  }
}

async function humanStepDelay(min = HUMAN_STEP_DELAY_MIN, max = HUMAN_STEP_DELAY_MAX) {
  const duration = Math.floor(Math.random() * (max - min + 1)) + min;
  await sleepWithStop(duration);
}

async function clickWithDebugger(tabId, rect) {
  if (!tabId) {
    throw new Error('未找到用于调试点击的认证页面标签页。');
  }
  if (!rect || !Number.isFinite(rect.centerX) || !Number.isFinite(rect.centerY)) {
    throw new Error('步骤 9 的调试器兜底点击需要有效的按钮坐标。');
  }

  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    throw new Error(
      `步骤 9 的调试器兜底点击附加失败：${err.message}。` +
      '如果认证页标签已打开 DevTools，请先关闭后重试。'
    );
  }

  try {
    const x = Math.round(rect.centerX);
    const y = Math.round(rect.centerY);

    await chrome.debugger.sendCommand(target, 'Page.bringToFront');
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
      clickCount: 0,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  } finally {
    await chrome.debugger.detach(target).catch(() => { });
  }
}

async function broadcastStopToContentScripts() {
  const registry = await getTabRegistry();
  for (const entry of Object.values(registry)) {
    if (!entry?.tabId) continue;
    try {
      await chrome.tabs.sendMessage(entry.tabId, withActiveAutoRunAttemptSession({
        type: 'STOP_FLOW',
        source: 'background',
        payload: {},
      }));
    } catch { }
  }
}

async function clearTabRegistrySources(sources = []) {
  const uniqueSources = [...new Set(sources.filter(Boolean))];
  if (!uniqueSources.length) return;
  const registry = await getTabRegistry();
  let changed = false;
  for (const source of uniqueSources) {
    if (registry[source]) {
      registry[source] = null;
      changed = true;
    }
  }
  if (changed) {
    await setState({ tabRegistry: registry });
  }
}

async function abandonCurrentAutoRunAttempt({ targetRun, totalRuns, attemptRun, reason, mailSource }) {
  cancelPendingCommands(reason || '当前尝试已放弃。');
  await broadcastStopToContentScripts();
  await markRunningStepsStopped();

  const state = await getState();
  const sourcesToClose = ['signup-page'];
  if (mailSource) {
    sourcesToClose.push(mailSource);
  }

  for (const source of sourcesToClose) {
    const tabId = await getTabId(source);
    if (tabId) {
      await chrome.tabs.remove(tabId).catch(() => { });
    }
  }

  const signupReferenceUrl = state.oauthUrl || state.sourceLastUrls?.['signup-page'] || 'https://auth.openai.com/';
  await closeConflictingTabsForSource('signup-page', signupReferenceUrl).catch(() => { });

  if (mailSource) {
    const mail = getMailConfig(state);
    if (!mail.error && mail.source === mailSource && mail.url) {
      await closeConflictingTabsForSource(mailSource, mail.url).catch(() => { });
    }
  }

  await clearTabRegistrySources(sourcesToClose);
  clearActiveAutoRunAttemptSession();
  await broadcastAutoRunStatus('retrying', {
    currentRun: targetRun,
    totalRuns,
    attemptRun,
  });
}

let stopRequested = false;

// ============================================================
// Message Handler (central router)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(LOG_PREFIX, `Received: ${message.type} from ${message.source || 'sidepanel'}`, message);

  handleMessage(message, sender).then(response => {
    sendResponse(response);
  }).catch(err => {
    console.error(LOG_PREFIX, 'Handler error:', err);
    sendResponse({ error: err.message });
  });

  return true; // async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'CONTENT_SCRIPT_READY': {
      const tabId = sender.tab?.id;
      if (tabId && message.source) {
        await registerTab(message.source, tabId);
        flushCommand(message.source, tabId);
        await addLog(`内容脚本已就绪：${getSourceLabel(message.source)}（标签页 ${tabId}）`);
      }
      return { ok: true };
    }

    case 'LOG': {
      if (shouldIgnoreAutoRunAttemptMessage(message)) {
        console.log(LOG_PREFIX, `Ignored stale LOG from ${message.source}`, message);
        return { ok: true, ignored: true };
      }
      const { message: msg, level } = message.payload;
      await addLog(`[${getSourceLabel(message.source)}] ${msg}`, level);
      return { ok: true };
    }

    case 'TRACE_EVENT': {
      if (shouldIgnoreAutoRunAttemptMessage(message)) {
        console.log(LOG_PREFIX, `Ignored stale TRACE_EVENT from ${message.source}`, message);
        return { ok: true, ignored: true };
      }
      const { kind, url, title, note, step, entries, detail } = message.payload || {};
      const parts = [
        `[追踪:${message.source}] ${kind || 'unknown'}`,
        step ? `step=${step}` : '',
        note || '',
        title ? `title=${String(title).replace(/\s+/g, ' ').trim().slice(0, 80)}` : '',
        url ? `url=${String(url).slice(0, 180)}` : '',
        detail ? `detail=${String(detail).replace(/\s+/g, ' ').trim().slice(0, 180)}` : '',
        Array.isArray(entries) && entries.length ? `entries=${entries.join(' || ').slice(0, 700)}` : '',
      ].filter(Boolean);
      await addLog(parts.join(' | '), kind === 'add_phone_detected' ? 'warn' : 'info');
      return { ok: true };
    }

    case 'STEP_COMPLETE': {
      if (shouldIgnoreAutoRunAttemptMessage(message)) {
        console.log(LOG_PREFIX, `Ignored stale STEP_COMPLETE for step ${message.step} from ${message.source}`, message);
        return { ok: true, ignored: true };
      }
      if (stopRequested) {
        await setStepStatus(message.step, 'stopped');
        notifyStepError(message.step, STOP_ERROR_MESSAGE);
        return { ok: true };
      }
      await setStepStatus(message.step, 'completed');
      await addLog(`步骤 ${message.step} 已完成`, 'ok');
      await handleStepData(message.step, message.payload);
      notifyStepComplete(message.step, message.payload);
      return { ok: true };
    }

    case 'STEP_ERROR': {
      if (shouldIgnoreAutoRunAttemptMessage(message)) {
        console.log(LOG_PREFIX, `Ignored stale STEP_ERROR for step ${message.step} from ${message.source}`, message);
        return { ok: true, ignored: true };
      }
      if (isStopError(message.error)) {
        await setStepStatus(message.step, 'stopped');
        await addLog(`步骤 ${message.step} 已被用户停止`, 'warn');
        notifyStepError(message.step, message.error);
      } else {
        await setStepStatus(message.step, 'failed');
        await addLog(`步骤 ${message.step} 失败：${message.error}`, 'error');
        notifyStepError(message.step, message.error);
      }
      return { ok: true };
    }

    case 'GET_STATE': {
      return await getState();
    }

    case 'RESET': {
      clearStopRequest();
      await resetState();
      await addLog('流程已重置', 'info');
      return { ok: true };
    }

    case 'EXECUTE_STEP': {
      clearStopRequest();
      if (message.source === 'sidepanel') {
        await ensureManualInteractionAllowed('手动执行步骤');
      }
      const step = message.payload.step;
      if (message.source === 'sidepanel') {
        await invalidateDownstreamAfterStepRestart(step, { logLabel: `步骤 ${step} 重新执行` });
      }
      // Save email if provided (from side panel step 3)
      if (message.payload.email) {
        await setEmailState(message.payload.email);
      }
      await executeStep(step);
      return { ok: true };
    }

    case 'AUTO_RUN': {
      clearStopRequest();
      const totalRuns = message.payload?.totalRuns || 1;
      const autoRunSkipFailures = Boolean(message.payload?.autoRunSkipFailures);
      const mode = message.payload?.mode === 'continue' ? 'continue' : 'restart';
      const emailGenerationService = normalizeEmailGenerationService(message.payload?.emailGenerationService);
      await setPersistentSettings({ autoRunSkipFailures, emailGenerationService });
      await setState({ autoRunSkipFailures, emailGenerationService });
      autoRunLoop(totalRuns, { autoRunSkipFailures, mode });  // fire-and-forget
      return { ok: true };
    }

    case 'RESUME_AUTO_RUN': {
      clearStopRequest();
      if (message.payload.email) {
        await setEmailState(message.payload.email);
      }
      resumeAutoRun();  // fire-and-forget
      return { ok: true };
    }

    case 'TAKEOVER_AUTO_RUN': {
      await requestStop({ logMessage: '已确认手动接管，正在停止自动流程并切换为手动控制...' });
      await addLog('自动流程已切换为手动控制。', 'warn');
      return { ok: true };
    }

    case 'SKIP_STEP': {
      const step = Number(message.payload?.step);
      return await skipStep(step);
    }

    case 'SAVE_SETTING': {
      const updates = {};
      if (message.payload.vpsUrl !== undefined) updates.vpsUrl = message.payload.vpsUrl;
      if (message.payload.vpsPassword !== undefined) updates.vpsPassword = message.payload.vpsPassword;
      if (message.payload.customPassword !== undefined) updates.customPassword = message.payload.customPassword;
      if (message.payload.autoRunSkipFailures !== undefined) updates.autoRunSkipFailures = Boolean(message.payload.autoRunSkipFailures);
      if (message.payload.mailProvider !== undefined) updates.mailProvider = message.payload.mailProvider;
      if (message.payload.emailGenerationService !== undefined) updates.emailGenerationService = normalizeEmailGenerationService(message.payload.emailGenerationService);
      await setPersistentSettings(updates);
      await setState(updates);
      return { ok: true };
    }

    // Side panel data updates
    case 'SAVE_EMAIL': {
      const state = await getState();
      if (isAutoRunLockedState(state)) {
        throw new Error('自动流程运行中，当前不能手动修改邮箱。');
      }
      await setEmailState(message.payload.email);
      await resumeAutoRun();
      return { ok: true, email: message.payload.email };
    }

    case 'DEBUGGER_CLICK_CURRENT_TAB': {
      const tabId = sender.tab?.id;
      const rect = message.payload?.rect;
      if (!tabId) {
        throw new Error('当前消息未附带邮箱标签页。');
      }
      if (!rect || !Number.isFinite(rect.centerX) || !Number.isFinite(rect.centerY)) {
        throw new Error('缺少有效的点击坐标。');
      }

      await chrome.tabs.update(tabId, { active: true });
      await clickWithDebugger(tabId, rect);
      return { ok: true };
    }

    case 'FETCH_GENERATED_EMAIL':
    case 'FETCH_DUCK_EMAIL': {
      clearStopRequest();
      const state = await getState();
      if (isAutoRunLockedState(state)) {
        throw new Error('自动流程运行中，当前不能手动获取邮箱。');
      }
      const email = await fetchGeneratedEmail(message.payload || {});
      await resumeAutoRun();
      return { ok: true, email };
    }

    case 'STOP_FLOW': {
      await requestStop();
      return { ok: true };
    }

    default:
      console.warn(LOG_PREFIX, `Unknown message type: ${message.type}`);
      return { error: `Unknown message type: ${message.type}` };
  }
}

// ============================================================
// Step Data Handlers
// ============================================================

async function handleStepData(step, payload) {
  switch (step) {
    case 1:
      if (payload.oauthUrl) {
        await setState({ oauthUrl: payload.oauthUrl });
        broadcastDataUpdate({ oauthUrl: payload.oauthUrl });
      }
      break;
    case 2:
    case 3:
      if (payload.email) await setEmailState(payload.email);
      break;
    case 4:
      if (payload.emailTimestamp) await setState({ lastEmailTimestamp: payload.emailTimestamp });
      break;
    case 5:
    case 7:
    case 8: {
      const updates = {};
      if (payload.localhostUrl) {
        if (!isLocalhostOAuthCallbackUrl(payload.localhostUrl)) {
          throw new Error(`步骤 ${step} 返回了无效的 localhost OAuth 回调地址。`);
        }
        updates.localhostUrl = payload.localhostUrl;
        updates.authPageState = 'callback';
      } else if (payload.skippedDirectToConsent) {
        updates.authPageState = 'consent';
      } else if (payload.loggedInHome) {
        updates.authPageState = 'logged_in_home';
      }

      if (Object.keys(updates).length) {
        await setState(updates);
        if (updates.localhostUrl) {
          broadcastDataUpdate({ localhostUrl: updates.localhostUrl });
        }
      }
      break;
    }
    case 9:
      if (payload.localhostUrl) {
        if (!isLocalhostOAuthCallbackUrl(payload.localhostUrl)) {
          throw new Error('步骤 9 返回了无效的 localhost OAuth 回调地址。');
        }
        await setState({ localhostUrl: payload.localhostUrl, authPageState: 'callback' });
        broadcastDataUpdate({ localhostUrl: payload.localhostUrl });
      }
      break;
    case 10: {
      const localhostPrefix = buildLocalhostCleanupPrefix(payload.localhostUrl);
      if (localhostPrefix) {
        await closeTabsByUrlPrefix(localhostPrefix);
      }
      break;
    }
  }
}

// ============================================================
// Step Completion Waiting
// ============================================================

// Map of step -> { resolve, reject } for waiting on step completion
const stepWaiters = new Map();
let resumeWaiter = null;
const AUTO_RUN_SIGNAL_COMPLETION_TIMEOUT_MS = 120000;
const AUTO_RUN_BACKGROUND_COMPLETED_STEPS = new Set([4, 6, 8, 9]);

function waitForStepComplete(step, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    throwIfStopped();
    if (stepWaiters.has(step)) {
      console.warn(LOG_PREFIX, `[waitForStepComplete] replacing existing waiter for step ${step}`);
    }
    console.log(LOG_PREFIX, `[waitForStepComplete] register step ${step}, timeout=${timeoutMs}ms`);
    const timer = setTimeout(() => {
      stepWaiters.delete(step);
      console.warn(LOG_PREFIX, `[waitForStepComplete] timeout for step ${step} after ${timeoutMs}ms`);
      reject(new Error(`Step ${step} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    stepWaiters.set(step, {
      resolve: (data) => { clearTimeout(timer); stepWaiters.delete(step); resolve(data); },
      reject: (err) => { clearTimeout(timer); stepWaiters.delete(step); reject(err); },
    });
  });
}

function notifyStepComplete(step, payload) {
  const waiter = stepWaiters.get(step);
  console.log(LOG_PREFIX, `[notifyStepComplete] step ${step}, hasWaiter=${Boolean(waiter)}`);
  if (waiter) waiter.resolve(payload);
}

function notifyStepError(step, error) {
  const waiter = stepWaiters.get(step);
  console.warn(LOG_PREFIX, `[notifyStepError] step ${step}, hasWaiter=${Boolean(waiter)}, error=${error}`);
  if (waiter) waiter.reject(new Error(error));
}

async function completeStepFromBackground(step, payload = {}) {
  if (stopRequested) {
    await setStepStatus(step, 'stopped');
    notifyStepError(step, STOP_ERROR_MESSAGE);
    return;
  }

  await setStepStatus(step, 'completed');
  await addLog(`步骤 ${step} 已完成`, 'ok');
  await handleStepData(step, payload);
  notifyStepComplete(step, payload);
}

async function markRunningStepsStopped() {
  const state = await getState();
  const runningSteps = Object.entries(state.stepStatuses || {})
    .filter(([, status]) => status === 'running')
    .map(([step]) => Number(step));

  for (const step of runningSteps) {
    await setStepStatus(step, 'stopped');
  }
}

async function requestStop(options = {}) {
  const { logMessage = '已收到停止请求，正在取消当前操作...' } = options;
  if (stopRequested) return;

  stopRequested = true;
  cancelPendingCommands();
  if (webNavListener) {
    chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
    webNavListener = null;
  }

  await addLog(logMessage, 'warn');
  await broadcastStopToContentScripts();

  for (const waiter of stepWaiters.values()) {
    waiter.reject(new Error(STOP_ERROR_MESSAGE));
  }
  stepWaiters.clear();

  if (resumeWaiter) {
    resumeWaiter.reject(new Error(STOP_ERROR_MESSAGE));
    resumeWaiter = null;
  }

  await markRunningStepsStopped();
  clearActiveAutoRunAttemptSession();
  autoRunActive = false;
  await broadcastAutoRunStatus('stopped', {
    currentRun: autoRunCurrentRun,
    totalRuns: autoRunTotalRuns,
    attemptRun: autoRunAttemptRun,
  });
}

// ============================================================
// Step Execution
// ============================================================

async function executeStep(step) {
  console.log(LOG_PREFIX, `Executing step ${step}`);
  throwIfStopped();
  await setStepStatus(step, 'running');
  await addLog(`步骤 ${step} 开始执行`);
  await humanStepDelay();

  const state = await getState();

  if (step === 1 && !state.flowStartTime) {
    await setState({ flowStartTime: Date.now() });
  }

  try {
    switch (step) {
      case 1: await executeStep1(state); break;
      case 2: await executeStep2(state); break;
      case 3: await executeStep3(state); break;
      case 4: await executeStep4(state); break;
      case 5: await executeStep5(state); break;
      case 6: await executeStep6(state); break;
      case 7: await executeStep7(state); break;
      case 8: await executeStep8(state); break;
      case 9: await executeStep9(state); break;
      case 10: await executeStep10(state); break;
      default:
        throw new Error(`未知步骤：${step}`);
    }
  } catch (err) {
    if (isStopError(err)) {
      await setStepStatus(step, 'stopped');
      await addLog(`步骤 ${step} 已被用户停止`, 'warn');
      throw err;
    }
    await setStepStatus(step, 'failed');
    await addLog(`步骤 ${step} 失败：${err.message}`, 'error');
    throw err;
  }
}

/**
 * Execute a step and wait for it to complete before returning.
 * @param {number} step
 * @param {number} delayAfter - ms to wait after completion (for page transitions)
 */
async function executeStepAndWait(step, delayAfter = 2000) {
  throwIfStopped();

  if (AUTO_RUN_BACKGROUND_COMPLETED_STEPS.has(step)) {
    await addLog(`自动运行：步骤 ${step} 由后台流程负责收尾，执行函数返回后将直接进入下一步。`, 'info');
    await executeStep(step);
    const latestState = await getState();
    await addLog(`自动运行：步骤 ${step} 已执行返回，当前状态为 ${latestState.stepStatuses?.[step] || 'pending'}，准备继续后续步骤。`, 'info');
  } else {
    await addLog(`自动运行：步骤 ${step} 已发起，正在等待完成信号（超时 ${AUTO_RUN_SIGNAL_COMPLETION_TIMEOUT_MS / 1000} 秒）。`, 'info');
    const completionResultPromise = waitForStepComplete(step, AUTO_RUN_SIGNAL_COMPLETION_TIMEOUT_MS).then(
      payload => ({ ok: true, payload }),
      error => ({ ok: false, error }),
    );

    try {
      await executeStep(step);
    } catch (err) {
      notifyStepError(step, getErrorMessage(err));
      await completionResultPromise;
      throw err;
    }

    const completionResult = await completionResultPromise;
    if (!completionResult.ok) {
      throw completionResult.error;
    }

    await addLog(`自动运行：步骤 ${step} 已收到完成信号，准备继续后续步骤。`, 'info');
  }

  // Extra delay for page transitions / DOM updates
  if (delayAfter > 0) {
    await sleepWithStop(delayAfter + Math.floor(Math.random() * 1200));
  }
}

async function fetchDuckEmail(options = {}) {
  return fetchGeneratedEmail({ ...options, service: 'duckmail' });
}

async function fetchGeneratedEmail(options = {}) {
  throwIfStopped();
  const state = await getState();
  const service = normalizeEmailGenerationService(options.service || state.emailGenerationService);
  const { generateNew = true } = options;

  if (isDuckMailGenerationService(service)) {
    await addLog(`Duck 邮箱：正在打开自动填充设置（${generateNew ? '生成新地址' : '复用当前地址'}）...`);
    await reuseOrCreateTab('duck-mail', DUCK_AUTOFILL_URL);

    const result = await sendToContentScript('duck-mail', {
      type: 'FETCH_DUCK_EMAIL',
      source: 'background',
      payload: { generateNew },
    }, {
      responseTimeoutMs: getContentScriptResponseTimeoutMs({ type: 'FETCH_DUCK_EMAIL', payload: { generateNew } }),
    });

    if (result?.error) {
      throw new Error(result.error);
    }
    if (!result?.email) {
      throw new Error('未返回 Duck 邮箱地址。');
    }

    await setEmailState(result.email);
    await addLog(`Duck 邮箱：${result.generated ? '已生成' : '已读取'} ${result.email}`, 'ok');
    return result.email;
  }

  const config = getEmailGenerationServiceConfig(service);
  await addLog(`${config.logLabel}：正在打开页面（${generateNew ? '生成新地址' : '读取当前地址'}）...`);
  await reuseOrCreateTab(config.source, config.url);

  const result = await sendToContentScript(config.source, {
    type: 'FETCH_GENERATED_EMAIL',
    source: 'background',
    payload: { generateNew, service },
  }, {
    responseTimeoutMs: getContentScriptResponseTimeoutMs({ type: 'FETCH_GENERATED_EMAIL', payload: { generateNew } }),
  });

  if (result?.error) {
    throw new Error(result.error);
  }
  if (!result?.email) {
    throw new Error(`未返回 ${config.label} 邮箱地址。`);
  }

  await setEmailState(result.email);
  await addLog(`${config.logLabel}：${result.generated ? '已生成' : '已读取'} ${result.email}`, 'ok');
  return result.email;
}

// ============================================================
// Auto Run Flow
// ============================================================

let autoRunActive = false;
let autoRunCurrentRun = 0;
let autoRunTotalRuns = 1;
let autoRunAttemptRun = 0;
let autoRunSessionId = 0;
let autoRunAttemptSessionId = 0;
let activeAutoRunAttemptSessionId = null;
const DUCK_EMAIL_MAX_ATTEMPTS = 5;
const VERIFICATION_POLL_MAX_ROUNDS = 5;
const VERIFICATION_MAIL_RECOVERY_GRACE_MS = 30000;
const GENERATED_EMAIL_RESTART_ERROR_MESSAGE = '邮箱自动获取失败，需要重新开始新一轮。';
const AUTO_STEP_DELAYS = {
  1: 2000,
  2: 2000,
  3: 3000,
  4: 2000,
  5: 3000,
  6: 1000,
  7: 3000,
  8: 2000,
  9: 2000,
  10: 1000,
};

async function resumeAutoRunIfWaitingForEmail(options = {}) {
  const { silent = false } = options;
  const state = await getState();
  if (!state.email || !isAutoRunPausedState(state)) {
    return false;
  }

  if (resumeWaiter) {
    if (!silent) {
      await addLog('邮箱已就绪，自动继续后续步骤...', 'info');
    }
    resumeWaiter.resolve();
    resumeWaiter = null;
    return true;
  }

  return false;
}

async function ensureAutoEmailReady(targetRun, totalRuns, attemptRuns) {
  const currentState = await getState();
  if (currentState.email) {
    return currentState.email;
  }

  const serviceLabel = getEmailGenerationServiceLabel(currentState.emailGenerationService);
  let lastGenerationError = null;
  for (let generationAttempt = 1; generationAttempt <= DUCK_EMAIL_MAX_ATTEMPTS; generationAttempt++) {
    try {
      if (generationAttempt > 1) {
        await addLog(`${serviceLabel}：正在进行第 ${generationAttempt}/${DUCK_EMAIL_MAX_ATTEMPTS} 次自动获取重试...`, 'warn');
      }
      const generatedEmail = await fetchGeneratedEmail({ generateNew: true, service: currentState.emailGenerationService });
      await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：${serviceLabel} 已就绪：${generatedEmail}（第 ${attemptRuns} 次尝试，获取第 ${generationAttempt}/${DUCK_EMAIL_MAX_ATTEMPTS} 次）===`, 'ok');
      return generatedEmail;
    } catch (err) {
      lastGenerationError = err;
      await addLog(`${serviceLabel} 自动获取失败（${generationAttempt}/${DUCK_EMAIL_MAX_ATTEMPTS}）：${err.message}`, 'warn');
    }
  }

  await addLog(`${serviceLabel} 自动获取已连续失败 ${DUCK_EMAIL_MAX_ATTEMPTS} 次：${lastGenerationError?.message || '未知错误'}`, 'error');
  throw new Error(GENERATED_EMAIL_RESTART_ERROR_MESSAGE);
}

async function runAutoSequenceFromStep(startStep, context = {}) {
  const { targetRun, totalRuns, attemptRuns, continued = false } = context;
  const maxStep10RestartAttempts = 5;
  let step10RestartAttempts = 0;

  if (continued) {
    await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：继续当前进度，从步骤 ${startStep} 开始（第 ${attemptRuns} 次尝试）===`, 'info');
  } else {
    await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：第 ${attemptRuns} 次尝试，阶段 1，打开 ChatGPT 官网并准备注册 ===`, 'info');
  }

  if (startStep <= 1) {
    await executeStepAndWait(1, AUTO_STEP_DELAYS[1]);
  }

  if (startStep <= 2) {
    await ensureAutoEmailReady(targetRun, totalRuns, attemptRuns);
    await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：阶段 2，进入注册流程并填写账号信息（第 ${attemptRuns} 次尝试）===`, 'info');
    await broadcastAutoRunStatus('running', {
      currentRun: targetRun,
      totalRuns,
      attemptRun: attemptRuns,
    });
    await executeStepAndWait(2, AUTO_STEP_DELAYS[2]);
    await executeStepAndWait(3, AUTO_STEP_DELAYS[3]);
  } else if (startStep === 3 && !continued) {
    await ensureAutoEmailReady(targetRun, totalRuns, attemptRuns);
    await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：阶段 2，填写密码并继续注册（第 ${attemptRuns} 次尝试）===`, 'info');
    await broadcastAutoRunStatus('running', {
      currentRun: targetRun,
      totalRuns,
      attemptRun: attemptRuns,
    });
    await executeStepAndWait(3, AUTO_STEP_DELAYS[3]);
  } else {
    await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：继续执行剩余流程（第 ${attemptRuns} 次尝试）===`, 'info');
  }

  const signupTabId = await getTabId('signup-page');
  if (signupTabId) {
    await chrome.tabs.update(signupTabId, { active: true });
  }

  let step = Math.max(startStep, 4);
  while (step <= MAX_FLOW_STEP) {
    try {
      await executeStepAndWait(step, AUTO_STEP_DELAYS[step]);
      step += 1;
    } catch (err) {
      if (step === 10 && isStep10OAuthTimeoutError(err) && step10RestartAttempts < maxStep10RestartAttempts) {
        step10RestartAttempts += 1;
        await addLog(
          `步骤 10：检测到 OAuth callback 超时，正在回到步骤 ${FINAL_OAUTH_CHAIN_START_STEP} 重新开始授权流程（${step10RestartAttempts}/${maxStep10RestartAttempts}）...`,
          'warn'
        );
        await invalidateDownstreamAfterStepRestart(FINAL_OAUTH_CHAIN_START_STEP, {
          logLabel: `步骤 10 超时后准备回到步骤 ${FINAL_OAUTH_CHAIN_START_STEP} 重试（${step10RestartAttempts}/${maxStep10RestartAttempts}）`,
        });
        step = FINAL_OAUTH_CHAIN_START_STEP;
        continue;
      }
      throw err;
    }
  }
}

// Outer loop: keep retrying until the target number of successful runs is reached.
async function autoRunLoop(totalRuns, options = {}) {
  if (autoRunActive) {
    await addLog('自动运行已在进行中', 'warn');
    return;
  }

  const sessionId = bumpAutoRunSessionId();
  clearStopRequest();
  autoRunActive = true;
  autoRunTotalRuns = totalRuns;
  autoRunCurrentRun = 0;
  autoRunAttemptRun = 0;
  const autoRunSkipFailures = Boolean(options.autoRunSkipFailures);
  const initialMode = options.mode === 'continue' ? 'continue' : 'restart';
  const resumeCurrentRun = Number.isInteger(options.resumeCurrentRun) ? options.resumeCurrentRun : 0;
  const resumeSuccessfulRuns = Number.isInteger(options.resumeSuccessfulRuns) ? options.resumeSuccessfulRuns : 0;
  const resumeAttemptRunsProcessed = Number.isInteger(options.resumeAttemptRunsProcessed) ? options.resumeAttemptRunsProcessed : 0;
  let maxAttempts = autoRunSkipFailures ? Math.max(totalRuns * 10, totalRuns + 20) : totalRuns;
  const forcedRetryCap = Math.max(totalRuns * 10, totalRuns + 20);
  let successfulRuns = Math.max(0, resumeSuccessfulRuns);
  let attemptRuns = Math.max(0, resumeAttemptRunsProcessed);
  let forceFreshTabsNextRun = false;
  let continueCurrentOnFirstAttempt = initialMode === 'continue';

  await setState({
    autoRunSkipFailures,
    ...getAutoRunStatusPayload('running', {
      currentRun: resumeCurrentRun,
      totalRuns,
      attemptRun: resumeAttemptRunsProcessed,
    }),
  });

  while (successfulRuns < totalRuns && attemptRuns < maxAttempts) {
    if (!isCurrentAutoRunSession(sessionId)) {
      return;
    }

    attemptRuns += 1;
    const targetRun = successfulRuns + 1;
    autoRunCurrentRun = targetRun;
    autoRunAttemptRun = attemptRuns;
    const attemptSessionId = bumpAutoRunAttemptSessionId();
    let startStep = 1;
    let useExistingProgress = false;

    if (continueCurrentOnFirstAttempt) {
      const currentState = await getState();
      const resumeStep = getFirstUnfinishedStep(currentState.stepStatuses);
      if (resumeStep && hasSavedProgress(currentState.stepStatuses)) {
        startStep = resumeStep;
        useExistingProgress = true;
      } else if (hasSavedProgress(currentState.stepStatuses)) {
        await addLog('当前流程已全部处理，将按“重新开始”新开一轮自动运行。', 'info');
      }
      continueCurrentOnFirstAttempt = false;
    }

    if (!useExistingProgress) {
      // Reset everything at the start of each fresh attempt (keep user settings).
      const prevState = await getState();
      const keepSettings = {
        vpsUrl: prevState.vpsUrl,
        vpsPassword: prevState.vpsPassword,
        customPassword: prevState.customPassword,
        autoRunSkipFailures: prevState.autoRunSkipFailures,
        mailProvider: prevState.mailProvider,
        emailGenerationService: prevState.emailGenerationService,
        ...getAutoRunStatusPayload('running', { currentRun: targetRun, totalRuns, attemptRun: attemptRuns }),
        ...(forceFreshTabsNextRun ? { tabRegistry: {} } : {}),
      };
      await resetState();
      await setState(keepSettings);
      chrome.runtime.sendMessage({ type: 'AUTO_RUN_RESET' }).catch(() => { });
      await sleepWithStop(500);
    } else {
      await setState({
        autoRunSkipFailures,
        ...getAutoRunStatusPayload('running', { currentRun: targetRun, totalRuns, attemptRun: attemptRuns }),
      });
    }

    if (forceFreshTabsNextRun) {
      await addLog(`兜底模式：上一轮已放弃，当前开始第 ${attemptRuns} 次尝试，将使用新线程继续补足第 ${targetRun}/${totalRuns} 轮。`, 'warn');
      forceFreshTabsNextRun = false;
    }

    try {
      throwIfStopped();
      await broadcastAutoRunStatus('running', {
        currentRun: targetRun,
        totalRuns,
        attemptRun: attemptRuns,
      });

      await runAutoSequenceFromStep(startStep, {
        targetRun,
        totalRuns,
        attemptRuns,
        continued: useExistingProgress,
      });

      successfulRuns += 1;
      autoRunCurrentRun = successfulRuns;
      clearActiveAutoRunAttemptSession();
      await addLog(`=== 目标 ${successfulRuns}/${totalRuns} 轮已完成（第 ${attemptRuns} 次尝试成功）===`, 'ok');
      continue;
    } catch (err) {
      if (!isCurrentAutoRunSession(sessionId)) {
        return;
      }

      if (isStopError(err)) {
        await addLog(`目标 ${targetRun}/${totalRuns} 轮已被用户停止`, 'warn');
        await broadcastAutoRunStatus('stopped', {
          currentRun: targetRun,
          totalRuns,
          attemptRun: attemptRuns,
        });
        break;
      }

      if (isRestartCurrentAttemptError(err)) {
        if (attemptSessionId !== activeAutoRunAttemptSessionId) {
          return;
        }
        const errorMessage = getErrorMessage(err);
        const restartReason = errorMessage.includes('手机号页面')
          ? '目标流程进入手机号页面'
          : (errorMessage.includes('邮箱自动获取失败')
            ? `${getEmailGenerationServiceLabel((await getState()).emailGenerationService)} 自动获取连续失败`
            : '检测到当前邮箱已存在');
        await addLog(`目标 ${targetRun}/${totalRuns} 轮${restartReason}，当前线程已放弃，将重新开始新一轮。`, 'warn');
        const mailSource = getMailConfig(await getState()).source;
        await abandonCurrentAutoRunAttempt({
          targetRun,
          totalRuns,
          attemptRun: attemptRuns,
          reason: `当前线程因${restartReason}而放弃。`,
          mailSource,
        });
        forceFreshTabsNextRun = true;
        maxAttempts = Math.max(maxAttempts, Math.min(forcedRetryCap, attemptRuns + 1));
        continue;
      }

      if (!autoRunSkipFailures) {
        await addLog(`目标 ${targetRun}/${totalRuns} 轮失败：${err.message}`, 'error');
        await broadcastAutoRunStatus('stopped', {
          currentRun: targetRun,
          totalRuns,
          attemptRun: attemptRuns,
        });
        break;
      }

      if (attemptSessionId !== activeAutoRunAttemptSessionId) {
        return;
      }
      await addLog(`目标 ${targetRun}/${totalRuns} 轮的第 ${attemptRuns} 次尝试失败：${err.message}`, 'error');
      await addLog('兜底开关已开启：将放弃当前线程，重新开一轮继续补足目标次数。', 'warn');
      const mailSource = getMailConfig(await getState()).source;
      await abandonCurrentAutoRunAttempt({
        targetRun,
        totalRuns,
        attemptRun: attemptRuns,
        reason: '当前尝试已放弃。',
        mailSource,
      });
      forceFreshTabsNextRun = true;
    }
  }

  if (!isCurrentAutoRunSession(sessionId)) {
    return;
  }

  clearActiveAutoRunAttemptSession();

  if (!stopRequested && autoRunSkipFailures && successfulRuns < totalRuns && attemptRuns >= maxAttempts) {
    await addLog(`已达到安全重试上限（${attemptRuns} 次尝试），当前仅完成 ${successfulRuns}/${totalRuns} 轮。`, 'error');
    await broadcastAutoRunStatus('stopped', {
      currentRun: successfulRuns,
      totalRuns: autoRunTotalRuns,
      attemptRun: attemptRuns,
    });
  } else if (stopRequested) {
    await addLog(`=== 已停止，完成 ${successfulRuns}/${autoRunTotalRuns} 轮，共尝试 ${attemptRuns} 次 ===`, 'warn');
    await broadcastAutoRunStatus('stopped', {
      currentRun: successfulRuns,
      totalRuns: autoRunTotalRuns,
      attemptRun: attemptRuns,
    });
  } else if (successfulRuns >= autoRunTotalRuns) {
    await addLog(`=== 全部 ${autoRunTotalRuns} 轮均已成功完成，共尝试 ${attemptRuns} 次 ===`, 'ok');
    await broadcastAutoRunStatus('complete', {
      currentRun: successfulRuns,
      totalRuns: autoRunTotalRuns,
      attemptRun: attemptRuns,
    });
  } else {
    await addLog(`=== 已停止，完成 ${successfulRuns}/${autoRunTotalRuns} 轮，共尝试 ${attemptRuns} 次 ===`, 'warn');
    await broadcastAutoRunStatus('stopped', {
      currentRun: successfulRuns,
      totalRuns: autoRunTotalRuns,
      attemptRun: attemptRuns,
    });
  }
  autoRunActive = false;
  autoRunAttemptRun = attemptRuns;
  await setState(getAutoRunStatusPayload(stopRequested ? 'stopped' : (successfulRuns >= autoRunTotalRuns ? 'complete' : 'stopped'), {
    currentRun: successfulRuns,
    totalRuns: autoRunTotalRuns,
    attemptRun: attemptRuns,
  }));
  clearStopRequest();
}

async function waitForResume() {
  throwIfStopped();
  const state = await getState();
  if (state.email) {
    await addLog('邮箱已就绪，自动继续后续步骤...', 'info');
    return;
  }

  return new Promise((resolve, reject) => {
    resumeWaiter = { resolve, reject };
  });
}

async function resumeAutoRun() {
  throwIfStopped();
  const state = await getState();
  if (!state.email) {
    await addLog('无法继续：当前没有邮箱地址，请先在侧边栏填写邮箱。', 'error');
    return false;
  }

  const resumedInMemory = await resumeAutoRunIfWaitingForEmail({ silent: true });
  if (resumedInMemory) {
    return true;
  }

  if (!isAutoRunPausedState(state)) {
    return false;
  }

  if (autoRunActive) {
    return false;
  }

  const totalRuns = state.autoRunTotalRuns || 1;
  const currentRun = state.autoRunCurrentRun || 1;
  const attemptRun = state.autoRunAttemptRun || 1;
  const successfulRuns = Math.max(0, currentRun - 1);

  await addLog('检测到自动流程暂停上下文已丢失，正在从当前进度恢复自动运行...', 'warn');
  autoRunLoop(totalRuns, {
    autoRunSkipFailures: Boolean(state.autoRunSkipFailures),
    mode: 'continue',
    resumeCurrentRun: currentRun,
    resumeSuccessfulRuns: successfulRuns,
    resumeAttemptRunsProcessed: Math.max(0, attemptRun - 1),
  });
  return true;
}

// ============================================================
// Step 1: Get OAuth Link (via vps-panel.js)
// ============================================================

async function requestFreshOAuthUrl(state, stepForLog = 7) {
  if (!state.vpsUrl) {
    throw new Error('尚未配置 CPA 地址，请先在侧边栏填写。');
  }

  await addLog(`步骤 ${stepForLog}：正在打开 CPA 面板并刷新 OAuth 链接...`);
  const injectFiles = ['content/utils.js', 'content/vps-panel.js'];
  let tabId = await getTabId('vps-panel');
  const alive = tabId && await isTabAlive('vps-panel');

  if (!alive) {
    tabId = await reuseOrCreateTab('vps-panel', state.vpsUrl, {
      inject: injectFiles,
      injectSource: 'vps-panel',
      reloadIfSameUrl: true,
      activate: false,
    });
  } else {
    await closeConflictingTabsForSource('vps-panel', state.vpsUrl, { excludeTabIds: [tabId] });
    tabId = await reuseOrCreateTab('vps-panel', state.vpsUrl, {
      inject: injectFiles,
      injectSource: 'vps-panel',
      reloadIfSameUrl: true,
      activate: false,
    });
  }

  const matchedTab = await waitForTabUrlFamily('vps-panel', tabId, state.vpsUrl, {
    timeoutMs: 15000,
    retryDelayMs: 400,
  });
  if (!matchedTab) {
    await addLog(`步骤 ${stepForLog}：CPA 页面尚未完全进入目标地址，继续尝试连接内容脚本...`, 'warn');
  }

  await ensureContentScriptReadyOnTab('vps-panel', tabId, {
    inject: injectFiles,
    injectSource: 'vps-panel',
    timeoutMs: 45000,
    retryDelayMs: 900,
    logMessage: `步骤 ${stepForLog}：CPA 面板仍在加载，正在重试连接内容脚本...`,
  });

  const result = await sendToContentScriptResilient('vps-panel', {
    type: 'FETCH_OAUTH_URL',
    step: stepForLog,
    source: 'background',
    payload: { vpsPassword: state.vpsPassword, step: stepForLog },
  }, {
    timeoutMs: 120000,
    responseTimeoutMs: 60000,
    retryDelayMs: 700,
    logMessage: `步骤 ${stepForLog}：CPA 面板通信未就绪，正在等待页面恢复...`,
    reinjectOnRetry: {
      url: state.vpsUrl,
      inject: injectFiles,
      injectSource: 'vps-panel',
      activate: false,
      reloadIfSameUrl: true,
    },
  });

  const oauthUrl = result?.oauthUrl;
  if (!oauthUrl) {
    throw new Error('刷新 OAuth 链接后仍未拿到可用链接。');
  }

  await setState({ oauthUrl, oauthSourceTabId: tabId, localhostUrl: null, authPageState: null });
  broadcastDataUpdate({ oauthUrl });
  return oauthUrl;
}

async function executeStep1() {
  const chatgptUrl = 'https://chatgpt.com/';
  await addLog('步骤 1：正在打开 ChatGPT 官网...');
  const tabId = await reuseOrCreateTab('signup-page', chatgptUrl);
  await ensureContentScriptReadyOnTab('signup-page', tabId, {
    timeoutMs: 30000,
    retryDelayMs: 600,
    logMessage: '步骤 1：ChatGPT 页面仍在加载，正在等待内容脚本就绪...',
  });

  const result = await sendToContentScriptResilient('signup-page', {
    type: 'ENSURE_SIGNUP_ENTRY_READY',
    step: 1,
    source: 'background',
    payload: { timeout: 20000 },
  }, {
    timeoutMs: 30000,
    retryDelayMs: 700,
    logMessage: '步骤 1：正在等待 ChatGPT 官网出现注册入口...',
  });

  if (result?.error) {
    throw new Error(result.error);
  }

  await completeStepFromBackground(1, {});
}

// ============================================================
// Step 2: Open Signup Page (Background opens tab, signup-page.js clicks Register)
// ============================================================

async function executeStep2(state) {
  if (!state.email) {
    throw new Error('缺少邮箱地址，请先在侧边栏填写或获取邮箱。');
  }

  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    throw new Error('缺少 ChatGPT 页面，请先完成步骤 1。');
  }

  await chrome.tabs.update(signupTabId, { active: true });
  await addLog(`步骤 2：正在进入注册流程并填写邮箱 ${state.email}...`);
  await sendToContentScriptResilient('signup-page', {
    type: 'EXECUTE_STEP',
    step: 2,
    source: 'background',
    payload: { email: state.email },
  }, {
    timeoutMs: 45000,
    retryDelayMs: 700,
    logMessage: '步骤 2：注册入口正在跳转到 OpenAI 认证页，等待页面重新就绪后继续填写邮箱...',
  });
}

// ============================================================
// Step 3: Fill Email & Password (via signup-page.js)
// ============================================================

async function executeStep3(state) {
  if (!state.email) {
    throw new Error('缺少邮箱地址，请先完成步骤 2。');
  }

  const password = state.customPassword || generatePassword();
  await setPasswordState(password);

  const accounts = state.accounts || [];
  accounts.push({ email: state.email, password, createdAt: new Date().toISOString() });
  await setState({ accounts });

  await addLog(
    `步骤 3：正在为 ${state.email} 填写密码，密码为${state.customPassword ? '自定义' : '自动生成'}（${password.length} 位）`
  );
  await sendToContentScriptResilient('signup-page', {
    type: 'EXECUTE_STEP',
    step: 3,
    source: 'background',
    payload: { email: state.email, password },
  }, {
    timeoutMs: 45000,
    retryDelayMs: 700,
    logMessage: '步骤 3：认证页正在跳转到密码页，等待页面重新就绪后继续填写密码...',
  });
}

// ============================================================
// Step 4: Get Signup Verification Code (qq-mail.js polls, then fills in signup-page.js)
// ============================================================

function getMailConfig(state) {
  const provider = state.mailProvider || 'qq';
  if (provider === '163') {
    return { source: 'mail-163', url: 'https://mail.163.com/js6/main.jsp?df=mail163_letter#module=mbox.ListModule%7C%7B%22fid%22%3A1%2C%22order%22%3A%22date%22%2C%22desc%22%3Atrue%7D', label: '163 邮箱' };
  }
  return { source: 'qq-mail', url: 'https://wx.mail.qq.com/', label: 'QQ 邮箱' };
}

function normalizeCookieDomainForMatch(domain) {
  return String(domain || '').trim().replace(/^\./, '').toLowerCase();
}

function shouldClearPreLoginCookie(cookie) {
  const domain = normalizeCookieDomainForMatch(cookie?.domain);
  if (!domain) return false;
  return PRE_LOGIN_COOKIE_CLEAR_DOMAINS.some((target) => (
    domain === target || domain.endsWith(`.${target}`)
  ));
}

function buildCookieRemovalUrl(cookie) {
  const host = normalizeCookieDomainForMatch(cookie?.domain);
  const path = String(cookie?.path || '/').startsWith('/')
    ? String(cookie?.path || '/')
    : `/${String(cookie?.path || '')}`;
  return `https://${host}${path}`;
}

async function collectCookiesForPreLoginCleanup() {
  if (!chrome.cookies?.getAll) {
    return [];
  }

  const stores = chrome.cookies.getAllCookieStores
    ? await chrome.cookies.getAllCookieStores()
    : [{ id: undefined }];
  const cookies = [];
  const seen = new Set();

  for (const store of stores) {
    const storeId = store?.id;
    const batch = await chrome.cookies.getAll(storeId ? { storeId } : {});
    for (const cookie of batch || []) {
      if (!shouldClearPreLoginCookie(cookie)) continue;
      const key = [
        cookie.storeId || storeId || '',
        cookie.domain || '',
        cookie.path || '',
        cookie.name || '',
        cookie.partitionKey ? JSON.stringify(cookie.partitionKey) : '',
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      cookies.push(cookie);
    }
  }

  return cookies;
}

async function removeCookieDirectly(cookie) {
  const details = {
    url: buildCookieRemovalUrl(cookie),
    name: cookie.name,
  };

  if (cookie.storeId) {
    details.storeId = cookie.storeId;
  }
  if (cookie.partitionKey) {
    details.partitionKey = cookie.partitionKey;
  }

  try {
    const result = await chrome.cookies.remove(details);
    return Boolean(result);
  } catch (err) {
    console.warn(LOG_PREFIX, '[removeCookieDirectly] failed', {
      domain: cookie?.domain,
      name: cookie?.name,
      message: getErrorMessage(err),
    });
    return false;
  }
}

async function runPreStep6CookieCleanup() {
  await addLog(
    `步骤 6：开始前等待 ${Math.round(STEP6_PRE_LOGIN_COOKIE_CLEAR_DELAY_MS / 1000)} 秒，然后直接删除 ChatGPT / OpenAI cookies...`,
    'info'
  );

  await sleepWithStop(STEP6_PRE_LOGIN_COOKIE_CLEAR_DELAY_MS);

  if (!chrome.cookies?.getAll || !chrome.cookies?.remove) {
    await addLog('步骤 6：当前浏览器不支持 cookies API，无法直接删除 cookies。', 'warn');
    return;
  }

  const cookies = await collectCookiesForPreLoginCleanup();
  let removedCount = 0;

  for (const cookie of cookies) {
    throwIfStopped();
    if (await removeCookieDirectly(cookie)) {
      removedCount += 1;
    }
  }

  if (chrome.browsingData?.removeCookies) {
    try {
      await chrome.browsingData.removeCookies({
        since: 0,
        origins: PRE_LOGIN_COOKIE_CLEAR_ORIGINS,
      });
    } catch (err) {
      await addLog(`步骤 6：browsingData 补扫 cookies 失败：${getErrorMessage(err)}`, 'warn');
    }
  }

  await addLog(`步骤 6：已直接删除 ${removedCount} 个 ChatGPT / OpenAI cookies，准备继续获取链接并登录。`, 'ok');
}

function getVerificationCodeStateKey(step) {
  return step === 4 ? 'lastSignupCode' : 'lastLoginCode';
}

function getVerificationCodeLabel(step) {
  return step === 4 ? '注册' : '登录';
}

function getVerificationPollPayload(step, state, overrides = {}) {
  if (step === 4) {
    return {
      filterAfterTimestamp: state.flowStartTime || 0,
      senderFilters: ['openai', 'noreply', 'verify', 'auth', 'duckduckgo', 'forward'],
      subjectFilters: ['verify', 'verification', 'code', '楠岃瘉', 'confirm'],
      targetEmail: state.email,
      maxAttempts: 5,
      intervalMs: 3000,
      ...overrides,
    };
  }

  return {
    filterAfterTimestamp: state.lastEmailTimestamp || state.flowStartTime || 0,
    senderFilters: ['openai', 'noreply', 'verify', 'auth', 'chatgpt', 'duckduckgo', 'forward'],
    subjectFilters: ['verify', 'verification', 'code', '楠岃瘉', 'confirm', 'login'],
    targetEmail: state.email,
    maxAttempts: 5,
    intervalMs: 3000,
    ...overrides,
  };
}

async function requestVerificationCodeResend(step) {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    throw new Error('认证页面标签页已关闭，无法重新请求验证码。');
  }

  await chrome.tabs.update(signupTabId, { active: true });
  await addLog(`步骤 ${step}：正在请求新的${getVerificationCodeLabel(step)}验证码...`, 'warn');

  const result = await sendToContentScript('signup-page', {
    type: 'RESEND_VERIFICATION_CODE',
    step,
    source: 'background',
    payload: {},
  });

  if (result && result.error) {
    throw new Error(result.error);
  }

  return Date.now();
}

async function pollFreshVerificationCode(step, state, mail, pollOverrides = {}) {
  const stateKey = getVerificationCodeStateKey(step);
  const rejectedCodes = new Set();
  if (state[stateKey]) {
    rejectedCodes.add(state[stateKey]);
  }
  for (const code of (pollOverrides.excludeCodes || [])) {
    if (code) rejectedCodes.add(code);
  }

  let lastError = null;
  const filterAfterTimestamp = pollOverrides.filterAfterTimestamp ?? getVerificationPollPayload(step, state).filterAfterTimestamp;
  const maxRounds = pollOverrides.maxRounds || VERIFICATION_POLL_MAX_ROUNDS;

  for (let round = 1; round <= maxRounds; round++) {
    if (round > 1) {
      await requestVerificationCodeResend(step);
    }

    const payload = getVerificationPollPayload(step, state, {
      ...pollOverrides,
      filterAfterTimestamp,
      excludeCodes: [...rejectedCodes],
    });

    try {
      const result = await sendToMailContentScriptResilient(
        mail,
        {
          type: 'POLL_EMAIL',
          step,
          source: 'background',
          payload,
        },
        {
          timeoutMs: getContentScriptResponseTimeoutMs({
            type: 'POLL_EMAIL',
            payload,
          }) + VERIFICATION_MAIL_RECOVERY_GRACE_MS,
          maxRecoveryAttempts: 2,
        }
      );

      if (result && result.error) {
        throw new Error(result.error);
      }

      if (!result || !result.code) {
        throw new Error(`步骤 ${step}：邮箱轮询结束，但未获取到验证码。`);
      }

      if (rejectedCodes.has(result.code)) {
        throw new Error(`步骤 ${step}：再次收到了相同的${getVerificationCodeLabel(step)}验证码：${result.code}`);
      }

      return result;
    } catch (err) {
      lastError = err;
      await addLog(`步骤 ${step}：${err.message}`, 'warn');
      if (round < maxRounds) {
        await addLog(`步骤 ${step}：将重新发送验证码后重试（${round + 1}/${maxRounds}）...`, 'warn');
      }
    }
  }

  throw lastError || new Error(`步骤 ${step}：无法获取新的${getVerificationCodeLabel(step)}验证码。`);
}

async function submitVerificationCode(step, code) {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    throw new Error('认证页面标签页已关闭，无法填写验证码。');
  }

  await chrome.tabs.update(signupTabId, { active: true });
  const result = await sendToContentScript('signup-page', {
    type: 'FILL_CODE',
    step,
    source: 'background',
    payload: { code },
  });

  if (result && result.error) {
    throw new Error(result.error);
  }

  return result || {};
}

async function resolveVerificationStep(step, state, mail, options = {}) {
  const stateKey = getVerificationCodeStateKey(step);
  const rejectedCodes = new Set();
  if (state[stateKey]) {
    rejectedCodes.add(state[stateKey]);
  }

  const nextFilterAfterTimestamp = options.filterAfterTimestamp ?? null;
  const requestFreshCodeFirst = Boolean(options.requestFreshCodeFirst);
  const maxSubmitAttempts = 3;

  if (requestFreshCodeFirst) {
    try {
      await requestVerificationCodeResend(step);
      await addLog(`步骤 ${step}：已先请求一封新的${getVerificationCodeLabel(step)}验证码，再开始轮询邮箱。`, 'warn');
    } catch (err) {
      await addLog(`步骤 ${step}：首次重新获取验证码失败：${err.message}，将继续使用当前时间窗口轮询。`, 'warn');
    }
  }

  for (let attempt = 1; attempt <= maxSubmitAttempts; attempt++) {
    const result = await pollFreshVerificationCode(step, state, mail, {
      excludeCodes: [...rejectedCodes],
      filterAfterTimestamp: nextFilterAfterTimestamp ?? undefined,
    });

    await addLog(`步骤 ${step}：已获取${getVerificationCodeLabel(step)}验证码：${result.code}`);
    const submitResult = await submitVerificationCode(step, result.code);

    if (submitResult.addPhonePage) {
      await addLog(`步骤 ${step}：验证码通过后进入手机号页面，本轮线程作废，准备重新开始新一轮。`, 'warn');
      throw new Error('当前流程已进入手机号页面，需要重新开始新一轮。');
    }

    if (submitResult.invalidCode) {
      rejectedCodes.add(result.code);
      await addLog(`步骤 ${step}：验证码被页面拒绝：${submitResult.errorText || result.code}`, 'warn');

      if (attempt >= maxSubmitAttempts) {
        throw new Error(`步骤 ${step}：验证码连续失败，已达到 ${maxSubmitAttempts} 次重试上限。`);
      }

      await requestVerificationCodeResend(step);
      await addLog(`步骤 ${step}：提交失败后已请求新验证码（${attempt + 1}/${maxSubmitAttempts}）...`, 'warn');
      continue;
    }

    await setState({
      lastEmailTimestamp: result.emailTimestamp,
      [stateKey]: result.code,
    });

    await completeStepFromBackground(step, {
      emailTimestamp: result.emailTimestamp,
      code: result.code,
    });
    return;
  }
}

async function executeStep4(state) {
  const mail = getMailConfig(state);
  if (mail.error) throw new Error(mail.error);
  const stepStartedAt = Date.now();
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    throw new Error('认证页面标签页已关闭，无法继续步骤 4。');
  }

  await chrome.tabs.update(signupTabId, { active: true });
  await addLog('步骤 4：正在确认注册验证码页面是否就绪，必要时自动恢复密码页超时报错...');
  const prepareResult = await sendToContentScriptResilient(
    'signup-page',
    {
      type: 'PREPARE_SIGNUP_VERIFICATION',
      step: 4,
      source: 'background',
      payload: { password: state.password || state.customPassword || '' },
    },
    {
      timeoutMs: 30000,
      retryDelayMs: 700,
      logMessage: '步骤 4：认证页正在切换，等待页面重新就绪后继续检测...',
    }
  );

  if (prepareResult && prepareResult.error) {
    throw new Error(prepareResult.error);
  }
  if (prepareResult?.alreadyVerified) {
    await completeStepFromBackground(4, {});
    return;
  }

  await addLog(`步骤 4：正在打开${mail.label}...`);

  // For mail tabs, only create if not alive — don't navigate (preserves login session)
  const alive = await isTabAlive(mail.source);
  if (alive) {
    if (mail.navigateOnReuse) {
      await reuseOrCreateTab(mail.source, mail.url, {
        inject: mail.inject,
        injectSource: mail.injectSource,
      });
    } else {
      const tabId = await getTabId(mail.source);
      await chrome.tabs.update(tabId, { active: true });
    }
  } else {
    await reuseOrCreateTab(mail.source, mail.url, {
      inject: mail.inject,
      injectSource: mail.injectSource,
    });
  }

  await resolveVerificationStep(4, state, mail, {
    filterAfterTimestamp: stepStartedAt,
    requestFreshCodeFirst: true,
  });
  return;
}

// ============================================================
// Step 5: Fill Name & Birthday (via signup-page.js)
// ============================================================

async function executeStep5(state) {
  const { firstName, lastName } = generateRandomName();
  const { year, month, day } = generateRandomBirthday();

  await addLog(`步骤 5：已生成姓名 ${firstName} ${lastName}，生日 ${year}-${month}-${day}`);

  const signupTabId = await getTabId('signup-page');
  if (signupTabId) {
    const signupTab = await chrome.tabs.get(signupTabId).catch(() => null);
    if (isLocalhostOAuthCallbackUrl(signupTab?.url)) {
      await addLog('步骤 5：认证页已直接进入 localhost 回调地址，资料页按已跳过处理。', 'ok');
      await completeStepFromBackground(5, { skippedDirectToCallback: true, localhostUrl: signupTab.url });
      return;
    }
  }

  try {
    await sendToContentScript('signup-page', {
      type: 'EXECUTE_STEP',
      step: 5,
      source: 'background',
      payload: { firstName, lastName, year, month, day },
    });
  } catch (err) {
    if (!isRetryableContentScriptTransportError(err) || !signupTabId) {
      throw err;
    }

    await addLog('步骤 5：资料提交后页面正在切换，准备检查是否已进入后续阶段...', 'warn');
    await sleepWithStop(4000);

    const signupTab = await chrome.tabs.get(signupTabId).catch(() => null);
    if (isLocalhostOAuthCallbackUrl(signupTab?.url)) {
      await addLog('步骤 5：资料提交后已直接进入 localhost 回调地址，资料页按已跳过处理。', 'ok');
      await completeStepFromBackground(5, { skippedDirectToCallback: true, localhostUrl: signupTab.url });
      return;
    }

    const authState = await sendToContentScriptResilient('signup-page', {
      type: 'INSPECT_AUTH_PAGE_STATE',
      step: 5,
      source: 'background',
      payload: {},
    }, {
      timeoutMs: 20000,
      retryDelayMs: 600,
      logMessage: '步骤 5：正在等待资料提交后的页面恢复，以确认是否已进入后续阶段...',
    });

    if (authState?.localhostUrl && isLocalhostOAuthCallbackUrl(authState.localhostUrl)) {
      await addLog('步骤 5：资料提交后已直接进入 localhost 回调地址，资料页按已跳过处理。', 'ok');
      await completeStepFromBackground(5, { skippedDirectToCallback: true, localhostUrl: authState.localhostUrl });
      return;
    }

    if (authState?.state === 'consent') {
      await addLog('步骤 5：资料提交后已进入 OAuth 同意页，资料页按已完成处理。', 'ok');
      await completeStepFromBackground(5, { skippedDirectToConsent: true });
      return;
    }

    if (authState?.state === 'logged_in_home') {
      await addLog('步骤 5：资料提交后进入已登录首页，将刷新 OAuth 链接重新进入登录链路。', 'ok');
      await completeStepFromBackground(5, { loggedInHome: true });
      return;
    }

    if (authState?.state === 'add_phone') {
      await addLog('步骤 5：资料提交后进入手机号页面。', 'ok');
      await completeStepFromBackground(5, { addPhonePage: true });
      return;
    }

    throw err;
  }
}

// ============================================================
// Step 6: Clear login cookies before OAuth login
// ============================================================

async function executeStep6() {
  await runPreStep6CookieCleanup();
  await completeStepFromBackground(6, {});
}

// ============================================================
// Step 7: Login ChatGPT (Background opens tab, signup-page.js handles login)
// ============================================================

async function refreshOAuthUrlBeforeStep7(state) {
  return requestFreshOAuthUrl(state, 7);
}

async function executeStep7(state) {
  if (!state.email) {
    throw new Error('缺少邮箱地址，请先完成步骤 3。');
  }

  if (state.localhostUrl && isLocalhostOAuthCallbackUrl(state.localhostUrl)) {
    await addLog('步骤 7：已记录 localhost 回调地址，本步骤按已完成处理。', 'ok');
    await completeStepFromBackground(7, { needsOTP: false, alreadyAtCallback: true, localhostUrl: state.localhostUrl });
    return;
  }

  if (state.authPageState === 'consent') {
    await addLog('步骤 7：已记录认证页直达 OAuth 同意页，本步骤按已完成处理。', 'ok');
    await completeStepFromBackground(7, { needsOTP: false, skippedDirectToConsent: true });
    return;
  }

  if (state.authPageState === 'logged_in_home') {
    await addLog('步骤 7：当前记录为已登录首页，不直接跳过，将刷新 OAuth 链接重新进入授权链路。', 'info');
    await setState({ authPageState: null });
  }

  const existingSignupTabAlive = await isTabAlive('signup-page');
  const existingSignupTabId = existingSignupTabAlive ? await getTabId('signup-page') : null;
  if (existingSignupTabId) {
    const existingSignupTab = await chrome.tabs.get(existingSignupTabId).catch(() => null);
    if (isLocalhostOAuthCallbackUrl(existingSignupTab?.url)) {
      await addLog('步骤 7：认证页已直接进入 localhost 回调地址，本步骤按已完成处理。', 'ok');
      await completeStepFromBackground(7, { needsOTP: false, alreadyAtCallback: true, localhostUrl: existingSignupTab.url });
      return;
    }

    const authState = await sendToContentScriptResilient('signup-page', {
      type: 'INSPECT_AUTH_PAGE_STATE',
      step: 7,
      source: 'background',
      payload: {},
    }, {
      timeoutMs: 15000,
      retryDelayMs: 500,
      logMessage: '步骤 7：认证页状态检测未就绪，正在重试...',
    });

    if (authState?.localhostUrl && isLocalhostOAuthCallbackUrl(authState.localhostUrl)) {
      await addLog('步骤 7：认证页已直接进入 localhost 回调地址，本步骤按已完成处理。', 'ok');
      await completeStepFromBackground(7, { needsOTP: false, alreadyAtCallback: true, localhostUrl: authState.localhostUrl });
      return;
    }

    if (authState?.state === 'consent') {
      await addLog('步骤 7：认证页已直接进入 OAuth 同意页，本步骤按已完成处理。', 'ok');
      await completeStepFromBackground(7, { needsOTP: false, skippedDirectToConsent: true });
      return;
    }

    if (authState?.state === 'add_phone') {
      await addLog('步骤 7：资料提交后进入手机号页面属于正常中间态，将刷新 OAuth 链接继续登录。', 'info');
    }
  }

  const oauthUrl = await refreshOAuthUrlBeforeStep7(state);

  await addLog('步骤 7：正在打开最新 OAuth 链接并登录...');
  const signupTabId = await reuseOrCreateTab('signup-page', oauthUrl);
  const signupTab = await chrome.tabs.get(signupTabId).catch(() => null);
  if (isLocalhostOAuthCallbackUrl(signupTab?.url)) {
    await addLog('步骤 7：刷新后的认证页已直接进入 localhost 回调地址，本步骤按已完成处理。', 'ok');
    await completeStepFromBackground(7, { needsOTP: false, alreadyAtCallback: true, localhostUrl: signupTab.url });
    return;
  }

  const postOpenAuthState = await sendToContentScriptResilient('signup-page', {
    type: 'INSPECT_AUTH_PAGE_STATE',
    step: 7,
    source: 'background',
    payload: {},
  }, {
    timeoutMs: 15000,
    retryDelayMs: 500,
    logMessage: '步骤 7：正在等待刷新后的认证页就绪...',
  });

  if (postOpenAuthState?.localhostUrl && isLocalhostOAuthCallbackUrl(postOpenAuthState.localhostUrl)) {
    await addLog('步骤 7：刷新后的认证页已直接进入 localhost 回调地址，本步骤按已完成处理。', 'ok');
    await completeStepFromBackground(7, { needsOTP: false, alreadyAtCallback: true, localhostUrl: postOpenAuthState.localhostUrl });
    return;
  }

  if (postOpenAuthState?.state === 'consent') {
    await addLog('步骤 7：刷新后的认证页已直接进入 OAuth 同意页，本步骤按已完成处理。', 'ok');
    await completeStepFromBackground(7, { needsOTP: false, skippedDirectToConsent: true });
    return;
  }

  if (postOpenAuthState?.state === 'add_phone') {
    await addLog('步骤 7：刷新后的认证页仍显示手机号页面，继续重新执行登录。', 'info');
  }

  const loginPassword = state.password || state.customPassword;
  if (!loginPassword) {
    throw new Error('缺少登录密码，请先完成步骤 3 或在侧边栏填写自定义密码。');
  }

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 7,
    source: 'background',
    payload: { email: state.email, password: loginPassword },
  });
}

// ============================================================
// Step 8: Get Login Verification Code (mail provider polls, then fills in signup-page.js)
// ============================================================

async function runStep8Attempt(state) {
  const mail = getMailConfig(state);
  if (mail.error) throw new Error(mail.error);
  const stepStartedAt = Date.now();

  if (state.localhostUrl && isLocalhostOAuthCallbackUrl(state.localhostUrl)) {
    await addLog('步骤 8：已记录 localhost 回调地址，跳过登录验证码阶段。', 'ok');
    await completeStepFromBackground(8, { skippedDirectToCallback: true, localhostUrl: state.localhostUrl });
    return;
  }

  if (state.authPageState === 'consent') {
    await addLog('步骤 8：已记录认证页直达 OAuth 同意页，跳过登录验证码阶段。', 'ok');
    await completeStepFromBackground(8, { skippedDirectToConsent: true });
    return;
  }

  if (state.authPageState === 'logged_in_home') {
    await addLog('步骤 8：当前记录为已登录首页，不视为 OAuth 同意页，先回到步骤 7 刷新授权链路。', 'warn');
    await setState({ authPageState: null });
    await rerunStep7ForStep8Recovery();
    await runStep8Attempt(await getState());
    return;
  }

  let authTabId = await (await isTabAlive('signup-page') ? getTabId('signup-page') : null);

  if (authTabId) {
    await chrome.tabs.update(authTabId, { active: true });
  } else {
    if (!state.oauthUrl) {
      throw new Error('缺少 OAuth 链接，请先完成步骤 7。');
    }
    authTabId = await reuseOrCreateTab('signup-page', state.oauthUrl);
  }

  const currentAuthTab = authTabId ? await chrome.tabs.get(authTabId).catch(() => null) : null;
  if (isLocalhostOAuthCallbackUrl(currentAuthTab?.url)) {
    await addLog('步骤 8：认证页已直接进入 localhost 回调地址，跳过登录验证码阶段。', 'ok');
    await completeStepFromBackground(8, { skippedDirectToCallback: true, localhostUrl: currentAuthTab.url });
    return;
  }

  const currentAuthState = await sendToContentScriptResilient('signup-page', {
    type: 'INSPECT_AUTH_PAGE_STATE',
    step: 8,
    source: 'background',
    payload: {},
  }, {
    timeoutMs: 15000,
    retryDelayMs: 500,
    logMessage: '步骤 8：认证页状态检测未就绪，正在重试...',
  });

  if (currentAuthState?.localhostUrl && isLocalhostOAuthCallbackUrl(currentAuthState.localhostUrl)) {
    await addLog('步骤 8：认证页已直接进入 localhost 回调地址，跳过登录验证码阶段。', 'ok');
    await completeStepFromBackground(8, { skippedDirectToCallback: true, localhostUrl: currentAuthState.localhostUrl });
    return;
  }

  if (currentAuthState?.state === 'consent') {
    await addLog('步骤 8：认证页已直接进入 OAuth 同意页，跳过登录验证码阶段。', 'ok');
    await completeStepFromBackground(8, { skippedDirectToConsent: true });
    return;
  }

  if (currentAuthState?.state === 'add_phone') {
    throw new Error('当前流程已进入手机号页面，需要重新开始新一轮。');
  }

  await addLog('步骤 8：正在准备认证页，必要时切换到一次性验证码登录...');
  const prepareResult = await sendToContentScript('signup-page', {
    type: 'PREPARE_LOGIN_CODE',
    step: 8,
    source: 'background',
    payload: {},
  });

  if (prepareResult && prepareResult.error) {
    throw new Error(prepareResult.error);
  }

  await addLog(`步骤 8：正在打开${mail.label}...`);

  const alive = await isTabAlive(mail.source);
  if (alive) {
    if (mail.navigateOnReuse) {
      await reuseOrCreateTab(mail.source, mail.url, {
        inject: mail.inject,
        injectSource: mail.injectSource,
      });
    } else {
      const tabId = await getTabId(mail.source);
      await chrome.tabs.update(tabId, { active: true });
    }
  } else {
    await reuseOrCreateTab(mail.source, mail.url, {
      inject: mail.inject,
      injectSource: mail.injectSource,
    });
  }

  await resolveVerificationStep(8, state, mail, {
    filterAfterTimestamp: stepStartedAt,
    requestFreshCodeFirst: true,
  });
}

async function rerunStep7ForStep8Recovery() {
  const currentState = await getState();
  const waitForStep7 = waitForStepComplete(7, 120000);
  await addLog('步骤 8：正在回到步骤 7，重新发起登录验证码流程...', 'warn');
  await executeStep7(currentState);
  await waitForStep7;
  await sleepWithStop(3000);
}

async function executeStep8(state) {
  let lastError = null;

  for (let round = 1; round <= STEP8_RESTART_MAX_ROUNDS; round++) {
    const currentState = round === 1 ? state : await getState();

    try {
      if (round > 1) {
        await addLog(`步骤 8：正在进行第 ${round}/${STEP8_RESTART_MAX_ROUNDS} 轮登录验证码恢复尝试。`, 'warn');
      }
      await runStep8Attempt(currentState);
      return;
    } catch (err) {
      lastError = err;

      if (!isVerificationMailPollingError(err)) {
        throw err;
      }

      if (round >= STEP8_RESTART_MAX_ROUNDS) {
        break;
      }

      await addLog(`步骤 8：检测到邮箱轮询类失败，准备从步骤 7 重新开始（${round + 1}/${STEP8_RESTART_MAX_ROUNDS}）...`, 'warn');
      await rerunStep7ForStep8Recovery();
    }
  }

  throw lastError || new Error(`步骤 8：登录验证码流程在 ${STEP8_RESTART_MAX_ROUNDS} 轮后仍未成功。`);
}

// ============================================================
// Step 9: 完成 OAuth（自动点击 + localhost 回调监听）
// ============================================================

let webNavListener = null;
const STEP8_CLICK_EFFECT_TIMEOUT_MS = 3500;
const STEP8_CLICK_RETRY_DELAY_MS = 500;
const STEP8_READY_WAIT_TIMEOUT_MS = 30000;
const STEP8_STRATEGIES = [
  { mode: 'content', strategy: 'requestSubmit', label: 'form.requestSubmit' },
  { mode: 'debugger', label: 'debugger click' },
  { mode: 'content', strategy: 'nativeClick', label: 'element.click' },
  { mode: 'content', strategy: 'dispatchClick', label: 'dispatch click' },
  { mode: 'debugger', label: 'debugger click retry' },
];

async function getStep8PageState(tabId, responseTimeoutMs = 1500) {
  try {
    const result = await sendTabMessageWithTimeout(tabId, 'signup-page', {
      type: 'STEP8_GET_STATE',
      source: 'background',
      payload: {},
    }, responseTimeoutMs);
    if (result?.error) {
      throw new Error(result.error);
    }
    return result;
  } catch (err) {
    if (isRetryableContentScriptTransportError(err)) {
      return null;
    }
    throw err;
  }
}

async function waitForStep8Ready(tabId, timeoutMs = STEP8_READY_WAIT_TIMEOUT_MS) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    throwIfStopped();
    const pageState = await getStep8PageState(tabId);
    if (pageState?.addPhonePage) {
      throw new Error('步骤 9：认证页进入了手机号页面，当前不是 OAuth 同意页，无法继续自动授权。');
    }
    if (pageState?.consentReady) {
      return pageState;
    }
    await sleepWithStop(250);
  }

  throw new Error('步骤 9：长时间未进入 OAuth 同意页，无法定位“继续”按钮。');
}

async function prepareStep8DebuggerClick() {
  const result = await sendToContentScriptResilient('signup-page', {
    type: 'STEP8_FIND_AND_CLICK',
    source: 'background',
    payload: {},
  }, {
    timeoutMs: 15000,
    retryDelayMs: 600,
    logMessage: '步骤 9：认证页正在切换，等待 OAuth 同意页按钮重新就绪...',
  });

  if (result?.error) {
    throw new Error(result.error);
  }

  return result;
}

async function triggerStep8ContentStrategy(strategy) {
  const result = await sendToContentScriptResilient('signup-page', {
    type: 'STEP8_TRIGGER_CONTINUE',
    source: 'background',
    payload: {
      strategy,
      findTimeoutMs: 4000,
      enabledTimeoutMs: 3000,
    },
  }, {
    timeoutMs: 15000,
    retryDelayMs: 600,
    logMessage: '步骤 9：认证页正在切换，等待“继续”按钮重新就绪...',
  });

  if (result?.error) {
    throw new Error(result.error);
  }

  return result;
}

async function waitForStep8ClickEffect(tabId, baselineUrl, timeoutMs = STEP8_CLICK_EFFECT_TIMEOUT_MS) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    throwIfStopped();

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      throw new Error('步骤 9：认证页面标签页已关闭，无法继续自动授权。');
    }

    if (baselineUrl && typeof tab.url === 'string' && tab.url !== baselineUrl) {
      return { progressed: true, reason: 'url_changed', url: tab.url };
    }

    const pageState = await getStep8PageState(tabId);
    if (pageState?.addPhonePage) {
      throw new Error('步骤 9：点击“继续”后页面跳到了手机号页面，当前流程无法继续自动授权。');
    }
    if (pageState === null) {
      return { progressed: true, reason: 'page_reloading' };
    }
    if (pageState && !pageState.consentPage) {
      return { progressed: true, reason: 'left_consent_page', url: pageState.url };
    }

    await sleepWithStop(200);
  }

  return { progressed: false, reason: 'no_effect' };
}

function getStep8EffectLabel(effect) {
  switch (effect?.reason) {
    case 'url_changed':
      return `URL 已变化：${effect.url}`;
    case 'page_reloading':
      return '页面正在跳转或重载';
    case 'left_consent_page':
      return `页面已离开 OAuth 同意页：${effect.url || 'unknown'}`;
    default:
      return '页面仍停留在 OAuth 同意页';
  }
}

async function executeStep9(state) {
  if (state.localhostUrl && isLocalhostOAuthCallbackUrl(state.localhostUrl)) {
    await addLog('步骤 9：已记录 localhost 回调地址，本步骤按已完成处理。', 'ok');
    await completeStepFromBackground(9, { localhostUrl: state.localhostUrl });
    return;
  }

  const existingSignupTabAlive = await isTabAlive('signup-page');
  const existingSignupTabId = existingSignupTabAlive ? await getTabId('signup-page') : null;
  if (!existingSignupTabId && !state.oauthUrl) {
    throw new Error('缺少 OAuth 链接，且当前没有可复用的认证页，请先完成步骤 7。');
  }

  await addLog('步骤 9：正在监听 localhost 回调地址...');

  async function completeIfCurrentTabAlreadyAtCallback(tabId, logMessage) {
    if (!tabId) return false;

    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return false;
    }

    if (!isLocalhostOAuthCallbackUrl(tab?.url)) {
      return false;
    }

    if (logMessage) {
      await addLog(logMessage, 'ok');
    }
    await completeStepFromBackground(9, { localhostUrl: tab.url });
    return true;
  }

  return new Promise((resolve, reject) => {
    let resolved = false;
    let signupTabId = null;

    const cleanupListener = () => {
      if (webNavListener) {
        chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
        webNavListener = null;
      }
    };

    const failStep9 = (error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      cleanupListener();
      reject(error);
    };

    const timeout = setTimeout(() => {
      failStep9(new Error('120 秒内未捕获到 localhost 回调跳转，步骤 9 已持续重试点击“继续”但页面仍未完成授权。'));
    }, 120000);

    webNavListener = (details) => {
      if (resolved || !signupTabId) return;
      if (details.tabId !== signupTabId) return;
      if (details.frameId !== 0) return;
      if (isLocalhostOAuthCallbackUrl(details.url)) {
        console.log(LOG_PREFIX, `已捕获 localhost OAuth 回调：${details.url}`);
        resolved = true;
        cleanupListener();
        clearTimeout(timeout);
        addLog(`步骤 9：已捕获 localhost 地址：${details.url}`, 'ok').then(() => {
          return completeStepFromBackground(9, { localhostUrl: details.url });
        }).then(() => {
          resolve();
        }).catch((err) => {
          reject(err);
        });
      }
    };

    (async () => {
      try {
        signupTabId = await (await isTabAlive('signup-page') ? getTabId('signup-page') : null);
        if (signupTabId) {
          if (await completeIfCurrentTabAlreadyAtCallback(signupTabId, '步骤 9：检测到认证页已停留在 localhost 回调地址，直接完成当前步骤。')) {
            resolved = true;
            clearTimeout(timeout);
            cleanupListener();
            resolve();
            return;
          }

          await chrome.tabs.update(signupTabId, { active: true });
          await addLog('步骤 9：已切回认证页，准备循环确认“继续”按钮直到页面真正跳转...');
        } else {
          signupTabId = await reuseOrCreateTab('signup-page', state.oauthUrl);
          await addLog('步骤 9：已重新打开认证页，准备循环确认“继续”按钮直到页面真正跳转...');
        }

        if (await completeIfCurrentTabAlreadyAtCallback(signupTabId, '步骤 9：检测到认证页已跳到 localhost 回调地址，直接完成当前步骤。')) {
          resolved = true;
          clearTimeout(timeout);
          cleanupListener();
          resolve();
          return;
        }

        chrome.webNavigation.onBeforeNavigate.addListener(webNavListener);

        let attempt = 0;
        while (!resolved) {
          const pageState = await waitForStep8Ready(signupTabId);
          if (!pageState?.consentReady) {
            await sleepWithStop(STEP8_CLICK_RETRY_DELAY_MS);
            continue;
          }

          const strategy = STEP8_STRATEGIES[attempt % STEP8_STRATEGIES.length];
          const round = attempt + 1;
          attempt += 1;

          await addLog(`步骤 9：第 ${round} 次尝试点击“继续”（${strategy.label}）...`);

          if (strategy.mode === 'debugger') {
            const clickTarget = await prepareStep8DebuggerClick();
            if (clickTarget?.alreadyAtCallback) {
              resolved = true;
              cleanupListener();
              clearTimeout(timeout);
              await addLog(`步骤 9：内容脚本确认当前页面已是 localhost 回调地址：${clickTarget.url}`, 'ok');
              await completeStepFromBackground(9, { localhostUrl: clickTarget.url });
              resolve();
              return;
            }
            if (!resolved) {
              await clickWithDebugger(signupTabId, clickTarget?.rect);
            }
          } else {
            await triggerStep8ContentStrategy(strategy.strategy);
          }

          if (resolved) {
            return;
          }

          const effect = await waitForStep8ClickEffect(signupTabId, pageState.url);
          if (resolved) {
            return;
          }

          if (effect.progressed) {
            await addLog(`步骤 9：检测到本次点击已生效，${getStep8EffectLabel(effect)}，继续等待 localhost 回调...`, 'info');
            break;
          }

          await addLog(`步骤 9：${strategy.label} 本次未触发页面离开同意页，准备继续重试。`, 'warn');
          await sleepWithStop(STEP8_CLICK_RETRY_DELAY_MS);
        }
      } catch (err) {
        failStep9(err);
      }
    })();
  });
}

// ============================================================
// Step 10: CPA 回调验证（通过 vps-panel.js）
// ============================================================

async function executeStep10(state) {
  if (state.localhostUrl && !isLocalhostOAuthCallbackUrl(state.localhostUrl)) {
    throw new Error('步骤 9 捕获到的 localhost OAuth 回调地址无效，请重新执行步骤 9。');
  }
  if (!state.localhostUrl) {
    throw new Error('缺少 localhost 回调地址，请先完成步骤 9。');
  }
  if (!state.vpsUrl) {
    throw new Error('尚未填写 CPA 地址，请先在侧边栏输入。');
  }
  if (!state.oauthUrl) {
    throw new Error('缺少步骤 7 生成的 OAuth 链接，请从步骤 7 重新开始。');
  }

  await addLog('步骤 10：正在回到步骤 7 使用的 CPA 面板...');

  const injectFiles = ['content/utils.js', 'content/vps-panel.js'];
  let tabId = Number.isInteger(state.oauthSourceTabId) ? state.oauthSourceTabId : await getTabId('vps-panel');
  const alive = tabId && await isTabAlive('vps-panel');

  if (!alive) {
    throw new Error('步骤 10：步骤 7 发起 OAuth 的 CPA 标签页已不存在。为确保使用同一条授权链接，请从步骤 7 重新开始。');
  }

  await closeConflictingTabsForSource('vps-panel', state.vpsUrl, { excludeTabIds: [tabId] });
  await rememberSourceLastUrl('vps-panel', state.vpsUrl);

  const currentPanelTab = await chrome.tabs.get(tabId).catch(() => null);
  if (!currentPanelTab || !matchesSourceUrlFamily('vps-panel', currentPanelTab.url, state.vpsUrl)) {
    throw new Error('步骤 10：步骤 7 使用的 CPA 页面已离开原始面板地址。为确保沿用同一条授权链接，请从步骤 7 重新开始。');
  }

  await ensureContentScriptReadyOnTab('vps-panel', tabId, {
    inject: injectFiles,
    injectSource: 'vps-panel',
  });

  const [currentTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  let vpsPanelTab = await chrome.tabs.get(tabId).catch(() => null);
  console.log(LOG_PREFIX, '[Step 10] tab switch precheck', {
    currentTab: currentTab ? {
      id: currentTab.id,
      windowId: currentTab.windowId,
      active: currentTab.active,
      url: currentTab.url,
      title: currentTab.title,
    } : null,
    vpsPanelTab: vpsPanelTab ? {
      id: vpsPanelTab.id,
      windowId: vpsPanelTab.windowId,
      active: vpsPanelTab.active,
      url: vpsPanelTab.url,
      title: vpsPanelTab.title,
    } : null,
  });
  await addLog(
    `步骤 10 调试：currentTab=${currentTab ? `${currentTab.id}@${currentTab.windowId}${currentTab.active ? ':active' : ''}` : 'null'}，` +
    `cpaTab=${vpsPanelTab ? `${vpsPanelTab.id}@${vpsPanelTab.windowId}${vpsPanelTab.active ? ':active' : ''}` : 'null'}`,
    'info'
  );

  if (vpsPanelTab && currentTab && Number.isInteger(currentTab.windowId) && vpsPanelTab.windowId !== currentTab.windowId) {
    console.log(LOG_PREFIX, '[Step 10] moving CPA tab to current window', {
      tabId,
      fromWindowId: vpsPanelTab.windowId,
      toWindowId: currentTab.windowId,
    });
    await addLog(`步骤 10 调试：检测到 CPA tab 在其他窗口，尝试移动到当前窗口 ${currentTab.windowId}。`, 'warn');
    const movedTab = await chrome.tabs.move(tabId, {
      windowId: currentTab.windowId,
      index: -1,
    }).catch((err) => {
      console.warn(LOG_PREFIX, '[Step 10] move CPA tab failed', err);
      return null;
    });
    const movedTabId = Array.isArray(movedTab) ? movedTab[0]?.id : movedTab?.id;
    await addLog(`步骤 10 调试：move 结果=${movedTabId || 'null'}`, movedTabId ? 'info' : 'warn');
    if (Number.isInteger(movedTabId)) {
      tabId = movedTabId;
      vpsPanelTab = await chrome.tabs.get(tabId).catch(() => vpsPanelTab);
    }
  }
  if (vpsPanelTab && !vpsPanelTab.active) {
    console.log(LOG_PREFIX, '[Step 10] activating CPA tab', {
      tabId,
      windowId: vpsPanelTab.windowId,
    });
    await addLog(`步骤 10 调试：准备激活 CPA tab ${tabId}@${vpsPanelTab.windowId}。`, 'info');
    await chrome.tabs.update(tabId, { active: true });
  }
  const finalCurrentTab = await chrome.tabs.get(tabId).catch(() => null);
  console.log(LOG_PREFIX, '[Step 10] tab switch final state', {
    tabId,
    finalCurrentTab: finalCurrentTab ? {
      id: finalCurrentTab.id,
      windowId: finalCurrentTab.windowId,
      active: finalCurrentTab.active,
      url: finalCurrentTab.url,
      title: finalCurrentTab.title,
    } : null,
  });
  await addLog(
    `步骤 10 调试：切换后 CPA tab=${finalCurrentTab ? `${finalCurrentTab.id}@${finalCurrentTab.windowId}${finalCurrentTab.active ? ':active' : ':inactive'}` : 'null'}`,
    finalCurrentTab?.active ? 'ok' : 'warn'
  );

  await addLog('步骤 10：正在填写回调地址...');
  const result = await sendToContentScriptResilient('vps-panel', {
    type: 'EXECUTE_STEP',
    step: 10,
    source: 'background',
    payload: {
      localhostUrl: state.localhostUrl,
      vpsPassword: state.vpsPassword,
      expectedOauthUrl: state.oauthUrl,
    },
  }, {
    timeoutMs: 50000,
    responseTimeoutMs: 45000,
    retryDelayMs: 700,
    logMessage: '步骤 10：CPA 面板通信未就绪，正在等待页面恢复...',
    reinjectOnRetry: {
      url: state.vpsUrl,
      inject: injectFiles,
      injectSource: 'vps-panel',
      activate: false,
    },
  });

  if (result?.error) {
    throw new Error(result.error);
  }
}

// ============================================================
// Open Side Panel on extension icon click
// ============================================================

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
