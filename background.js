// background.js — Service Worker: orchestration, state, tab management, message routing

importScripts('data/names.js');

const LOG_PREFIX = '[MultiPage:bg]';
const DUCK_AUTOFILL_URL = 'https://duckduckgo.com/email/settings/autofill';
const SIMPLELOGIN_APP_URL = 'https://app.simplelogin.io/dashboard/';
const ADDY_APP_URL = 'https://app.addy.io/aliases';
const STOP_ERROR_MESSAGE = '流程已被用户停止。';
const HUMAN_STEP_DELAY_MIN = 700;
const HUMAN_STEP_DELAY_MAX = 2200;
const MAX_FLOW_STEP = 7;
const FLOW_VERSION = 7;
const EMAIL_POOL_STORAGE_KEY = 'emailPoolsByProvider';
const EMAIL_POOL_VERSION = 1;
const EMAIL_POOL_STATUSES = ['pending', 'claimed', 'running', 'success', 'failed', 'abandoned'];
const EMAIL_POOL_TERMINAL_STATUSES = new Set(['success', 'failed', 'abandoned']);
const EMAIL_GENERATION_SERVICE_DEFAULT = 'duckmail';
const EMAIL_GENERATION_SERVICES = ['duckmail', 'simplelogin', 'addy'];

initializeSessionStorageAccess();

// ============================================================
// 状态管理（chrome.storage.session + chrome.storage.local）
// ============================================================

const WINDOW_SCOPED_SETTING_DEFAULTS = {
  vpsUrl: '', // VPS 面板地址，可手动填写。
  vpsPassword: '', // VPS 面板登录密码，可手动填写。
  customPassword: '', // 自定义账号密码；留空时由程序自动生成随机密码。
  autoRunSkipFailures: false, // 自动运行遇到失败步骤后，是否继续执行后续流程。
  mailProvider: '163', // 验证码邮箱来源，当前支持 163 / inbucket。
  emailGenerationService: EMAIL_GENERATION_SERVICE_DEFAULT, // Step 3 邮箱生成服务。
  inbucketHost: '', // 仅当 mailProvider 为 inbucket 时填写 Inbucket 地址，其他情况保持为空。
  inbucketMailbox: '', // 仅当 mailProvider 为 inbucket 时填写邮箱名，其他情况保持为空。
};

const WINDOW_SCOPED_SETTING_KEYS = Object.keys(WINDOW_SCOPED_SETTING_DEFAULTS);

const DEFAULT_STATE = {
  flowVersion: FLOW_VERSION,
  currentStep: 0, // 当前流程执行到的步骤编号。
  stepStatuses: {
    1: 'pending', 2: 'pending', 3: 'pending', 4: 'pending', 5: 'pending', // 运行时步骤状态映射，不要手动预填。
    6: 'pending', 7: 'pending',
  },
  oauthUrl: null, // 运行时抓取到的 OAuth 地址，不要手动预填。
  email: null, // 运行时邮箱，由程序自动获取并写入，不能手动预填。
  poolBinding: null, // 当前窗口绑定的邮箱池条目：{ provider, itemId }。
  password: null, // 运行时实际密码，由 customPassword 或程序自动生成后写入。
  accounts: [], // 已生成账号记录：{ email, password, createdAt }。
  lastEmailTimestamp: null, // 最近一次获取到邮箱数据的运行时时间戳。
  lastSignupCode: null, // 注册验证码，运行时由程序自动读取并写入。
  lastLoginCode: null, // 登录验证码，运行时由程序自动读取并写入。
  localhostUrl: null, // 运行时捕获到的 localhost 回调地址，不要手动预填。
  flowStartTime: null, // 当前流程开始时间。
  tabRegistry: {}, // 程序维护的标签页注册表。
  sourceLastUrls: {}, // 各来源页面最近一次打开的地址记录。
  logs: [], // 侧边栏展示的运行日志。
  ...WINDOW_SCOPED_SETTING_DEFAULTS, // 当前窗口自己的侧边栏配置默认值。
  autoRunning: false, // 当前是否处于自动运行中。
  autoRunPhase: 'idle', // 当前自动运行阶段。
  autoRunCurrentRun: 0, // 自动运行当前执行到第几轮。
  autoRunTotalRuns: 1, // 自动运行计划总轮数。
  autoRunAttemptRun: 0, // 当前轮次的重试序号。
};

const WINDOW_STATE_KEY_PREFIX = 'windowState:';
const pendingCommandsByWindow = new Map();
const stepWaitersByWindow = new Map();
const resumeWaitersByWindow = new Map();
const stopRequestedByWindow = new Set();
const autoRunRuntimeByWindow = new Map();
const step8ListenersByWindow = new Map();
const emailPoolLocksByProvider = new Map();

function getWindowStateKey(windowId) {
  return `${WINDOW_STATE_KEY_PREFIX}${windowId}`;
}

function requireWindowId(message, sender) {
  const candidates = [sender?.tab?.windowId, message?.windowId, message?.payload?.windowId];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isInteger(value) && value >= 0) {
      return value;
    }
  }
  throw new Error('缺少 windowId，无法确定当前浏览器窗口。');
}

function getPendingCommands(windowId) {
  if (!pendingCommandsByWindow.has(windowId)) {
    pendingCommandsByWindow.set(windowId, new Map());
  }
  return pendingCommandsByWindow.get(windowId);
}

async function withEmailPoolProviderLock(provider, task) {
  const normalizedProvider = normalizeMailProvider(provider);
  const previous = emailPoolLocksByProvider.get(normalizedProvider) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  emailPoolLocksByProvider.set(normalizedProvider, tail);

  await previous;
  try {
    return await task(normalizedProvider);
  } finally {
    release();
    if (emailPoolLocksByProvider.get(normalizedProvider) === tail) {
      emailPoolLocksByProvider.delete(normalizedProvider);
    }
  }
}

function getStepWaiters(windowId) {
  if (!stepWaitersByWindow.has(windowId)) {
    stepWaitersByWindow.set(windowId, new Map());
  }
  return stepWaitersByWindow.get(windowId);
}

function getResumeWaiter(windowId) {
  return resumeWaitersByWindow.get(windowId) || null;
}

function setResumeWaiter(windowId, waiter) {
  if (waiter) {
    resumeWaitersByWindow.set(windowId, waiter);
  } else {
    resumeWaitersByWindow.delete(windowId);
  }
}

function isStopRequested(windowId) {
  return stopRequestedByWindow.has(windowId);
}

function clearStep8Listener(windowId) {
  const listener = step8ListenersByWindow.get(windowId);
  if (listener) {
    chrome.webNavigation.onBeforeNavigate.removeListener(listener);
    step8ListenersByWindow.delete(windowId);
  }
}

function getAutoRunRuntime(windowId) {
  if (!autoRunRuntimeByWindow.has(windowId)) {
    autoRunRuntimeByWindow.set(windowId, {
      active: false,
      currentRun: 0,
      totalRuns: 1,
      attemptRun: 0,
      sessionId: 0,
      attemptSessionId: 0,
      activeAttemptSessionId: null,
    });
  }
  return autoRunRuntimeByWindow.get(windowId);
}

async function sendWindowMessage(windowId, type, payload) {
  await chrome.runtime.sendMessage({ type, windowId, payload }).catch(() => { });
}

function pickWindowScopedSettings(state = {}) {
  const picked = {};
  for (const key of WINDOW_SCOPED_SETTING_KEYS) {
    if (state[key] !== undefined) {
      picked[key] = state[key];
    }
  }
  if (picked.autoRunSkipFailures !== undefined) {
    picked.autoRunSkipFailures = Boolean(picked.autoRunSkipFailures);
  }
  if (picked.mailProvider !== undefined) {
    picked.mailProvider = normalizeMailProvider(picked.mailProvider);
  }
  if (picked.emailGenerationService !== undefined) {
    picked.emailGenerationService = normalizeEmailGenerationService(picked.emailGenerationService);
  }
  return picked;
}

function normalizeFlowStep(step) {
  const numericStep = Number(step) || 0;
  if (numericStep === 8) return 6;
  if (numericStep === 9) return 7;
  return numericStep;
}

function isLegacyFlowState(rawState = {}) {
  const storedVersion = Number(rawState.flowVersion || 0);
  if (storedVersion >= FLOW_VERSION) {
    return false;
  }

  const statuses = rawState.stepStatuses || {};
  return Boolean(
    Number(rawState.currentStep)
    || statuses[6] !== undefined
    || statuses[7] !== undefined
    || statuses[8] !== undefined
    || statuses[9] !== undefined
    || rawState.localhostUrl
    || rawState.lastLoginCode
  );
}

function normalizeStepStatuses(statuses = {}, options = {}) {
  const { legacy = false, localhostUrl = null } = options;
  const normalized = { ...DEFAULT_STATE.stepStatuses };

  for (let step = 1; step <= 5; step++) {
    if (statuses[step] !== undefined) {
      normalized[step] = statuses[step];
    }
  }

  if (legacy) {
    if (statuses[8] !== undefined) {
      normalized[6] = statuses[8];
    }
    if (statuses[9] !== undefined) {
      normalized[7] = statuses[9];
    }
  } else {
    if (statuses[6] !== undefined) {
      normalized[6] = statuses[6];
    }
    if (statuses[7] !== undefined) {
      normalized[7] = statuses[7];
    }
  }

  if (localhostUrl) {
    normalized[6] = isStepDoneStatus(normalized[6]) ? normalized[6] : 'completed';
  }
  if (isStepDoneStatus(normalized[7]) && !isStepDoneStatus(normalized[6])) {
    normalized[6] = 'completed';
  }
  return normalized;
}

function normalizeCurrentStep(currentStep, rawStepStatuses = {}, stepStatuses = normalizeStepStatuses(rawStepStatuses), options = {}) {
  const { legacy = false } = options;
  const numericStep = Number(currentStep) || 0;
  if (numericStep <= 0) return 0;
  if (numericStep > MAX_FLOW_STEP) {
    return normalizeFlowStep(numericStep);
  }
  if (legacy && numericStep >= 6) {
    return getFirstUnfinishedStep(stepStatuses) || 0;
  }
  return numericStep;
}

function normalizeState(rawState = {}) {
  const rawStepStatuses = rawState.stepStatuses || {};
  const legacy = isLegacyFlowState(rawState);
  const stepStatuses = normalizeStepStatuses(rawStepStatuses, {
    legacy,
    localhostUrl: rawState.localhostUrl,
  });
  return {
    ...rawState,
    flowVersion: FLOW_VERSION,
    stepStatuses,
    currentStep: normalizeCurrentStep(rawState.currentStep, rawStepStatuses, stepStatuses, { legacy }),
  };
}

async function getWindowSessionState(windowId) {
  const stored = await chrome.storage.session.get(getWindowStateKey(windowId));
  return normalizeState(stored[getWindowStateKey(windowId)] || {});
}

