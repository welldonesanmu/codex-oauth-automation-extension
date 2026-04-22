// content/signup-page.js — Content script for OpenAI auth pages (steps 2, 3, 4-receive, 5)
// Injected on: auth0.openai.com, auth.openai.com, accounts.openai.com

console.log('[MultiPage:signup-page] Content script loaded on', location.href);

// Listen for commands from Background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message.type === 'EXECUTE_STEP'
    || message.type === 'FILL_CODE'
    || message.type === 'STEP8_FIND_AND_CLICK'
    || message.type === 'STEP8_GET_STATE'
    || message.type === 'STEP8_TRIGGER_CONTINUE'
    || message.type === 'PREPARE_SIGNUP_VERIFICATION'
    || message.type === 'RESEND_VERIFICATION_CODE'
    || message.type === 'INSPECT_AUTH_PAGE_STATE'
    || message.type === 'ENSURE_SIGNUP_ENTRY_READY'
    || message.type === 'ENSURE_SIGNUP_PASSWORD_PAGE_READY'
  ) {
    setCurrentCommandContext(message);
    resetStopState();
    handleCommand(message).then((result) => {
      sendResponse({ ok: true, ...(result || {}) });
    }).catch(err => {
      if (isStopError(err)) {
        log(`步骤 ${message.step || 8}：已被用户停止。`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }

      if (message.type === 'STEP8_FIND_AND_CLICK') {
        log(`步骤 9：${err.message}`, 'error');
        sendResponse({ error: err.message });
        return;
      }

      reportError(message.step, err.message);
      sendResponse({ error: err.message });
    });
    return true;
  }
});

async function handleCommand(message) {
  switch (message.type) {
    case 'EXECUTE_STEP':
      switch (message.step) {
        case 2: return await step2_clickRegister(message.payload);
        case 3: return await step3_fillEmailPassword(message.payload);
        case 5: return await step5_fillNameBirthday(message.payload);
        case 7: return await step7_login(message.payload);
        case 9: return await step9_findAndClick();
        default: throw new Error(`signup-page.js 不处理步骤 ${message.step}`);
      }
    case 'FILL_CODE':
      // Step 4 = signup code, Step 8 = login code (same handler)
      return await fillVerificationCode(message.step, message.payload);
    case 'PREPARE_SIGNUP_VERIFICATION':
      return await prepareSignupVerificationFlow(message.payload);
    case 'RESEND_VERIFICATION_CODE':
      return await resendVerificationCode(message.step);
    case 'INSPECT_AUTH_PAGE_STATE':
      return inspectAuthPageState();
    case 'STEP8_FIND_AND_CLICK':
      return await step9_findAndClick();
    case 'STEP8_GET_STATE':
      return getStep8State();
    case 'STEP8_TRIGGER_CONTINUE':
      return await step8_triggerContinue(message.payload);
    case 'ENSURE_SIGNUP_ENTRY_READY':
      return await ensureSignupEntryReady(message.payload?.timeout);
    case 'ENSURE_SIGNUP_PASSWORD_PAGE_READY':
      return await ensureSignupPasswordPageReady(message.payload?.timeout);
  }
}

const VERIFICATION_CODE_INPUT_SELECTOR = [
  'input[name="code"]',
  'input[name="otp"]',
  'input[autocomplete="one-time-code"]',
  'input[type="text"][maxlength="6"]',
  'input[type="tel"][maxlength="6"]',
  'input[aria-label*="code" i]',
  'input[placeholder*="code" i]',
  'input[inputmode="numeric"]',
].join(', ');

const ONE_TIME_CODE_LOGIN_PATTERN = /使用一次性验证码登录|改用(?:一次性)?验证码(?:登录)?|使用验证码登录|一次性验证码|验证码登录|one[-\s]*time\s*(?:passcode|password|code)|use\s+(?:a\s+)?one[-\s]*time\s*(?:passcode|password|code)(?:\s+instead)?|use\s+(?:a\s+)?code(?:\s+instead)?|sign\s+in\s+with\s+(?:email|code)|email\s+(?:me\s+)?(?:a\s+)?code/i;

const RESEND_VERIFICATION_CODE_PATTERN = /重新发送(?:验证码)?|再次发送(?:验证码)?|重发(?:验证码)?|未收到(?:验证码|邮件)|resend(?:\s+code)?|send\s+(?:a\s+)?new\s+code|send\s+(?:it\s+)?again|request\s+(?:a\s+)?new\s+code|didn'?t\s+receive/i;

function isVisibleElement(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && rect.width > 0
    && rect.height > 0;
}

function getVerificationCodeTarget() {
  const codeInput = document.querySelector(VERIFICATION_CODE_INPUT_SELECTOR);
  if (codeInput && isVisibleElement(codeInput)) {
    return { type: 'single', element: codeInput };
  }

  const singleInputs = Array.from(document.querySelectorAll('input[maxlength="1"]'))
    .filter(isVisibleElement);
  if (singleInputs.length >= 6) {
    return { type: 'split', elements: singleInputs };
  }

  return null;
}

