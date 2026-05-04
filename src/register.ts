import type { Page } from 'playwright';
import { LOGIN, REGISTER, URLS } from './selectors.js';

export interface RegistrationData {
  userId: string;
  password: string;
  /**
   * Set true to let the script fill the password fields. Otherwise the script will stop
   * at each panel and wait for a human to fill / confirm. Recommended default is false:
   * registration is a one-time setup with sensitive fields the script doesn't yet model
   * (user category, mobile/email OTP, DSC, etc.).
   */
  autofillPasswords?: boolean;
}

export type RegisterOutcome =
  | { kind: 'awaiting-human'; reason: string; currentUrl: string }
  | { kind: 'success'; landedAt: string }
  | { kind: 'unknown'; landedAt: string; bodyTextSample: string };

/**
 * Starts the registration flow on fologin.html. Registration on MCA V3 is multi-step
 * (category select → identity fields → mobile/email OTP → password → captcha → DSC association).
 * Most of these steps require user input or values we don't have, so this opens the form,
 * fills the parts we know, and hands off to the human.
 */
export async function startRegistration(page: Page, data: RegistrationData): Promise<RegisterOutcome> {
  await page.goto(URLS.LOGIN, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(LOGIN.REGISTER_BTN, { state: 'visible', timeout: 20_000 });
  await page.locator(LOGIN.REGISTER_BTN).click();

  // Wait for the registration panel to render. We watch for either the user-id field or
  // the confirm/cancel button — whichever appears first signals the panel is up.
  await Promise.race([
    page.waitForSelector(REGISTER.USER_ID_FIELD, { state: 'visible', timeout: 20_000 }),
    page.waitForSelector(REGISTER.CONFIRM_BTN, { state: 'visible', timeout: 20_000 }),
  ]).catch(() => {});

  // Fill the user ID if the field is present and editable.
  const userIdField = page.locator(REGISTER.USER_ID_FIELD);
  if (await userIdField.isVisible().catch(() => false)) {
    const enabled = await userIdField.isEnabled().catch(() => false);
    if (enabled) await userIdField.fill(data.userId);
  }

  if (data.autofillPasswords) {
    const pw = page.locator(REGISTER.PASSWORD_FIELD);
    const pwc = page.locator(REGISTER.PASSWORD_CONFIRM_FIELD);
    if (await pw.isVisible().catch(() => false)) await pw.fill(data.password);
    if (await pwc.isVisible().catch(() => false)) await pwc.fill(data.password);
  }

  return {
    kind: 'awaiting-human',
    reason:
      'Registration requires user-category, mobile/email OTP verification, captcha and (for Business User) DSC association. Complete these in the open browser window. The script will not click submit on your behalf.',
    currentUrl: page.url(),
  };
}