async function getState(windowId) {
  const state = await getWindowSessionState(windowId);
  return { ...DEFAULT_STATE, ...state };
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

async function setState(windowId, updates) {
  const prevState = await getWindowSessionState(windowId);
  const nextState = {
    ...DEFAULT_STATE,
    ...pickWindowScopedSettings(prevState),
    ...prevState,
    ...updates,
    flowVersion: FLOW_VERSION,
  };
  nextState.autoRunSkipFailures = Boolean(nextState.autoRunSkipFailures);
  nextState.mailProvider = normalizeMailProvider(nextState.mailProvider);
  if (nextState.emailGenerationService !== undefined) {
    nextState.emailGenerationService = normalizeEmailGenerationService(nextState.emailGenerationService);
  }
  if (nextState.stepStatuses) {
    nextState.stepStatuses = normalizeStepStatuses(nextState.stepStatuses, {
      localhostUrl: nextState.localhostUrl,
    });
  }
  if (nextState.currentStep !== undefined) {
    nextState.currentStep = normalizeCurrentStep(
      nextState.currentStep,
      nextState.stepStatuses || DEFAULT_STATE.stepStatuses,
    );
  }
  console.log(LOG_PREFIX, `storage.set window=${windowId}:`, JSON.stringify(nextState).slice(0, 200));
  await chrome.storage.session.set({ [getWindowStateKey(windowId)]: nextState });
}

function normalizeMailProvider(provider) {
  const value = String(provider || '').trim();
  return value || WINDOW_SCOPED_SETTING_DEFAULTS.mailProvider;
}

function normalizeEmailGenerationService(service) {
  const value = String(service || '').trim().toLowerCase();
  return EMAIL_GENERATION_SERVICES.includes(value) ? value : EMAIL_GENERATION_SERVICE_DEFAULT;
}

function normalizeEmailAddress(email) {
  return String(email || '').trim().toLowerCase();
}

function createEmailPoolItemId() {
  return `pool_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizePoolItemStatus(status) {
  return EMAIL_POOL_STATUSES.includes(status) ? status : 'pending';
}

function buildEmptyEmailPool(provider) {
  const normalizedProvider = normalizeMailProvider(provider);
  return {
    version: EMAIL_POOL_VERSION,
    pool: `${normalizedProvider}-pool`,
    mailProvider: normalizedProvider,
    updatedAt: null,
    items: [],
  };
}

function getGenerationPoolKey(service) {
  return `gen:${normalizeEmailGenerationService(service)}`;
}

function getGenerationPoolLabel(service) {
  const normalized = normalizeEmailGenerationService(service);
  if (normalized === 'simplelogin') return 'SimpleLogin';
  if (normalized === 'addy') return 'Addy';
  return 'Duck';
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

function normalizeEmailPoolItem(provider, item = {}, defaults = {}) {
  const normalizedProvider = normalizeMailProvider(item.mailProvider || provider || defaults.mailProvider);
  const normalizedEmail = normalizeEmailAddress(item.email);
  if (!normalizedEmail) {
    return null;
  }

  let status = normalizePoolItemStatus(item.status || defaults.status);
  let claimedWindowId = Number.isInteger(item.claimedWindowId) ? item.claimedWindowId : null;
  let claimedAt = item.claimedAt || null;
  let startedAt = item.startedAt || null;
  if (defaults.resetTransientState && !EMAIL_POOL_TERMINAL_STATUSES.has(status)) {
    status = 'pending';
    claimedWindowId = null;
    claimedAt = null;
    startedAt = null;
  }

  return {
    id: String(item.id || defaults.id || createEmailPoolItemId()),
    email: normalizedEmail,
    mailProvider: normalizedProvider,
    status,
    batchId: item.batchId || defaults.batchId || null,
    claimedWindowId,
    claimedAt,
    startedAt,
    finishedAt: item.finishedAt || null,
    attemptCount: Number.isFinite(Number(item.attemptCount)) ? Math.max(0, Number(item.attemptCount)) : Number(defaults.attemptCount || 0),
    result: item.result || defaults.result || null,
    lastError: item.lastError || defaults.lastError || null,
    source: item.source || defaults.source || 'imported',
  };
}

function normalizeEmailPool(provider, rawPool = {}) {
  const base = buildEmptyEmailPool(provider);
  const normalizedProvider = normalizeMailProvider(rawPool.mailProvider || provider || base.mailProvider);
  const items = Array.isArray(rawPool.items)
    ? rawPool.items.map((item) => normalizeEmailPoolItem(normalizedProvider, item)).filter(Boolean)
    : [];

  return {
    version: Number(rawPool.version) || EMAIL_POOL_VERSION,
    pool: rawPool.pool || base.pool,
    mailProvider: normalizedProvider,
    updatedAt: rawPool.updatedAt || null,
    items,
  };
}

function summarizeEmailPool(pool) {
  const summary = {
    provider: normalizeMailProvider(pool?.mailProvider),
    total: 0,
    pending: 0,
    claimed: 0,
    running: 0,
    success: 0,
    failed: 0,
    abandoned: 0,
    updatedAt: pool?.updatedAt || null,
  };

  for (const status of EMAIL_POOL_STATUSES) {
    summary[status] = 0;
  }

  const items = Array.isArray(pool?.items) ? pool.items : [];
  summary.total = items.length;
  for (const item of items) {
    const status = normalizePoolItemStatus(item?.status);
    summary[status] += 1;
  }

  return summary;
}

async function getEmailPools() {
  const stored = await chrome.storage.local.get(EMAIL_POOL_STORAGE_KEY);
  const pools = stored[EMAIL_POOL_STORAGE_KEY] || {};
  const normalizedPools = {};
  for (const [provider, pool] of Object.entries(pools)) {
    normalizedPools[normalizeMailProvider(provider)] = normalizeEmailPool(provider, pool);
  }
  return normalizedPools;
}

async function setEmailPools(pools) {
  const normalizedPools = {};
  for (const [provider, pool] of Object.entries(pools || {})) {
    const normalizedProvider = normalizeMailProvider(provider);
    normalizedPools[normalizedProvider] = normalizeEmailPool(normalizedProvider, pool);
  }
  await chrome.storage.local.set({ [EMAIL_POOL_STORAGE_KEY]: normalizedPools });
  return normalizedPools;
}

async function getEmailPool(provider) {
  const normalizedProvider = normalizeMailProvider(provider);
  const pools = await getEmailPools();
  return normalizeEmailPool(normalizedProvider, pools[normalizedProvider] || buildEmptyEmailPool(normalizedProvider));
}

async function setEmailPool(provider, pool) {
  const normalizedProvider = normalizeMailProvider(provider);
  const pools = await getEmailPools();
  pools[normalizedProvider] = normalizeEmailPool(normalizedProvider, pool);
  await setEmailPools(pools);
  await broadcastPoolStateToAllWindows();
  return pools[normalizedProvider];
}

async function getAllEmailPoolSummaries() {
  const pools = await getEmailPools();
  const summaries = {};
  for (const provider of Object.keys(pools)) {
    summaries[provider] = summarizeEmailPool(pools[provider]);
  }
  return summaries;
}

async function getEmailPoolSummary(provider) {
  return summarizeEmailPool(await getEmailPool(provider));
}

async function broadcastPoolState(windowId, provider) {
  const state = await getState(windowId);
  const normalizedProvider = normalizeMailProvider(provider || getGenerationPoolKey(state.emailGenerationService));
  const [summary, boundItem, allSummaries] = await Promise.all([
    getEmailPoolSummary(normalizedProvider),
    getBoundPoolItem(windowId),
    getAllEmailPoolSummaries(),
  ]);
  await broadcastDataUpdate(windowId, {
    emailPoolSummary: summary,
    emailPoolSummaries: allSummaries,
    boundPoolItem: boundItem,
    poolBinding: boundItem ? { provider: boundItem.mailProvider, itemId: boundItem.id } : null,
  });
}

async function broadcastPoolStateToAllWindows() {
  const windows = await chrome.windows.getAll();
  await Promise.all(windows.map(async (win) => {
    try {
      await broadcastPoolState(win.id);
    } catch (err) {
      console.warn(LOG_PREFIX, `广播邮箱池状态失败（window=${win.id}）：`, err);
    }
  }));
}

function clonePoolItem(item) {
  return item ? JSON.parse(JSON.stringify(item)) : null;
}

function findPoolItem(pool, itemId) {
  if (!itemId) return null;
  return (pool.items || []).find((item) => item.id === itemId) || null;
}

async function setPoolBinding(windowId, provider, itemId) {
  const binding = provider && itemId
    ? { provider: normalizeMailProvider(provider), itemId: String(itemId) }
    : null;
  await setState(windowId, { poolBinding: binding });
  await broadcastDataUpdate(windowId, { poolBinding: binding });
  return binding;
}

async function clearPoolBinding(windowId, provider = null) {
  await setPoolBinding(windowId, null, null);
  await broadcastDataUpdate(windowId, { boundPoolItem: null });
  if (provider) {
    await broadcastPoolState(windowId, provider);
  }
}

async function getBoundPoolItem(windowId) {
  const state = await getState(windowId);
  const binding = state.poolBinding;
  if (!binding?.provider || !binding?.itemId) {
    return null;
  }

  const pool = await getEmailPool(binding.provider);
  const item = findPoolItem(pool, binding.itemId);
  if (!item) {
    await clearPoolBinding(windowId, binding.provider);
    return null;
  }
  return clonePoolItem(item);
}

async function updateBoundPoolItem(windowId, updater) {
  const state = await getState(windowId);
  const binding = state.poolBinding;
  if (!binding?.provider || !binding?.itemId) {
    return null;
  }

  const pool = await getEmailPool(binding.provider);
  const index = (pool.items || []).findIndex((item) => item.id === binding.itemId);
  if (index < 0) {
    await clearPoolBinding(windowId, binding.provider);
    return null;
  }

  const current = pool.items[index];
  const next = normalizeEmailPoolItem(binding.provider, updater(clonePoolItem(current)) || current, {
    id: current.id,
    source: current.source,
  });
  pool.items[index] = next;
  pool.updatedAt = new Date().toISOString();
  await setEmailPool(binding.provider, pool);
  await broadcastDataUpdate(windowId, { boundPoolItem: next, poolBinding: { provider: binding.provider, itemId: next.id } });
  await broadcastPoolState(windowId, binding.provider);
  return clonePoolItem(next);
}

function createEmailPoolItem(email, provider, extra = {}) {
  return normalizeEmailPoolItem(provider, {
    id: extra.id || createEmailPoolItemId(),
    email,
    mailProvider: provider,
    status: extra.status || 'pending',
    batchId: extra.batchId || null,
    claimedWindowId: extra.claimedWindowId,
    claimedAt: extra.claimedAt,
    startedAt: extra.startedAt,
    finishedAt: extra.finishedAt,
    attemptCount: extra.attemptCount,
    result: extra.result,
    lastError: extra.lastError,
    source: extra.source,
  });
}

async function appendEmailPoolItems(provider, items, options = {}) {
  const normalizedProvider = normalizeMailProvider(provider);
  const pool = await getEmailPool(normalizedProvider);
  const existingKeys = new Set((pool.items || []).map((item) => `${item.mailProvider}::${normalizeEmailAddress(item.email)}`));
  const batchId = options.batchId || `batch_${Date.now().toString(36)}`;
  const appendedItems = [];
  let skippedDuplicates = 0;

  for (const rawItem of Array.isArray(items) ? items : []) {
    const item = normalizeEmailPoolItem(normalizedProvider, rawItem, {
      batchId,
      source: options.source || rawItem?.source || 'imported',
      resetTransientState: Boolean(options.resetTransientState),
    });
    if (!item) continue;
    const dedupeKey = `${item.mailProvider}::${normalizeEmailAddress(item.email)}`;
    if (existingKeys.has(dedupeKey)) {
      skippedDuplicates += 1;
      continue;
    }
    existingKeys.add(dedupeKey);
    pool.items.push(item);
    appendedItems.push(clonePoolItem(item));
  }

  pool.updatedAt = new Date().toISOString();
  const nextPool = await setEmailPool(normalizedProvider, pool);
  return {
    pool: nextPool,
    appendedItems,
    appendedCount: appendedItems.length,
    skippedDuplicates,
    batchId,
    summary: summarizeEmailPool(nextPool),
  };
}

function collectImportedPoolItems(rawData, defaultProvider) {
  const groups = new Map();
  const pushItem = (provider, rawItem) => {
    const normalizedProvider = normalizeMailProvider(provider || defaultProvider);
    if (!groups.has(normalizedProvider)) {
      groups.set(normalizedProvider, []);
    }
    groups.get(normalizedProvider).push(rawItem);
  };

  const handleEntry = (entry, inheritedProvider) => {
    if (!entry) return;
    if (typeof entry === 'string') {
      pushItem(inheritedProvider, { email: entry });
      return;
    }
    if (typeof entry === 'object') {
      if (Array.isArray(entry.items)) {
        for (const item of entry.items) {
          handleEntry(item, entry.mailProvider || inheritedProvider);
        }
        return;
      }
      if (Array.isArray(entry.emails)) {
        for (const item of entry.emails) {
          handleEntry(item, entry.mailProvider || inheritedProvider);
        }
        return;
      }
      if (entry.email) {
        pushItem(entry.mailProvider || inheritedProvider, entry);
      }
    }
  };

  if (Array.isArray(rawData)) {
    for (const item of rawData) {
      handleEntry(item, defaultProvider);
    }
  } else {
    handleEntry(rawData, rawData?.mailProvider || defaultProvider);
  }

  return [...groups.entries()].map(([provider, items]) => ({ provider, items }));
}

async function importEmailPoolData(rawData, defaultProvider) {
  const groups = collectImportedPoolItems(rawData, defaultProvider);
  const results = [];
  for (const group of groups) {
    const result = await appendEmailPoolItems(group.provider, group.items, { source: 'imported', resetTransientState: true });
    results.push({
      provider: group.provider,
      appendedCount: result.appendedCount,
      skippedDuplicates: result.skippedDuplicates,
      summary: result.summary,
    });
  }
  return {
    groups: results,
    summaries: await getAllEmailPoolSummaries(),
  };
}

async function generateEmailPoolItems(windowId, options = {}) {
  const count = Math.max(1, Math.min(100, Number(options.count) || 1));
  const state = await getState(windowId);
  const service = normalizeEmailGenerationService(options.service || state.emailGenerationService);
  const provider = normalizeMailProvider(options.provider || getGenerationPoolKey(service));
  const previousEmail = state.email;
  let lastGeneratedEmail = previousEmail || null;
  let appendedCount = 0;
  let skippedDuplicates = 0;
  let summary = await getEmailPoolSummary(provider);
  let batchId = null;

  for (let index = 0; index < count; index++) {
    const email = await fetchGeneratedEmail(windowId, { generateNew: true, suppressStateUpdate: true, service });
    lastGeneratedEmail = email;

    const result = await appendEmailPoolItems(provider, [createEmailPoolItem(email, provider, {
      source: 'generated',
      batchId,
    })], {
      source: 'generated',
      batchId,
    });

    batchId = batchId || result.batchId;
    appendedCount += result.appendedCount;
    skippedDuplicates += result.skippedDuplicates;
    summary = result.summary;

    await addLog(windowId, `邮箱池：第 ${index + 1}/${count} 条 ${getEmailGenerationServiceLabel(service)} 邮箱已入池 ${email}`, 'info');
  }

  await setEmailState(windowId, previousEmail || null);
  await broadcastPoolState(windowId, provider);
  await addLog(windowId, `邮箱池：${getEmailGenerationServiceLabel(service)} 已追加 ${appendedCount} 条，去重跳过 ${skippedDuplicates} 条。`, 'ok');

  return {
    provider,
    service,
    count,
    lastGeneratedEmail,
    appendedCount,
    skippedDuplicates,
    summary,
    batchId,
  };
}

async function claimNextEmailPoolItem(windowId, provider) {
  return withEmailPoolProviderLock(provider, async (normalizedProvider) => {
    const existingBoundItem = await getBoundPoolItem(windowId);
    if (existingBoundItem) {
      if (normalizeMailProvider(existingBoundItem.mailProvider) !== normalizedProvider) {
        throw new Error('当前窗口已绑定其他邮箱池条目，请先放弃当前条目。');
      }
      await setEmailState(windowId, existingBoundItem.email);
      await broadcastPoolState(windowId, normalizedProvider);
      return existingBoundItem;
    }

    const pool = await getEmailPool(normalizedProvider);
    const nextItem = (pool.items || []).find((item) => normalizePoolItemStatus(item.status) === 'pending');
    if (!nextItem) {
      return null;
    }

    nextItem.status = 'claimed';
    nextItem.claimedWindowId = windowId;
    nextItem.claimedAt = new Date().toISOString();
    nextItem.lastError = null;
    pool.updatedAt = new Date().toISOString();
    await setEmailPool(normalizedProvider, pool);
    await setPoolBinding(windowId, normalizedProvider, nextItem.id);
    await setEmailState(windowId, nextItem.email);
    await broadcastDataUpdate(windowId, { boundPoolItem: nextItem });
    await broadcastPoolState(windowId, normalizedProvider);
    return clonePoolItem(nextItem);
  });
}

async function markBoundPoolItemRunning(windowId) {
  return updateBoundPoolItem(windowId, (item) => {
    if (!item) return item;
    item.status = 'running';
    item.claimedWindowId = windowId;
    item.startedAt = item.startedAt || new Date().toISOString();
    item.attemptCount = (Number(item.attemptCount) || 0) + 1;
    item.lastError = null;
    return item;
  });
}

async function markBoundPoolItemSuccess(windowId, result = null) {
  const binding = (await getState(windowId)).poolBinding;
  const item = await updateBoundPoolItem(windowId, (current) => {
    if (!current) return current;
    current.status = 'success';
    current.finishedAt = new Date().toISOString();
    current.result = result || current.result || null;
    current.lastError = null;
    return current;
  });
  await clearPoolBinding(windowId, binding?.provider || item?.mailProvider || null);
  return item;
}

async function markBoundPoolItemFailed(windowId, error) {
  const binding = (await getState(windowId)).poolBinding;
  const item = await updateBoundPoolItem(windowId, (current) => {
    if (!current) return current;
    current.status = 'failed';
    current.finishedAt = new Date().toISOString();
    current.lastError = getErrorMessage(error);
    return current;
  });
  await clearPoolBinding(windowId, binding?.provider || item?.mailProvider || null);
  return item;
}

async function abandonBoundPoolItem(windowId, reason = '当前条目已放弃。') {
  const binding = (await getState(windowId)).poolBinding;
  const item = await updateBoundPoolItem(windowId, (current) => {
    if (!current) return current;
    current.status = 'abandoned';
    current.finishedAt = new Date().toISOString();
    current.lastError = reason;
    return current;
  });
  await clearPoolBinding(windowId, binding?.provider || item?.mailProvider || null);
  await setEmailState(windowId, null);
  return item;
}

async function bindManualEmailToState(windowId, email, options = {}) {
  const normalizedEmail = normalizeEmailAddress(email);
  const boundItem = await getBoundPoolItem(windowId);
  if (boundItem && (!options.keepBoundItem || normalizedEmail !== normalizeEmailAddress(boundItem.email))) {
    await abandonBoundPoolItem(windowId, options.reason || '当前池条目已被手动替换。');
  }
  await setEmailState(windowId, normalizedEmail || null);
  return normalizedEmail || null;
}

async function buildStateResponse(windowId) {
  const initialState = await getState(windowId);
  const provider = getGenerationPoolKey(initialState.emailGenerationService);
  const [boundPoolItem, emailPoolSummary, emailPoolSummaries] = await Promise.all([
    getBoundPoolItem(windowId),
    getEmailPoolSummary(provider),
    getAllEmailPoolSummaries(),
  ]);
  const state = await getState(windowId);

  return {
    ...state,
    poolBinding: boundPoolItem ? { provider: boundPoolItem.mailProvider, itemId: boundPoolItem.id } : state.poolBinding || null,
    emailPoolSummary,
    emailPoolSummaries,
    boundPoolItem,
  };
}

function broadcastDataUpdate(windowId, payload) {
  return sendWindowMessage(windowId, 'DATA_UPDATED', payload);
}

async function setEmailState(windowId, email) {
  const normalizedEmail = email ? normalizeEmailAddress(email) : null;
  await setState(windowId, { email: normalizedEmail });
  await broadcastDataUpdate(windowId, { email: normalizedEmail });
  if (normalizedEmail) {
    await resumeAutoRunIfWaitingForEmail(windowId);
  }
}

async function setPasswordState(windowId, password) {
  await setState(windowId, { password });
  await broadcastDataUpdate(windowId, { password });
}

async function resetState(windowId) {
  console.log(LOG_PREFIX, `Resetting state for window ${windowId}`);
  const prev = await getWindowSessionState(windowId);
  const boundItem = await getBoundPoolItem(windowId);
  if (boundItem) {
    await abandonBoundPoolItem(windowId, '流程已重置，当前池条目已放弃。');
  }
  await chrome.storage.session.set({
    [getWindowStateKey(windowId)]: {
      ...DEFAULT_STATE,
      ...pickWindowScopedSettings(prev),
      flowVersion: FLOW_VERSION,
      accounts: prev.accounts || [],
      tabRegistry: prev.tabRegistry || {},
      sourceLastUrls: prev.sourceLastUrls || {},
    },
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

async function getTabRegistry(windowId) {
  const state = await getState(windowId);
  return state.tabRegistry || {};
}

async function registerTab(windowId, source, tabId) {
  const registry = await getTabRegistry(windowId);
  registry[source] = { tabId, ready: true };
  await setState(windowId, { tabRegistry: registry });
  console.log(LOG_PREFIX, `Tab registered: window=${windowId} ${source} -> ${tabId}`);
}

async function isTabAlive(windowId, source) {
  const registry = await getTabRegistry(windowId);
  const entry = registry[source];
  if (!entry) return false;
  try {
    const tab = await chrome.tabs.get(entry.tabId);
    return tab?.windowId === windowId;
  } catch {
    // Tab no longer exists — clean up registry
    registry[source] = null;
    await setState(windowId, { tabRegistry: registry });
    return false;
  }
}

async function getTabId(windowId, source) {
  const registry = await getTabRegistry(windowId);
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
  return ['auth0.openai.com', 'auth.openai.com', 'accounts.openai.com'].includes(hostname);
}

function is163MailHost(hostname = '') {
  return hostname === 'mail.163.com'
    || hostname.endsWith('.mail.163.com')
    || hostname === 'webmail.vip.163.com';
}

function isLocalhostOAuthCallbackUrl(rawUrl) {
  const parsed = parseUrlSafely(rawUrl);
  if (!parsed) return false;
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) return false;
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
      return candidate.hostname === 'app.simplelogin.io';
    case 'addy-mail':
      return candidate.hostname === 'app.addy.io';
    case 'qq-mail':
      return candidate.hostname === 'mail.qq.com' || candidate.hostname === 'wx.mail.qq.com';
    case 'mail-163':
      return is163MailHost(candidate.hostname);
    case 'inbucket-mail':
      return Boolean(reference)
        && candidate.origin === reference.origin
        && candidate.pathname.startsWith('/m/');
    case 'vps-panel':
      return Boolean(reference)
        && candidate.origin === reference.origin
        && candidate.pathname === reference.pathname;
    default:
      return false;
  }
}

async function rememberSourceLastUrl(windowId, source, url) {
  if (!source || !url) return;
  const state = await getState(windowId);
  const sourceLastUrls = { ...(state.sourceLastUrls || {}) };
  sourceLastUrls[source] = url;
  await setState(windowId, { sourceLastUrls });
}

async function closeConflictingTabsForSource(windowId, source, currentUrl, options = {}) {
  const { excludeTabIds = [] } = options;
  const excluded = new Set(excludeTabIds.filter(id => Number.isInteger(id)));
  const state = await getState(windowId);
  const lastUrl = state.sourceLastUrls?.[source];
  const referenceUrls = [currentUrl, lastUrl].filter(Boolean);

  if (!referenceUrls.length) return;

  const tabs = await chrome.tabs.query({ windowId });
  const matchedIds = tabs
    .filter((tab) => Number.isInteger(tab.id) && !excluded.has(tab.id))
    .filter((tab) => referenceUrls.some((refUrl) => matchesSourceUrlFamily(source, tab.url, refUrl)))
    .map(tab => tab.id);

  if (!matchedIds.length) return;

  await chrome.tabs.remove(matchedIds).catch(() => { });

  const registry = await getTabRegistry(windowId);
  if (registry[source]?.tabId && matchedIds.includes(registry[source].tabId)) {
    registry[source] = null;
    await setState(windowId, { tabRegistry: registry });
  }

  await addLog(windowId, `已关闭 ${matchedIds.length} 个旧的${getSourceLabel(source)}标签页。`, 'info');
}

async function closeTabsByUrlPrefix(windowId, prefix, options = {}) {
  if (!prefix) return 0;

  const { excludeTabIds = [] } = options;
  const excluded = new Set(excludeTabIds.filter(id => Number.isInteger(id)));
  const tabs = await chrome.tabs.query({ windowId });
  const matchedIds = tabs
    .filter((tab) => Number.isInteger(tab.id) && !excluded.has(tab.id))
    .filter((tab) => typeof tab.url === 'string' && tab.url.startsWith(prefix))
    .map((tab) => tab.id);

  if (!matchedIds.length) return 0;

  await chrome.tabs.remove(matchedIds).catch(() => { });
  await addLog(windowId, `已关闭 ${matchedIds.length} 个匹配 ${prefix} 的 localhost 残留标签页。`, 'info');
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

async function ensureContentScriptReadyOnTab(windowId, source, tabId, options = {}) {
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
    `[ensureContentScriptReadyOnTab] start window=${windowId} ${source} tab=${tabId}, timeout=${timeoutMs}ms, inject=${Array.isArray(inject) ? inject.join(',') : 'none'}`
  );

  while (Date.now() - start < timeoutMs) {
    attempt += 1;
    const pong = await pingContentScriptOnTab(tabId);
    if (pong?.ok && (!pong.source || pong.source === source)) {
      console.log(
        LOG_PREFIX,
        `[ensureContentScriptReadyOnTab] ready window=${windowId} ${source} tab=${tabId} on attempt ${attempt} after ${Date.now() - start}ms`
      );
      await registerTab(windowId, source, tabId);
      return;
    }

    if (!inject || !inject.length) {
      throw new Error(`${getSourceLabel(source)} 内容脚本未就绪，且未提供可用的注入文件。`);
    }

    const registry = await getTabRegistry(windowId);
    if (registry[source]) {
      registry[source].ready = false;
      await setState(windowId, { tabRegistry: registry });
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
        `[ensureContentScriptReadyOnTab] inject attempt ${attempt} failed for window=${windowId} ${source} tab=${tabId}: ${err?.message || err}`
      );
    }

    const pongAfterInject = await pingContentScriptOnTab(tabId);
    if (pongAfterInject?.ok && (!pongAfterInject.source || pongAfterInject.source === source)) {
      console.log(
        LOG_PREFIX,
        `[ensureContentScriptReadyOnTab] ready after inject window=${windowId} ${source} tab=${tabId} on attempt ${attempt} after ${Date.now() - start}ms`
      );
      await registerTab(windowId, source, tabId);
      return;
    }

    if (logMessage && !logged) {
      console.warn(
        LOG_PREFIX,
        `[ensureContentScriptReadyOnTab] window=${windowId} ${source} tab=${tabId} still not ready after ${Date.now() - start}ms`
      );
      await addLog(windowId, logMessage, 'warn');
      logged = true;
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  throw lastError || new Error(`${getSourceLabel(source)} 内容脚本长时间未就绪。`);
}

// ============================================================
// Command Queue (for content scripts not yet ready)
// ============================================================


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
    return Number(message.step) === 7 ? 45000 : 30000;
  }

  if (message.type === 'PREPARE_SIGNUP_VERIFICATION') {
    return 45000;
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

function queueCommand(windowId, source, message, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const pendingCommands = getPendingCommands(windowId);
    const timer = setTimeout(() => {
      pendingCommands.delete(source);
      const err = `Content script on ${source} did not respond in ${timeout / 1000}s. Try refreshing the tab and retry.`;
      console.error(LOG_PREFIX, `window=${windowId}`, err);
      reject(new Error(err));
    }, timeout);
    pendingCommands.set(source, { message, resolve, reject, timer });
    console.log(LOG_PREFIX, `Command queued for window=${windowId} ${source} (waiting for ready)`);
  });
}

function flushCommand(windowId, source, tabId) {
  const pendingCommands = getPendingCommands(windowId);
  const pending = pendingCommands.get(source);
  if (pending) {
    clearTimeout(pending.timer);
    pendingCommands.delete(source);
    sendTabMessageWithTimeout(tabId, source, pending.message).then(pending.resolve).catch(pending.reject);
    console.log(LOG_PREFIX, `Flushed queued command to window=${windowId} ${source} (tab ${tabId})`);
  }
}

function cancelPendingCommands(windowId, reason = STOP_ERROR_MESSAGE) {
  const pendingCommands = getPendingCommands(windowId);
  for (const [source, pending] of pendingCommands.entries()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    pendingCommands.delete(source);
    console.log(LOG_PREFIX, `Cancelled queued command for window=${windowId} ${source}`);
  }
}

// ============================================================
// Reuse or create tab
// ============================================================

async function reuseOrCreateTab(windowId, source, url, options = {}) {
  const shouldActivate = options.activate !== false;
  const alive = await isTabAlive(windowId, source);
  if (alive) {
    const tabId = await getTabId(windowId, source);
    await closeConflictingTabsForSource(windowId, source, url, { excludeTabIds: [tabId] });
    const currentTab = await chrome.tabs.get(tabId);
    const sameUrl = currentTab.url === url;
    const shouldReloadOnReuse = sameUrl && options.reloadIfSameUrl;

    const registry = await getTabRegistry(windowId);
    if (sameUrl) {
      if (shouldActivate) {
        await chrome.tabs.update(tabId, { active: true });
      }
      console.log(LOG_PREFIX, `Reused window=${windowId} tab ${source} (${tabId}) on same URL`);

      if (shouldReloadOnReuse) {
        if (registry[source]) registry[source].ready = false;
        await setState(windowId, { tabRegistry: registry });
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

      if (options.inject) {
        if (registry[source]) registry[source].ready = false;
        await setState(windowId, { tabRegistry: registry });
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

      await rememberSourceLastUrl(windowId, source, url);
      return tabId;
    }

    if (registry[source]) registry[source].ready = false;
    await setState(windowId, { tabRegistry: registry });

    if (shouldActivate) {
      await chrome.tabs.update(tabId, { url, active: true });
    } else {
      await chrome.tabs.update(tabId, { url });
    }
    console.log(LOG_PREFIX, `Reused window=${windowId} tab ${source} (${tabId}), navigated to ${url.slice(0, 60)}`);

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

    await new Promise(r => setTimeout(r, 500));

    await rememberSourceLastUrl(windowId, source, url);
    return tabId;
  }

  await closeConflictingTabsForSource(windowId, source, url);
  const tab = await chrome.tabs.create({ url, active: shouldActivate, windowId });
  console.log(LOG_PREFIX, `Created new window=${windowId} tab ${source} (${tab.id})`);

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

  await rememberSourceLastUrl(windowId, source, url);
  return tab.id;
}

// ============================================================
// Send command to content script (with readiness check)
// ============================================================

async function sendToContentScript(windowId, source, message, options = {}) {
  const messageWithSession = withActiveAutoRunAttemptSession(windowId, message);
  const { responseTimeoutMs = getContentScriptResponseTimeoutMs(messageWithSession) } = options;
  const registry = await getTabRegistry(windowId);
  const entry = registry[source];

  if (!entry || !entry.ready) {
    console.log(LOG_PREFIX, `window=${windowId} ${source} not ready, queuing command`);
    return queueCommand(windowId, source, messageWithSession);
  }

  const alive = await isTabAlive(windowId, source);
  if (!alive) {
    console.log(LOG_PREFIX, `window=${windowId} ${source} tab was closed, queuing command`);
    return queueCommand(windowId, source, messageWithSession);
  }

  console.log(LOG_PREFIX, `Sending to window=${windowId} ${source} (tab ${entry.tabId}):`, messageWithSession.type);
  return sendTabMessageWithTimeout(entry.tabId, source, messageWithSession, responseTimeoutMs);
}

async function sendToContentScriptResilient(windowId, source, message, options = {}) {
  const {
    timeoutMs = 30000,
    retryDelayMs = 600,
    logMessage = '',
    responseTimeoutMs = undefined,
  } = options;
  const start = Date.now();
  let lastError = null;
  let logged = false;
  let attempt = 0;
  const debugLabel = `window=${windowId} ${getMessageDebugLabel(source, message)}`;

  console.log(
    LOG_PREFIX,
    `[sendToContentScriptResilient] start ${debugLabel}, totalTimeout=${timeoutMs}ms, retryDelay=${retryDelayMs}ms`
  );

  while (Date.now() - start < timeoutMs) {
    throwIfStopped(windowId);
    attempt += 1;

    try {
      console.log(
        LOG_PREFIX,
        `[sendToContentScriptResilient] attempt ${attempt} -> ${debugLabel}, elapsed=${Date.now() - start}ms`
      );
      const result = await sendToContentScript(windowId, source, message, { responseTimeoutMs });
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
        await addLog(windowId, logMessage, 'warn');
        logged = true;
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw lastError || new Error(`等待 ${getSourceLabel(source)} 重新就绪超时。`);
}

async function sendToMailContentScriptResilient(windowId, mail, message, options = {}) {
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
    throwIfStopped(windowId);

    try {
      return await sendToContentScript(windowId, mail.source, message, { responseTimeoutMs });
    } catch (err) {
      if (!isRetryableContentScriptTransportError(err)) {
        throw err;
      }

      lastError = err;
      if (!logged) {
        await addLog(windowId, `步骤 ${message.step}：${mail.label} 页面通信异常，正在尝试让邮箱页重新就绪...`, 'warn');
        logged = true;
      }

      if (recoveries >= maxRecoveryAttempts) {
        break;
      }

      recoveries += 1;
      await reuseOrCreateTab(windowId, mail.source, mail.url, {
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

function bumpAutoRunSessionId(windowId) {
  const runtime = getAutoRunRuntime(windowId);
  runtime.sessionId += 1;
  return runtime.sessionId;
}

function isCurrentAutoRunSession(windowId, sessionId) {
  return sessionId === getAutoRunRuntime(windowId).sessionId;
}

function bumpAutoRunAttemptSessionId(windowId) {
  const runtime = getAutoRunRuntime(windowId);
  runtime.attemptSessionId += 1;
  runtime.activeAttemptSessionId = runtime.attemptSessionId;
  return runtime.activeAttemptSessionId;
}

function clearActiveAutoRunAttemptSession(windowId) {
  getAutoRunRuntime(windowId).activeAttemptSessionId = null;
}

function isCurrentAutoRunAttemptSession(windowId, sessionId) {
  const runtime = getAutoRunRuntime(windowId);
  return Number.isInteger(sessionId)
    && Number.isInteger(runtime.activeAttemptSessionId)
    && sessionId === runtime.activeAttemptSessionId;
}

function shouldIgnoreAutoRunAttemptMessage(windowId, message) {
  return Number.isInteger(message?.autoRunAttemptId)
    && !isCurrentAutoRunAttemptSession(windowId, message.autoRunAttemptId);
}

function withActiveAutoRunAttemptSession(windowId, message) {
  const runtime = getAutoRunRuntime(windowId);
  if (!Number.isInteger(runtime.activeAttemptSessionId)) {
    return message;
  }
  return {
    ...message,
    autoRunAttemptId: runtime.activeAttemptSessionId,
  };
}

async function addLog(windowId, message, level = 'info') {
  const state = await getState(windowId);
  const logs = state.logs || [];
  const entry = { message: normalizeUserFacingStepText(message), level, timestamp: Date.now() };
  logs.push(entry);
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  await setState(windowId, { logs });
  await sendWindowMessage(windowId, 'LOG_ENTRY', entry);
}

function getSourceLabel(source) {
  const labels = {
    'sidepanel': '侧边栏',
    'signup-page': '认证页',
    'vps-panel': 'CPA 面板',
    'qq-mail': 'QQ 邮箱',
    'mail-163': '163 邮箱',
    'inbucket-mail': 'Inbucket 邮箱',
    'duck-mail': 'Duck 邮箱',
    'simplelogin-mail': 'SimpleLogin',
    'addy-mail': 'Addy.io',
  };
  return labels[source] || source || '未知来源';
}

// ============================================================
// Step Status Management
// ============================================================

async function setStepStatus(windowId, step, status) {
  const normalizedStep = normalizeFlowStep(step);
  const state = await getState(windowId);
  const statuses = { ...state.stepStatuses };
  statuses[normalizedStep] = status;
  await setState(windowId, { stepStatuses: statuses, currentStep: normalizedStep });
  await sendWindowMessage(windowId, 'STEP_STATUS_CHANGED', { step: normalizedStep, status });
}

function isStopError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return message === STOP_ERROR_MESSAGE;
}

function isRetryableContentScriptTransportError(error) {
  const message = String(typeof error === 'string' ? error : error?.message || '');
  return /back\/forward cache|message channel is closed|Receiving end does not exist|port closed before a response was received|A listener indicated an asynchronous response|did not respond in \d+s/i.test(message);
}

function normalizeUserFacingStepText(text) {
  return String(text || '')
    .replace(/STEP9_OAUTH_TIMEOUT::/g, 'STEP7_OAUTH_TIMEOUT::')
    .replace(/步骤\s*8/g, '步骤 6')
    .replace(/步骤\s*9/g, '步骤 7')
    .replace(/\b[Ss]tep\s*8\b/g, 'Step 6')
    .replace(/\b[Ss]tep\s*9\b/g, 'Step 7');
}

function getErrorMessage(error) {
  return String(typeof error === 'string' ? error : error?.message || '');
}

function isVerificationMailPollingError(error) {
  const message = getErrorMessage(error);
  return /未在 .*邮箱中找到新的匹配邮件|邮箱轮询结束，但未获取到验证码|无法获取新的(?:注册|登录)验证码|页面未能重新就绪|页面通信异常|did not respond in \d+s/i.test(message);
}

function isStep8ContinueStuckError(error) {
  const message = getErrorMessage(error);
  return /连续 \d+ 次点击“继续”仍未触发页面离开 OAuth 同意页/.test(message);
}

function isRestartCurrentAttemptError(error) {
  const message = String(typeof error === 'string' ? error : error?.message || '');
  return /当前邮箱已存在，需要重新开始新一轮|当前流程已进入手机号页面，需要重新开始新一轮|Duck 邮箱自动获取失败，需要重新开始新一轮|认证页进入了手机号页面|点击“继续”后页面跳到了手机号页面|当前页面已进入手机号页面，不是 OAuth 授权同意页/.test(message)
    || isStep8ContinueStuckError(message);
}

function isStep9OAuthTimeoutError(error) {
  const message = String(typeof error === 'string' ? error : error?.message || '');
  return /STEP9_OAUTH_TIMEOUT::|STEP7_OAUTH_TIMEOUT::|认证失败:\s*Timeout waiting for OAuth callback/i.test(message);
}

function isStepDoneStatus(status) {
  return status === 'completed' || status === 'manual_completed' || status === 'skipped';
}

function getFirstUnfinishedStep(statuses = {}) {
  const normalized = normalizeStepStatuses(statuses);
  for (let step = 1; step <= MAX_FLOW_STEP; step++) {
    if (!isStepDoneStatus(normalized[step] || 'pending')) {
      return step;
    }
  }
  return null;
}

function hasSavedProgress(statuses = {}) {
  return Object.values(normalizeStepStatuses(statuses)).some((status) => status !== 'pending');
}

function getDownstreamStateResets(step) {
  if (step <= 1) {
    return {
      oauthUrl: null,
      flowStartTime: null,
      password: null,
      lastEmailTimestamp: null,
      lastSignupCode: null,
      lastLoginCode: null,
      localhostUrl: null,
    };
  }
  if (step === 2) {
    return {
      password: null,
      lastEmailTimestamp: null,
      lastSignupCode: null,
      lastLoginCode: null,
      localhostUrl: null,
    };
  }
  if (step === 3 || step === 4) {
    return {
      lastEmailTimestamp: null,
      lastSignupCode: null,
      lastLoginCode: null,
      localhostUrl: null,
    };
  }
  if (step === 5) {
    return {
      lastLoginCode: null,
      localhostUrl: null,
    };
  }
  if (step === 6) {
    return {
      localhostUrl: null,
    };
  }
  return {};
}

async function invalidateDownstreamAfterStepRestart(windowId, step, options = {}) {
  const normalizedStep = normalizeFlowStep(step);
  const { logLabel = `步骤 ${normalizedStep} 重新执行` } = options;
  const state = await getState(windowId);
  const statuses = normalizeStepStatuses(state.stepStatuses || {});
  const changedSteps = [];

  for (let downstream = normalizedStep + 1; downstream <= MAX_FLOW_STEP; downstream++) {
    if (statuses[downstream] !== 'pending') {
      statuses[downstream] = 'pending';
      changedSteps.push(downstream);
    }
  }

  if (changedSteps.length) {
    await setState(windowId, { stepStatuses: statuses });
    for (const downstream of changedSteps) {
      await sendWindowMessage(windowId, 'STEP_STATUS_CHANGED', { step: downstream, status: 'pending' });
    }
    await addLog(windowId, `${logLabel}，已重置后续步骤状态：${changedSteps.join(', ')}`, 'warn');
  }

  const resets = getDownstreamStateResets(normalizedStep);
  if (Object.keys(resets).length) {
    await setState(windowId, resets);
    await broadcastDataUpdate(windowId, resets);
  }
}

function clearStopRequest(windowId) {
  stopRequestedByWindow.delete(windowId);
}

function cleanupWindowRuntime(windowId) {
  pendingCommandsByWindow.delete(windowId);
  stepWaitersByWindow.delete(windowId);
  resumeWaitersByWindow.delete(windowId);
  stopRequestedByWindow.delete(windowId);
  autoRunRuntimeByWindow.delete(windowId);
  clearStep8Listener(windowId);
}

function getAutoRunStatusPayload(windowId, phase, payload = {}) {
  const runtime = getAutoRunRuntime(windowId);
  const currentRun = payload.currentRun ?? runtime.currentRun;
  const totalRuns = payload.totalRuns ?? runtime.totalRuns;
  const attemptRun = payload.attemptRun ?? runtime.attemptRun;
  const autoRunning = phase === 'running' || phase === 'waiting_email' || phase === 'retrying';

  runtime.currentRun = currentRun;
  runtime.totalRuns = totalRuns;
  runtime.attemptRun = attemptRun;
  runtime.active = autoRunning;

  return {
    autoRunning,
    autoRunPhase: phase,
    autoRunCurrentRun: currentRun,
    autoRunTotalRuns: totalRuns,
    autoRunAttemptRun: attemptRun,
  };
}

async function broadcastAutoRunStatus(windowId, phase, payload = {}) {
  const runtime = getAutoRunRuntime(windowId);
  const statusPayload = {
    phase,
    currentRun: payload.currentRun ?? runtime.currentRun,
    totalRuns: payload.totalRuns ?? runtime.totalRuns,
    attemptRun: payload.attemptRun ?? runtime.attemptRun,
  };

  await setState(windowId, getAutoRunStatusPayload(windowId, phase, statusPayload));
  await sendWindowMessage(windowId, 'AUTO_RUN_STATUS', statusPayload);
}

function isAutoRunLockedState(state) {
  return Boolean(state.autoRunning) && (state.autoRunPhase === 'running' || state.autoRunPhase === 'retrying');
}

function isAutoRunPausedState(state) {
  return Boolean(state.autoRunning) && state.autoRunPhase === 'waiting_email';
}

async function ensureManualInteractionAllowed(windowId, actionLabel) {
  const state = await getState(windowId);

  if (isAutoRunLockedState(state)) {
    throw new Error(`自动流程运行中，请先停止后再${actionLabel}。`);
  }
  if (isAutoRunPausedState(state)) {
    throw new Error(`自动流程当前已暂停。请点击“继续”，或先确认接管自动流程后再${actionLabel}。`);
  }

  return state;
}

async function skipStep(windowId, step) {
  const state = await ensureManualInteractionAllowed(windowId, '跳过步骤');
  const normalizedStep = normalizeFlowStep(step);

  if (!Number.isInteger(normalizedStep) || normalizedStep < 1 || normalizedStep > MAX_FLOW_STEP) {
    throw new Error(`无效步骤：${step}`);
  }

  const statuses = normalizeStepStatuses(state.stepStatuses || {});
  const currentStatus = statuses[normalizedStep];
  if (currentStatus === 'running') {
    throw new Error(`步骤 ${normalizedStep} 正在运行中，不能跳过。`);
  }
  if (isStepDoneStatus(currentStatus)) {
    throw new Error(`步骤 ${normalizedStep} 已完成，无需再跳过。`);
  }

  if (normalizedStep > 1) {
    const prevStatus = statuses[normalizedStep - 1];
    if (!isStepDoneStatus(prevStatus)) {
      throw new Error(`请先完成步骤 ${normalizedStep - 1}，再跳过步骤 ${normalizedStep}。`);
    }
  }

  await setStepStatus(windowId, normalizedStep, 'skipped');
  await addLog(windowId, `步骤 ${normalizedStep} 已跳过`, 'warn');

  if (normalizedStep === 1) {
    const latestState = await getState(windowId);
    const step2Status = latestState.stepStatuses?.[2];
    if (!isStepDoneStatus(step2Status) && step2Status !== 'running') {
      await setStepStatus(windowId, 2, 'skipped');
      await addLog(windowId, '步骤 1 已跳过，步骤 2 也已同时跳过。', 'warn');
    }
  }

  return { ok: true, step: normalizedStep, status: 'skipped' };
}

function throwIfStopped(windowId) {
  if (isStopRequested(windowId)) {
    throw new Error(STOP_ERROR_MESSAGE);
  }
}

async function sleepWithStop(windowId, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    throwIfStopped(windowId);
    await new Promise(r => setTimeout(r, Math.min(100, ms - (Date.now() - start))));
  }
}

async function humanStepDelay(windowId, min = HUMAN_STEP_DELAY_MIN, max = HUMAN_STEP_DELAY_MAX) {
  const duration = Math.floor(Math.random() * (max - min + 1)) + min;
  await sleepWithStop(windowId, duration);
}

async function clickWithDebugger(tabId, rect) {
  if (!tabId) {
    throw new Error('未找到用于调试点击的认证页面标签页。');
  }
  if (!rect || !Number.isFinite(rect.centerX) || !Number.isFinite(rect.centerY)) {
    throw new Error('步骤 6 的调试器兜底点击需要有效的按钮坐标。');
  }

  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    throw new Error(
      `步骤 6 的调试器兜底点击附加失败：${err.message}。` +
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

async function broadcastStopToContentScripts(windowId) {
  const registry = await getTabRegistry(windowId);
  for (const entry of Object.values(registry)) {
    if (!entry?.tabId) continue;
    try {
      const tab = await chrome.tabs.get(entry.tabId);
      if (!tab || tab.windowId !== windowId) continue;
      await chrome.tabs.sendMessage(entry.tabId, withActiveAutoRunAttemptSession(windowId, {
        type: 'STOP_FLOW',
        source: 'background',
        payload: {},
      }));
    } catch { }
  }
}

async function clearTabRegistrySources(windowId, sources = []) {
  const uniqueSources = [...new Set(sources.filter(Boolean))];
  if (!uniqueSources.length) return;
  const registry = await getTabRegistry(windowId);
  let changed = false;
  for (const source of uniqueSources) {
    if (registry[source]) {
      registry[source] = null;
      changed = true;
    }
  }
  if (changed) {
    await setState(windowId, { tabRegistry: registry });
  }
}

async function abandonCurrentAutoRunAttempt(windowId, { targetRun, totalRuns, attemptRun, reason, mailSource }) {
  const boundItem = await getBoundPoolItem(windowId);
  if (boundItem) {
    await abandonBoundPoolItem(windowId, reason || '当前尝试已放弃。');
  }

  cancelPendingCommands(windowId, reason || '当前尝试已放弃。');
  await broadcastStopToContentScripts(windowId);
  await markRunningStepsStopped(windowId);

  const state = await getState(windowId);
  const sourcesToClose = ['signup-page'];
  if (mailSource) {
    sourcesToClose.push(mailSource);
  }

  for (const source of sourcesToClose) {
    const tabId = await getTabId(windowId, source);
    if (tabId) {
      await chrome.tabs.remove(tabId).catch(() => { });
    }
  }

  const signupReferenceUrl = state.oauthUrl || state.sourceLastUrls?.['signup-page'] || 'https://auth.openai.com/';
  await closeConflictingTabsForSource(windowId, 'signup-page', signupReferenceUrl).catch(() => { });

  if (mailSource) {
    const mail = getMailConfig(state);
    if (!mail.error && mail.source === mailSource && mail.url) {
      await closeConflictingTabsForSource(windowId, mailSource, mail.url).catch(() => { });
    }
  }

  await clearTabRegistrySources(windowId, sourcesToClose);
  clearActiveAutoRunAttemptSession(windowId);
  await broadcastAutoRunStatus(windowId, 'retrying', {
    currentRun: targetRun,
    totalRuns,
    attemptRun,
  });
}


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

chrome.windows.onRemoved.addListener((windowId) => {
  cleanupWindowRuntime(windowId);
});

async function handleMessage(message, sender) {
  const windowId = requireWindowId(message, sender);
  switch (message.type) {
    case 'CONTENT_SCRIPT_READY': {
      const tabId = sender.tab?.id;
      if (tabId && message.source) {
        await registerTab(windowId, message.source, tabId);
        flushCommand(windowId, message.source, tabId);
        await addLog(windowId, `内容脚本已就绪：${getSourceLabel(message.source)}（标签页 ${tabId}）`);
      }
      return { ok: true };
    }

    case 'LOG': {
      if (shouldIgnoreAutoRunAttemptMessage(windowId, message)) {
        console.log(LOG_PREFIX, `Ignored stale LOG from window=${windowId} ${message.source}`, message);
        return { ok: true, ignored: true };
      }
      const { message: msg, level } = message.payload;
      await addLog(windowId, `[${getSourceLabel(message.source)}] ${msg}`, level);
      return { ok: true };
    }

    case 'STEP_COMPLETE': {
      if (shouldIgnoreAutoRunAttemptMessage(windowId, message)) {
        console.log(LOG_PREFIX, `Ignored stale STEP_COMPLETE for window=${windowId} step ${message.step} from ${message.source}`, message);
        return { ok: true, ignored: true };
      }
      const step = normalizeFlowStep(message.step);
      if (isStopRequested(windowId)) {
        await setStepStatus(windowId, step, 'stopped');
        notifyStepError(windowId, step, STOP_ERROR_MESSAGE);
        return { ok: true };
      }
      await setStepStatus(windowId, step, 'completed');
      await addLog(windowId, `步骤 ${step} 已完成`, 'ok');
      await handleStepData(windowId, step, message.payload);
      if (step === MAX_FLOW_STEP) {
        const state = await getState(windowId);
        const boundItem = await getBoundPoolItem(windowId);
        if (boundItem) {
          await markBoundPoolItemSuccess(windowId, {
            email: boundItem.email,
            localhostUrl: state.localhostUrl,
            completedAt: new Date().toISOString(),
          });
          await setEmailState(windowId, null);
        }
      }
      notifyStepComplete(windowId, step, message.payload);
      return { ok: true };
    }

    case 'STEP_ERROR': {
      if (shouldIgnoreAutoRunAttemptMessage(windowId, message)) {
        console.log(LOG_PREFIX, `Ignored stale STEP_ERROR for window=${windowId} step ${message.step} from ${message.source}`, message);
        return { ok: true, ignored: true };
      }
      const step = normalizeFlowStep(message.step);
      if (isStopError(message.error)) {
        await setStepStatus(windowId, step, 'stopped');
        await addLog(windowId, `步骤 ${step} 已被用户停止`, 'warn');
        notifyStepError(windowId, step, message.error);
      } else {
        if (await getBoundPoolItem(windowId)) {
          await markBoundPoolItemFailed(windowId, message.error);
          await setEmailState(windowId, null);
        }
        await setStepStatus(windowId, step, 'failed');
        await addLog(windowId, `步骤 ${step} 失败：${normalizeUserFacingStepText(message.error)}`, 'error');
        notifyStepError(windowId, step, message.error);
      }
      return { ok: true };
    }

    case 'GET_STATE': {
      return await buildStateResponse(windowId);
    }

    case 'RESET': {
      clearStopRequest(windowId);
      clearStep8Listener(windowId);
      await resetState(windowId);
      await addLog(windowId, '流程已重置', 'info');
      return { ok: true };
    }

    case 'EXECUTE_STEP': {
      clearStopRequest(windowId);
      if (message.source === 'sidepanel') {
        await ensureManualInteractionAllowed(windowId, '手动执行步骤');
      }
      const step = normalizeFlowStep(message.payload.step);
      if (message.source === 'sidepanel') {
        await invalidateDownstreamAfterStepRestart(windowId, step, { logLabel: `步骤 ${step} 重新执行` });
      }
      if (message.payload.email) {
        await bindManualEmailToState(windowId, message.payload.email, {
          reason: '当前池条目已被手动执行邮箱覆盖。',
          keepBoundItem: step === 3,
        });
      }
      if (step === 3) {
        await setState(windowId, { emailGenerationService: normalizeEmailGenerationService((await getState(windowId)).emailGenerationService) });
      }
      await executeStep(windowId, step);
      return { ok: true };
    }

    case 'AUTO_RUN': {
      clearStopRequest(windowId);
      const totalRuns = message.payload?.totalRuns || 1;
      const autoRunSkipFailures = Boolean(message.payload?.autoRunSkipFailures);
      const mode = message.payload?.mode === 'continue' ? 'continue' : 'restart';
      await setState(windowId, { autoRunSkipFailures });
      autoRunLoop(windowId, totalRuns, { autoRunSkipFailures, mode });
      return { ok: true };
    }

    case 'RESUME_AUTO_RUN': {
      clearStopRequest(windowId);
      if (message.payload.email) {
        await setEmailState(windowId, message.payload.email);
      }
      resumeAutoRun(windowId);
      return { ok: true };
    }

    case 'TAKEOVER_AUTO_RUN': {
      await requestStop(windowId, { logMessage: '已确认手动接管，正在停止自动流程并切换为手动控制...' });
      await addLog(windowId, '自动流程已切换为手动控制。', 'warn');
      return { ok: true };
    }

    case 'SKIP_STEP': {
      const step = Number(message.payload?.step);
      return await skipStep(windowId, step);
    }

    case 'SAVE_SETTING': {
      const updates = {};
      if (message.payload.vpsUrl !== undefined) updates.vpsUrl = message.payload.vpsUrl;
      if (message.payload.vpsPassword !== undefined) updates.vpsPassword = message.payload.vpsPassword;
      if (message.payload.customPassword !== undefined) updates.customPassword = message.payload.customPassword;
      if (message.payload.autoRunSkipFailures !== undefined) updates.autoRunSkipFailures = Boolean(message.payload.autoRunSkipFailures);
      if (message.payload.mailProvider !== undefined) updates.mailProvider = message.payload.mailProvider;
      if (message.payload.emailGenerationService !== undefined) updates.emailGenerationService = message.payload.emailGenerationService;
      if (message.payload.inbucketHost !== undefined) updates.inbucketHost = message.payload.inbucketHost;
      if (message.payload.inbucketMailbox !== undefined) updates.inbucketMailbox = message.payload.inbucketMailbox;
      await setState(windowId, updates);
      if (updates.mailProvider !== undefined) {
        await broadcastDataUpdate(windowId, { mailProvider: normalizeMailProvider(updates.mailProvider) });
      }
      if (updates.emailGenerationService !== undefined) {
        await broadcastDataUpdate(windowId, { emailGenerationService: normalizeEmailGenerationService(updates.emailGenerationService) });
        await broadcastPoolState(windowId);
      }
      return { ok: true };
    }

    case 'SAVE_EMAIL': {
      const state = await getState(windowId);
      if (isAutoRunLockedState(state)) {
        throw new Error('自动流程运行中，当前不能手动修改邮箱。');
      }
      const email = await bindManualEmailToState(windowId, message.payload.email, {
        reason: '当前池条目已被手动邮箱覆盖。',
      });
      await resumeAutoRun(windowId);
      return { ok: true, email };
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
      clearStopRequest(windowId);
      const state = await getState(windowId);
      if (isAutoRunLockedState(state)) {
        throw new Error('自动流程运行中，当前不能手动获取邮箱。');
      }
      const email = await fetchGeneratedEmail(windowId, message.payload || {});
      await resumeAutoRun(windowId);
      return { ok: true, email };
    }

    case 'GET_EMAIL_POOL_SUMMARY': {
      const state = await getState(windowId);
      const provider = normalizeMailProvider(message.payload?.provider || state.mailProvider);
      const [summary, summaries, boundPoolItem] = await Promise.all([
        getEmailPoolSummary(provider),
        getAllEmailPoolSummaries(),
        getBoundPoolItem(windowId),
      ]);
      return { ok: true, provider, summary, summaries, boundPoolItem };
    }

    case 'IMPORT_EMAIL_POOL': {
      const state = await getState(windowId);
      const result = await importEmailPoolData(message.payload?.data, message.payload?.provider || state.mailProvider);
      await broadcastPoolState(windowId, message.payload?.provider || state.mailProvider);
      return { ok: true, ...result };
    }

    case 'EXPORT_EMAIL_POOL': {
      const state = await getState(windowId);
      const provider = normalizeMailProvider(message.payload?.provider || state.mailProvider);
      const pool = await getEmailPool(provider);
      return { ok: true, provider, pool };
    }

    case 'GENERATE_POOL_EMAILS': {
      clearStopRequest(windowId);
      const state = await getState(windowId);
      if (isAutoRunLockedState(state)) {
        throw new Error('自动流程运行中，当前不能批量生成邮箱池。');
      }
      const result = await generateEmailPoolItems(windowId, message.payload || {});
      return { ok: true, ...result };
    }

    case 'CLAIM_NEXT_POOL_ITEM': {
      const state = await getState(windowId);
      if (isAutoRunLockedState(state)) {
        throw new Error('自动流程运行中，当前不能手动领取邮箱池条目。');
      }
      const provider = normalizeMailProvider(message.payload?.provider || state.mailProvider);
      const item = await claimNextEmailPoolItem(windowId, provider);
      const summaries = await getAllEmailPoolSummaries();
      if (!item) {
        return {
          ok: true,
          provider,
          item: null,
          summary: await getEmailPoolSummary(provider),
          summaries,
        };
      }
      return {
        ok: true,
        provider,
        item,
        summary: await getEmailPoolSummary(provider),
        summaries,
      };
    }

    case 'ABANDON_CURRENT_POOL_ITEM': {
      const state = await getState(windowId);
      if (isAutoRunLockedState(state)) {
        throw new Error('自动流程运行中，当前不能手动放弃邮箱池条目。');
      }
      const item = await abandonBoundPoolItem(windowId, message.payload?.reason || '已手动放弃当前邮箱池条目。');
      return { ok: true, item };
    }

    case 'STOP_FLOW': {
      await requestStop(windowId);
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

async function handleStepData(windowId, step, payload) {
  const normalizedStep = normalizeFlowStep(step);
  switch (normalizedStep) {
    case 1:
      if (payload.oauthUrl) {
        await setState(windowId, { oauthUrl: payload.oauthUrl });
        await broadcastDataUpdate(windowId, { oauthUrl: payload.oauthUrl });
      }
      break;
    case 3:
      if (payload.email) await setEmailState(windowId, payload.email);
      break;
    case 4:
      if (payload.emailTimestamp) await setState(windowId, { lastEmailTimestamp: payload.emailTimestamp });
      break;
    case 6:
      if (payload.localhostUrl) {
        if (!isLocalhostOAuthCallbackUrl(payload.localhostUrl)) {
          throw new Error('步骤 6 返回了无效的 localhost OAuth 回调地址。');
        }
        await setState(windowId, { localhostUrl: payload.localhostUrl });
        await broadcastDataUpdate(windowId, { localhostUrl: payload.localhostUrl });
      }
      break;
    case 7: {
      const localhostPrefix = buildLocalhostCleanupPrefix(payload.localhostUrl);
      if (localhostPrefix) {
        await closeTabsByUrlPrefix(windowId, localhostPrefix);
      }
      break;
    }
  }
}

// ============================================================
// Step Completion Waiting
// ============================================================

const AUTO_RUN_SIGNAL_COMPLETION_TIMEOUT_MS = 120000;
const AUTO_RUN_BACKGROUND_COMPLETED_STEPS = new Set([4, 6]);

function waitForStepComplete(windowId, step, timeoutMs = 120000) {
  const normalizedStep = normalizeFlowStep(step);
  const stepWaiters = getStepWaiters(windowId);
  return new Promise((resolve, reject) => {
    throwIfStopped(windowId);
    if (stepWaiters.has(normalizedStep)) {
      console.warn(LOG_PREFIX, `[waitForStepComplete] replacing existing waiter for window=${windowId} step ${normalizedStep}`);
    }
    console.log(LOG_PREFIX, `[waitForStepComplete] register window=${windowId} step ${normalizedStep}, timeout=${timeoutMs}ms`);
    const timer = setTimeout(() => {
      stepWaiters.delete(normalizedStep);
      console.warn(LOG_PREFIX, `[waitForStepComplete] timeout for window=${windowId} step ${normalizedStep} after ${timeoutMs}ms`);
      reject(new Error(`Step ${normalizedStep} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    stepWaiters.set(normalizedStep, {
      resolve: (data) => { clearTimeout(timer); stepWaiters.delete(normalizedStep); resolve(data); },
      reject: (err) => { clearTimeout(timer); stepWaiters.delete(normalizedStep); reject(err); },
    });
  });
}

