import type { Page } from 'playwright';
import { solveCaptchaWithVision } from './captcha-solver.js';

/**
 * MCA V3 captcha is server-validated HMAC. The page calls:
 *   GET  /bin/mca/generateCaptchaWithHMAC  → multipart blob (PNG + WAV) + sets pre_CT on canvas
 *   POST /bin/mca/HmacCaptchaValidationServlet  → encrypted (userInput, pre_CT), returns new pre_CT
 *
 * There is no client-side answer to extract. To pass it we either:
 *   (a) hand off to a human in the open browser (current default)
 *   (b) OCR / vision-read the canvas image
 *   (c) audio-transcribe the WAV
 *   (d) outsource to a captcha service
 */
export const CAPTCHA = {
  POPUP: '#captchaPopup',
  CANVAS: '#captchaCanvas',
  REFRESH_IMG: '#refresh-img',
  AUDIO_PLAY: '#captcha_play_image',
  INPUT: '#customCaptchaInput',
  RESULT_TEXT: '#showResult',
  CONTINUE_BTN: '#guideContainer-rootPanel-modal_container_copy_984288898-nextitemnav_copy___widget',
  GENERATE_ENDPOINT: '/bin/mca/generateCaptchaWithHMAC',
  VALIDATE_ENDPOINT: '/bin/mca/HmacCaptchaValidationServlet',
} as const;

/**
 * Captures the current captcha image as a base64 PNG so a vision model / OCR can read it.
 * Returns the image data without solving — solving is left to the caller.
 */
export async function snapshotCaptchaImage(page: Page): Promise<{ pngBase64: string; preCT: string | null }> {
  return await page.evaluate(() => {
    const canvas = document.getElementById('captchaCanvas') as HTMLCanvasElement | null;
    if (!canvas) throw new Error('captchaCanvas not present');
    const dataUrl = canvas.toDataURL('image/png');
    const pngBase64 = dataUrl.split(',', 2)[1] ?? '';
    const preCT = canvas.getAttribute('pre_CT');
    return { pngBase64, preCT };
  });
}

/** True when the captcha modal is currently visible. */
export async function isCaptchaVisible(page: Page): Promise<boolean> {
  return await page.locator(CAPTCHA.POPUP).isVisible().catch(() => false);
}

/** Clicks the refresh icon — useful if the captcha image looks unreadable. */
export async function refreshCaptcha(page: Page): Promise<void> {
  await page.locator(CAPTCHA.REFRESH_IMG).click();
}

/**
 * Submits a candidate captcha solution and waits for either success (popup closes) or an error message.
 */
export async function submitCaptcha(page: Page, value: string, opts: { timeoutMs?: number } = {}): Promise<{ ok: boolean; error?: string }> {
  await page.locator(CAPTCHA.INPUT).fill(value);
  await page.locator(CAPTCHA.CONTINUE_BTN).click();

  const timeout = opts.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const stillVisible = await isCaptchaVisible(page);
    if (!stillVisible) return { ok: true };
    const errText = (await page.locator(CAPTCHA.RESULT_TEXT).innerText().catch(() => '')).trim();
    if (errText) return { ok: false, error: errText };
    await page.waitForTimeout(500);
  }
  return { ok: false, error: 'timed out waiting for captcha resolution' };
}

export interface AutoSolveResult {
  ok: boolean;
  attempts: number;
  attemptsLog: { attempt: number; solution?: string; outcome: 'solved' | 'invalid' | 'solver-error'; error?: string }[];
  lastError?: string;
}

/**
 * Reads the captcha image, asks Claude to OCR it, fills the input, clicks Continue.
 * Refreshes the captcha and retries up to `maxAttempts` times if validation rejects the answer.
 */
export async function autoSolveCaptcha(page: Page, opts: { maxAttempts?: number } = {}): Promise<AutoSolveResult> {
  const max = opts.maxAttempts ?? 3;
  const log: AutoSolveResult['attemptsLog'] = [];
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= max; attempt++) {
    if (!(await isCaptchaVisible(page))) {
      return { ok: true, attempts: attempt - 1, attemptsLog: log };
    }

    let solution: string;
    try {
      const { pngBase64 } = await snapshotCaptchaImage(page);
      solution = await solveCaptchaWithVision(pngBase64);
    } catch (e) {
      lastError = `solver: ${(e as Error).message}`;
      log.push({ attempt, outcome: 'solver-error', error: lastError });
      await refreshCaptcha(page);
      await page.waitForTimeout(800);
      continue;
    }

    const result = await submitCaptcha(page, solution);
    if (result.ok) {
      log.push({ attempt, solution, outcome: 'solved' });
      return { ok: true, attempts: attempt, attemptsLog: log };
    }

    lastError = result.error;
    log.push({ attempt, solution, outcome: 'invalid', error: result.error });

    if (await isCaptchaVisible(page)) {
      await refreshCaptcha(page);
      await page.waitForTimeout(800);
    } else {
      // Modal closed (e.g. moved on to OTP) despite reported error — treat as solved.
      return { ok: true, attempts: attempt, attemptsLog: log };
    }
  }

  return { ok: false, attempts: max, attemptsLog: log, lastError };
}