function getActionText(el) {
  return [
    el?.textContent,
    el?.value,
    el?.getAttribute?.('aria-label'),
    el?.getAttribute?.('title'),
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isActionEnabled(el) {
  return Boolean(el)
    && !el.disabled
    && el.getAttribute('aria-disabled') !== 'true';
}

function findOneTimeCodeLoginTrigger() {
  const candidates = document.querySelectorAll(
    'button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"]'
  );

  for (const el of candidates) {
    if (!isVisibleElement(el)) continue;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;

    const text = [
      el.textContent,
      el.value,
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (text && ONE_TIME_CODE_LOGIN_PATTERN.test(text)) {
      return el;
    }
  }

  return null;
}

function findResendVerificationCodeTrigger({ allowDisabled = false } = {}) {
  const candidates = document.querySelectorAll(
    'button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"]'
  );

  for (const el of candidates) {
    if (!isVisibleElement(el)) continue;
    if (!allowDisabled && !isActionEnabled(el)) continue;

    const text = getActionText(el);
    if (text && RESEND_VERIFICATION_CODE_PATTERN.test(text)) {
      return el;
    }
  }

  return null;
}

function isEmailVerificationPage() {
  return /\/email-verification(?:[/?#]|$)/i.test(location.pathname || '');
}

function parseUrlSafely(rawUrl) {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function isLocalhostOAuthCallbackUrl(rawUrl = location.href) {
  const parsed = parseUrlSafely(rawUrl);
  if (!parsed) return false;
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (!['localhost', '127.0.0.1', '192.168.2.1'].includes(parsed.hostname)) return false;
  if (parsed.pathname !== '/auth/callback') return false;

  const code = (parsed.searchParams.get('code') || '').trim();
  const state = (parsed.searchParams.get('state') || '').trim();
  return Boolean(code && state);
}

async function prepareLoginCodeFlow(timeout = 15000) {
  const readyTarget = getVerificationCodeTarget();
  if (readyTarget) {
    log('步骤 8：验证码输入框已就绪。');
    return { ready: true, mode: readyTarget.type };
  }

  if (isEmailVerificationPage() && isVerificationPageStillVisible()) {
    log('步骤 8：已进入邮箱验证码页面，正在等待验证码输入框或重发入口稳定。');
    return { ready: true, mode: 'verification_page' };
  }

  const start = Date.now();
  let switchClickCount = 0;
  let lastSwitchAttemptAt = 0;
  let loggedPasswordPage = false;
  let loggedVerificationPage = false;

  while (Date.now() - start < timeout) {
    throwIfStopped();

    const target = getVerificationCodeTarget();
    if (target) {
      log('步骤 8：验证码页面已就绪。');
      return { ready: true, mode: target.type };
    }

    if (isEmailVerificationPage() && isVerificationPageStillVisible()) {
      if (!loggedVerificationPage) {
        loggedVerificationPage = true;
        log('步骤 8：页面已进入邮箱验证码流程，继续等待验证码输入框渲染...');
      }
      await sleep(250);
      continue;
    }

    const passwordInput = document.querySelector('input[type="password"]');
    const switchTrigger = findOneTimeCodeLoginTrigger();

    if (switchTrigger && (switchClickCount === 0 || Date.now() - lastSwitchAttemptAt > 1500)) {
      switchClickCount += 1;
      lastSwitchAttemptAt = Date.now();
      loggedPasswordPage = false;
      log('步骤 8：检测到密码页，正在切换到一次性验证码登录...');
      await humanPause(350, 900);
      simulateClick(switchTrigger);
      await sleep(1200);
      continue;
    }

    if (passwordInput && !loggedPasswordPage) {
      loggedPasswordPage = true;
      log('步骤 8：正在等待密码页上的一次性验证码登录入口...');
    }

    await sleep(200);
  }

  throw new Error('无法切换到一次性验证码验证页面。URL: ' + location.href);
}

async function resendVerificationCode(step, timeout = 45000) {
  if (step === 8) {
    await prepareLoginCodeFlow();
  }

  const start = Date.now();
  let action = null;
  let loggedWaiting = false;

  while (Date.now() - start < timeout) {
    throwIfStopped();
    action = findResendVerificationCodeTrigger({ allowDisabled: true });

    if (action && isActionEnabled(action)) {
      log(`步骤 ${step}：重新发送验证码按钮已可用。`);
      await humanPause(350, 900);
      simulateClick(action);
      await sleep(1200);
      return {
        resent: true,
        buttonText: getActionText(action),
      };
    }

    if (action && !loggedWaiting) {
      loggedWaiting = true;
      log(`步骤 ${step}：正在等待重新发送验证码按钮变为可点击...`);
    }

    await sleep(250);
  }

  throw new Error('无法点击重新发送验证码按钮。URL: ' + location.href);
}

// ============================================================
// Signup Entry Helpers
// ============================================================

const SIGNUP_ENTRY_TRIGGER_PATTERN = /免费注册|立即注册|注册|sign\s*up|register|create\s*account|create\s+account/i;
const LOGGED_IN_HOME_PROFILE_TRIGGER_PATTERN = /个人资料|profile|workspace|工作空间|打开.*个人资料.*菜单|open.*profile.*menu/i;
const LOGGED_IN_HOME_LANDING_PATTERN = /今天有什么计划|what(?:'|’)s on your mind|new chat|新聊天|upgrade chatgpt|邀请团队成员|invite team members/i;
const LOGOUT_TRIGGER_PATTERN = /退出登录|退出|注销|log\s*out|sign\s*out/i;
const SIGNUP_EMAIL_INPUT_SELECTOR = 'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email" i]';

function getSignupEmailInput() {
  const input = document.querySelector(SIGNUP_EMAIL_INPUT_SELECTOR);
  return input && isVisibleElement(input) ? input : null;
}

function getSignupEmailContinueButton({ allowDisabled = false } = {}) {
  const direct = document.querySelector('button[type="submit"], input[type="submit"]');
  if (direct && isVisibleElement(direct) && (allowDisabled || isActionEnabled(direct))) {
    return direct;
  }

  const candidates = document.querySelectorAll(
    'button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"]'
  );
  return Array.from(candidates).find((el) => {
    if (!isVisibleElement(el) || (!allowDisabled && !isActionEnabled(el))) return false;
    return /continue|next|submit|继续|下一步/i.test(getActionText(el));
  }) || null;
}

function findSignupEntryTrigger() {
  const candidates = document.querySelectorAll('a, button, [role="button"], [role="link"]');
  return Array.from(candidates).find((el) => {
    if (!isVisibleElement(el) || !isActionEnabled(el)) return false;
    return SIGNUP_ENTRY_TRIGGER_PATTERN.test(getActionText(el));
  }) || null;
}

function isLikelyLoggedInChatGptHome() {
  if (!/chatgpt\.com$/i.test(location.hostname || '')) return false;
  if (getSignupEmailInput() || getSignupPasswordInput()) return false;
  const visibleActions = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"]'))
    .filter((el) => isVisibleElement(el) && isActionEnabled(el));
  const hasProfileTrigger = visibleActions.some((el) => LOGGED_IN_HOME_PROFILE_TRIGGER_PATTERN.test(getActionText(el)));
  if (!hasProfileTrigger) return false;
  return LOGGED_IN_HOME_LANDING_PATTERN.test(getPageTextSnapshot());
}

function findLoggedInHomeProfileTrigger() {
  const candidates = document.querySelectorAll('a, button, [role="button"], [role="link"], div[role="button"]');
  return Array.from(candidates).find((el) => {
    if (!isVisibleElement(el) || !isActionEnabled(el)) return false;
    return LOGGED_IN_HOME_PROFILE_TRIGGER_PATTERN.test(getActionText(el));
  }) || null;
}

function findLogoutTrigger() {
  const candidates = document.querySelectorAll('a, button, [role="button"], [role="link"], [role="menuitem"], div[role="button"]');
  return Array.from(candidates).find((el) => {
    if (!isVisibleElement(el) || !isActionEnabled(el)) return false;
    return LOGOUT_TRIGGER_PATTERN.test(getActionText(el));
  }) || null;
}

async function ensureLoggedOutToSignupEntry(timeout = 15000) {
  const profileTrigger = findLoggedInHomeProfileTrigger();
  if (!profileTrigger) {
    throw new Error('当前页面疑似已登录，但未找到个人资料菜单入口。URL: ' + location.href);
  }

  log('步骤 1：检测到当前已登录 ChatGPT，正在退出到注册入口...');
  await humanPause(350, 900);
  simulateClick(profileTrigger);

  const start = Date.now();
  let logoutClicked = false;
  while (Date.now() - start < timeout) {
    throwIfStopped();
    const logoutTrigger = findLogoutTrigger();
    if (logoutTrigger) {
      logoutClicked = true;
      await humanPause(350, 900);
      simulateClick(logoutTrigger);
      await sleep(1200);
      break;
    }
    await sleep(200);
  }

  if (!logoutClicked) {
    throw new Error('当前页面疑似已登录，但未找到退出登录按钮。URL: ' + location.href);
  }

  const signedOutSnapshot = await waitForSignupEntryState({
    timeout: 20000,
    autoOpenEntry: false,
    step: 1,
    logDiagnostics: true,
  });
  if (signedOutSnapshot.state === 'entry_home' || signedOutSnapshot.state === 'email_entry' || signedOutSnapshot.state === 'password_page') {
    return signedOutSnapshot;
  }

  throw new Error('退出登录后仍未回到可注册状态。URL: ' + location.href);
}

function getSignupPasswordDisplayedEmail() {
  const text = (document.body?.innerText || document.body?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig);
  return matches?.[0] ? String(matches[0]).trim().toLowerCase() : '';
}

function inspectSignupEntryState() {
  const passwordInput = getSignupPasswordInput();
  if (isSignupPasswordPage() && passwordInput) {
    return {
      state: 'password_page',
      passwordInput,
      submitButton: getSignupPasswordSubmitButton({ allowDisabled: true }),
      displayedEmail: getSignupPasswordDisplayedEmail(),
      url: location.href,
    };
  }

  const emailInput = getSignupEmailInput();
  if (emailInput) {
    return {
      state: 'email_entry',
      emailInput,
      continueButton: getSignupEmailContinueButton({ allowDisabled: true }),
      url: location.href,
    };
  }

  const signupTrigger = findSignupEntryTrigger();
  if (signupTrigger) {
    return {
      state: 'entry_home',
      signupTrigger,
      url: location.href,
    };
  }

  if (isLikelyLoggedInChatGptHome()) {
    return {
      state: 'logged_in_home',
      profileTrigger: findLoggedInHomeProfileTrigger(),
      url: location.href,
    };
  }

  return {
    state: 'unknown',
    url: location.href,
  };
}

function getSignupEntryStateSummary(snapshot = inspectSignupEntryState()) {
  const summary = {
    state: snapshot?.state || 'unknown',
    url: snapshot?.url || location.href,
    hasEmailInput: Boolean(snapshot?.emailInput || getSignupEmailInput()),
    hasPasswordInput: Boolean(snapshot?.passwordInput || getSignupPasswordInput()),
  };

  if (snapshot?.displayedEmail) {
    summary.displayedEmail = snapshot.displayedEmail;
  }

  if (snapshot?.signupTrigger) {
    summary.signupTrigger = {
      tag: (snapshot.signupTrigger.tagName || '').toLowerCase(),
      text: getActionText(snapshot.signupTrigger).slice(0, 80),
    };
  }

  if (snapshot?.profileTrigger) {
    summary.profileTrigger = {
      tag: (snapshot.profileTrigger.tagName || '').toLowerCase(),
      text: getActionText(snapshot.profileTrigger).slice(0, 80),
    };
  }

  if (snapshot?.continueButton) {
    summary.continueButton = {
      tag: (snapshot.continueButton.tagName || '').toLowerCase(),
      text: getActionText(snapshot.continueButton).slice(0, 80),
      enabled: isActionEnabled(snapshot.continueButton),
    };
  }

  return summary;
}

function getSignupEntryDiagnostics() {
  const actionCandidates = document.querySelectorAll(
    'a, button, [role="button"], [role="link"], input[type="button"], input[type="submit"]'
  );
  const allActions = Array.from(actionCandidates).map((el) => {
    const rect = typeof el?.getBoundingClientRect === 'function'
      ? el.getBoundingClientRect()
      : null;
    const text = getActionText(el);
    return {
      tag: (el.tagName || '').toLowerCase(),
      type: el.getAttribute?.('type') || '',
      text: text.slice(0, 80),
      visible: isVisibleElement(el),
      enabled: isActionEnabled(el),
      rect: rect
        ? {
            width: Math.round(rect.width || 0),
            height: Math.round(rect.height || 0),
          }
        : null,
    };
  });
  const visibleActions = Array.from(actionCandidates)
    .filter(isVisibleElement)
    .slice(0, 12)
    .map((el) => ({
      tag: (el.tagName || '').toLowerCase(),
      type: el.getAttribute?.('type') || '',
      text: getActionText(el).slice(0, 80),
      enabled: isActionEnabled(el),
    }))
    .filter((item) => item.text);
  const signupLikeActions = allActions
    .filter((item) => item.text && SIGNUP_ENTRY_TRIGGER_PATTERN.test(item.text))
    .slice(0, 12);

  return {
    url: location.href,
    title: document.title || '',
    readyState: document.readyState || '',
    hasEmailInput: Boolean(getSignupEmailInput()),
    hasPasswordInput: Boolean(getSignupPasswordInput()),
    bodyContainsSignupText: SIGNUP_ENTRY_TRIGGER_PATTERN.test(getPageTextSnapshot()),
    signupLikeActions,
    visibleActions,
    bodyTextPreview: getPageTextSnapshot().slice(0, 240),
  };
}

async function waitForSignupEntryState(options = {}) {
  const {
    timeout = 15000,
    autoOpenEntry = false,
    step = 2,
    logDiagnostics = false,
  } = options;
  const start = Date.now();
  let lastTriggerClickAt = 0;
  let clickAttempts = 0;
  let lastState = '';
  let slowSnapshotLogged = false;

  while (Date.now() - start < timeout) {
    throwIfStopped();
    const snapshot = inspectSignupEntryState();

    if (logDiagnostics && snapshot.state !== lastState) {
      lastState = snapshot.state;
      log(`步骤 ${step}：注册入口状态切换为 ${snapshot.state}，状态快照：${JSON.stringify(getSignupEntryStateSummary(snapshot))}`);
    }

    if (snapshot.state === 'password_page' || snapshot.state === 'email_entry') {
      return snapshot;
    }

    if (snapshot.state === 'logged_in_home') {
      await ensureLoggedOutToSignupEntry();
      await sleep(500);
      continue;
    }

    if (snapshot.state === 'entry_home') {
      if (!autoOpenEntry) {
        return snapshot;
      }

      if (Date.now() - lastTriggerClickAt >= 1500) {
        lastTriggerClickAt = Date.now();
        clickAttempts += 1;
        if (logDiagnostics) {
          log(`步骤 ${step}：正在点击官网注册入口（第 ${clickAttempts} 次）：“${getActionText(snapshot.signupTrigger).slice(0, 80)}”`);
        }
        log(`步骤 ${step}：正在点击官网注册入口...`);
        await humanPause(350, 900);
        simulateClick(snapshot.signupTrigger);
      }
    }

    if (logDiagnostics && !slowSnapshotLogged && Date.now() - start >= 5000) {
      slowSnapshotLogged = true;
      log(`步骤 ${step}：等待注册入口超过 5 秒，页面诊断快照：${JSON.stringify(getSignupEntryDiagnostics())}`, 'warn');
    }

    await sleep(250);
  }

  const finalSnapshot = inspectSignupEntryState();
  if (logDiagnostics) {
    log(`步骤 ${step}：等待注册入口状态超时，最终状态快照：${JSON.stringify(getSignupEntryStateSummary(finalSnapshot))}`, 'warn');
  }
  return finalSnapshot;
}

async function ensureSignupEntryReady(timeout = 15000) {
  const snapshot = await waitForSignupEntryState({ timeout, autoOpenEntry: false, step: 1, logDiagnostics: true });
  if (snapshot.state === 'entry_home' || snapshot.state === 'email_entry' || snapshot.state === 'password_page') {
    return {
      ready: true,
      state: snapshot.state,
      url: snapshot.url || location.href,
    };
  }

  log(`注册入口识别失败，诊断快照：${JSON.stringify(getSignupEntryDiagnostics())}`, 'warn');
  throw new Error('当前页面没有可用的注册入口，也不在邮箱/密码页。URL: ' + location.href);
}

async function ensureSignupPasswordPageReady(timeout = 20000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    const passwordInput = getSignupPasswordInput();
    if (isSignupPasswordPage() && passwordInput) {
      return {
        ready: true,
        state: 'password_page',
        url: location.href,
      };
    }
    await sleep(200);
  }

  throw new Error('等待进入密码页超时。URL: ' + location.href);
}

async function waitForSignupEmailContinueOrPasswordPage(email, step, timeout = 12000) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const start = Date.now();
  let loggedWaiting = false;

  while (Date.now() - start < timeout) {
    throwIfStopped();
    const snapshot = inspectSignupEntryState();

    if (snapshot.state === 'password_page') {
      return {
        state: 'password_page',
        snapshot,
      };
    }

    if (snapshot.state === 'email_entry' && snapshot.emailInput) {
      const continueButton = snapshot.continueButton || getSignupEmailContinueButton({ allowDisabled: true });
      if (continueButton && isActionEnabled(continueButton)) {
        return {
          state: 'ready',
          snapshot,
          continueButton,
        };
      }

      const currentValue = String(snapshot.emailInput.value || '').trim().toLowerCase();
      if (!loggedWaiting && currentValue === normalizedEmail) {
        loggedWaiting = true;
        log(`步骤 ${step}：继续按钮暂不可用，正在等待页面切换到密码页或按钮恢复...`);
      }
    }

    await sleep(200);
  }

  return {
    state: 'timeout',
    snapshot: inspectSignupEntryState(),
  };
}

async function fillSignupEmailAndContinue(email, step) {
  if (!email) throw new Error(`未提供邮箱地址，步骤 ${step} 无法继续。`);
  const normalizedEmail = String(email || '').trim().toLowerCase();

  const snapshot = await waitForSignupEntryState({
    timeout: 20000,
    autoOpenEntry: true,
    step,
    logDiagnostics: step === 2,
  });

  if (snapshot.state === 'password_page') {
    if (snapshot.displayedEmail && snapshot.displayedEmail !== normalizedEmail) {
      throw new Error(`步骤 ${step}：当前密码页邮箱为 ${snapshot.displayedEmail}，与目标邮箱 ${email} 不一致，请先回到步骤 1 重新开始。`);
    }
    log(`步骤 ${step}：当前已在密码页，无需重复提交邮箱。`);
    if (step === 2) {
      reportComplete(step, { email, alreadyOnPasswordPage: true });
    }
    return {
      alreadyOnPasswordPage: true,
      url: snapshot.url || location.href,
    };
  }

  if (snapshot.state !== 'email_entry' || !snapshot.emailInput) {
    if (step === 2) {
      log(`步骤 ${step}：未进入邮箱输入页，最终页面诊断快照：${JSON.stringify(getSignupEntryDiagnostics())}`, 'warn');
    }
    throw new Error(`步骤 ${step}：未找到可用的邮箱输入入口。URL: ${location.href}`);
  }

  log(`步骤 ${step}：正在填写邮箱：${email}`);
  await humanPause(500, 1400);
  fillInput(snapshot.emailInput, email);
  log(`步骤 ${step}：邮箱已填写`);

  let continueButton = snapshot.continueButton || getSignupEmailContinueButton({ allowDisabled: true });
  if (!continueButton || !isActionEnabled(continueButton)) {
    const waitResult = await waitForSignupEmailContinueOrPasswordPage(email, step, step === 2 ? 10000 : 12000);
    if (waitResult.state === 'password_page') {
      log(`步骤 ${step}：页面已切换到密码页，无需重复点击“继续”。`);
      if (step === 2) {
        reportComplete(step, { email, alreadyOnPasswordPage: true, transitionedWhileWaiting: true });
      }
      return {
        alreadyOnPasswordPage: true,
        url: waitResult.snapshot?.url || location.href,
      };
    }
    continueButton = waitResult.continueButton || null;
  }

  if (!continueButton || !isActionEnabled(continueButton)) {
    throw new Error(`步骤 ${step}：未找到可点击的“继续”按钮。URL: ${location.href}`);
  }

  const completionPayload = {
    email,
    submitted: true,
    deferredSubmit: true,
  };
  reportComplete(step, completionPayload);

  log(`步骤 ${step}：邮箱已准备提交，正在前往密码页...`);
  window.setTimeout(() => {
    try {
      throwIfStopped();
      simulateClick(continueButton);
    } catch (error) {
      if (!isStopError(error)) {
        console.error('[MultiPage:signup-page] deferred signup email submit failed:', error?.message || error);
      }
    }
  }, 120);

  return completionPayload;
}

// ============================================================
// Step 2: Click Register, fill email, then continue to password page
// ============================================================

async function step2_clickRegister(payload = {}) {
  const { email } = payload;
  return fillSignupEmailAndContinue(email, 2);
}

// ============================================================
// Step 3: Fill Password
// ============================================================

async function step3_fillEmailPassword(payload) {
  const { email, password } = payload;
  if (!password) throw new Error('未提供密码，步骤 3 需要可用密码。');
  const normalizedEmail = String(email || '').trim().toLowerCase();

  let snapshot = inspectSignupEntryState();
  if (snapshot.state === 'entry_home') {
    throw new Error('当前仍停留在 ChatGPT 官网首页，请先完成步骤 2。');
  }

  if (snapshot.state === 'email_entry') {
    const transition = await fillSignupEmailAndContinue(email, 3);
    if (!transition.alreadyOnPasswordPage) {
      await sleep(1200);
      await ensureSignupPasswordPageReady();
    }
    snapshot = inspectSignupEntryState();
  }

  if (snapshot.state !== 'password_page' || !snapshot.passwordInput) {
    await ensureSignupPasswordPageReady();
    snapshot = inspectSignupEntryState();
  }

  if (snapshot.state !== 'password_page' || !snapshot.passwordInput) {
    throw new Error('在密码页未找到密码输入框。URL: ' + location.href);
  }
  if (normalizedEmail && snapshot.displayedEmail && snapshot.displayedEmail !== normalizedEmail) {
    throw new Error(`当前密码页邮箱为 ${snapshot.displayedEmail}，与目标邮箱 ${email} 不一致，请先回到步骤 1 重新开始。`);
  }

  await humanPause(600, 1500);
  fillInput(snapshot.passwordInput, password);
  log('步骤 3：密码已填写');

  const submitBtn = snapshot.submitButton
    || getSignupPasswordSubmitButton({ allowDisabled: true })
    || await waitForElementByText('button', /continue|sign\s*up|submit|注册|创建|create/i, 5000).catch(() => null);

  const signupVerificationRequestedAt = submitBtn ? Date.now() : null;
  const completionPayload = {
    email,
    signupVerificationRequestedAt,
    deferredSubmit: Boolean(submitBtn),
  };
  reportComplete(3, completionPayload);

  if (submitBtn) {
    window.setTimeout(async () => {
      try {
        throwIfStopped();
        await sleep(500);
        await humanPause(500, 1300);
        simulateClick(submitBtn);
        log('步骤 3：表单已提交');
      } catch (error) {
        if (!isStopError(error)) {
          console.error('[MultiPage:signup-page] deferred step 3 submit failed:', error?.message || error);
        }
      }
    }, 120);
  }

  return completionPayload;
}

// ============================================================
// Fill Verification Code (used by step 4 and step 7)
// ============================================================

const INVALID_VERIFICATION_CODE_PATTERN = /代码不正确|验证码不正确|验证码错误|code\s+(?:is\s+)?incorrect|invalid\s+code|incorrect\s+code|try\s+again/i;
const VERIFICATION_PAGE_PATTERN = /检查您的收件箱|输入我们刚刚向|重新发送电子邮件|重新发送验证码|验证码|代码不正确|email\s+verification/i;
const OAUTH_CONSENT_PAGE_PATTERN = /使用\s*ChatGPT\s*登录到\s*Codex|sign\s+in\s+to\s+codex(?:\s+with\s+chatgpt)?|login\s+to\s+codex|log\s+in\s+to\s+codex|continue\s+to\s+codex|authorize|授权/i;
const ADD_PHONE_PAGE_PATTERN = /add[\s-]*phone|添加手机号|手机号码|手机号|phone\s+number|telephone/i;
const STEP5_SUBMIT_ERROR_PATTERN = /无法根据该信息创建帐户|请重试|unable\s+to\s+create\s+(?:your\s+)?account|couldn'?t\s+create\s+(?:your\s+)?account|something\s+went\s+wrong|invalid\s+(?:birthday|birth|date)|生日|出生日期/i;
const SIGNUP_PASSWORD_ERROR_TITLE_PATTERN = /糟糕，出错了|something\s+went\s+wrong|oops/i;
const SIGNUP_PASSWORD_ERROR_DETAIL_PATTERN = /operation\s+timed\s+out|timed\s+out|请求超时|操作超时/i;
const SIGNUP_EMAIL_EXISTS_PATTERN = /与此电子邮件地址相关联的帐户已存在|account\s+associated\s+with\s+this\s+email\s+address\s+already\s+exists|email\s+address.*already\s+exists/i;
const ADD_PHONE_TRACE_MAX_RESOURCE_ENTRIES = 8;
let addPhoneTraceBootstrapped = false;
let addPhoneTraceLastUrl = '';
let addPhoneTraceLastState = '';

function getTraceTextSnippet(text, maxLength = 140) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function snapshotRecentResourceEntries() {
  if (typeof performance?.getEntriesByType !== 'function') return [];
  try {
    return performance.getEntriesByType('resource')
      .slice(-ADD_PHONE_TRACE_MAX_RESOURCE_ENTRIES)
      .map((entry) => {
        const name = entry?.name || '';
        const shortName = name.length > 120 ? `...${name.slice(-120)}` : name;
        const transferSize = Number.isFinite(entry?.transferSize) ? entry.transferSize : 'na';
        const duration = Number.isFinite(entry?.duration) ? Math.round(entry.duration) : 'na';
        const initiator = entry?.initiatorType || 'unknown';
        return `${initiator} ${duration}ms ${transferSize}b ${shortName}`;
      });
  } catch {
    return [];
  }
}

function detectAuthStateForTrace() {
  if (isLocalhostOAuthCallbackUrl()) return 'callback';
  if (isAddPhonePageReady()) return 'add_phone';
  if (isStep8Ready()) return 'consent';
  if (isVerificationPageStillVisible()) return 'verification';
  if (isStep5Ready()) return 'step5';
  return 'other';
}

function emitAuthFlowTrace(kind, extra = {}) {
  reportTrace(kind, {
    state: detectAuthStateForTrace(),
    entries: snapshotRecentResourceEntries(),
    ...extra,
  });
}

function monitorAddPhoneRouteTransitions() {
  if (addPhoneTraceBootstrapped) return;
  addPhoneTraceBootstrapped = true;

  const emitNavigationTrace = (trigger) => {
    const url = location.href;
    const state = detectAuthStateForTrace();
    if (url === addPhoneTraceLastUrl && state === addPhoneTraceLastState) return;
    addPhoneTraceLastUrl = url;
    addPhoneTraceLastState = state;

    emitAuthFlowTrace(state === 'add_phone' ? 'add_phone_detected' : 'auth_route', {
      note: trigger,
      detail: `state=${state}`,
    });
  };

  const wrapHistory = (methodName) => {
    const original = history[methodName];
    if (typeof original !== 'function') return;
    history[methodName] = function(...args) {
      const result = original.apply(this, args);
      setTimeout(() => emitNavigationTrace(`history.${methodName}`), 0);
      return result;
    };
  };

  wrapHistory('pushState');
  wrapHistory('replaceState');
  window.addEventListener('popstate', () => emitNavigationTrace('popstate'));
  window.addEventListener('hashchange', () => emitNavigationTrace('hashchange'));

  setInterval(() => {
    const currentUrl = location.href;
    const currentState = detectAuthStateForTrace();
    if (currentUrl !== addPhoneTraceLastUrl || currentState !== addPhoneTraceLastState) {
      emitNavigationTrace('poll');
    }
  }, 1000);

  emitNavigationTrace('bootstrap');
}

function getVerificationErrorText() {
  const messages = [];
  const selectors = [
    '.react-aria-FieldError',
    '[slot="errorMessage"]',
    '[id$="-error"]',
    '[data-invalid="true"] + *',
    '[aria-invalid="true"] + *',
    '[class*="error"]',
  ];

  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach((el) => {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) {
        messages.push(text);
      }
    });
  }

  const invalidInput = document.querySelector(`${VERIFICATION_CODE_INPUT_SELECTOR}[aria-invalid="true"], ${VERIFICATION_CODE_INPUT_SELECTOR}[data-invalid="true"]`);
  if (invalidInput) {
    const wrapper = invalidInput.closest('form, [data-rac], ._root_18qcl_51, div');
    if (wrapper) {
      const text = (wrapper.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) {
        messages.push(text);
      }
    }
  }

  return messages.find((text) => INVALID_VERIFICATION_CODE_PATTERN.test(text)) || '';
}

function isStep5Ready() {
  return Boolean(
    document.querySelector('input[name="name"], input[autocomplete="name"], input[name="birthday"], input[name="age"], [role="spinbutton"][data-type="year"]')
  );
}

function getPageTextSnapshot() {
  return (document.body?.innerText || document.body?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getPrimaryContinueButton() {
  const continueBtn = document.querySelector(
    'button[type="submit"][data-dd-action-name="Continue"], button[type="submit"]._primary_3rdp0_107'
  );
  if (continueBtn && isVisibleElement(continueBtn)) {
    return continueBtn;
  }

  const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isVisibleElement);
  const labeledButton = buttons.find((el) => /继续|continue|authorize|allow|同意|accept|approve/i.test(getActionText(el)));
  if (labeledButton) {
    return labeledButton;
  }

  const submitButton = buttons.find((el) => (el.getAttribute('type') || '').toLowerCase() === 'submit');
  return submitButton || null;
}

function isVerificationPageStillVisible() {
  if (getVerificationCodeTarget()) return true;
  if (findResendVerificationCodeTrigger({ allowDisabled: true })) return true;
  if (document.querySelector('form[action*="email-verification" i]')) return true;

  return VERIFICATION_PAGE_PATTERN.test(getPageTextSnapshot());
}

function isAddPhonePageReady() {
  const path = `${location.pathname || ''} ${location.href || ''}`;
  if (/\/add-phone(?:[/?#]|$)/i.test(path)) return true;

  const phoneInput = document.querySelector(
    'input[type="tel"]:not([maxlength="6"]), input[name*="phone" i], input[id*="phone" i], input[autocomplete="tel"]'
  );
  if (phoneInput && isVisibleElement(phoneInput)) {
    return true;
  }

  return ADD_PHONE_PAGE_PATTERN.test(getPageTextSnapshot());
}

function isStep8Ready() {
  const continueBtn = getPrimaryContinueButton();
  if (!continueBtn) return false;
  if (isVerificationPageStillVisible()) return false;
  if (isAddPhonePageReady()) return false;

  return OAUTH_CONSENT_PAGE_PATTERN.test(getPageTextSnapshot());
}

function inspectAuthPageState() {
  if (isLocalhostOAuthCallbackUrl()) {
    return { state: 'callback', localhostUrl: location.href };
  }

  if (isLikelyLoggedInChatGptHome()) {
    return { state: 'logged_in_home', url: location.href };
  }

  if (isAddPhonePageReady()) {
    return { state: 'add_phone', url: location.href };
  }

  if (isStep8Ready()) {
    return { state: 'consent', url: location.href };
  }

  if (isEmailVerificationPage() || getVerificationCodeTarget() || isVerificationPageStillVisible()) {
    return { state: 'verification', url: location.href };
  }

  if (isStep5Ready()) {
    return { state: 'step5', url: location.href };
  }

  if (isSignupEmailAlreadyExistsPage()) {
    return { state: 'email_exists', url: location.href };
  }

  if (document.querySelector('input[type="password"]')) {
    return { state: 'password', url: location.href };
  }

  if (document.querySelector('input[type="email"], input[name="email"], input[name="username"]')) {
    return { state: 'email', url: location.href };
  }

  return { state: 'unknown', url: location.href };
}

function normalizeInlineText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function findBirthdayReactAriaSelect(labelText) {
  const normalizedLabel = normalizeInlineText(labelText);
  const roots = document.querySelectorAll('.react-aria-Select');

  for (const root of roots) {
    const labelEl = Array.from(root.querySelectorAll('span')).find((el) => normalizeInlineText(el.textContent) === normalizedLabel);
    if (!labelEl) continue;

    const item = root.closest('[class*="selectItem"], ._selectItem_ppsls_113') || root.parentElement;
    const nativeSelect = item?.querySelector('[data-testid="hidden-select-container"] select') || null;
    const button = root.querySelector('button[aria-haspopup="listbox"]') || null;
    const valueEl = root.querySelector('.react-aria-SelectValue') || null;

    return { root, item, labelEl, nativeSelect, button, valueEl };
  }

  return null;
}

async function setReactAriaBirthdaySelect(control, value) {
  if (!control?.nativeSelect) {
    throw new Error('未找到可写入的生日下拉框。');
  }

  const desiredValue = String(value);
  const option = Array.from(control.nativeSelect.options).find((item) => item.value === desiredValue);
  if (!option) {
    throw new Error(`生日下拉框中不存在值 ${desiredValue}。`);
  }

  control.nativeSelect.value = desiredValue;
  option.selected = true;
  control.nativeSelect.dispatchEvent(new Event('input', { bubbles: true }));
  control.nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(120);
}

function getStep5ErrorText() {
  const messages = [];
  const selectors = [
    '.react-aria-FieldError',
    '[slot="errorMessage"]',
    '[id$="-error"]',
    '[id$="-errors"]',
    '[role="alert"]',
    '[aria-live="assertive"]',
    '[aria-live="polite"]',
    '[class*="error"]',
  ];

  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach((el) => {
      if (!isVisibleElement(el)) return;
      const text = normalizeInlineText(el.textContent);
      if (text) {
        messages.push(text);
      }
    });
  }

  const invalidField = Array.from(document.querySelectorAll('[aria-invalid="true"], [data-invalid="true"]'))
    .find((el) => isVisibleElement(el));
  if (invalidField) {
    const wrapper = invalidField.closest('form, fieldset, [data-rac], div');
    if (wrapper) {
      const text = normalizeInlineText(wrapper.textContent);
      if (text) {
        messages.push(text);
      }
    }
  }

  return messages.find((text) => STEP5_SUBMIT_ERROR_PATTERN.test(text)) || '';
}

async function waitForStep5SubmitOutcome(timeout = 25000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();

    const errorText = getStep5ErrorText();
    if (errorText) {
      return { invalidProfile: true, errorText };
    }

    if (isLocalhostOAuthCallbackUrl()) {
      return {
        success: true,
        terminalState: 'callback',
        localhostUrl: location.href,
      };
    }

    if (isAddPhonePageReady()) {
      return { success: true, terminalState: 'add_phone', addPhonePage: true };
    }

    if (isLikelyLoggedInChatGptHome()) {
      return { success: true, terminalState: 'logged_in_home' };
    }

    if (isStep8Ready()) {
      return { success: true, terminalState: 'consent' };
    }

    await sleep(150);
  }

  const errorText = getStep5ErrorText();
  if (errorText) {
    return { invalidProfile: true, errorText };
  }

  return {
    invalidProfile: true,
    errorText: '提交后未进入下一阶段，请检查生日是否真正被页面接受。',
  };
}

function isSignupPasswordPage() {
  return /\/create-account\/password(?:[/?#]|$)/i.test(location.pathname || '');
}

function isLoginPasswordPage() {
  return /\/log-in\/password(?:[/?#]|$)/i.test(location.pathname || '');
}

function getSignupPasswordInput() {
  const input = document.querySelector('input[type="password"]');
  return input && isVisibleElement(input) ? input : null;
}

function getSignupPasswordSubmitButton({ allowDisabled = false } = {}) {
  const direct = document.querySelector('button[type="submit"]');
  if (direct && isVisibleElement(direct) && (allowDisabled || isActionEnabled(direct))) {
    return direct;
  }

  const candidates = document.querySelectorAll('button, [role="button"]');
  return Array.from(candidates).find((el) => {
    if (!isVisibleElement(el) || (!allowDisabled && !isActionEnabled(el))) return false;
    const text = getActionText(el);
    return /继续|continue|submit|创建|create/i.test(text);
  }) || null;
}

function getSignupRetryButton() {
  const direct = document.querySelector('button[data-dd-action-name="Try again"]');
  if (direct && isVisibleElement(direct) && isActionEnabled(direct)) {
    return direct;
  }

  const candidates = document.querySelectorAll('button, [role="button"]');
  return Array.from(candidates).find((el) => {
    if (!isVisibleElement(el) || !isActionEnabled(el)) return false;
    const text = getActionText(el);
    return /重试|try\s+again/i.test(text);
  }) || null;
}

function isSignupPasswordErrorPage() {
  if (!isSignupPasswordPage()) return false;
  const text = getPageTextSnapshot();
  return Boolean(
    getSignupRetryButton()
    && (SIGNUP_PASSWORD_ERROR_TITLE_PATTERN.test(text)
      || SIGNUP_PASSWORD_ERROR_DETAIL_PATTERN.test(text)
      || SIGNUP_PASSWORD_ERROR_TITLE_PATTERN.test(document.title || ''))
  );
}

function isSignupEmailAlreadyExistsPage() {
  return (isSignupPasswordPage() || isLoginPasswordPage())
    && SIGNUP_EMAIL_EXISTS_PATTERN.test(getPageTextSnapshot());
}

function inspectSignupVerificationState() {
  if (isStep5Ready()) {
    return { state: 'step5' };
  }

  if (isVerificationPageStillVisible()) {
    return { state: 'verification' };
  }

  if (isLoginPasswordPage()) {
    return { state: 'email_exists' };
  }

  if (isSignupPasswordErrorPage()) {
    return {
      state: 'error',
      retryButton: getSignupRetryButton(),
    };
  }

  if (isSignupEmailAlreadyExistsPage()) {
    return { state: 'email_exists' };
  }

  const passwordInput = getSignupPasswordInput();
  if (passwordInput) {
    return {
      state: 'password',
      passwordInput,
      submitButton: getSignupPasswordSubmitButton({ allowDisabled: true }),
    };
  }

  return { state: 'unknown' };
}

async function waitForSignupVerificationTransition(timeout = 5000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();

    const snapshot = inspectSignupVerificationState();
    if (snapshot.state === 'step5' || snapshot.state === 'verification' || snapshot.state === 'error' || snapshot.state === 'email_exists') {
      return snapshot;
    }

    await sleep(200);
  }

  return inspectSignupVerificationState();
}

async function prepareSignupVerificationFlow(payload = {}, timeout = 30000) {
  const { password } = payload;
  const start = Date.now();
  let recoveryRound = 0;
  const maxRecoveryRounds = 3;

  while (Date.now() - start < timeout && recoveryRound < maxRecoveryRounds) {
    throwIfStopped();

    const roundNo = recoveryRound + 1;
    log(`步骤 4：等待页面进入验证码阶段（第 ${roundNo}/${maxRecoveryRounds} 轮，先等待 5 秒）...`, 'info');
    const snapshot = await waitForSignupVerificationTransition(5000);

    if (snapshot.state === 'step5') {
      log('步骤 4：页面已进入验证码后的下一阶段，本步骤按已完成处理。', 'ok');
      return { ready: true, alreadyVerified: true, retried: recoveryRound };
    }

    if (snapshot.state === 'verification') {
      log(`步骤 4：验证码页面已就绪${recoveryRound ? `（期间自动恢复 ${recoveryRound} 次）` : ''}。`, 'ok');
      return { ready: true, retried: recoveryRound };
    }

    if (snapshot.state === 'email_exists') {
      throw new Error('当前邮箱已存在，需要重新开始新一轮。');
    }

    recoveryRound += 1;

    if (snapshot.state === 'error') {
      if (snapshot.retryButton && isActionEnabled(snapshot.retryButton)) {
        log(`步骤 4：检测到密码页超时报错，正在点击“重试”（第 ${recoveryRound}/${maxRecoveryRounds} 次）...`, 'warn');
        await humanPause(350, 900);
        simulateClick(snapshot.retryButton);
        await sleep(1200);
        continue;
      }

      log(`步骤 4：检测到异常页，但“重试”按钮暂不可用，准备继续等待（${recoveryRound}/${maxRecoveryRounds}）...`, 'warn');
      continue;
    }

    if (snapshot.state === 'password') {
      if (!password) {
        throw new Error('当前回到了密码页，但没有可用密码，无法自动重新提交。');
      }

      if ((snapshot.passwordInput.value || '') !== password) {
        log('步骤 4：页面仍停留在密码页，正在重新填写密码...', 'warn');
        await humanPause(450, 1100);
        fillInput(snapshot.passwordInput, password);
      }

      if (snapshot.submitButton && isActionEnabled(snapshot.submitButton)) {
        log(`步骤 4：页面仍停留在密码页，正在重新点击“继续”（第 ${recoveryRound}/${maxRecoveryRounds} 次）...`, 'warn');
        await humanPause(350, 900);
        simulateClick(snapshot.submitButton);
        await sleep(1200);
        continue;
      }

      log(`步骤 4：页面仍停留在密码页，但“继续”按钮暂不可用，准备继续等待（${recoveryRound}/${maxRecoveryRounds}）...`, 'warn');
      continue;
    }

    log(`步骤 4：页面仍在切换中，准备继续等待（${recoveryRound}/${maxRecoveryRounds}）...`, 'warn');
  }

  throw new Error(`等待注册验证码页面就绪超时或自动恢复失败（已尝试 ${recoveryRound}/${maxRecoveryRounds} 轮）。URL: ${location.href}`);
}


async function waitForVerificationSubmitOutcome(step, timeout) {
  const resolvedTimeout = timeout ?? (step === 8 ? 30000 : 12000);
  const start = Date.now();

  while (Date.now() - start < resolvedTimeout) {
    throwIfStopped();

    const errorText = getVerificationErrorText();
    if (errorText) {
      return { invalidCode: true, errorText };
    }

    if (step === 4 && isStep5Ready()) {
      return { success: true };
    }

    if (step === 8 && isStep8Ready()) {
      return { success: true };
    }

    if (step === 8 && isAddPhonePageReady()) {
      return { success: true, addPhonePage: true };
    }

    await sleep(150);
  }

  if (isVerificationPageStillVisible()) {
    return {
      invalidCode: true,
      errorText: getVerificationErrorText() || '提交后仍停留在验证码页面，准备重新发送验证码。',
    };
  }

  return { success: true, assumed: true };
}

async function fillVerificationCode(step, payload) {
  const { code } = payload;
  if (!code) throw new Error('未提供验证码。');

  log(`步骤 ${step}：正在填写验证码：${code}`);

  if (step === 8) {
    await prepareLoginCodeFlow();
  }

  // Find code input — could be a single input or multiple separate inputs
  let codeInput = null;
  try {
    codeInput = await waitForElement(VERIFICATION_CODE_INPUT_SELECTOR, 10000);
  } catch {
    // Check for multiple single-digit inputs (common pattern)
    const singleInputs = document.querySelectorAll('input[maxlength="1"]');
    if (singleInputs.length >= 6) {
      log(`步骤 ${step}：发现分开的单字符验证码输入框，正在逐个填写...`);
      for (let i = 0; i < 6 && i < singleInputs.length; i++) {
        fillInput(singleInputs[i], code[i]);
        await sleep(100);
      }
      const outcome = await waitForVerificationSubmitOutcome(step);
      if (outcome.invalidCode) {
        log(`步骤 ${step}：验证码被拒绝：${outcome.errorText}`, 'warn');
      } else if (outcome.addPhonePage) {
        log(`步骤 ${step}：验证码已通过，并已跳转到手机号页面。`, 'ok');
      } else {
        log(`步骤 ${step}：验证码已通过${outcome.assumed ? '（按成功推定）' : ''}。`, 'ok');
      }
      return outcome;
    }
    throw new Error('未找到验证码输入框。URL: ' + location.href);
  }

  fillInput(codeInput, code);
  log(`步骤 ${step}：验证码已填写`);

  // Report complete BEFORE submit (page may navigate away)

  // Submit
  await sleep(500);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /verify|confirm|submit|continue|确认|验证/i, 5000).catch(() => null);

  if (submitBtn) {
    await humanPause(450, 1200);
    if (step === 8) {
      emitAuthFlowTrace('before_step8_code_submit', {
        step: 8,
        note: '登录验证码提交前',
        detail: `codeLength=${String(code).length}`,
      });
    }
    simulateClick(submitBtn);
    log(`步骤 ${step}：验证码已提交`);
  }

  const outcome = await waitForVerificationSubmitOutcome(step);
  if (step === 8) {
    emitAuthFlowTrace('after_step8_code_submit', {
      step: 8,
      note: '登录验证码提交后',
      detail: `outcome=${outcome.addPhonePage ? 'add_phone' : (outcome.invalidCode ? 'invalid_code' : (outcome.assumed ? 'assumed_success' : 'success'))}`,
    });
  }
  if (outcome.invalidCode) {
    log(`步骤 ${step}：验证码被拒绝：${outcome.errorText}`, 'warn');
  } else if (outcome.addPhonePage) {
    log(`步骤 ${step}：验证码已通过，并已跳转到手机号页面。`, 'ok');
  } else {
    log(`步骤 ${step}：验证码已通过${outcome.assumed ? '（按成功推定）' : ''}。`, 'ok');
  }

  return outcome;
}

// ============================================================
// Step 6: Find "继续" on OAuth consent page for debugger click
// ============================================================

async function step7_login(payload) {
  emitAuthFlowTrace('step7_login_entry', {
    step: 7,
    note: '进入登录步骤',
  });
  const { email, password } = payload;
  if (!email) throw new Error('登录时缺少邮箱地址。');
  if (!password) throw new Error('登录时缺少密码。');

  log(`步骤 7：正在使用 ${email} 登录...`);

  // Wait for email input on the auth page
  let emailInput = null;
  try {
    emailInput = await waitForElement(
      'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email" i], input[placeholder*="Email"]',
      15000
    );
  } catch {
    throw new Error('在登录页未找到邮箱输入框。URL: ' + location.href);
  }

  await humanPause(500, 1400);
  fillInput(emailInput, email);
  log('步骤 7：邮箱已填写');

  // Submit email
  await sleep(500);
  const submitBtn1 = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /continue|next|submit|继续|下一步/i, 5000).catch(() => null);
  if (submitBtn1) {
    await humanPause(400, 1100);
    simulateClick(submitBtn1);
    log('步骤 7：邮箱已提交');
  }

  await sleep(2000);

  // Check for password field
  const passwordInput = document.querySelector('input[type="password"]');
  if (passwordInput) {
    log('步骤 7：已找到密码输入框，正在填写密码...');
    await humanPause(550, 1450);
    fillInput(passwordInput, password);

    await sleep(500);
    const submitBtn2 = document.querySelector('button[type="submit"]')
      || await waitForElementByText('button', /continue|log\s*in|submit|sign\s*in|登录|继续/i, 5000).catch(() => null);
    // Report complete BEFORE submit in case page navigates
    reportComplete(7, { needsOTP: true });

    if (submitBtn2) {
      await humanPause(450, 1200);
      simulateClick(submitBtn2);
      log('步骤 7：密码已提交，可能还需要验证码（步骤 8）');
    }
    return;
  }

  // No password field — OTP flow
  log('步骤 7：未发现密码输入框，可能进入验证码流程或自动跳转。');
  reportComplete(7, { needsOTP: true });
}

// ============================================================
// Step 9: Find "继续" on OAuth consent page for debugger click
// ============================================================
// After login + verification, page shows:
// "使用 ChatGPT 登录到 Codex" with a "继续" submit button.
// Background performs the actual click through the debugger Input API.

async function step9_findAndClick() {
  emitAuthFlowTrace('step9_probe', {
    step: 9,
    note: '准备确认 OAuth 同意页状态',
  });
  if (isLocalhostOAuthCallbackUrl()) {
    log('步骤 9：当前页面已是 localhost 回调地址，跳过“继续”按钮点击。', 'ok');
    return {
      alreadyAtCallback: true,
      url: location.href,
    };
  }

  log('步骤 9：正在查找 OAuth 同意页的“继续”按钮...');

  const continueBtn = await prepareStep8ContinueButton();

  const rect = getSerializableRect(continueBtn);
  log('步骤 9：已找到“继续”按钮并准备好调试器点击坐标。');
  return {
    rect,
    buttonText: (continueBtn.textContent || '').trim(),
    url: location.href,
  };
}

function getStep8State() {
  if (isAddPhonePageReady()) {
    emitAuthFlowTrace('step9_state_add_phone', {
      step: 9,
      note: 'Step9 状态检查命中 add_phone',
    });
  }
  const pageText = getPageTextSnapshot();
  const continueBtn = getPrimaryContinueButton();
  const state = {
    url: location.href,
    consentPage: OAUTH_CONSENT_PAGE_PATTERN.test(pageText),
    consentReady: isStep8Ready(),
    verificationPage: isVerificationPageStillVisible(),
    addPhonePage: isAddPhonePageReady(),
    buttonFound: Boolean(continueBtn),
    buttonEnabled: isButtonEnabled(continueBtn),
    buttonText: continueBtn ? getActionText(continueBtn) : '',
  };

  if (continueBtn) {
    try {
      state.rect = getSerializableRect(continueBtn);
    } catch {
      state.rect = null;
    }
  }

  return state;
}

async function step8_triggerContinue(payload = {}) {
  const strategy = payload?.strategy || 'requestSubmit';
  const continueBtn = await prepareStep8ContinueButton({
    findTimeoutMs: payload?.findTimeoutMs,
    enabledTimeoutMs: payload?.enabledTimeoutMs,
  });
  const form = continueBtn.form || continueBtn.closest('form');

  switch (strategy) {
    case 'requestSubmit':
      if (!form || typeof form.requestSubmit !== 'function') {
        throw new Error('“继续”按钮当前不在可提交的 form 中，无法使用 requestSubmit。URL: ' + location.href);
      }
      form.requestSubmit(continueBtn);
      break;
    case 'nativeClick':
      continueBtn.click();
      break;
    case 'dispatchClick':
      simulateClick(continueBtn);
      break;
    default:
      throw new Error(`未知的 Step 9 触发策略：${strategy}`);
  }

  log(`步骤 9：已通过 ${strategy} 触发“继续”按钮。`);
  return {
    strategy,
    ...getStep8State(),
  };
}

async function prepareStep8ContinueButton(options = {}) {
  const {
    findTimeoutMs = 10000,
    enabledTimeoutMs = 8000,
  } = options;

  const continueBtn = await findContinueButton(findTimeoutMs);
  await waitForButtonEnabled(continueBtn, enabledTimeoutMs);

  await humanPause(350, 650);
  continueBtn.scrollIntoView({ behavior: 'auto', block: 'center' });
  continueBtn.focus();
  await waitForStableButtonRect(continueBtn);
  return continueBtn;
}

async function findContinueButton(timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (isAddPhonePageReady()) {
      throw new Error('当前页面已进入手机号页面，不是 OAuth 授权同意页。URL: ' + location.href);
    }
    const button = getPrimaryContinueButton();
    if (button && isStep8Ready()) {
      return button;
    }
    await sleep(150);
  }

  const pageState = getStep8State();
  debugLog('Step 9 continue button lookup failed', {
    url: location.href,
    pageState,
    title: document.title || '',
    pageText: getPageTextSnapshot().slice(0, 400),
  });
  throw new Error('在 OAuth 同意页未找到“继续”按钮，或页面尚未进入授权同意状态。URL: ' + location.href);
}

async function waitForButtonEnabled(button, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (isButtonEnabled(button)) return;
    await sleep(150);
  }
  throw new Error('“继续”按钮长时间不可点击。URL: ' + location.href);
}

function isButtonEnabled(button) {
  return Boolean(button)
    && !button.disabled
    && button.getAttribute('aria-disabled') !== 'true';
}

async function waitForStableButtonRect(button, timeout = 1500) {
  let previous = null;
  let stableSamples = 0;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    const rect = button?.getBoundingClientRect?.();
    if (rect && rect.width > 0 && rect.height > 0) {
      const snapshot = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };

      if (
        previous
        && Math.abs(snapshot.left - previous.left) < 1
        && Math.abs(snapshot.top - previous.top) < 1
        && Math.abs(snapshot.width - previous.width) < 1
        && Math.abs(snapshot.height - previous.height) < 1
      ) {
        stableSamples += 1;
        if (stableSamples >= 2) {
          return;
        }
      } else {
        stableSamples = 0;
      }

      previous = snapshot;
    }

    await sleep(80);
  }
}

function getSerializableRect(el) {
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    throw new Error('滚动后“继续”按钮没有可点击尺寸。URL: ' + location.href);
  }

  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    centerX: rect.left + (rect.width / 2),
    centerY: rect.top + (rect.height / 2),
  };
}