function notifyStepComplete(windowId, step, payload) {
  const normalizedStep = normalizeFlowStep(step);
  const waiter = getStepWaiters(windowId).get(normalizedStep);
  console.log(LOG_PREFIX, `[notifyStepComplete] window=${windowId} step ${normalizedStep}, hasWaiter=${Boolean(waiter)}`);
  if (waiter) waiter.resolve(payload);
}

function notifyStepError(windowId, step, error) {
  const normalizedStep = normalizeFlowStep(step);
  const waiter = getStepWaiters(windowId).get(normalizedStep);
  console.warn(LOG_PREFIX, `[notifyStepError] window=${windowId} step ${normalizedStep}, hasWaiter=${Boolean(waiter)}, error=${error}`);
  if (waiter) waiter.reject(new Error(normalizeUserFacingStepText(error)));
}

async function completeStepFromBackground(windowId, step, payload = {}) {
  const normalizedStep = normalizeFlowStep(step);
  if (isStopRequested(windowId)) {
    await setStepStatus(windowId, normalizedStep, 'stopped');
    notifyStepError(windowId, normalizedStep, STOP_ERROR_MESSAGE);
    return;
  }

  await setStepStatus(windowId, normalizedStep, 'completed');
  await addLog(windowId, `步骤 ${normalizedStep} 已完成`, 'ok');
  await handleStepData(windowId, normalizedStep, payload);
  if (normalizedStep === MAX_FLOW_STEP) {
    const state = await getState(windowId);
    const boundItem = await getBoundPoolItem(windowId);
    if (boundItem) {
      await markBoundPoolItemSuccess(windowId, {
        email: boundItem.email,
        localhostUrl: state.localhostUrl,
        completedAt: new Date().toISOString(),
      });
      await setEmailState(windowId, null);
    }
  }
  notifyStepComplete(windowId, normalizedStep, payload);
}

