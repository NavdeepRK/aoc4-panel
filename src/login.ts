import type { Page } from 'playwright';
import { LOGIN, URLS } from './selectors.js';
import { CAPTCHA, isCaptchaVisible, autoSolveCaptcha } from './captcha.js';

export interface LoginCredentials {
  userId: string;
  password: string;
}

export type CurrentStep =
  | 'captcha'
  | 'otp'
  | 'invalid-credentials'
  | 'logged-in'
  | 'session-conflict'  // "already logged in elsewhere" popup — must click Yes to continue
  | 'login-form'
  | 'unknown';

export interface LoginObservation {
  step: CurrentStep;
  url: string;
  errorMessage?: string;
}

/**
 * Fills the login form and clicks Login. Does NOT advance past captcha / OTP.
 */
export async function submitCredentials(page: Page, creds: LoginCredentials): Promise<void> {
  if (!creds.userId || !creds.password) {
    throw new Error('login: userId and password are required (set MCA_USER_ID / MCA_PASSWORD)');
  }
  await page.goto(URLS.LOGIN, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(LOGIN.USER_ID, { state: 'visible', timeout: 20_000 });
  await page.locator(LOGIN.USER_ID).fill(creds.userId);
  await page.locator(LOGIN.PASSWORD).fill(creds.password);
  await page.locator(LOGIN.LOGIN_BTN).click();
}

/** Returns the current step the user is on, based on visible UI markers. */
export async function observe(page: Page): Promise<LoginObservation> {
  const url = page.url();

  if (await isCaptchaVisible(page)) {
    return { step: 'captcha', url };
  }

  // Check for an inline error BEFORE the OTP-page check. When MCA rejects an
  // OTP, the OTP form stays visible with an inline error like "Invalid OTP" /
  // "Wrong OTP" — if we checked OTP first, observe() would return step='otp'
  // and the worker would never escalate the error, leaving the UI spinning at
  // SUBMITTING_OTP. The text filter is specific enough (invalid/incorrect/
  // wrong/etc) that it won't false-positive on a clean OTP page.
  const errorMsg = await page
    .locator('.guideFieldError, .guideMessage--error, [class*="error"]:not([class*="captcha"])')
    .filter({ hasText: /invalid|incorrect|wrong|locked|disabled|not\s*registered|expired|mismatch/i })
    .first()
    .textContent()
    .catch(() => null);
  if (errorMsg && errorMsg.trim()) {
    return { step: 'invalid-credentials', url, errorMessage: errorMsg.trim() };
  }

  const otpVisible = await page
    .getByText(/one\s*time\s*password|enter\s*otp|verify\s*otp/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (otpVisible) return { step: 'otp', url };

  // Logged-in markers, in priority order:
  //   1. URL contains /application-history — original confident signal
  //   2. URL outside the /foportal/fo*.html login routes AND both auth cookies set
  //   3. Cookies-only fallback for SPA-style flows where URL stays at fologin.html
  //      even after OTP submits successfully (observed live 2026-05-14: OTP succeeded,
  //      auth cookies set, but URL never changed — old check timed out).
  //
  // The cookie-based check uses BOTH sessionID + session-token-md5 (the names MCA has
  // been using consistently throughout 2025-2026). Both must be present AND have
  // values — otherwise we'd false-positive on partial state during the OTP submit.
  const onApplicationHistory = url.includes('/application-history');
  if (onApplicationHistory) {
    return { step: 'logged-in', url };
  }

  // Cookie-based fallback. page.context().cookies() is async; do it after the cheap URL
  // check above so we don't fire it every poll when URL alone is conclusive.
  const cookies = await page.context().cookies().catch(() => []);
  const hasAuth = cookies.some(c => c.name === 'sessionID' && c.value)
                && cookies.some(c => c.name === 'session-token-md5' && c.value);
  if (hasAuth) {
    return { step: 'logged-in', url };
  }

  // "Already logged in elsewhere" / session conflict modal.
  // MUST be checked BEFORE login-form: MCA renders this as an overlay while the
  // login form stays in the DOM, so LOGIN.USER_ID.isVisible() still returns true
  // and would incorrectly report 'login-form', confusing the entire login flow.
  const sessionConflict = await page
    .locator('text=/already\\s*(logged\\s*in|have\\s*an)|active\\s*session|end\\s*that\\s*session|logging\\s*in\\s*here\\s*again/i')
    .first()
    .isVisible()
    .catch(() => false);
  if (sessionConflict) return { step: 'session-conflict', url };

  // Login form still showing
  const userIdVisible = await page.locator(LOGIN.USER_ID).isVisible().catch(() => false);
  if (userIdVisible) return { step: 'login-form', url };

  return { step: 'unknown', url };
}

/**
 * Polls for a logged-in state. When a captcha is detected, attempts auto-solve via Claude vision
 * (if ANTHROPIC_API_KEY is set); otherwise falls back to human handoff in the open browser.
 * OTP always falls back to human (we don't automate OTP).
 */
export async function waitForLoggedIn(
  page: Page,
  opts: {
    timeoutMs?: number;
    pollMs?: number;
    onStep?: (obs: LoginObservation) => void;
    autoSolveCaptcha?: boolean;
    captchaMaxAttempts?: number;
  } = {},
): Promise<LoginObservation> {
  const timeout = opts.timeoutMs ?? 10 * 60_000;
  const poll = opts.pollMs ?? 2000;
  // Auto-solve enabled if EITHER captcha service is configured. TrueCaptcha is the
  // primary (~95% accuracy), with OpenRouter vision as fallback if both are set.
  const hasTrueCaptcha = !!(process.env.TRUECAPTCHA_USER && process.env.TRUECAPTCHA_KEY);
  const auto = opts.autoSolveCaptcha ?? (hasTrueCaptcha || !!process.env.OPENROUTER_API_KEY);
  const captchaAttempts = opts.captchaMaxAttempts ?? 3;
  const deadline = Date.now() + timeout;
  let lastStep: CurrentStep | null = null;
  let captchaTried = false;

  while (Date.now() < deadline) {
    const obs = await observe(page).catch((e) => ({ step: 'unknown' as const, url: page.url(), errorMessage: (e as Error).message }));
    if (obs.step !== lastStep) {
      lastStep = obs.step;
      captchaTried = false;
      opts.onStep?.(obs);
    }

    if (obs.step === 'captcha' && auto && !captchaTried) {
      captchaTried = true;
      const result = await autoSolveCaptcha(page, { maxAttempts: captchaAttempts }).catch((e) => ({
        ok: false,
        attempts: 0,
        attemptsLog: [],
        lastError: (e as Error).message,
      }));
      opts.onStep?.({
        step: 'captcha',
        url: page.url(),
        errorMessage: result.ok
          ? `auto-solved in ${result.attempts} attempt(s)`
          : `auto-solve failed after ${result.attempts}: ${result.lastError ?? 'unknown'} — falling back to human`,
      });
    }

    if (obs.step === 'logged-in') return obs;
    if (obs.step === 'invalid-credentials') return obs;
    await page.waitForTimeout(poll);
  }
  throw new Error('waitForLoggedIn: timed out');
}

// Compatibility wrapper for the original API.
export async function login(
  page: Page,
  creds: LoginCredentials,
  opts: { onStep?: (obs: LoginObservation) => void } = {},
): Promise<LoginObservation> {
  await submitCredentials(page, creds);
  return await waitForLoggedIn(page, { onStep: opts.onStep });
}

// Backwards-compat helper used by callers in earlier drafts.
export async function waitForHumanThen(
  page: Page,
  successPredicate: (page: Page) => Promise<boolean>,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const timeout = opts.timeoutMs ?? 5 * 60_000;
  const poll = opts.pollMs ?? 1500;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await successPredicate(page).catch(() => false)) return;
    await page.waitForTimeout(poll);
  }
  throw new Error('waitForHumanThen: timed out waiting for human step');
}

// Re-export selector constant references that callers may want.
export { CAPTCHA };