// ============================================================
// Step 5: Fill Name & Birthday / Age
// ============================================================

monitorAddPhoneRouteTransitions();

async function step5_fillNameBirthday(payload) {
  const { firstName, lastName, age, year, month, day } = payload;

  if (!isStep5Ready()) {
    if (isStep8Ready()) {
      log('步骤 5：当前账号已跳过资料页，页面已直接进入 OAuth 同意页。', 'warn');
      reportComplete(5, { skippedDirectToConsent: true });
      return;
    }

    if (isLocalhostOAuthCallbackUrl()) {
      log('步骤 5：当前账号已跳过资料页，页面已直接进入 localhost 回调地址。', 'warn');
      reportComplete(5, { skippedDirectToCallback: true, localhostUrl: location.href });
      return;
    }
  }

  if (!firstName || !lastName) throw new Error('未提供姓名数据。');

  const resolvedAge = age ?? (year ? new Date().getFullYear() - Number(year) : null);
  const hasBirthdayData = [year, month, day].every(value => value != null && !Number.isNaN(Number(value)));
  if (!hasBirthdayData && (resolvedAge == null || Number.isNaN(Number(resolvedAge)))) {
    throw new Error('未提供生日或年龄数据。');
  }

  const fullName = `${firstName} ${lastName}`;
  log(`步骤 5：正在填写姓名：${fullName}`);

  // Actual DOM structure:
  // - Full name: <input name="name" placeholder="全名" type="text">
  // - Birthday: React Aria DateField or hidden input[name="birthday"]
  // - Age: <input name="age" type="text|number">

  // --- Full Name (single field, not first+last) ---
  let nameInput = null;
  try {
    nameInput = await waitForElement(
      'input[name="name"], input[placeholder*="全名"], input[autocomplete="name"]',
      10000
    );
  } catch {
    throw new Error('未找到姓名输入框。URL: ' + location.href);
  }
  await humanPause(500, 1300);
  fillInput(nameInput, fullName);
  log(`步骤 5：姓名已填写：${fullName}`);

  let birthdayMode = false;
  let ageInput = null;
  let yearSpinner = null;
  let monthSpinner = null;
  let daySpinner = null;
  let hiddenBirthday = null;
  let yearReactSelect = null;
  let monthReactSelect = null;
  let dayReactSelect = null;
  let visibleAgeInput = false;
  let visibleBirthdaySpinners = false;
  let visibleBirthdaySelects = false;

  for (let i = 0; i < 100; i++) {
    yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
    monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
    daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');
    hiddenBirthday = document.querySelector('input[name="birthday"]');
    ageInput = document.querySelector('input[name="age"]');
    yearReactSelect = findBirthdayReactAriaSelect('年');
    monthReactSelect = findBirthdayReactAriaSelect('月');
    dayReactSelect = findBirthdayReactAriaSelect('天');

    visibleAgeInput = Boolean(ageInput && isVisibleElement(ageInput));
    visibleBirthdaySpinners = Boolean(
      yearSpinner
      && monthSpinner
      && daySpinner
      && isVisibleElement(yearSpinner)
      && isVisibleElement(monthSpinner)
      && isVisibleElement(daySpinner)
    );
    visibleBirthdaySelects = Boolean(
      yearReactSelect?.button
      && monthReactSelect?.button
      && dayReactSelect?.button
      && isVisibleElement(yearReactSelect.button)
      && isVisibleElement(monthReactSelect.button)
      && isVisibleElement(dayReactSelect.button)
    );

    if (visibleAgeInput) break;
    if (visibleBirthdaySpinners || visibleBirthdaySelects) {
      birthdayMode = true;
      break;
    }
    await sleep(100);
  }

  if (birthdayMode) {
    if (!hasBirthdayData) {
      throw new Error('检测到生日字段，但未提供生日数据。');
    }

    const yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
    const monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
    const daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');
    const yearReactSelect = findBirthdayReactAriaSelect('年');
    const monthReactSelect = findBirthdayReactAriaSelect('月');
    const dayReactSelect = findBirthdayReactAriaSelect('天');

    if (yearReactSelect?.nativeSelect && monthReactSelect?.nativeSelect && dayReactSelect?.nativeSelect) {
      const desiredDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const hiddenBirthday = document.querySelector('input[name="birthday"]');

      log('步骤 5：检测到 React Aria 下拉生日字段，正在填写生日...');
      await humanPause(450, 1100);
      await setReactAriaBirthdaySelect(yearReactSelect, year);
      await humanPause(250, 650);
      await setReactAriaBirthdaySelect(monthReactSelect, month);
      await humanPause(250, 650);
      await setReactAriaBirthdaySelect(dayReactSelect, day);

      if (hiddenBirthday) {
        const start = Date.now();
        while (Date.now() - start < 2000) {
          if ((hiddenBirthday.value || '') === desiredDate) break;
          await sleep(100);
        }

        if ((hiddenBirthday.value || '') !== desiredDate) {
          throw new Error(`生日值未成功写入页面。期望 ${desiredDate}，实际 ${(hiddenBirthday.value || '空')}。`);
        }
      }

      log(`步骤 5：React Aria 生日已填写：${desiredDate}`);
    }

    if (yearSpinner && monthSpinner && daySpinner) {
      log('步骤 5：检测到生日字段，正在填写生日...');

      async function setSpinButton(el, value) {
        el.focus();
        await sleep(100);
        document.execCommand('selectAll', false, null);
        await sleep(50);

        const valueStr = String(value);
        for (const char of valueStr) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: `Digit${char}`, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: char, code: `Digit${char}`, bubbles: true }));
          el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: char, bubbles: true }));
          el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }));
          await sleep(50);
        }

        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', code: 'Tab', bubbles: true }));
        el.blur();
        await sleep(100);
      }

      await humanPause(450, 1100);
      await setSpinButton(yearSpinner, year);
      await humanPause(250, 650);
      await setSpinButton(monthSpinner, String(month).padStart(2, '0'));
      await humanPause(250, 650);
      await setSpinButton(daySpinner, String(day).padStart(2, '0'));
      log(`步骤 5：生日已填写：${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }

    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    if (hiddenBirthday) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      hiddenBirthday.value = dateStr;
      hiddenBirthday.dispatchEvent(new Event('input', { bubbles: true }));
      hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
      log(`步骤 5：已设置隐藏生日输入框：${dateStr}`);
    }
  } else if (ageInput) {
    if (resolvedAge == null || Number.isNaN(Number(resolvedAge))) {
      throw new Error('检测到年龄字段，但未提供年龄数据。');
    }
    await humanPause(500, 1300);
    fillInput(ageInput, String(resolvedAge));
    log(`步骤 5：年龄已填写：${resolvedAge}`);
  } else {
    throw new Error('未找到生日或年龄输入项。URL: ' + location.href);
  }

  // Click "完成帐户创建" button
  await sleep(500);
  const completeBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /完成|create|continue|finish|done|agree/i, 5000).catch(() => null);
  if (!completeBtn) {
    throw new Error('未找到“完成帐户创建”按钮。URL: ' + location.href);
  }

  await humanPause(500, 1300);
  emitAuthFlowTrace('before_step5_submit', {
    step: 5,
    note: '资料页提交前',
    detail: `name=${fullName}`,
  });
  simulateClick(completeBtn);
  log('步骤 5：已点击“完成帐户创建”，正在等待页面结果...');

  const outcome = await waitForStep5SubmitOutcome();
  emitAuthFlowTrace('after_step5_submit', {
    step: 5,
    note: '资料页提交后',
    detail: `terminalState=${outcome.terminalState || (outcome.addPhonePage ? 'add_phone' : (outcome.invalidProfile ? 'invalid_profile' : 'unknown'))}`,
  });
  if (outcome.invalidProfile) {
    throw new Error(`步骤 5：${outcome.errorText}`);
  }

  log(`步骤 5：资料已通过。`, 'ok');
  if (outcome.terminalState === 'callback') {
    reportComplete(5, {
      skippedDirectToCallback: true,
      localhostUrl: outcome.localhostUrl || location.href,
    });
    return;
  }

  if (outcome.terminalState === 'consent') {
    reportComplete(5, { skippedDirectToConsent: true });
    return;
  }

  reportComplete(5, { addPhonePage: Boolean(outcome.addPhonePage) });
}