async function markRunningStepsStopped(windowId) {
  const state = await getState(windowId);
  const runningSteps = Object.entries(state.stepStatuses || {})
    .filter(([, status]) => status === 'running')
    .map(([step]) => Number(step));

  for (const step of runningSteps) {
    await setStepStatus(windowId, step, 'stopped');
  }
}

async function requestStop(windowId, options = {}) {
  const { logMessage = '已收到停止请求，正在取消当前操作...' } = options;
  if (isStopRequested(windowId)) return;

  stopRequestedByWindow.add(windowId);
  cancelPendingCommands(windowId);
  clearStep8Listener(windowId);

  await addLog(windowId, logMessage, 'warn');
  await broadcastStopToContentScripts(windowId);

  const stepWaiters = getStepWaiters(windowId);
  for (const waiter of stepWaiters.values()) {
    waiter.reject(new Error(STOP_ERROR_MESSAGE));
  }
  stepWaiters.clear();

  const resumeWaiter = getResumeWaiter(windowId);
  if (resumeWaiter) {
    resumeWaiter.reject(new Error(STOP_ERROR_MESSAGE));
    setResumeWaiter(windowId, null);
  }

  await markRunningStepsStopped(windowId);
  clearActiveAutoRunAttemptSession(windowId);
  getAutoRunRuntime(windowId).active = false;
  await broadcastAutoRunStatus(windowId, 'stopped', {
    currentRun: getAutoRunRuntime(windowId).currentRun,
    totalRuns: getAutoRunRuntime(windowId).totalRuns,
    attemptRun: getAutoRunRuntime(windowId).attemptRun,
  });
}

// ============================================================
// Step Execution
// ============================================================

async function executeStep(windowId, step) {
  const normalizedStep = normalizeFlowStep(step);
  console.log(LOG_PREFIX, `Executing window=${windowId} step ${normalizedStep}`);
  throwIfStopped(windowId);
  await setStepStatus(windowId, normalizedStep, 'running');
  await addLog(windowId, `步骤 ${normalizedStep} 开始执行`);
  if (normalizedStep === 6) {
    await sleepWithStop(windowId, 900);
  } else {
    await humanStepDelay(windowId);
  }

  const state = await getState(windowId);

  if (normalizedStep === 1 && !state.flowStartTime) {
    await setState(windowId, { flowStartTime: Date.now() });
  }

  try {
    switch (normalizedStep) {
      case 1: await executeStep1(windowId, state); break;
      case 2: await executeStep2(windowId, state); break;
      case 3: await executeStep3(windowId, state); break;
      case 4: await executeStep4(windowId, state); break;
      case 5: await executeStep5(windowId, state); break;
      case 6: await executeStep8(windowId, state); break;
      case 7: await executeStep9(windowId, state); break;
      default:
        throw new Error(`未知步骤：${normalizedStep}`);
    }
  } catch (err) {
    if (isStopError(err)) {
      await setStepStatus(windowId, normalizedStep, 'stopped');
      await addLog(windowId, `步骤 ${normalizedStep} 已被用户停止`, 'warn');
      throw err;
    }
    if (await getBoundPoolItem(windowId)) {
      await markBoundPoolItemFailed(windowId, err);
      await setEmailState(windowId, null);
    }
    await setStepStatus(windowId, normalizedStep, 'failed');
    await addLog(windowId, `步骤 ${normalizedStep} 失败：${normalizeUserFacingStepText(err.message)}`, 'error');
    throw new Error(normalizeUserFacingStepText(err.message));
  }
}

/**
 * Execute a step and wait for it to complete before returning.
 * @param {number} step
 * @param {number} delayAfter - ms to wait after completion (for page transitions)
 */
async function executeStepAndWait(windowId, step, delayAfter = 2000) {
  throwIfStopped(windowId);

  if (AUTO_RUN_BACKGROUND_COMPLETED_STEPS.has(step)) {
    await addLog(windowId, `自动运行：步骤 ${step} 由后台流程负责收尾，执行函数返回后将直接进入下一步。`, 'info');
    await executeStep(windowId, step);
    const latestState = await getState(windowId);
    await addLog(windowId, `自动运行：步骤 ${step} 已执行返回，当前状态为 ${latestState.stepStatuses?.[step] || 'pending'}，准备继续后续步骤。`, 'info');
  } else {
    await addLog(windowId, `自动运行：步骤 ${step} 已发起，正在等待完成信号（超时 ${AUTO_RUN_SIGNAL_COMPLETION_TIMEOUT_MS / 1000} 秒）。`, 'info');
    const completionResultPromise = waitForStepComplete(windowId, step, AUTO_RUN_SIGNAL_COMPLETION_TIMEOUT_MS).then(
      payload => ({ ok: true, payload }),
      error => ({ ok: false, error }),
    );

    try {
      await executeStep(windowId, step);
    } catch (err) {
      notifyStepError(windowId, step, getErrorMessage(err));
      await completionResultPromise;
      throw err;
    }

    const completionResult = await completionResultPromise;
    if (!completionResult.ok) {
      throw completionResult.error;
    }

    await addLog(windowId, `自动运行：步骤 ${step} 已收到完成信号，准备继续后续步骤。`, 'info');
  }

  if (delayAfter > 0) {
    await sleepWithStop(windowId, delayAfter + Math.floor(Math.random() * 1200));
  }
}

async function fetchDuckEmail(windowId, options = {}) {
  throwIfStopped(windowId);
  const { generateNew = true, suppressStateUpdate = false } = options;

  await addLog(windowId, `[调试] Duck fetch start｜${JSON.stringify({ windowId, generateNew, suppressStateUpdate, url: DUCK_AUTOFILL_URL })}`);
  await addLog(windowId, `Duck 邮箱：正在打开自动填充设置（${generateNew ? '生成新地址' : '复用当前地址'}）...`);
  await reuseOrCreateTab(windowId, 'duck-mail', DUCK_AUTOFILL_URL);

  const result = await sendToContentScriptResilient(windowId, 'duck-mail', {
    type: 'FETCH_DUCK_EMAIL',
    source: 'background',
    payload: {
      generateNew,
      maxGenerateAttempts: generateNew ? 4 : 1,
    },
  }, {
    timeoutMs: generateNew ? 150000 : 45000,
    retryDelayMs: 1000,
    logMessage: 'Duck 邮箱页面通信异常，正在等待页面恢复后继续生成...',
  });

  if (result?.error) {
    await addLog(windowId, `[调试] Duck fetch error｜${JSON.stringify({ windowId, error: result.error })}`, 'warn');
    throw new Error(result.error);
  }
  if (!result?.email) {
    await addLog(windowId, `[调试] Duck fetch empty result｜${JSON.stringify({ windowId, result })}`, 'warn');
    throw new Error('未返回 Duck 邮箱地址。');
  }

  if (!suppressStateUpdate) {
    await setEmailState(windowId, result.email);
  }
  await addLog(windowId, `[调试] Duck fetch result｜${JSON.stringify({ windowId, email: result.email, generated: Boolean(result.generated) })}`);
  await addLog(windowId, `Duck 邮箱：${result.generated ? '已生成' : '已读取'} ${result.email}`, 'ok');
  return result.email;
}

async function fetchGeneratedEmail(windowId, options = {}) {
  const state = await getState(windowId);
  const service = normalizeEmailGenerationService(options.service || state.emailGenerationService);
  await addLog(windowId, `[调试] Generated email request｜${JSON.stringify({ windowId, requestedService: options.service || null, resolvedService: service, stateService: state.emailGenerationService || null, generateNew: options.generateNew !== false, suppressStateUpdate: Boolean(options.suppressStateUpdate) })}`);
  if (isDuckMailGenerationService(service)) {
    return fetchDuckEmail(windowId, options);
  }

  throwIfStopped(windowId);
  const { generateNew = true, suppressStateUpdate = false } = options;
  const config = getEmailGenerationServiceConfig(service);
  const injectFiles = ['content/utils.js', `content/${config.source}.js`];

  await addLog(windowId, `[调试] Generated email config｜${JSON.stringify({ windowId, service, source: config.source, url: config.url, injectFiles })}`);
  await addLog(windowId, `${config.logLabel}：正在打开页面（${generateNew ? '生成新地址' : '读取当前地址'}）...`);
  const tabId = await reuseOrCreateTab(windowId, config.source, config.url);
  await ensureContentScriptReadyOnTab(windowId, config.source, tabId, {
    inject: injectFiles,
    injectSource: config.source,
    timeoutMs: generateNew ? 90000 : 45000,
    retryDelayMs: 1000,
    logMessage: `${config.logLabel} 页面通信异常，正在等待页面恢复后继续生成...`,
  });

  const result = await sendToContentScriptResilient(windowId, config.source, {
    type: 'FETCH_GENERATED_EMAIL',
    source: 'background',
    payload: {
      generateNew,
      service,
    },
  }, {
    timeoutMs: generateNew ? 90000 : 45000,
    retryDelayMs: 1000,
    logMessage: `${config.logLabel} 页面通信异常，正在等待页面恢复后继续生成...`,
  });

  await addLog(windowId, `[调试] Generated email raw result｜${JSON.stringify({ windowId, service, result })}`);
  if (result?.error) {
    await addLog(windowId, `[调试] Generated email error｜${JSON.stringify({ windowId, service, error: result.error })}`, 'warn');
    throw new Error(result.error);
  }
  if (!result?.email) {
    await addLog(windowId, `[调试] Generated email empty result｜${JSON.stringify({ windowId, service, result })}`, 'warn');
    throw new Error(`未返回 ${config.label} 邮箱地址。`);
  }

  if (!suppressStateUpdate) {
    await setEmailState(windowId, result.email);
  }
  await addLog(windowId, `[调试] Generated email final｜${JSON.stringify({ windowId, service, email: result.email, generated: Boolean(result.generated) })}`);
  await addLog(windowId, `${config.logLabel}：${result.generated ? '已生成' : '已读取'} ${result.email}`, 'ok');
  return result.email;
}

// ============================================================
// Auto Run Flow
// ============================================================

const GENERATED_EMAIL_MAX_ATTEMPTS = 5;
const VERIFICATION_POLL_MAX_ROUNDS = 5;
const VERIFICATION_MAIL_RECOVERY_GRACE_MS = 30000;
const GENERATED_EMAIL_RESTART_ERROR_MESSAGE = '邮箱自动获取失败，需要重新开始新一轮。';
const AUTO_STEP_DELAYS = {
  1: 2000,
  2: 2000,
  3: 3000,
  4: 2000,
  5: 0,
  6: 2000,
  7: 1000,
};

async function resumeAutoRunIfWaitingForEmail(windowId, options = {}) {
  const { silent = false } = options;
  const state = await getState(windowId);
  if (!state.email || !isAutoRunPausedState(state)) {
    return false;
  }

  const resumeWaiter = getResumeWaiter(windowId);
  if (resumeWaiter) {
    if (!silent) {
      await addLog(windowId, '邮箱已就绪，自动继续后续步骤...', 'info');
    }
    resumeWaiter.resolve();
    setResumeWaiter(windowId, null);
    return true;
  }

  return false;
}

async function ensureAutoEmailReady(windowId, targetRun, totalRuns, attemptRuns) {
  const currentState = await getState(windowId);
  if (currentState.email) {
    return currentState.email;
  }

  const service = normalizeEmailGenerationService(currentState.emailGenerationService);

  let lastGeneratedEmailError = null;
  for (let attempt = 1; attempt <= GENERATED_EMAIL_MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        await addLog(windowId, `${getEmailGenerationServiceLabel(service)}：正在进行第 ${attempt}/${GENERATED_EMAIL_MAX_ATTEMPTS} 次自动获取重试...`, 'warn');
      }
      const generatedEmail = await fetchGeneratedEmail(windowId, { generateNew: true, service });
      await addLog(windowId, `=== 目标 ${targetRun}/${totalRuns} 轮：${getEmailGenerationServiceLabel(service)} 已就绪：${generatedEmail}（第 ${attemptRuns} 次尝试，第 ${attempt}/${GENERATED_EMAIL_MAX_ATTEMPTS} 次获取）===`, 'ok');
      return generatedEmail;
    } catch (err) {
      lastGeneratedEmailError = err;
      await addLog(windowId, `${getEmailGenerationServiceLabel(service)} 自动获取失败（${attempt}/${GENERATED_EMAIL_MAX_ATTEMPTS}）：${err.message}`, 'warn');
    }
  }

  await addLog(windowId, `${getEmailGenerationServiceLabel(service)} 自动获取已连续失败 ${GENERATED_EMAIL_MAX_ATTEMPTS} 次：${lastGeneratedEmailError?.message || '未知错误'}`, 'error');
  throw new Error(GENERATED_EMAIL_RESTART_ERROR_MESSAGE);
}

async function runAutoSequenceFromStep(windowId, startStep, context = {}) {
  const { targetRun, totalRuns, attemptRuns, continued = false } = context;
  const maxStep9RestartAttempts = 5;
  let step9RestartAttempts = 0;

  if (continued) {
    await addLog(windowId, `=== 目标 ${targetRun}/${totalRuns} 轮：继续当前进度，从步骤 ${startStep} 开始（第 ${attemptRuns} 次尝试）===`, 'info');
  } else {
    await addLog(windowId, `=== 目标 ${targetRun}/${totalRuns} 轮：第 ${attemptRuns} 次尝试，阶段 1，获取 OAuth 链接并打开注册页 ===`, 'info');
  }

  if (startStep <= 2) {
    for (const step of [1, 2]) {
      if (step < startStep) continue;
      await executeStepAndWait(windowId, step, AUTO_STEP_DELAYS[step]);
    }
  }

  if (startStep <= 3) {
    await ensureAutoEmailReady(windowId, targetRun, totalRuns, attemptRuns);
    await addLog(windowId, `=== 目标 ${targetRun}/${totalRuns} 轮：阶段 2，注册、验证、登录并完成授权（第 ${attemptRuns} 次尝试）===`, 'info');
    await broadcastAutoRunStatus(windowId, 'running', {
      currentRun: targetRun,
      totalRuns,
      attemptRun: attemptRuns,
    });
    await executeStepAndWait(windowId, 3, AUTO_STEP_DELAYS[3]);
  } else {
    await addLog(windowId, `=== 目标 ${targetRun}/${totalRuns} 轮：继续执行剩余流程（第 ${attemptRuns} 次尝试）===`, 'info');
  }

  const signupTabId = await getTabId(windowId, 'signup-page');
  if (signupTabId) {
    await chrome.tabs.update(signupTabId, { active: true });
  }

  let step = Math.max(normalizeFlowStep(startStep), 4);
  while (step <= MAX_FLOW_STEP) {
    try {
      await executeStepAndWait(windowId, step, AUTO_STEP_DELAYS[step]);
      step += 1;
    } catch (err) {
      if (step === 7 && isStep9OAuthTimeoutError(err) && step9RestartAttempts < maxStep9RestartAttempts) {
        step9RestartAttempts += 1;
        await addLog(
          windowId,
          `步骤 7：检测到 OAuth callback 超时，正在回到步骤 6 重新开始授权流程（${step9RestartAttempts}/${maxStep9RestartAttempts}）...`,
          'warn'
        );
        await invalidateDownstreamAfterStepRestart(windowId, 6, {
          logLabel: `步骤 7 超时后准备回到步骤 6 重试（${step9RestartAttempts}/${maxStep9RestartAttempts}）`,
        });
        step = 6;
        continue;
      }
      throw err;
    }
  }
}

// Outer loop: keep retrying until the target number of successful runs is reached.
async function autoRunLoop(windowId, totalRuns, options = {}) {
  const runtime = getAutoRunRuntime(windowId);
  if (runtime.active) {
    await addLog(windowId, '自动运行已在进行中', 'warn');
    return;
  }

  const sessionId = bumpAutoRunSessionId(windowId);
  clearStopRequest(windowId);
  runtime.active = true;
  runtime.totalRuns = totalRuns;
  runtime.currentRun = 0;
  runtime.attemptRun = 0;
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

  await setState(windowId, {
    autoRunSkipFailures,
    ...getAutoRunStatusPayload(windowId, 'running', {
      currentRun: resumeCurrentRun,
      totalRuns,
      attemptRun: resumeAttemptRunsProcessed,
    }),
  });

  while (successfulRuns < totalRuns && attemptRuns < maxAttempts) {
    if (!isCurrentAutoRunSession(windowId, sessionId)) {
      return;
    }

    attemptRuns += 1;
    const targetRun = successfulRuns + 1;
    runtime.currentRun = targetRun;
    runtime.attemptRun = attemptRuns;
    const attemptSessionId = bumpAutoRunAttemptSessionId(windowId);
    let startStep = 1;
    let useExistingProgress = false;

    if (continueCurrentOnFirstAttempt) {
      const currentState = await getState(windowId);
      const resumeStep = getFirstUnfinishedStep(currentState.stepStatuses);
      if (resumeStep && hasSavedProgress(currentState.stepStatuses)) {
        startStep = resumeStep;
        useExistingProgress = true;
      } else if (hasSavedProgress(currentState.stepStatuses)) {
        await addLog(windowId, '当前流程已全部处理，将按“重新开始”新开一轮自动运行。', 'info');
      }
      continueCurrentOnFirstAttempt = false;
    }

    if (!useExistingProgress) {
      // Reset everything at the start of each fresh attempt (keep current window settings).
      await resetState(windowId);
      await setState(windowId, {
        ...getAutoRunStatusPayload(windowId, 'running', { currentRun: targetRun, totalRuns, attemptRun: attemptRuns }),
        ...(forceFreshTabsNextRun ? { tabRegistry: {} } : {}),
      });
      await sendWindowMessage(windowId, 'AUTO_RUN_RESET', {});
      await sleepWithStop(windowId, 500);
    } else {
      await setState(windowId, {
        autoRunSkipFailures,
        ...getAutoRunStatusPayload(windowId, 'running', { currentRun: targetRun, totalRuns, attemptRun: attemptRuns }),
      });
    }

    if (forceFreshTabsNextRun) {
      await addLog(windowId, `兜底模式：上一轮已放弃，当前开始第 ${attemptRuns} 次尝试，将使用新线程继续补足第 ${targetRun}/${totalRuns} 轮。`, 'warn');
      forceFreshTabsNextRun = false;
    }

    try {
      throwIfStopped(windowId);
      await broadcastAutoRunStatus(windowId, 'running', {
        currentRun: targetRun,
        totalRuns,
        attemptRun: attemptRuns,
      });

      await runAutoSequenceFromStep(windowId, startStep, {
        targetRun,
        totalRuns,
        attemptRuns,
        continued: useExistingProgress,
      });

      successfulRuns += 1;
      runtime.currentRun = successfulRuns;
      clearActiveAutoRunAttemptSession(windowId);
      await addLog(windowId, `=== 目标 ${successfulRuns}/${totalRuns} 轮已完成（第 ${attemptRuns} 次尝试成功）===`, 'ok');
      continue;
    } catch (err) {
      if (!isCurrentAutoRunSession(windowId, sessionId)) {
        return;
      }

      if (isStopError(err)) {
        await addLog(windowId, `目标 ${targetRun}/${totalRuns} 轮已被用户停止`, 'warn');
        await broadcastAutoRunStatus(windowId, 'stopped', {
          currentRun: targetRun,
          totalRuns,
          attemptRun: attemptRuns,
        });
        break;
      }

      if (isRestartCurrentAttemptError(err)) {
        if (!isCurrentAutoRunAttemptSession(windowId, attemptSessionId)) {
          return;
        }
        const errorMessage = getErrorMessage(err);
        const restartReason = errorMessage.includes('手机号页面')
          ? '目标流程进入手机号页面'
          : (errorMessage.includes('Duck 邮箱自动获取失败')
            ? 'Duck 邮箱自动获取连续失败'
            : (isStep8ContinueStuckError(errorMessage)
              ? '步骤 6 连续点击“继续”无效'
              : '检测到当前邮箱已存在'));
        await addLog(windowId, `目标 ${targetRun}/${totalRuns} 轮${restartReason}，当前线程已放弃，将重新开始新一轮。`, 'warn');
        const mailSource = getMailConfig(await getState(windowId)).source;
        await abandonCurrentAutoRunAttempt(windowId, {
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
        await addLog(windowId, `目标 ${targetRun}/${totalRuns} 轮失败：${err.message}`, 'error');
        await broadcastAutoRunStatus(windowId, 'stopped', {
          currentRun: targetRun,
          totalRuns,
          attemptRun: attemptRuns,
        });
        break;
      }

      if (!isCurrentAutoRunAttemptSession(windowId, attemptSessionId)) {
        return;
      }
      await addLog(windowId, `目标 ${targetRun}/${totalRuns} 轮的第 ${attemptRuns} 次尝试失败：${err.message}`, 'error');
      await addLog(windowId, '兜底开关已开启：将放弃当前线程，重新开一轮继续补足目标次数。', 'warn');
      const mailSource = getMailConfig(await getState(windowId)).source;
      await abandonCurrentAutoRunAttempt(windowId, {
        targetRun,
        totalRuns,
        attemptRun: attemptRuns,
        reason: '当前尝试已放弃。',
        mailSource,
      });
      forceFreshTabsNextRun = true;
    }
  }

  if (!isCurrentAutoRunSession(windowId, sessionId)) {
    return;
  }

  clearActiveAutoRunAttemptSession(windowId);

  const stopped = isStopRequested(windowId);
  let finalPhase = 'stopped';

  if (!stopped && autoRunSkipFailures && successfulRuns < totalRuns && attemptRuns >= maxAttempts) {
    await addLog(windowId, `已达到安全重试上限（${attemptRuns} 次尝试），当前仅完成 ${successfulRuns}/${totalRuns} 轮。`, 'error');
    await broadcastAutoRunStatus(windowId, 'stopped', {
      currentRun: successfulRuns,
      totalRuns,
      attemptRun: attemptRuns,
    });
  } else if (stopped) {
    await addLog(windowId, `=== 已停止，完成 ${successfulRuns}/${totalRuns} 轮，共尝试 ${attemptRuns} 次 ===`, 'warn');
    await broadcastAutoRunStatus(windowId, 'stopped', {
      currentRun: successfulRuns,
      totalRuns,
      attemptRun: attemptRuns,
    });
  } else if (successfulRuns >= totalRuns) {
    finalPhase = 'complete';
    await addLog(windowId, `=== 全部 ${totalRuns} 轮均已成功完成，共尝试 ${attemptRuns} 次 ===`, 'ok');
    await broadcastAutoRunStatus(windowId, 'complete', {
      currentRun: successfulRuns,
      totalRuns,
      attemptRun: attemptRuns,
    });
  } else {
    await addLog(windowId, `=== 已停止，完成 ${successfulRuns}/${totalRuns} 轮，共尝试 ${attemptRuns} 次 ===`, 'warn');
    await broadcastAutoRunStatus(windowId, 'stopped', {
      currentRun: successfulRuns,
      totalRuns,
      attemptRun: attemptRuns,
    });
  }

  runtime.active = false;
  runtime.currentRun = successfulRuns;
  runtime.totalRuns = totalRuns;
  runtime.attemptRun = attemptRuns;
  await setState(windowId, getAutoRunStatusPayload(windowId, finalPhase, {
    currentRun: successfulRuns,
    totalRuns,
    attemptRun: attemptRuns,
  }));
  clearStopRequest(windowId);
}

async function waitForResume(windowId) {
  throwIfStopped(windowId);
  const state = await getState(windowId);
  if (state.email) {
    await addLog(windowId, '邮箱已就绪，自动继续后续步骤...', 'info');
    return;
  }

  return new Promise((resolve, reject) => {
    setResumeWaiter(windowId, { resolve, reject });
  });
}

async function resumeAutoRun(windowId) {
  throwIfStopped(windowId);
  const state = await getState(windowId);
  if (!state.email) {
    await addLog(windowId, '无法继续：当前没有邮箱地址，请先在侧边栏填写邮箱。', 'error');
    return false;
  }

  const resumedInMemory = await resumeAutoRunIfWaitingForEmail(windowId, { silent: true });
  if (resumedInMemory) {
    return true;
  }

  if (!isAutoRunPausedState(state)) {
    return false;
  }

  if (getAutoRunRuntime(windowId).active) {
    return false;
  }

  const totalRuns = state.autoRunTotalRuns || 1;
  const currentRun = state.autoRunCurrentRun || 1;
  const attemptRun = state.autoRunAttemptRun || 1;
  const successfulRuns = Math.max(0, currentRun - 1);

  await addLog(windowId, '检测到自动流程暂停上下文已丢失，正在从当前进度恢复自动运行...', 'warn');
  autoRunLoop(windowId, totalRuns, {
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

async function executeStep1(windowId, state) {
  if (!state.vpsUrl) {
    throw new Error('尚未配置 CPA 地址，请先在侧边栏填写。');
  }
  await addLog(windowId, '步骤 1：正在打开 CPA 面板...');

  const injectFiles = ['content/utils.js', 'content/vps-panel.js'];

  const tabId = await reuseOrCreateTab(windowId, 'vps-panel', state.vpsUrl, {
    activate: false,
    reloadIfSameUrl: true,
  });

  await addLog(windowId, '步骤 1：CPA 面板已打开，正在等待页面进入目标地址...');
  const matchedTab = await waitForTabUrlFamily('vps-panel', tabId, state.vpsUrl, {
    timeoutMs: 15000,
    retryDelayMs: 400,
  });
  if (!matchedTab) {
    await addLog(windowId, '步骤 1：CPA 页面尚未完全进入目标地址，继续尝试连接内容脚本...', 'warn');
  }

  await ensureContentScriptReadyOnTab(windowId, 'vps-panel', tabId, {
    inject: injectFiles,
    timeoutMs: 45000,
    retryDelayMs: 900,
    logMessage: '步骤 1：CPA 面板仍在加载，正在重试连接内容脚本...',
  });

  const result = await sendToContentScriptResilient(windowId, 'vps-panel', {
    type: 'EXECUTE_STEP',
    step: 1,
    source: 'background',
    payload: { vpsPassword: state.vpsPassword },
  }, {
    timeoutMs: 30000,
    retryDelayMs: 700,
    logMessage: '步骤 1：CPA 面板通信未就绪，正在等待页面恢复...',
  });

  if (result?.error) {
    throw new Error(result.error);
  }
}

// ============================================================
// Step 2: Open Signup Page (Background opens tab, signup-page.js clicks Register)
// ============================================================

async function executeStep2(windowId, state) {
  if (!state.oauthUrl) {
    throw new Error('缺少 OAuth 链接，请先完成步骤 1。');
  }
  await addLog(windowId, '步骤 2：正在打开认证链接...');
  await reuseOrCreateTab(windowId, 'signup-page', state.oauthUrl, {
    activate: false,
  });

  await sendToContentScript(windowId, 'signup-page', {
    type: 'EXECUTE_STEP',
    step: 2,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Step 3: Fill Email & Password (via signup-page.js)
// ============================================================

async function executeStep3(windowId, state) {
  if (!state.email) {
    throw new Error('缺少邮箱地址，请先在侧边栏获取或粘贴邮箱。');
  }

  const password = state.customPassword || generatePassword();
  await setPasswordState(windowId, password);

  // Save account record
  const accounts = state.accounts || [];
  accounts.push({ email: state.email, password, createdAt: new Date().toISOString() });
  await setState(windowId, { accounts });

  const signupTabId = await getTabId(windowId, 'signup-page');
  if (!signupTabId) {
    throw new Error('认证页面标签页已关闭，无法继续步骤 3。');
  }

  await chrome.tabs.update(signupTabId, { active: true });
  await addLog(windowId, `步骤 3：正在填写邮箱 ${state.email}，密码为${state.customPassword ? '自定义' : '自动生成'}（${password.length} 位）`);
  await sendToContentScriptResilient(windowId, 'signup-page', {
    type: 'EXECUTE_STEP',
    step: 3,
    source: 'background',
    payload: { email: state.email, password },
  }, {
    timeoutMs: 45000,
    responseTimeoutMs: 30000,
    retryDelayMs: 800,
    logMessage: '步骤 3：认证页通信异常，正在等待页面恢复后重试...',
  });
}

// ============================================================
// Step 4: Get Signup Verification Code (qq-mail.js polls, then fills in signup-page.js)
// ============================================================

function getMailConfig(state) {
  const provider = getEffectiveMailProvider(state) || 'qq';
  if (provider === '163') {
    return { source: 'mail-163', url: 'https://mail.163.com/js6/main.jsp?df=mail163_letter#module=mbox.ListModule%7C%7B%22fid%22%3A1%2C%22order%22%3A%22date%22%2C%22desc%22%3Atrue%7D', label: '163 邮箱' };
  }
  if (provider === '163-vip') {
    return { source: 'mail-163', url: 'https://webmail.vip.163.com/js6/main.jsp?df=mail163_letter#module=mbox.ListModule%7C%7B%22fid%22%3A1%2C%22order%22%3A%22date%22%2C%22desc%22%3Atrue%7D', label: '163 VIP 邮箱' };
  }
  if (provider === 'inbucket') {
    const host = normalizeInbucketOrigin(state.inbucketHost);
    const mailbox = (state.inbucketMailbox || '').trim();
    if (!host) {
      return { error: 'Inbucket 主机地址为空或无效。' };
    }
    if (!mailbox) {
      return { error: 'Inbucket 邮箱名称为空。' };
    }
    return {
      source: 'inbucket-mail',
      url: `${host}/m/${encodeURIComponent(mailbox)}/`,
      label: `Inbucket 邮箱（${mailbox}）`,
      navigateOnReuse: true,
      inject: ['content/utils.js', 'content/inbucket-mail.js'],
      injectSource: 'inbucket-mail',
    };
  }
  return { source: 'qq-mail', url: 'https://wx.mail.qq.com/', label: 'QQ 邮箱' };
}

function normalizeInbucketOrigin(rawValue) {
  const value = (rawValue || '').trim();
  if (!value) return '';

  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value) ? value : `https://${value}`;

  try {
    const parsed = new URL(candidate);
    return parsed.origin;
  } catch {
    return '';
  }
}

function getEffectiveMailProvider(state) {
  return normalizeMailProvider(state?.mailProvider);
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
      disableFallbackToOldMail: true,
      firstAttemptDelayMs: 3000,
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

async function requestVerificationCodeResend(windowId, step) {
  const signupTabId = await getTabId(windowId, 'signup-page');
  if (!signupTabId) {
    throw new Error('认证页面标签页已关闭，无法重新请求验证码。');
  }

  await chrome.tabs.update(signupTabId, { active: true });
  await addLog(windowId, `步骤 ${step}：正在请求新的${getVerificationCodeLabel(step)}验证码...`, 'warn');

  const result = await sendToContentScript(windowId, 'signup-page', {
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

async function pollFreshVerificationCode(windowId, step, state, mail, pollOverrides = {}) {
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
      await requestVerificationCodeResend(windowId, step);
    }

    while (true) {
      const payload = getVerificationPollPayload(step, state, {
        ...pollOverrides,
        filterAfterTimestamp,
        excludeCodes: [...rejectedCodes],
      });

      try {
        const result = await sendToMailContentScriptResilient(
          windowId,
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

        if (result?.reloadRequired && mail.source === 'qq-mail') {
          await addLog(windowId, `步骤 ${step}：QQ 邮箱页内刷新无效，正在直接刷新页面后继续轮询...`, 'warn');
          await reuseOrCreateTab(windowId, mail.source, mail.url, {
            inject: mail.inject,
            injectSource: mail.injectSource,
            reloadIfSameUrl: true,
          });
          continue;
        }

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
        break;
      }
    }

    await addLog(windowId, `步骤 ${step}：${lastError.message}`, 'warn');
    if (round < maxRounds) {
      await addLog(windowId, `步骤 ${step}：将重新发送验证码后重试（${round + 1}/${maxRounds}）...`, 'warn');
    }
  }

  throw lastError || new Error(`步骤 ${step}：无法获取新的${getVerificationCodeLabel(step)}验证码。`);
}

async function submitVerificationCode(windowId, step, code) {
  const signupTabId = await getTabId(windowId, 'signup-page');
  if (!signupTabId) {
    throw new Error('认证页面标签页已关闭，无法填写验证码。');
  }

  await chrome.tabs.update(signupTabId, { active: true });
  const result = await sendToContentScript(windowId, 'signup-page', {
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

async function resolveVerificationStep(windowId, step, state, mail, options = {}) {
  const stateKey = getVerificationCodeStateKey(step);
  const rejectedCodes = new Set();
  if (state[stateKey]) {
    rejectedCodes.add(state[stateKey]);
  }

  const nextFilterAfterTimestamp = options.filterAfterTimestamp ?? null;
  const requestFreshCodeFirst = Boolean(options.requestFreshCodeFirst);
  const reportCompletion = options.reportCompletion !== false;
  const maxSubmitAttempts = 3;

  if (requestFreshCodeFirst) {
    try {
      await requestVerificationCodeResend(windowId, step);
      await addLog(windowId, `步骤 ${step}：已先请求一封新的${getVerificationCodeLabel(step)}验证码，再开始轮询邮箱。`, 'warn');
    } catch (err) {
      await addLog(windowId, `步骤 ${step}：首次重新获取验证码失败：${err.message}，将继续使用当前时间窗口轮询。`, 'warn');
    }
  }

  for (let attempt = 1; attempt <= maxSubmitAttempts; attempt++) {
    const result = await pollFreshVerificationCode(windowId, step, state, mail, {
      excludeCodes: [...rejectedCodes],
      filterAfterTimestamp: nextFilterAfterTimestamp ?? undefined,
    });

    await addLog(windowId, `步骤 ${step}：已获取${getVerificationCodeLabel(step)}验证码：${result.code}`);
    const submitResult = await submitVerificationCode(windowId, step, result.code);

    if (submitResult.addPhonePage) {
      await addLog(windowId, `步骤 ${step}：验证码通过后进入手机号页面，本轮线程作废，准备重新开始新一轮。`, 'warn');
      throw new Error('当前流程已进入手机号页面，需要重新开始新一轮。');
    }

    if (submitResult.invalidCode) {
      rejectedCodes.add(result.code);
      await addLog(windowId, `步骤 ${step}：验证码被页面拒绝：${submitResult.errorText || result.code}`, 'warn');

      if (attempt >= maxSubmitAttempts) {
        throw new Error(`步骤 ${step}：验证码连续失败，已达到 ${maxSubmitAttempts} 次重试上限。`);
      }

      await requestVerificationCodeResend(windowId, step);
      await addLog(windowId, `步骤 ${step}：提交失败后已请求新验证码（${attempt + 1}/${maxSubmitAttempts}）...`, 'warn');
      continue;
    }

    await setState(windowId, {
      lastEmailTimestamp: result.emailTimestamp,
      [stateKey]: result.code,
    });

    if (reportCompletion) {
      await completeStepFromBackground(windowId, step, {
        emailTimestamp: result.emailTimestamp,
        code: result.code,
      });
    }
    return {
      emailTimestamp: result.emailTimestamp,
      code: result.code,
    };
  }
}

async function executeStep4(windowId, state) {
  const mail = getMailConfig(state);
  if (mail.error) throw new Error(mail.error);
  const stepStartedAt = Date.now();
  const signupTabId = await getTabId(windowId, 'signup-page');
  if (!signupTabId) {
    throw new Error('认证页面标签页已关闭，无法继续步骤 4。');
  }

  await chrome.tabs.update(signupTabId, { active: true });
  await addLog(windowId, '步骤 4：正在确认注册验证码页面是否就绪，必要时自动恢复密码页超时报错...');
  const prepareResult = await sendToContentScriptResilient(
    windowId,
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
    await completeStepFromBackground(windowId, 4, {});
    return;
  }

  await addLog(windowId, `步骤 4：正在打开${mail.label}...`);

  const alive = await isTabAlive(windowId, mail.source);
  if (alive) {
    if (mail.navigateOnReuse) {
      await reuseOrCreateTab(windowId, mail.source, mail.url, {
        inject: mail.inject,
        injectSource: mail.injectSource,
      });
    } else {
      const tabId = await getTabId(windowId, mail.source);
      await chrome.tabs.update(tabId, { active: true });
    }
  } else {
    await reuseOrCreateTab(windowId, mail.source, mail.url, {
      inject: mail.inject,
      injectSource: mail.injectSource,
    });
  }

  await resolveVerificationStep(windowId, 4, state, mail, {
    filterAfterTimestamp: stepStartedAt,
    requestFreshCodeFirst: true,
  });
}

// ============================================================
// Step 5: Fill Name & Birthday (via signup-page.js)
// ============================================================

async function executeStep5(windowId, state) {
  const { firstName, lastName } = generateRandomName();
  const { year, month, day } = generateRandomBirthday();

  await addLog(windowId, `步骤 5：已生成姓名 ${firstName} ${lastName}，生日 ${year}-${month}-${day}`);

  const signupTabId = await getTabId(windowId, 'signup-page');
  if (signupTabId) {
    const signupTab = await chrome.tabs.get(signupTabId).catch(() => null);
    if (isLocalhostOAuthCallbackUrl(signupTab?.url)) {
      await addLog(windowId, '步骤 5：认证页已直接进入 localhost 回调地址，资料页按已跳过处理。', 'ok');
      await completeStepFromBackground(windowId, 5, { skippedDirectToCallback: true });
      return;
    }
  }

  await sendToContentScript(windowId, 'signup-page', {
    type: 'EXECUTE_STEP',
    step: 5,
    source: 'background',
    payload: { firstName, lastName, year, month, day },
  });
}

// ============================================================
// Step 6: 完成 OAuth（自动点击 + localhost 回调监听）
// ============================================================

const STEP8_CLICK_EFFECT_TIMEOUT_MS = 3500;
const STEP8_CLICK_RETRY_DELAY_MS = 500;
const STEP8_READY_WAIT_TIMEOUT_MS = 30000;
const STEP8_READY_SETTLE_MS = 1000;
const STEP8_MAX_NO_EFFECT_ATTEMPTS = 4;
const STEP8_STRATEGIES = [
  { mode: 'content', strategy: 'requestSubmit', label: 'form.requestSubmit' },
  { mode: 'debugger', label: 'debugger click' },
  { mode: 'content', strategy: 'nativeClick', label: 'element.click' },
  { mode: 'content', strategy: 'dispatchClick', label: 'dispatch click' },
  { mode: 'debugger', label: 'debugger click retry' },
];

async function getStep8PageState(windowId, tabId, responseTimeoutMs = 1500) {
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

async function waitForStep8Ready(windowId, tabId, timeoutMs = STEP8_READY_WAIT_TIMEOUT_MS) {
  const start = Date.now();
  let settledSince = 0;
  let latestReadyState = null;

  while (Date.now() - start < timeoutMs) {
    throwIfStopped(windowId);
    const pageState = await getStep8PageState(windowId, tabId);
    if (pageState?.addPhonePage) {
      throw new Error('步骤 6：认证页进入了手机号页面，当前不是 OAuth 同意页，无法继续自动授权。');
    }
    if (pageState?.consentReady) {
      if (!settledSince) {
        settledSince = Date.now();
        latestReadyState = pageState;
      } else {
        latestReadyState = pageState;
        if (Date.now() - settledSince >= STEP8_READY_SETTLE_MS) {
          return latestReadyState;
        }
      }
    } else {
      settledSince = 0;
      latestReadyState = null;
    }
    await sleepWithStop(windowId, 250);
  }

  throw new Error('步骤 6：长时间未进入 OAuth 同意页，无法定位“继续”按钮。');
}

async function prepareStep8DebuggerClick(windowId) {
  const result = await sendToContentScriptResilient(windowId, 'signup-page', {
    type: 'STEP8_FIND_AND_CLICK',
    source: 'background',
    payload: {},
  }, {
    timeoutMs: 15000,
    retryDelayMs: 600,
    logMessage: '步骤 6：认证页正在切换，等待 OAuth 同意页按钮重新就绪...',
  });

  if (result?.error) {
    throw new Error(result.error);
  }

  return result;
}

async function triggerStep8ContentStrategy(windowId, strategy) {
  const result = await sendToContentScriptResilient(windowId, 'signup-page', {
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
    logMessage: '步骤 6：认证页正在切换，等待“继续”按钮重新就绪...',
  });

  if (result?.error) {
    throw new Error(result.error);
  }

  return result;
}

async function waitForStep8ClickEffect(windowId, tabId, baselineUrl, timeoutMs = STEP8_CLICK_EFFECT_TIMEOUT_MS) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    throwIfStopped(windowId);

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      throw new Error('步骤 6：认证页面标签页已关闭，无法继续自动授权。');
    }

    if (baselineUrl && typeof tab.url === 'string' && tab.url !== baselineUrl) {
      return { progressed: true, reason: 'url_changed', url: tab.url };
    }

    const pageState = await getStep8PageState(windowId, tabId);
    if (pageState?.addPhonePage) {
      throw new Error('步骤 6：点击“继续”后页面跳到了手机号页面，当前流程无法继续自动授权。');
    }
    if (pageState === null) {
      return { progressed: true, reason: 'page_reloading' };
    }
    if (pageState && !pageState.consentPage) {
      return { progressed: true, reason: 'left_consent_page', url: pageState.url };
    }

    await sleepWithStop(windowId, 200);
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

async function executeStep8(windowId, state) {
  if (!state.oauthUrl) {
    throw new Error('缺少 OAuth 链接，请先完成步骤 1。');
  }

  const signupTabId = await getTabId(windowId, 'signup-page');
  if (!signupTabId) {
    throw new Error('认证页面标签页已关闭，无法继续步骤 6。');
  }

  await chrome.tabs.update(signupTabId, { active: true });

  const authState = await sendToContentScriptResilient(windowId, 'signup-page', {
    type: 'INSPECT_AUTH_PAGE_STATE',
    step: 6,
    source: 'background',
    payload: {},
  }, {
    timeoutMs: 15000,
    retryDelayMs: 500,
    logMessage: '步骤 6：认证页状态检测未就绪，正在重试...',
  });

  if (authState?.localhostUrl && isLocalhostOAuthCallbackUrl(authState.localhostUrl)) {
    await addLog(windowId, '步骤 6：认证页已直接进入 localhost 回调地址，本步骤按已完成处理。', 'ok');
    await completeStepFromBackground(windowId, 6, { localhostUrl: authState.localhostUrl, alreadyAtCallback: true });
    return;
  }

  if (authState?.state === 'verification' || authState?.state === 'password' || authState?.state === 'email') {
    const verificationMail = getMailConfig(state);
    if (verificationMail.error) {
      throw new Error(verificationMail.error);
    }

    await addLog(windowId, '步骤 6：认证页仍处于登录校验阶段，正在补做登录验证码流程...', 'warn');
    const loginVerificationResult = await resolveVerificationStep(windowId, 7, state, verificationMail, {
      filterAfterTimestamp: state.lastEmailTimestamp || state.flowStartTime || Date.now(),
      requestFreshCodeFirst: true,
      reportCompletion: false,
    });

    const refreshedState = await getState(windowId);
    const latestSignupTabId = await getTabId(windowId, 'signup-page');
    if (!latestSignupTabId) {
      throw new Error('认证页面标签页已关闭，无法继续步骤 6。');
    }

    const postVerificationAuthState = await sendToContentScriptResilient(windowId, 'signup-page', {
      type: 'INSPECT_AUTH_PAGE_STATE',
      step: 6,
      source: 'background',
      payload: {},
    }, {
      timeoutMs: 15000,
      retryDelayMs: 500,
      logMessage: '步骤 6：登录验证码已提交，正在等待认证页切换...',
    });

    if (postVerificationAuthState?.localhostUrl && isLocalhostOAuthCallbackUrl(postVerificationAuthState.localhostUrl)) {
      await addLog(windowId, '步骤 6：登录验证码通过后已直接进入 localhost 回调地址，本步骤按已完成处理。', 'ok');
      await completeStepFromBackground(windowId, 6, {
        localhostUrl: postVerificationAuthState.localhostUrl,
        alreadyAtCallback: true,
        emailTimestamp: loginVerificationResult?.emailTimestamp,
        code: loginVerificationResult?.code,
      });
      return;
    }

    if (postVerificationAuthState?.state === 'add_phone') {
      throw new Error('当前流程已进入手机号页面，需要重新开始新一轮。');
    }

    if (postVerificationAuthState?.state === 'verification' || postVerificationAuthState?.state === 'password' || postVerificationAuthState?.state === 'email') {
      throw new Error('登录验证码流程结束后仍未进入 OAuth 同意页，请重新开始新一轮。');
    }

    return executeStep8(windowId, refreshedState);
  }

  if (authState?.state === 'add_phone') {
    throw new Error('当前流程已进入手机号页面，需要重新开始新一轮。');
  }

  await addLog(windowId, '步骤 6：正在监听 localhost 回调地址...');

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
      await addLog(windowId, logMessage, 'ok');
    }
    await completeStepFromBackground(windowId, 6, { localhostUrl: tab.url });
    return true;
  }

  return new Promise((resolve, reject) => {
    let resolved = false;
    let activeSignupTabId = null;

    const cleanupListener = () => {
      clearStep8Listener(windowId);
    };

    const failStep8 = (error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      cleanupListener();
      reject(error);
    };

    const timeout = setTimeout(() => {
      failStep8(new Error('120 秒内未捕获到 localhost 回调跳转，步骤 6 已持续重试点击“继续”但页面仍未完成授权。'));
    }, 120000);

    const listener = (details) => {
      if (resolved || !activeSignupTabId) return;
      if (details.tabId !== activeSignupTabId) return;
      if (details.frameId !== 0) return;
      if (isLocalhostOAuthCallbackUrl(details.url)) {
        console.log(LOG_PREFIX, `已捕获 window=${windowId} localhost OAuth 回调：${details.url}`);
        resolved = true;
        clearTimeout(timeout);
        cleanupListener();
        addLog(windowId, `步骤 6：已捕获 localhost 地址：${details.url}`, 'ok').then(() => {
          return completeStepFromBackground(windowId, 6, { localhostUrl: details.url });
        }).then(() => {
          resolve();
        }).catch((err) => {
          reject(err);
        });
      }
    };

    (async () => {
      try {
        clearStep8Listener(windowId);
        step8ListenersByWindow.set(windowId, listener);

        activeSignupTabId = await getTabId(windowId, 'signup-page');
        if (activeSignupTabId) {
          if (await completeIfCurrentTabAlreadyAtCallback(activeSignupTabId, '步骤 6：检测到认证页已停留在 localhost 回调地址，直接完成当前步骤。')) {
            resolved = true;
            clearTimeout(timeout);
            cleanupListener();
            resolve();
            return;
          }

          await chrome.tabs.update(activeSignupTabId, { active: true });
          await addLog(windowId, '步骤 6：已切回认证页，准备循环确认“继续”按钮直到页面真正跳转...');
        } else {
          activeSignupTabId = await reuseOrCreateTab(windowId, 'signup-page', state.oauthUrl);
          await addLog(windowId, '步骤 6：已重新打开认证页，准备循环确认“继续”按钮直到页面真正跳转...');
        }

        if (await completeIfCurrentTabAlreadyAtCallback(activeSignupTabId, '步骤 6：检测到认证页已跳到 localhost 回调地址，直接完成当前步骤。')) {
          resolved = true;
          clearTimeout(timeout);
          cleanupListener();
          resolve();
          return;
        }

        chrome.webNavigation.onBeforeNavigate.addListener(listener);

        let attempt = 0;
        let noEffectAttempts = 0;
        while (!resolved) {
          const pageState = await waitForStep8Ready(windowId, activeSignupTabId);
          if (!pageState?.consentReady) {
            await sleepWithStop(windowId, STEP8_CLICK_RETRY_DELAY_MS);
            continue;
          }

          const strategy = STEP8_STRATEGIES[attempt % STEP8_STRATEGIES.length];
          const round = attempt + 1;
          attempt += 1;

          await addLog(windowId, `步骤 6：第 ${round} 次尝试点击“继续”（${strategy.label}）...`);

          if (strategy.mode === 'debugger') {
            const clickTarget = await prepareStep8DebuggerClick(windowId);
            if (clickTarget?.alreadyAtCallback) {
              resolved = true;
              cleanupListener();
              clearTimeout(timeout);
              await addLog(windowId, `步骤 6：内容脚本确认当前页面已是 localhost 回调地址：${clickTarget.url}`, 'ok');
              await completeStepFromBackground(windowId, 6, { localhostUrl: clickTarget.url });
              resolve();
              return;
            }
            if (!resolved) {
              await clickWithDebugger(activeSignupTabId, clickTarget?.rect);
            }
          } else {
            await triggerStep8ContentStrategy(windowId, strategy.strategy);
          }

          if (resolved) {
            return;
          }

          const effect = await waitForStep8ClickEffect(windowId, activeSignupTabId, pageState.url);
          if (resolved) {
            return;
          }

          if (effect.progressed) {
            noEffectAttempts = 0;
            await addLog(windowId, `步骤 6：检测到本次点击已生效，${getStep8EffectLabel(effect)}，继续等待 localhost 回调...`, 'info');
            break;
          }

          noEffectAttempts += 1;
          if (noEffectAttempts >= STEP8_MAX_NO_EFFECT_ATTEMPTS) {
            throw new Error(`步骤 6：连续 ${noEffectAttempts} 次点击“继续”仍未触发页面离开 OAuth 同意页，需要重新开始新一轮。`);
          }

          await addLog(windowId, `步骤 6：${strategy.label} 本次未触发页面离开同意页，准备继续重试（${noEffectAttempts}/${STEP8_MAX_NO_EFFECT_ATTEMPTS}）。`, 'warn');
          await sleepWithStop(windowId, STEP8_CLICK_RETRY_DELAY_MS);
        }
      } catch (err) {
        failStep8(err);
      }
    })();
  });
}

// ============================================================
// Step 7: CPA 回调验证（通过 vps-panel.js）
// ============================================================

async function executeStep9(windowId, state) {
  if (state.localhostUrl && !isLocalhostOAuthCallbackUrl(state.localhostUrl)) {
    throw new Error('步骤 6 捕获到的 localhost OAuth 回调地址无效，请重新执行步骤 6。');
  }
  if (!state.localhostUrl) {
    throw new Error('缺少 localhost 回调地址，请先完成步骤 6。');
  }
  if (!state.vpsUrl) {
    throw new Error('尚未填写 CPA 地址，请先在侧边栏输入。');
  }

  await addLog(windowId, '步骤 7：正在打开 CPA 面板...');

  const injectFiles = ['content/utils.js', 'content/vps-panel.js'];
  let tabId = await getTabId(windowId, 'vps-panel');
  const alive = tabId && await isTabAlive(windowId, 'vps-panel');

  if (!alive) {
    tabId = await reuseOrCreateTab(windowId, 'vps-panel', state.vpsUrl, {
      inject: injectFiles,
      reloadIfSameUrl: true,
    });
  } else {
    await closeConflictingTabsForSource(windowId, 'vps-panel', state.vpsUrl, { excludeTabIds: [tabId] });
    await chrome.tabs.update(tabId, { active: true });
    await rememberSourceLastUrl(windowId, 'vps-panel', state.vpsUrl);
  }

  await ensureContentScriptReadyOnTab(windowId, 'vps-panel', tabId, {
    inject: injectFiles,
  });

  await addLog(windowId, '步骤 7：正在填写回调地址...');
  const result = await sendToContentScriptResilient(windowId, 'vps-panel', {
    type: 'EXECUTE_STEP',
    step: 7,
    source: 'background',
    payload: { localhostUrl: state.localhostUrl, vpsPassword: state.vpsPassword },
  }, {
    timeoutMs: 30000,
    retryDelayMs: 700,
    logMessage: '步骤 7：CPA 面板通信未就绪，正在等待页面恢复...',
  });

  if (result?.error) {
    throw new Error(result.error);
  }
}

// ============================================================
// Open Side Panel on extension icon click
// ============================================================

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
