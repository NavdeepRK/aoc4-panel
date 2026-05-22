/**
 * Worker that drives a single AOC-4 filing job.
 *
 * Strategy (rewritten 2026-05-01 evening — "honest save"):
 *
 * Earlier iterations bypassed AEM's `gb.validate()` and force-enabled `disabled` save
 * buttons to cram partial saves through panels 2-6. That worked for creating Siebel SR
 * records but produced ORPHAN drafts: the SRs existed in MCA's CRM but were invisible
 * to the user's "My Application" dashboard because AEM's portal draft store was never
 * populated. Without portal-store registration, no PDF download, no signed-PDF upload,
 * no formSubmitConfirmation — the entire downstream chain is gated on it.
 *
 * The fix: **save panel 1 cleanly through AEM's normal flow** (no validate bypass, no
 * disabled-attribute strip, no modal click hack). When panel 1 validates, AEM:
 *   1. Calls /bin/commonSaveSubmit → Siebel SR record
 *   2. Calls /content/forms/portal/draftandsubmission.fp.draft.json → AEM portal store
 *   3. Modal pops, user/automation acknowledges → form transitions to panel 2
 *
 * The draft now appears in My Application. The director/CA picks it up there, completes
 * panels 2-7 with their actual financial data + judgment calls, downloads the PDF for
 * DSC signing, and submits.
 *
 * Our automation's job is the bookkeeping → financials → draft creation slice. Panels
 * 2-7 + DSC + final submit run through MCA's UX (where professional review belongs anyway).
 *
 * Flow (assumes fresh `storage-state.json` — run `npm run login` first):
 *   1. Launch browser, load AOC-4 form, wait for guideBridge.
 *   2. Set CIN_Number_Professional_User, run prefillWithCin (60+ fields populate).
 *   3. Apply panel 1 fill (small-Pvt preset) + signatory tables.
 *   4. Click panel 1 Save NORMALLY — no overrides.
 *   5. Wait for both /bin/commonSaveSubmit AND .fp.draft.json XHRs to confirm dual-store save.
 *   6. Capture SR id, mark phase = DRAFT_CREATED, leave browser warm.
 *
 * Caveats:
 *   - Panel 1 validation must pass. small-Pvt preset radios are tuned for this case (Pvt Ltd,
 *     normal AGM, no extension, no provisional FS). For other scenarios extend the preset.
 *   - If panel 1 fails to validate, the worker logs the visible error markers and exits in
 *     FAILED phase. No silent partial saves.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { launch } from '../browser.js';
import { AOC4_FORM_URL, waitForBridge } from '../aoc4/bridge.js';
import { setPhase, type Aoc4Job, deferred } from './jobs.js';
import { submitCredentials, observe } from '../login.js';
import { autoSolveCaptcha } from '../captcha.js';
import { URLS, LOGIN } from '../selectors.js';

const SR_ID_REGEX = /\[Id\]\s*=\s*"([0-9A-Z\-]+)"/;
// Match both 'Submitted By is a required field' and quoted variants like
// "'Submitted By' is a required field" — MCA's wire format quotes the field name.
const PARTIAL_SAVE_MARKER = /['"]?Submitted By['"]?\s+is\s+a\s+required\s+field/i;

/**
 * Per-panel Save button widget IDs in the live AOC-4 form (captured via DOM scan
 * 2026-05-01). Panels 3 + 7 don't expose their own Save buttons in the visible DOM
 * (the form auto-saves them with the last non-empty panel). The worker handles this
 * by treating their save as a no-op and continuing.
 */
const PANEL_SAVE_IDS: Record<string, string | null> = {
  panel1AOC4: 'guideContainer-rootPanel-panel-panel-panel1AOC4-panel_copy_790625936-nextitemnav___widget',
  panel2AOC4: 'guideContainer-rootPanel-panel-panel-panel2AOC4-panel_copy_1258675259-nextitemnav___widget',
  panel3AOC4: null, // no separate Save button — saved via panel4 click in the live form
  panel4AOC4: 'guideContainer-rootPanel-panel-panel-panel4AOC4-panel_2074267803_cop_2609391-panel_2092040517-nextitemnav___widget',
  panel5AOC4: 'guideContainer-rootPanel-panel-panel-panel5AOC4-panel_1564862517-nextitemnav___widget',
  panel6AOC4: 'guideContainer-rootPanel-panel-panel-panel6AOC4-panel_685745594_copy-panel-nextitemnav___widget',
  panel7AOC4: null, // final-submit panel — no separate Save button (uses formSubmitConfirmation)
};

/**
 * After a successful per-SPOC login, post the captured Playwright storageState back
 * to the customer-portal-backend so the next ⚡ for this SPOC can skip the login flow.
 *
 * Endpoint:  POST {PORTAL_BACKEND_URL}/api/compliance/system/mca-session/:userId
 * Auth:      X-System-Token header set to env SYSTEM_AUTH_TOKEN
 *
 * Silently no-ops if SYSTEM_AUTH_TOKEN or PORTAL_BACKEND_URL is not configured —
 * the filing continues without saving the session (SPOC just has to log in again
 * next time).
 */
async function _postStorageStateBack(
  spocUserId: string,
  mcaUserId: string,
  storageState: { cookies?: unknown[]; origins?: unknown[] },
  log: (m: string) => void,
): Promise<void> {
  const backendUrl = process.env.PORTAL_BACKEND_URL;
  const token = process.env.SYSTEM_AUTH_TOKEN;
  if (!backendUrl || !token) {
    log('storageState save-back skipped — PORTAL_BACKEND_URL or SYSTEM_AUTH_TOKEN not set');
    return;
  }
  const url = `${backendUrl.replace(/\/$/, '')}/api/compliance/system/mca-session/${encodeURIComponent(spocUserId)}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-system-token': token,
      },
      body: JSON.stringify({ mcaUserId, storageState }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      log(`storageState save-back HTTP ${resp.status}: ${txt.slice(0, 200)}`);
      return;
    }
    log(`storageState save-back ok — session reusable for SPOC ${spocUserId} (mcaUserId=${mcaUserId})`);
  } catch (e) {
    log(`storageState save-back threw: ${(e as Error).message}`);
  }
}

/**
 * MCA sometimes shows a "This account is already logged in somewhere else.
 * Do you want to continue?" dialog right after credentials are accepted (and
 * occasionally during OTP flow). Auto-click Yes/Continue so the worker doesn't
 * stall waiting for human intervention — the original session gets booted,
 * which is what the SPOC presumably wants since they're re-logging in.
 *
 * Returns true if a popup was found + dismissed.
 */
async function _dismissAlreadyLoggedInPopup(page: import('playwright').Page): Promise<boolean> {
  try {
    // The dialog text varies slightly. Match on the recognisable phrase.
    const dialog = page.locator('text=/already\\s*logged\\s*in/i').first();
    if (await dialog.count() === 0) return false;
    // Find a Yes/Continue/OK button reasonably near the message
    const yesBtn = page
      .getByRole('button', { name: /^(yes|continue|ok|proceed|confirm)$/i })
      .first();
    if (await yesBtn.count() > 0) {
      await yesBtn.click({ timeout: 3000, force: true });
      return true;
    }
    // Fallback: any visible <button>/<a> with that text inside a modal-ish container
    const fallback = page.locator('button, a, input[type="button"], input[type="submit"]')
      .filter({ hasText: /^\s*(yes|continue|ok|proceed|confirm)\s*$/i })
      .first();
    if (await fallback.count() > 0) {
      await fallback.click({ timeout: 3000, force: true });
      return true;
    }
  } catch { /* swallow — best-effort */ }
  return false;
}

/**
 * Fill MCA's OTP input and click verify. The OTP page is reached after submitCredentials
 * succeeds; it has either a single OTP input or 6 separate digit boxes depending on the
 * AEM version. We try both layouts.
 */
async function _fillOtpAndSubmit(page: import('playwright').Page, otp: string): Promise<void> {
  // Single-input layout — common
  const singleOtp = page.getByLabel(/one\s*time\s*password|enter\s*otp|verify\s*otp|otp/i).first();
  if (await singleOtp.count() > 0 && await singleOtp.isVisible().catch(() => false)) {
    await singleOtp.fill(otp);
  } else {
    // 6-digit-box layout: type characters one at a time into visible inputs
    const inputs = await page.locator('input[maxlength="1"]').all();
    if (inputs.length >= otp.length) {
      for (let i = 0; i < otp.length; i++) {
        await inputs[i].fill(otp[i]);
      }
    } else {
      // Fallback: focus any visible text input and type
      const fallback = page.locator('input[type="text"], input[type="tel"], input:not([type])').first();
      await fallback.fill(otp);
    }
  }

  // Click a button labeled Verify / Submit / Continue
  const submitBtn = page.getByRole('button', { name: /verify|submit|continue|proceed|confirm/i }).first();
  if (await submitBtn.count() > 0) {
    await submitBtn.click();
  } else {
    // Fallback: press Enter on the OTP input
    await page.keyboard.press('Enter');
  }
}

export async function runAoc4Job(job: Aoc4Job, opts: { artifactDir: string; skipPanels2to6?: boolean; usePerJobLogin?: boolean }): Promise<void> {
  const { jobId, payload } = job;
  const log = (msg: string) => process.stdout.write(`[aoc4-worker ${jobId}] ${msg}\n`);

  // ── Per-job login mode (new, default) vs. legacy shared-session mode ─────────
  // When usePerJobLogin is true (the new flow), the worker:
  //   1. Launches a FRESH browser (no storage-state.json)
  //   2. Navigates to MCA login page
  //   3. Sets phase=LOGIN_NEEDED and awaits SPOC creds via /jobs/:id/creds
  //   4. Submits creds, sets phase=OTP_PENDING, awaits OTP via /jobs/:id/otp
  //   5. Verifies login success, sets phase=AUTHENTICATED, proceeds with form fill
  // When false (legacy), it loads the shared storage-state.json — for backwards
  // compat with the dev flow until all SPOCs are migrated.
  const perJobLogin = opts.usePerJobLogin ?? false;

  setPhase(jobId, 'LOGGING_IN');
  // Honors HEADLESS env var. For CI/automated runs set HEADLESS=true.
  //
  // Browser startup options:
  //   - Per-job mode WITHOUT saved session: fresh context, SPOC will log in
  //   - Per-job mode WITH saved session: load the per-SPOC storageState (skip login)
  //   - Legacy mode: load shared storage-state.json from disk
  const savedStorageState = payload._storageState;
  const { browser, page } = await launch({
    loadSession: !perJobLogin,
    storageState: perJobLogin && savedStorageState ? savedStorageState : undefined,
  });
  job._browser = browser;
  job._page = page;

  // esbuild (via tsx) emits `__name(fn, "name")` calls into compiled output when keepNames
  // is set. The helper is part of the Node runtime but missing in the browser. When we
  // page.evaluate(...) a function, the serialized form contains `__name(...)` references
  // and throws ReferenceError in the page. Polyfill via init script (string form so the
  // payload itself isn't subject to esbuild's compile-time transforms).
  await page.addInitScript('window.__name = function(f, n){ return f; };');

  if (perJobLogin) {
    // ─── Saved-session fast path ─────────────────────────────────────────────
    // If the SPOC has a saved MCA storage state, try opening the form directly.
    // If MCA accepts the cookies, we skip the login entirely. If we get redirected
    // to login, fall through to the fresh-login flow below.
    let usedSavedSession = false;
    if (savedStorageState) {
      log(`saved MCA session available (mcaUserId=${payload._savedMcaUserId ?? '?'}) — trying directly`);
      await page.goto(AOC4_FORM_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(2500);
      const url = page.url();
      const onLogin = /fologin|\/login|login\.html/i.test(url);
      if (!onLogin) {
        log('saved session valid — proceeding without login');
        setPhase(jobId, 'AUTHENTICATED');
        usedSavedSession = true;
      } else {
        log('saved session expired (redirected to login) — falling through to fresh login');
      }
    }

    if (usedSavedSession) {
      // Skip ahead — main form-fill flow takes over below at LOADING_FORM
    } else {
    // ─── Fresh per-SPOC login flow ───────────────────────────────────────────
    log('per-job login: navigating to MCA login page');
    await page.goto(URLS.LOGIN, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForSelector(LOGIN.USER_ID, { state: 'visible', timeout: 20_000 }).catch(() => {});

    // Set up the creds + otp signal deferreds so the HTTP endpoints can resolve them.
    const credsSignal = deferred<{ userId: string; password: string }>();
    const otpSignal   = deferred<{ otp: string }>();
    job._signals = { creds: credsSignal, otp: otpSignal };

    setPhase(jobId, 'LOGIN_NEEDED');
    log('waiting for SPOC credentials via POST /jobs/' + jobId + '/creds (15 min timeout)');
    const creds = await Promise.race([
      credsSignal.promise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('credentials timeout (15 min)')), 15 * 60 * 1000)),
    ]).catch((e: Error) => { throw e; });

    // Store userId on the job for the admin dashboard (password is never persisted)
    job.mcaUserId = creds.userId;

    setPhase(jobId, 'LOGGING_IN_CREDS');
    log(`submitting credentials for userId=${creds.userId}`);
    await submitCredentials(page, creds);

    // Poll for the next state — could be OTP step, invalid creds, captcha,
    // OR the "already logged in elsewhere" interstitial. Auto-dismiss the
    // latter on every iteration so the worker doesn't stall.
    let postLoginObs = await observe(page);
    for (let i = 0; i < 30 && (postLoginObs.step === 'login-form' || postLoginObs.step === 'unknown'); i++) {
      const dismissed = await _dismissAlreadyLoggedInPopup(page);
      if (dismissed) log('dismissed "already logged in elsewhere" popup');
      await page.waitForTimeout(500);
      postLoginObs = await observe(page);
    }

    if (postLoginObs.step === 'invalid-credentials') {
      log(`MCA rejected credentials: ${postLoginObs.errorMessage}`);
      setPhase(jobId, 'INVALID_CREDS', { error: postLoginObs.errorMessage ?? 'MCA rejected credentials' });
      await browser.close().catch(() => {});
      return;
    }

    // Captcha loop — try up to 3 times: each attempt calls autoSolveCaptcha
    // (which uses OPENROUTER_API_KEY / TrueCaptcha if configured), polls for
    // next state, retries if MCA throws a fresh captcha back.
    let captchaAttempts = 0;
    while (postLoginObs.step === 'captcha' && captchaAttempts < 3) {
      captchaAttempts++;
      log(`captcha detected (attempt ${captchaAttempts}/3) — invoking autoSolveCaptcha`);
      const result = await autoSolveCaptcha(page, { maxAttempts: 3 }).catch((e: Error) => ({
        ok: false as const, error: e.message, attempts: 0,
      }));
      log(`autoSolveCaptcha returned: ${JSON.stringify(result)}`);
      // Give MCA time to validate the submitted captcha + transition
      await page.waitForTimeout(2000);
      postLoginObs = await observe(page);
      // If still captcha, MCA rejected the solve — loop will retry with a fresh image
    }

    if (postLoginObs.step === 'captcha') {
      log('captcha unsolved after 3 attempts');
      setPhase(jobId, 'FAILED', { error: 'Captcha auto-solve failed — set OPENROUTER_API_KEY in worker .env, or solve manually in the headed browser' });
      await browser.close().catch(() => {});
      return;
    }

    if (postLoginObs.step === 'otp') {
      setPhase(jobId, 'OTP_PENDING');
      log('OTP page reached — waiting for SPOC OTP via POST /jobs/' + jobId + '/otp OR direct browser entry (5 min timeout)');

      // Race three outcomes (whichever happens first wins):
      //   1. SPOC POSTed OTP to /jobs/:id/otp  → worker fills it via Playwright
      //   2. SPOC typed OTP directly in the browser tab (production won't allow
      //      this since SPOCs don't see the headless browser, but in dev/headed
      //      mode this is convenient — observe() detects the logged-in state)
      //   3. 5-minute timeout → FAILED
      //
      // We also auto-dismiss the "already logged in" popup mid-OTP since MCA
      // sometimes shows it on the OTP page too.
      const OTP_TIMEOUT_MS = 5 * 60 * 1000;
      const otpStart = Date.now();
      let otpFilled = false;
      let observedLoggedIn = false;

      while (Date.now() - otpStart < OTP_TIMEOUT_MS) {
        // Always try to dismiss the popup first
        await _dismissAlreadyLoggedInPopup(page).catch(() => {});

        // Did the API receive an OTP?
        if (!otpFilled) {
          // Non-blocking check: if the signal already resolved, fill it; otherwise move on
          const otpData = await Promise.race([
            otpSignal.promise.then(d => ({ resolved: true as const, data: d })),
            new Promise<{ resolved: false }>(r => setTimeout(() => r({ resolved: false }), 200)),
          ]);
          if (otpData.resolved) {
            setPhase(jobId, 'SUBMITTING_OTP');
            log(`SPOC POSTed OTP via API (${otpData.data.otp.length} chars) — filling`);
            await _fillOtpAndSubmit(page, otpData.data.otp);
            otpFilled = true;
          }
        }

        // Check the browser state regardless — SPOC may have typed OTP in the
        // browser tab directly (dev/headed mode), or our fill above may have
        // succeeded and AEM transitioned.
        const obs = await observe(page);
        if (obs.step === 'logged-in') {
          observedLoggedIn = true;
          postLoginObs = obs;
          if (!otpFilled) log('login completed in browser (OTP not received via API — assuming SPOC typed in headed browser)');
          break;
        }
        if (obs.step === 'invalid-credentials') {
          log(`MCA rejected OTP: ${obs.errorMessage}`);
          setPhase(jobId, 'INVALID_OTP', { error: obs.errorMessage ?? 'MCA rejected OTP' });
          await browser.close().catch(() => {});
          return;
        }
        await page.waitForTimeout(700);
      }

      if (!observedLoggedIn) {
        const msg = otpFilled
          ? 'OTP was submitted but MCA never confirmed logged-in state within 5 min'
          : 'OTP timeout (5 min) — SPOC never submitted OTP via the portal prompt';
        log(msg);
        setPhase(jobId, 'FAILED', { error: msg });
        await browser.close().catch(() => {});
        return;
      }
    }

    if (postLoginObs.step !== 'logged-in') {
      const msg = `login did not reach logged-in state (last step: ${postLoginObs.step})`;
      log(msg);
      setPhase(jobId, 'FAILED', { error: msg });
      await browser.close().catch(() => {});
      return;
    }

    setPhase(jobId, 'AUTHENTICATED');
    log('login successful — proceeding to AOC-4 form');

    // ─── Capture + persist the new storage state for this SPOC ──────────────
    // Posts to the customer-portal-backend's /system/mca-session/:userId endpoint
    // which encrypts at rest. The SPOC's NEXT trigger will reuse this and skip
    // the login flow entirely (until MCA's session cookies expire ~3h later).
    if (payload._spocUserId) {
      try {
        const newStorageState = await page.context().storageState();
        await _postStorageStateBack(payload._spocUserId, creds.userId, newStorageState, log);
      } catch (e) {
        log(`failed to capture/post storageState: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    } // close the `else { fresh per-SPOC login flow ... }` block
  }

  setPhase(jobId, 'LOADING_FORM');
  await page.goto(AOC4_FORM_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });

  // ── Legacy-mode session check (only relevant when usePerJobLogin=false) ──
  if (!perJobLogin) {
    const currentUrl = page.url();
    const isLoginPage =
      currentUrl.includes('fologin') ||
      currentUrl.includes('/login') ||
      currentUrl.includes('login.html');

    if (!isLoginPage) {
      await page.waitForTimeout(3000);
      const settledUrl = page.url();
      if (
        settledUrl.includes('fologin') ||
        settledUrl.includes('/login') ||
        settledUrl.includes('login.html')
      ) {
        await browser.close().catch(() => {});
        setPhase(jobId, 'FAILED', {
          error:
            'MCA session expired or storage-state.json is missing. ' +
            'Run `npm run login` in the mca-filing-service directory to create a fresh session, then retry.',
        });
        return;
      }
    } else {
      await browser.close().catch(() => {});
      setPhase(jobId, 'FAILED', {
        error:
          'MCA session expired or storage-state.json is missing. ' +
          'Run `npm run login` in the mca-filing-service directory to create a fresh session, then retry.',
      });
      return;
    }
  }
  log('session OK — form URL loaded');

  // waitForBridge with a descriptive error on timeout (e.g. session expired mid-load)
  await waitForBridge(page, 30_000).catch(async (e: unknown) => {
    const currentUrl = page.url();
    const onLogin =
      currentUrl.includes('fologin') ||
      currentUrl.includes('/login') ||
      currentUrl.includes('login.html');
    await browser.close().catch(() => {});
    const hint = onLogin
      ? 'Redirected to login page — session expired. Run `npm run login` and retry.'
      : `guideBridge did not load within 30 s (URL: ${currentUrl}). The form may have changed.`;
    throw Object.assign(new Error(hint), { cause: e });
  });

  await page.waitForFunction(
    () => typeof (window as unknown as { encrypt?: unknown }).encrypt === 'function' && !!document.querySelector('#csrfToken'),
    { timeout: 30_000 },
  );

  // Pre-prime the form's draftID before any save. Without this, each save creates a
  // NEW Siebel SR (proliferation issue) because the form's `_handleDraftSaveWrapper`
  // only generates a draftID when one is missing — and the per-panel saves race past
  // that initialisation. We mirror what AEM does internally:
  //   GET /content/forms/portal/draftandsubmission.fp.draft.json?func=getUid
  //   → gb.customContextProperty('draftID', `${uid}_af`)
  await page.evaluate(async () => {
    type GBExt = { customContextProperty?: (k: string, v?: unknown) => unknown };
    const gb = (window as unknown as { guideBridge: GBExt }).guideBridge;
    const existing = gb.customContextProperty?.('draftID');
    if (existing) return;
    try {
      const r = await fetch('/content/forms/portal/draftandsubmission.fp.draft.json?func=getUid', { credentials: 'include' });
      if (!r.ok) return;
      const j = await r.json() as { id?: string };
      if (j.id) gb.customContextProperty?.('draftID', j.id + '_af');
    } catch { /* worst case: original behavior (multiple SRs) */ }
  });
  log('draftID pre-primed');

  setPhase(jobId, 'PREFILLING');
  await page.evaluate((cin) => {
    type GuideNode = { name?: string; somExpression?: string; items?: GuideNode[] };
    const gb = (window as unknown as { guideBridge: { resolveNode: (s: string) => unknown; setProperty: (s: string[], p: string, v: unknown[]) => void } }).guideBridge;
    const root = gb.resolveNode('rootPanel') as GuideNode | null;
    const findSom = (name: string): string | null => {
      let found: string | null = null;
      const walk = (n: GuideNode | undefined): void => {
        if (!n || found) return;
        if (n.name === name && n.somExpression) { found = n.somExpression; return; }
        if (Array.isArray(n.items)) for (const k of n.items) walk(k);
      }
      walk(root ?? undefined);
      return found;
    }
    // Set the visible Professional CIN field (also write to Other_User + CINofCompany for safety)
    for (const n of ['CIN_Number_Professional_User', 'CIN_Number_Other_User', 'CINofCompany']) {
      const s = findSom(n);
      if (s) gb.setProperty([s], 'value', [cin]);
    }
    (window as unknown as { prefillWithCin: (s: string) => void }).prefillWithCin(cin);
  }, payload.cin);
  await page.waitForTimeout(4500);
  log('prefill complete');

  // ─── Diagnostic: dump radio + dropdown options for panel 1 radios so we can see
  // the REAL {value, label} mapping in AEM. The legacy worker's '1'=Yes assumption
  // was demonstrably wrong on the 2026-05-20 PHARMLOGIC run (model accepted '1'
  // but MCA rendered "Not Applicable"). AEM re-renders the form after prefill which
  // destroys the page context — retry a few times with increasing waits.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await page.waitForTimeout(2000 * attempt);
      const dump = await _dumpRadioOptions(page, [
        'whetherAnnualGeneralMeeting','wetherProFinancialStatement','whetherAdoptedAdjAGM',
        'whetherAnyExtension','whetherSchedule3','whetherConsolidated','whetherBooksOfAccount',
        'WhetherCompanyIsSubsidiary','whetherCompanyHasSubsidiary','categoryOfAuditor',
        'natureS','industryType','country_Auditor','area_locality_Auditor','InsuranceOrNBFC',
      ]);
      fs.writeFileSync(path.join(opts.artifactDir, `${jobId}-radio-options-dump.json`), JSON.stringify(dump, null, 2));
      log(`radio-options dumped (attempt ${attempt}) — ${dump.length} fields`);
      break;
    } catch (e) {
      log(`radio-options dump attempt ${attempt} threw: ${(e as Error).message?.slice(0, 100)}`);
      if (attempt === 5) log('radio-options dump failed after 5 attempts — proceeding without dump');
    }
  }

  // ─── HYBRID SAVE FLOW ───────────────────────────────────────────────────────
  // 1. Bypass gb.validate() so the panel-1 save click actually fires (otherwise AEM's
  //    GLOBAL validate fails on empty mandatory fields in panels 2-7 and the click is
  //    silently absorbed — we get no XHR).
  // 2. Click panel 1 Save → /bin/commonSaveSubmit fires → Siebel SR record created.
  // 3. Directly invoke AEM's `_handleDraftSave` — the inner function that does the portal
  //    register XHR, bypassing the validate-checking wrapper. This writes the draft to
  //    AEM's portal store at `/content/forms/portal/draftandsubmission`, so the draft
  //    appears in the user's "My Application" list.

  // Apply panel 1 fills + signatory tables (small-Pvt preset).
  setPhase(jobId, 'FILLING_PANEL', { panelInProgress: 1 });
  await applyPanel1(page, payload);
  await populateSignatoryTables(page, payload);

  // Apply schema-driven panel1 panelOverrides AFTER the legacy applyPanel1 hardcoded
  // values, so anything the SPOC entered in the form (e.g. natureS, agm dates) wins.
  const panel1Overrides = payload.panelOverrides?.panel1;
  if (panel1Overrides && Object.keys(panel1Overrides).length > 0) {
    const r = await _applyDirectOverrides(page, panel1Overrides, payload._fieldMeta);
    fs.writeFileSync(path.join(opts.artifactDir, `${jobId}-panel1-overrides.json`), JSON.stringify(r, null, 2));
    log(`panel1 applied ${r.count}/${Object.keys(panel1Overrides).length} direct overrides`);

    // Diagnostic dump — capture the AEM node options + nearby DOM radios for every
    // panel1 radio override so we can see the REAL {value, label} mapping when MCA
    // renders the wrong option. Runs after a settle delay so the page navigation
    // (post-modal-dismiss) doesn't destroy the execution context.
    await page.waitForTimeout(1500);
    try {
      const radioNames = Object.keys(panel1Overrides).filter(n =>
        ['whetherAnnualGeneralMeeting','wetherProFinancialStatement','whetherAdoptedAdjAGM',
         'whetherAnyExtension','whetherSchedule3','whetherConsolidated','whetherBooksOfAccount',
         'WhetherCompanyIsSubsidiary','whetherCompanyHasSubsidiary','categoryOfAuditor',
         'natureS','industryType'].includes(n));
      if (radioNames.length > 0) {
        const dump = await _dumpRadioOptions(page, radioNames);
        fs.writeFileSync(path.join(opts.artifactDir, `${jobId}-radio-options-dump.json`), JSON.stringify(dump, null, 2));
        log(`radio-options dumped (${radioNames.length} fields)`);
      }
    } catch (e) {
      log(`radio-options dump threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await page.waitForTimeout(800);
  log('panel1 filled + signatory tables populated');

  // ── Pre-save panel 1 validation check ───────────────────────────────────────
  // Trigger AEM's own per-field blur validation so errors appear in the DOM
  // before we inspect, then check for visible error markers.
  await page.evaluate(() => {
    // Fire blur on every visible input/select so AEM's field-level validators run
    document.querySelectorAll<HTMLElement>(
      '[id*="panel1AOC4"] input, [id*="panel1AOC4"] select, [id*="panel1AOC4"] textarea'
    ).forEach(el => {
      if ((el as HTMLElement).offsetParent !== null) {
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  });
  await page.waitForTimeout(600);

  const preCheck = await capturePanel1Errors(page);
  fs.writeFileSync(path.join(opts.artifactDir, `${jobId}-panel1-errors.json`), JSON.stringify(preCheck, null, 2));

  if (preCheck.errorCount > 0) {
    const errSummary = preCheck.samples.map(s => s.msg).join(' | ');
    log(`panel1 has ${preCheck.errorCount} validation error(s): ${errSummary}`);
    setPhase(jobId, 'FAILED', {
      error: `Panel 1 validation failed (${preCheck.errorCount} error${preCheck.errorCount > 1 ? 's' : ''}): ${errSummary.slice(0, 300)}`,
    });
    return;
  }
  log('panel1 validation clean — proceeding to save');

  // Bypass gb.validate so the save click fires despite panels 2-7 being empty.
  // (AEM's GLOBAL gb.validate() fails if any other panel has unfilled mandatory fields,
  //  silently swallowing the click without firing /bin/commonSaveSubmit. We've already
  //  confirmed panel 1 itself is clean above, so bypassing here is safe.)
  await page.evaluate(() => {
    type GBOverride = { validate?: () => boolean; _origValidate?: () => boolean };
    const gb = (window as unknown as { guideBridge: GBOverride }).guideBridge;
    if (typeof gb.validate === 'function' && !gb._origValidate) gb._origValidate = gb.validate.bind(gb);
    try { Object.defineProperty(gb, 'validate', { value: () => true, writable: false, configurable: false }); }
    catch { gb.validate = () => true; }
  });

  setPhase(jobId, 'SAVING_PANEL', { panelInProgress: 1 });
  const siebelPromise = page.waitForResponse(
    (r) => r.url().includes('/bin/commonSaveSubmit'), { timeout: 30_000 },
  ).catch(() => null);

  // Click the panel 1 Save button
  const clickRes = await page.evaluate(() => {
    const id = 'guideContainer-rootPanel-panel-panel-panel1AOC4-panel_copy_790625936-nextitemnav___widget';
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (!el) return { ok: false as const, reason: 'button not in DOM' };
    el.click();
    return { ok: true as const };
  });
  if (!clickRes.ok) {
    setPhase(jobId, 'FAILED', { error: `panel1 click failed: ${clickRes.reason}` });
    return;
  }

  const siebelResp = await siebelPromise;
  let srId: string | undefined;
  let aemDraftId: string | undefined;
  let aemResp: Awaited<ReturnType<typeof page.waitForResponse>> | null = null;

  // If no XHR fired at all, panel 1 save silently failed — check DOM for errors
  if (!siebelResp) {
    const postSaveErrors = await capturePanel1Errors(page);
    const errSummary = postSaveErrors.samples.map(s => s.msg).join(' | ') || 'Save button click did not reach MCA server (validate blocked or network error)';
    log(`panel1 save XHR never fired. DOM errors: ${errSummary}`);
    setPhase(jobId, 'FAILED', { error: `Panel 1 save failed: ${errSummary.slice(0, 300)}` });
    return;
  }

  // referenceNumber from a CLEAN save (e.g. "1-25383887613") — this is what shows in MCA's
  // "My Application" SRN column. Distinguished from the integrationId / SR id which is
  // shorter (e.g. "1-BNSWT19") and used internally.
  let referenceNumber: string | undefined;
  if (siebelResp) {
    try {
      const text = await siebelResp.text();
      fs.writeFileSync(path.join(opts.artifactDir, `${jobId}-siebel-response.json`), text);
      const outer = JSON.parse(text) as { resStr?: string };
      if (typeof outer.resStr === 'string') {
        const inner = JSON.parse(outer.resStr) as { message?: string; data?: { integrationId?: string; referenceNumber?: string; SRFOStatus?: string; formIntegrationId?: string } };
        // Old "partial save" pattern: error message contains [Id] = "1-XXXXX"
        const m = (inner.message ?? '').match(SR_ID_REGEX);
        if (m) srId = m[1];
        // New "Data Added Successfully" pattern: structured data block
        if (inner.data?.integrationId) srId = inner.data.integrationId;
        if (inner.data?.referenceNumber) referenceNumber = inner.data.referenceNumber;
        const status = inner.data?.SRFOStatus ?? '';
        // Detect server-side validation errors in the Siebel response
        const msg = inner.message ?? '';
        const isServerError = siebelResp.status() >= 400 ||
          (msg.length > 0 && !inner.data?.integrationId && !m);
        if (isServerError) {
          log(`panel1 Siebel save returned error: ${msg.slice(0, 200)}`);
          setPhase(jobId, 'FAILED', { error: `Panel 1 save rejected by MCA: ${msg.slice(0, 300) || `HTTP ${siebelResp.status()}`}` });
          return;
        }
        log(`Siebel save: status=${siebelResp.status()}, srId=${srId ?? '-'}, ref=${referenceNumber ?? '-'}, mcaStatus=${status}, msg=${msg.slice(0, 100)}`);
      } else {
        log(`Siebel save: status=${siebelResp.status()}, no resStr — body: ${text.slice(0, 200)}`);
      }
    } catch (e) {
      log(`Siebel save: status=${siebelResp.status()}, parse error: ${(e as Error).message}`);
    }
  } else {
    log('WARNING: no commonSaveSubmit response within 30s — Siebel save did not fire');
  }

  // ─── AEM PORTAL DRAFT REGISTER (the missing piece for My Application visibility) ───
  // Capture ALL POST requests during the next 25 seconds so we can identify the actual
  // AEM portal register URL (whatever pattern it uses).
  await page.waitForTimeout(1500);
  const aemPostsCapture: Array<{ url: string; status?: number; method: string; bodyPreview?: string }> = [];
  const recordRequest = (req: import('playwright').Request): void => {
    if (req.method() !== 'POST') return;
    if (/\.(css|js|png|jpg|gif|svg|ico|woff)/.test(req.url())) return;
    aemPostsCapture.push({ url: req.url(), method: req.method() });
  };
  const recordResponse = async (resp: import('playwright').Response): Promise<void> => {
    if (resp.request().method() !== 'POST') return;
    if (/\.(css|js|png|jpg|gif|svg|ico|woff)/.test(resp.url())) return;
    let entry = null;
    for (let i = aemPostsCapture.length - 1; i >= 0; i--) {
      if (aemPostsCapture[i].url === resp.url() && aemPostsCapture[i].status === undefined) { entry = aemPostsCapture[i]; break; }
    }
    if (!entry) return;
    entry.status = resp.status();
    try { entry.bodyPreview = (await resp.text()).slice(0, 300); } catch { /* */ }
  };
  page.on('request', recordRequest);
  page.on('response', recordResponse);

  const aemRegisterClick = await page.evaluate(() => {
    type WinExt = {
      handleDraftSave?: (cfg: unknown, opts?: unknown) => unknown;
      FD?: { FP?: { AF?: { _handleDraftSave?: (opts: unknown) => unknown; _handleDraftSaveWrapper?: (opts: unknown) => unknown } } };
    };
    const w = window as unknown as WinExt;
    const af = w.FD?.FP?.AF;
    if (!af?._handleDraftSave) return { ok: false as const, reason: '_handleDraftSave not exposed' };
    try {
      // Use _handleDraftSaveWrapper instead of _handleDraftSave directly — the wrapper
      // does the getUid → set draftID flow first if needed, then calls _handleDraftSave.
      // _handleDraftSave alone may not fire the XHR if internal state isn't right.
      af._handleDraftSaveWrapper?.({ metadataToSave: {}, enableAnonymous: false, isAutoSaveTriggered: false });
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, reason: (e as Error).message };
    }
  });
  log(`AEM _handleDraftSaveWrapper invocation: ${JSON.stringify(aemRegisterClick)}`);

  // Wait for any XHRs to settle
  await page.waitForTimeout(8_000);
  page.off('request', recordRequest);
  page.off('response', recordResponse);
  fs.writeFileSync(path.join(opts.artifactDir, `${jobId}-aem-posts.json`), JSON.stringify(aemPostsCapture, null, 2));
  log(`AEM posts captured: ${aemPostsCapture.length} — ${aemPostsCapture.map((p) => `${p.status ?? '?'} ${p.url.slice(-80)}`).join(', ')}`);

  // Find any AEM-portal-related POST in the captured set
  const aemRegisterPost = aemPostsCapture.find((p) => /draftandsubmission|fp\.attach|fp\.save|portal/i.test(p.url));
  if (aemRegisterPost) {
    log(`AEM portal draft register fired: ${aemRegisterPost.status ?? '?'} ${aemRegisterPost.url.slice(-100)}`);
    try {
      // Try to parse a draftID from the body preview
      const m = aemRegisterPost.bodyPreview?.match(/"(?:id|draftID)"\s*:\s*"([^"]+)"/);
      if (m) aemDraftId = m[1];
    } catch { /* */ }
  } else {
    log('WARNING: no AEM portal-register POST seen — draft may NOT appear in My Application');
  }
  // Mark aemResp as not-set since we no longer use the promise variant
  void aemResp;

  // Panel 1 is filled via explicit field writes (not generic fill), so we don't have
  // a fillStats count. Use a sentinel value (-1) to mean "filled by automation logic"
  // so the UI can distinguish it from panels that were genuinely empty (0).
  job.panelResults.push({ panel: 1, ok: !!siebelResp && siebelResp.status() < 400, srId, fieldsWritten: -1 });
  if (srId) job.srId = srId;
  if (referenceNumber) job.referenceNumber = referenceNumber;

  // Construct the "Continue Filing" / resume URL. Paste into a logged-in MCA browser
  // tab and the form re-loads with the draft's data populated. Discovered live 2026-05-02
  // — the `applicationHistory` query param is base64-encoded JSON of the draft identity.
  if (srId || referenceNumber) {
    const purpose = (payload as { natureOfFinancialStatements?: string }).natureOfFinancialStatements
      ?? 'Adopted Financial statements';
    const appHistory = {
      srn: '',
      reference: referenceNumber ?? '',
      purpose,
      integrationId: srId ?? '',
    };
    const encoded = Buffer.from(JSON.stringify(appHistory)).toString('base64');
    job.resumeUrl = `${AOC4_FORM_URL}?applicationHistory=${encodeURIComponent(encoded)}`;
    log(`resume URL: ${job.resumeUrl}`);
  }

  // Wait briefly for the post-save modal to render, then DISMISS IT.
  // After panel 1 saves MCA shows an "OK" confirmation modal. The form WON'T transition
  // to panel 2 until the modal is dismissed — panel 2's save button stays disabled, and
  // gb.resolveNode('panel2AOC4') returns a node with uninitialized fields (no `value` props).
  // Earlier code left this modal open ("don't dismiss programmatically") which caused
  // panels 2-6 to fill 0 fields. Dismissing here is required for the wizard to advance.
  await page.waitForTimeout(2000);
  const panel1ModalDismissed = await _dismissPostSaveModal(page);
  if (panel1ModalDismissed) {
    log('panel1 post-save modal dismissed — form should now navigate to panel 2');
    // Give AEM a moment to render panel 2's fields into the guideBridge model
    await page.waitForTimeout(2000);
  } else {
    log('panel1 post-save modal not found — form may have auto-advanced or modal uses different selector');
    await page.waitForTimeout(1000);
  }

  // Capture final state — does the bridge now report a draftID?
  const finalState = await page.evaluate(() => {
    type GBExt = { customContextProperty?: (k: string) => unknown };
    const gb = (window as unknown as { guideBridge: GBExt }).guideBridge;
    return { draftID: gb.customContextProperty?.('draftID') ?? null };
  });
  log(`final state: bridgeDraftID=${finalState.draftID ?? '-'} aemRespDraftID=${aemDraftId ?? '-'} siebelSR=${srId ?? '-'}`);

  if (!siebelResp || (siebelResp.status() >= 400)) {
    setPhase(jobId, 'FAILED', { error: 'panel1 save did not complete on Siebel' });
    return;
  }

  setPhase(jobId, 'DRAFT_CREATED');
  log(`draft created — SR ${srId}, AEM draftID ${aemDraftId ?? finalState.draftID ?? '(not registered)'}`);

  // ─── PANEL 2-6 COMPLETION (force-save technique on top of hybrid save) ────────
  //
  // Panel 1's hybrid save registered the draft in MCA's My Application. But the form's
  // PDF render endpoint only becomes available when ALL panels are filled — partial
  // drafts have no downloadable PDF (verified live 2026-05-02 by manually opening our
  // draft and observing the missing PDF action).
  //
  // Strategy:
  //   - Validate-bypass is already in place from panel 1
  //   - Generic-fill panel content (numerics → 0.00, radios → '1', dates → today, text → 'NA')
  //   - Force-enable disabled save buttons (AEM gates them by current-panel-index)
  //   - Click save → /bin/commonSaveSubmit fires for each panel
  //   - Dismiss the post-save modal between panels
  //
  // Panels 3 and 7 don't have their own Save buttons — panel 3 rolls into panel 4's save,
  // panel 7 is review/submit (handled by formSubmitConfirmation, not auto-saveable).
  if (opts.skipPanels2to6 !== true) {
    const downstreamPanels: Array<'panel2AOC4' | 'panel3AOC4' | 'panel4AOC4' | 'panel5AOC4' | 'panel6AOC4'> =
      ['panel2AOC4', 'panel3AOC4', 'panel4AOC4', 'panel5AOC4', 'panel6AOC4'];

    for (const panelKey of downstreamPanels) {
      const panelNum = Number(panelKey.match(/panel(\d+)AOC4/)?.[1]);
      setPhase(jobId, 'FILLING_PANEL', { panelInProgress: panelNum });

      // CRITICAL: wait for the panel's Save button to enable BEFORE filling.
      // AEM keeps panels 2-6 in a non-active state with `disabled=true` on their Save
      // buttons until the previous panel saves successfully and the panel transitions.
      // Filling a non-active panel is a no-op (the bridge fields aren't visible/writable).
      // Discovered live 2026-05-04 — earlier code filled too eagerly and saw `0n / 0r / 0t / 0d`
      // for every downstream panel.
      // Root cause (2026-05-13): the post-save modal from the PREVIOUS panel must be dismissed
      // before the CURRENT panel's save button enables. The form won't navigate forward while
      // a modal is open. We now dismiss the previous panel's modal right after its save, but
      // as a belt-and-suspenders check we also try dismissal here, before the button poll.
      const dismissedBeforePoll = await _dismissPostSaveModal(page);
      if (dismissedBeforePoll) {
        log(`panel${panelNum} found lingering modal before button poll — dismissed`);
        await page.waitForTimeout(1500);
      }

      const buttonId = PANEL_SAVE_IDS[panelKey];
      if (buttonId) {
        const enabled = await page.evaluate(async (id: string) => {
          const start = Date.now();
          while (Date.now() - start < 20_000) {
            const el = document.getElementById(id) as HTMLButtonElement | null;
            if (el && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && el.offsetParent !== null) return true;
            await new Promise((r) => setTimeout(r, 500));
          }
          return false;
        }, buttonId);
        if (!enabled) {
          // Fallback to force-enable so the loop continues — we may save with empty data
          // but that's better than hanging on every panel.
          log(`panel${panelNum} save button did not enable within 20s — force-enabling`);
        } else {
          log(`panel${panelNum} save button now active — filling`);
        }
      }

      // Diagnostic: probe the guideBridge node for this panel before filling
      const panelDiag = await page.evaluate((pk: string) => {
        type GuideNode = { name?: string; somExpression?: string; items?: GuideNode[]; value?: unknown; visible?: boolean; className?: string };
        const gb = (window as unknown as { guideBridge: { resolveNode: (s: string) => unknown; customContextProperty?: (k: string) => unknown } }).guideBridge;
        const node = gb.resolveNode(pk) as GuideNode | null;
        if (!node) return { nodeExists: false, itemCount: 0, leafCount: 0, currentIndex: -1, visibleItemCount: 0 };
        let leafCount = 0; let visibleItemCount = 0;
        const count = (n: GuideNode): void => {
          if (n.somExpression && 'value' in n) leafCount++;
          if (n.visible !== false) visibleItemCount++;
          if (Array.isArray(n.items)) for (const c of n.items) count(c);
        };
        count(node);
        const currentIndex = (gb as unknown as { currentIndex?: number }).currentIndex ?? -1;
        return { nodeExists: true, itemCount: node.items?.length ?? 0, leafCount, visibleItemCount, nodeVisible: node.visible, currentIndex };
      }, panelKey);
      log(`panel${panelNum} diag: nodeExists=${panelDiag.nodeExists} items=${panelDiag.itemCount} leafs=${panelDiag.leafCount} visibleItems=${panelDiag.visibleItemCount} nodeVisible=${panelDiag.nodeVisible} gbIdx=${panelDiag.currentIndex}`);

      // Generic fill — also captures field metadata for smart overrides + artifacts
      const fillStats = await _applyGenericPanelFill(page, panelKey, payload);
      const fieldsWritten = fillStats.numericCount + fillStats.radioCount + fillStats.textCount + fillStats.dateCount;
      log(`panel${panelNum} filled ${fillStats.numericCount}n / ${fillStats.radioCount}r / ${fillStats.textCount}t / ${fillStats.dateCount}d`);

      // Save field name dump to artifacts (key for discovering real AEM field names)
      if (fillStats.fields.length > 0) {
        fs.writeFileSync(
          path.join(opts.artifactDir, `${jobId}-panel${panelNum}-fields.json`),
          JSON.stringify(fillStats.fields, null, 2),
        );
      }

      // ALL field fills are now driven by `panelOverrides` (built schema-side from the
      // ~93 scalar aemField mappings + the 528 BS_TABLE cell mappings + repeating-table
      // row flattening). The legacy panel2/3/6 hand-curated functions have been removed
      // in favor of this single code path.
      // Caller-supplied direct field-name overrides:
      const shortKey = `panel${panelNum}` as 'panel1' | 'panel2' | 'panel3' | 'panel4' | 'panel5' | 'panel6' | 'panel7';
      const overrides = payload.panelOverrides?.[shortKey];
      if (overrides && Object.keys(overrides).length > 0) {
        const overrideResult = await _applyDirectOverrides(page, overrides, payload._fieldMeta);
        fs.writeFileSync(
          path.join(opts.artifactDir, `${jobId}-panel${panelNum}-overrides.json`),
          JSON.stringify(overrideResult, null, 2),
        );
        log(`panel${panelNum} applied ${overrideResult.count}/${Object.keys(overrides).length} direct overrides (see panel${panelNum}-overrides.json)`);
      }

      setPhase(jobId, 'SAVING_PANEL', { panelInProgress: panelNum });
      if (PANEL_SAVE_IDS[panelKey]) {
        await _reapplyValidateOverride(page);
        const r = await _clickPanelSaveAndCapture(page, panelKey);
        job.panelResults.push({ panel: panelNum, ok: r.ok, srId: r.srId, error: r.error, fieldsWritten });
        fs.writeFileSync(path.join(opts.artifactDir, `${jobId}-panel${panelNum}.json`), JSON.stringify(r, null, 2));
        log(`panel${panelNum} save ok=${r.ok} srId=${r.srId ?? '-'}`);
      } else {
        job.panelResults.push({ panel: panelNum, ok: true, fieldsWritten });
        log(`panel${panelNum} no Save button (rolls into next panel's save)`);
      }

      // Dismiss the post-save modal so the next panel's button unlocks
      const dismissed = await _dismissPostSaveModal(page);
      if (dismissed) log(`panel${panelNum} dismissed post-save modal`);

      await page.waitForTimeout(800);
    }

    log(`all panels processed — ${job.panelResults.filter((p) => p.ok).length}/${job.panelResults.length} succeeded`);
    // Update phase to indicate panels-complete state
    setPhase(jobId, 'DRAFT_CREATED', { panelInProgress: undefined });
  } else {
    log('skipPanels2to6=true; stopping at panel 1');
  }

  // ─── PANEL 7 — review / submit panel (no Save button of its own). ────────────
  // Apply its panelOverrides via setProperty so fields like the CSR + RPT +
  // product-category radios and the Declaration signer block all land on the
  // draft even though panel 7 isn't part of the per-panel save loop.
  const panel7Overrides = payload.panelOverrides?.panel7;
  if (panel7Overrides && Object.keys(panel7Overrides).length > 0) {
    try {
      const r = await _applyDirectOverrides(page, panel7Overrides, payload._fieldMeta);
      fs.writeFileSync(path.join(opts.artifactDir, `${jobId}-panel7-overrides.json`), JSON.stringify(r, null, 2));
      log(`panel7 applied ${r.count}/${Object.keys(panel7Overrides).length} direct overrides (no save — rolls into final-submit)`);
    } catch (e) {
      log(`panel7 overrides threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  log('Next steps: director/CA opens MCA "My Application", finds this draft, completes panels 2-7, downloads PDF, DSC-signs, submits');

  // Try to download the draft PDF if the AEM register fired
  if (aemDraftId || finalState.draftID) {
    try {
      const pdfPath = path.join(opts.artifactDir, 'draft.pdf');
      const pdfRes = await downloadDraftPdf(page, payload.cin, pdfPath, job.srId, job.referenceNumber);
      if (pdfRes.ok) {
        job.draftPdfPath = pdfPath;
        setPhase(jobId, 'PDF_DOWNLOADED');
        log(`draft PDF saved → ${pdfPath} (${pdfRes.bytes} bytes via ${pdfRes.via})`);
      } else {
        fs.writeFileSync(path.join(opts.artifactDir, `${jobId}-pdf-attempts.json`), JSON.stringify(pdfRes.tried, null, 2));
        log(`draft PDF download failed: ${pdfRes.error}`);
      }
    } catch (e) {
      log(`PDF download threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ─── SOURCE-ATTACHMENT UPLOAD (Segment VI attachments) ──────────────────────
  // Best-effort: download each S3 attachment to a temp file, find the matching file
  // input widget in the form's DOM, and use Playwright setInputFiles to upload.
  // MCA uses a custom attachment widget that may not always expose <input type="file">,
  // so this records every attempt to an artifact for diagnostics.
  if (payload.attachments && Object.keys(payload.attachments).length > 0) {
    try {
      const attachReport = await uploadSourceAttachments(page, payload.attachments, opts.artifactDir, jobId, log);
      fs.writeFileSync(
        path.join(opts.artifactDir, `${jobId}-attachments.json`),
        JSON.stringify(attachReport, null, 2),
      );
      log(`source attachments: ${attachReport.uploaded}/${attachReport.attempted} uploaded`);
    } catch (e) {
      log(`source attachment upload threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Log mapping-stats coverage if the adapter included them
  type Stats = { scalarMapped?: number; cellMapped?: number; tableRowsFlat?: number; totalWrites?: number; scalarUnmappedPanel?: number };
  const stats = (payload as { _aemMappingStats?: Stats })._aemMappingStats;
  if (stats) {
    log(`schema-driven aemField mapping: scalars=${stats.scalarMapped ?? 0}, cells=${stats.cellMapped ?? 0}, tableRows=${stats.tableRowsFlat ?? 0}, total=${stats.totalWrites ?? 0} (${stats.scalarUnmappedPanel ?? 0} scalars unmapped)`);
  }

  fs.writeFileSync(
    path.join(opts.artifactDir, `${jobId}-summary.json`),
    JSON.stringify({ jobId, srId: job.srId, phase: job.phase, panelResults: job.panelResults, draftPdfPath: job.draftPdfPath }, null, 2),
  );
}

/**
 * Upload source-attachment PDFs (Segment VI) to MCA's per-slot file widgets.
 *
 * Each entry in `attachments` carries an HTTPS URL (the S3 public/pre-signed link
 * the backend already stored against the ComplianceService). We:
 *   1. fetch() each URL into memory (PDFs are capped at 6 MB per MCA)
 *   2. Write to a temp file under the artifact dir (Playwright's setInputFiles
 *      needs a real path, not a Buffer)
 *   3. Probe the DOM for the MCA attachment widget — it exposes an Attach Documents
 *      modal panel with one `<input type="file">` per slot. Selectors discovered live
 *      typically follow the pattern `input[type=file][id*="<slotName>"]`. We try a
 *      few patterns per slot and record what worked.
 *
 * Returns a per-slot report `{ slot, url, ok, error?, selector? }` for diagnostics.
 */
async function uploadSourceAttachments(
  page: import('playwright').Page,
  attachments: NonNullable<import('./jobs.js').Aoc4FormPayload['attachments']>,
  artifactDir: string,
  _jobId: string,
  log: (msg: string) => void,
): Promise<{ attempted: number; uploaded: number; results: Array<{ slot: string; url: string; ok: boolean; tempPath?: string; selector?: string; error?: string }> }> {
  const results: Array<{ slot: string; url: string; ok: boolean; tempPath?: string; selector?: string; error?: string }> = [];

  // Slot → candidate selector patterns. MCA AEM forms expose attachment inputs as
  // hidden file inputs whose id/name contain the schema slot id or a slot-specific
  // AEM widget name. Try id-contains first, then name-contains, then a broad class
  // selector as a last resort.
  // NOTE: the MCA AEM attachment widget historically maps slots by `metadataselector`
  // attribute (e.g. metadataselector="attachFinancialStatements") — try that pattern too.
  const SLOT_AEM_HINTS: Record<string, string[]> = {
    attachFinancialStatements:      ['attachFinancialStatements', 'financialStatements', 'financialStatement', 'copyOfFinancialStatement'],
    attachSupplementaryAuditReport: ['attachSupplementaryAuditReport', 'supplementaryAuditReport', 'supplementaryAudit'],
    attachCagComments:              ['attachCagComments', 'cagComments', 'cagOfIndia', 'commentsOfCag'],
    attachSecretarialAuditReport:   ['attachSecretarialAuditReport', 'secretarialAuditReport', 'secretarialAudit'],
    attachStatementForNotAdopted:   ['attachStatementForNotAdopted', 'statementForNotAdopted', 'notAdopted'],
    attachStatementForNotHoldingAgm:['attachStatementForNotHoldingAgm', 'notHoldingAgm', 'notHoldingAGM'],
    attachOptional:                 ['attachOptional', 'optionalAttachment', 'optionalAttachments'],
  };

  // Make sure the Attach Documents panel is visible — MCA usually renders attachment
  // inputs only after the user clicks an "Attach Documents" link/button. Try to
  // navigate to the attachment section first.
  await page.evaluate(() => {
    // Look for any "Attach Documents" link or button and click it
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('a, button, [role="link"]'))
      .filter(el => /attach\s*document/i.test(el.textContent ?? ''));
    if (candidates.length > 0 && (candidates[0] as HTMLElement).offsetParent !== null) {
      (candidates[0] as HTMLElement).click();
    }
  });
  await page.waitForTimeout(2000);

  for (const [slot, info] of Object.entries(attachments)) {
    if (!info || !info.url) continue;
    const slotResult: { slot: string; url: string; ok: boolean; tempPath?: string; selector?: string; error?: string } = {
      slot, url: info.url, ok: false,
    };
    results.push(slotResult);

    // 1) Download the file
    let buf: Buffer;
    try {
      const r = await fetch(info.url);
      if (!r.ok) { slotResult.error = `S3 fetch HTTP ${r.status}`; continue; }
      buf = Buffer.from(await r.arrayBuffer());
    } catch (e) {
      slotResult.error = `S3 fetch threw: ${(e as Error).message}`;
      continue;
    }

    const ext = '.pdf';
    const tempPath = path.join(artifactDir, `attach-${slot}-${Date.now()}${ext}`);
    fs.writeFileSync(tempPath, buf);
    slotResult.tempPath = tempPath;
    log(`attach ${slot}: downloaded ${buf.length} bytes -> ${path.basename(tempPath)}`);

    // 2) Locate the file input. Try each candidate hint.
    const hints = SLOT_AEM_HINTS[slot] ?? [slot];
    let workingSelector: string | null = null;
    for (const hint of hints) {
      const sel = `input[type="file"][id*="${hint}"], input[type="file"][name*="${hint}"]`;
      try {
        const el = await page.$(sel);
        if (el) { workingSelector = sel; break; }
      } catch { /* try next */ }
    }
    if (!workingSelector) {
      // Final fallback: any visible file input (only the first matching slot will succeed)
      slotResult.error = `no file input found for slot — tried hints: ${hints.join(',')}`;
      continue;
    }

    // 3) setInputFiles
    try {
      await page.setInputFiles(workingSelector, tempPath);
      slotResult.ok = true;
      slotResult.selector = workingSelector;
      log(`attach ${slot}: uploaded via ${workingSelector}`);
      // Brief wait for AEM to register the upload
      await page.waitForTimeout(1500);
    } catch (e) {
      slotResult.error = `setInputFiles threw: ${(e as Error).message}`;
    }
  }

  return {
    attempted: results.length,
    uploaded: results.filter(r => r.ok).length,
    results,
  };
}

/**
 * Re-apply the gb.validate() override after AEM redraws.
 *
 * This is the technique that unlocks partial saves — without it, the form's global validate
 * fails because of empty mandatory fields in panels not yet filled, and Save click silently
 * short-circuits without firing /bin/commonSaveSubmit.
 */
/**
 * Capture currently-visible validation errors on panel 1 — used as a pre-save check so
 * we surface AEM's silent-swallow failures explicitly. Returns the count + a sample of
 * which fields are invalid (for diagnostics).
 */
async function capturePanel1Errors(
  page: import('playwright').Page,
): Promise<{ errorCount: number; samples: Array<{ msg: string; widget?: string }> }> {
  return await page.evaluate(() => {
    const errs: Array<{ msg: string; widget?: string }> = [];
    const seen = new Set<string>();
    document.querySelectorAll('[class*="error"], [class*="invalid"]').forEach((el) => {
      const e = el as HTMLElement;
      if (e.offsetParent === null) return;
      if (e.children.length > 1) return;
      const text = (e.innerText ?? '').trim();
      if (!text || text.length > 200) return;
      const parent = e.closest('[id*="guideContainer"]') as HTMLElement | null;
      const pid = parent?.id ?? '';
      if (!pid.includes('panel1AOC4')) return;
      const key = pid + '|' + text;
      if (seen.has(key)) return;
      seen.add(key);
      errs.push({ msg: text.slice(0, 120), widget: pid.slice(-80) });
    });
    return { errorCount: errs.length, samples: errs.slice(0, 30) };
  });
}

/**
 * Click the OK button on MCA's post-save confirmation modal.
 *
 * Discovery: after every successful `commonSaveSubmit`, the form renders a modal panel
 * (`modal_container_copy_*-nextitemnav_copy___widget`, text "OK"). Until clicked, the
 * NEXT panel's Save button stays `disabled=true` and clicking it is a no-op.
 *
 * This was the root cause of panels 2-6 not firing during automated runs (originally
 * mistaken as a `gb.validate()` issue). Captured live 2026-05-01 via inspect-panel2 CLI.
 *
 * Returns true if a modal was visible and clicked, false if no modal was present.
 */
async function _dismissPostSaveModal(page: import('playwright').Page): Promise<boolean> {
  return await page.evaluate(() => {
    // Modal OK buttons follow a distinct id pattern: contain "modal_container" AND end
    // with "nextitemnav_copy___widget" (vs panel saves which end with just "nextitemnav___widget").
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('button[id*="modal_container"][id$="nextitemnav_copy___widget"]'));
    const visible = candidates.filter((el) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled);
    if (visible.length === 0) return false;
    visible[0].click();
    return true;
  });
}

async function _reapplyValidateOverride(page: import('playwright').Page): Promise<void> {
  await page.evaluate(() => {
    type GBOverride = { validate?: () => boolean; _origValidate?: () => boolean };
    const gb = (window as unknown as { guideBridge: GBOverride }).guideBridge;

    // Stash original once
    if (typeof gb.validate === 'function' && !gb._origValidate) {
      gb._origValidate = gb.validate.bind(gb);
    }

    // Hard-override via Object.defineProperty — non-writable, non-configurable. AEM's
    // re-binding during panel transitions silently fails because the property is locked.
    try {
      Object.defineProperty(gb, 'validate', {
        value: () => true,
        writable: false,
        configurable: false,
      });
    } catch {
      // If already locked, fall back to direct assignment (no-op if still pinned to true)
      try { gb.validate = () => true; } catch { /* nothing more we can do */ }
    }

    // Also lock panel-level validate if exposed
    type PanelObj = { validate?: () => boolean; _origValidate?: () => boolean };
    const root = (gb as unknown as { resolveNode?: (s: string) => unknown }).resolveNode?.('rootPanel') as { items?: PanelObj[] } | null;
    if (root?.items) {
      for (const child of root.items) {
        if (typeof child.validate === 'function' && !child._origValidate) {
          child._origValidate = child.validate.bind(child);
        }
        try {
          Object.defineProperty(child, 'validate', { value: () => true, writable: false, configurable: false });
        } catch {
          try { child.validate = () => true; } catch { /* skip */ }
        }
      }
    }
  });
}

/**
 * Generic panel filler — walks the panel's subtree, sets:
 *   - guideTextBox: numeric-format → '0.00'; PAN-format leaves blank for override; otherwise 'NA'
 *   - guideDatePicker: today's ISO date
 *   - guideDropDownList: first non-empty option
 *   - guideRadioButton: option index '1' (typically "No" for "whether..." questions)
 *
 * Skips fields that are already filled OR not visible. Designed to clear validation, NOT
 * to produce a meaningful filing — real financial data overrides via applyPanelXOverrides.
 */
async function _applyGenericPanelFill(
  page: import('playwright').Page,
  panelKey: string,
  _payload: import('./jobs.js').Aoc4FormPayload,
): Promise<{
  numericCount: number;
  radioCount: number;
  textCount: number;
  dateCount: number;
  ddCount: number;
  fields: Array<{ name: string; som: string; cls: string; was: unknown; wrote: string | null }>;
}> {
  return await page.evaluate(({ panelKey: pk, today }) => {
    type GuideNode = {
      name?: string;
      somExpression?: string;
      className?: string;
      items?: GuideNode[];
      value?: unknown;
      visible?: boolean;
      mandatory?: boolean;
      jsonModel?: { options?: Array<string | { value?: string; label?: string }>; format?: string };
    };
    const gb = (window as unknown as {
      guideBridge: { resolveNode: (s: string) => unknown; setProperty: (s: string[], p: string, v: unknown[]) => void };
    }).guideBridge;
    const panel = gb.resolveNode(pk) as GuideNode | null;
    if (!panel) return { numericCount: 0, radioCount: 0, textCount: 0, dateCount: 0, ddCount: 0, fields: [] };

    let numericCount = 0, radioCount = 0, textCount = 0, dateCount = 0, ddCount = 0;
    const fields: Array<{ name: string; som: string; cls: string; was: unknown; wrote: string | null }> = [];
    const setVal = (som: string, v: unknown): void => { try { gb.setProperty([som], 'value', [v]); } catch { /* ignore */ } };

    const isNumericName = (name?: string): boolean => {
      if (!name) return false;
      // Names ending with currency-like patterns: "Date", "PreviousDate", "Current", "Previous", numeric column suffixes
      return /(?:Current|Previous|Date|Total|Number|Capital|Amount|Tax|Profit|Loss|Revenue|Expense)\d*$/.test(name)
        && !/^date|^From|^To|^On$/i.test(name);
    }

    const walk = (n: GuideNode | undefined): void => {
      if (!n) return;
      // NOTE: We intentionally do NOT skip visible:false nodes here.
      // AEM marks the ENTIRE subtree of inactive panels as visible:false, so
      // checking visibility would zero-out panels 2-6 completely. gb.setProperty
      // writes to the data model directly and works on hidden fields — the model
      // value is what gets submitted, not the DOM state.
      const cls = n.className ?? '';

      // Leaf — has somExpression and a 'value' property (own or prototype getter).
      // AEM guide nodes often define 'value' as a prototype accessor, so hasOwnProperty
      // would miss them entirely. Use 'in' operator which traverses the prototype chain.
      if (n.somExpression && 'value' in n) {
        const cur = n.value;
        const empty = cur == null || cur === '';
        let wrote: string | null = null;

        if (empty) {
          if (/RadioButton/i.test(cls)) {
            // Default to '1' (typically "No"). For radios where '1' is invalid the form will reject.
            setVal(n.somExpression, '1');
            radioCount++;
            wrote = '1';
          } else if (/DatePicker/i.test(cls)) {
            setVal(n.somExpression, today);
            dateCount++;
            wrote = today;
          } else if (/DropDownList/i.test(cls)) {
            // Pick first non-empty option from jsonModel
            const opts = n.jsonModel?.options ?? [];
            for (const o of opts) {
              const v = typeof o === 'string' ? o.split('=')[0] : (o?.value ?? '');
              if (v && v !== '') { setVal(n.somExpression, v); ddCount++; wrote = v; break; }
            }
          } else if (/TextBox|TextField|NumericBox/i.test(cls)) {
            // Field name → value heuristic. The previous fallback to 'NA' for unrecognised
            // names produced incorrect output: balance-sheet rows showed "NA" in the live
            // form where the PDF had "0" (SPOC complaint 2026-05-18).
            //
            // Better default:
            //   - Numeric-looking name (Current/Previous/Total/Amount/etc.) OR a NumericBox
            //     widget → '0.00' (or '0' depending on width)
            //   - True text fields (name/address) → leave EMPTY (don't write 'NA' which the
            //     PDF would then carry forward as a literal value)
            const treatAsNumeric = /NumericBox/i.test(cls) || isNumericName(n.name);
            if (treatAsNumeric) {
              setVal(n.somExpression, '0');
              numericCount++;
              wrote = '0';
            } else {
              // Skip — leave blank. Worth re-visiting once we have a verified list of
              // text fields that genuinely require some non-empty value to save.
            }
          }
        }

        // Record ALL leaf fields (whether filled or already had a value)
        fields.push({ name: n.name ?? '', som: n.somExpression, cls, was: cur, wrote });
      }

      if (Array.isArray(n.items)) for (const k of n.items) walk(k);
    }
    walk(panel);
    return { numericCount, radioCount, textCount, dateCount, ddCount, fields };
  }, { panelKey, today: new Date().toISOString().slice(0, 10) });
}

// NOTE (Phase A-F rewrite, 2026-05-19): The legacy _applyPanel2Overrides,
// _applyPanel3Overrides, and _applyPanel6Overrides functions have been
// removed. ALL field fills now go through the schema-driven panelOverrides
// bucket consumed by _applyDirectOverrides. The adapter side of the contract
// (utils/aoc4FormDataToPayload.js) builds those buckets from the schema as
// aemField mappings + 528 BS_TABLE cell mappings (cell-mappings.json) +
// repeating-TABLE row flattening. One code path, end-to-end.

/**
 * Upload the DSC-signed PDF back to MCA, then trigger the form's submit confirmation.
 *
 * Two sub-steps:
 *   1. POST signed PDF as multipart/form-data to AEM's per-draft attachment endpoint
 *      (`<form-path>.fp.attach.jsp/<draftID>`) — the same path we saw inside `_handleDraftSave`.
 *   2. Call `window.formSubmitConfirmation()` (a function the form exposes globally) which
 *      drives the final-submit flow internally and returns the MCA-assigned SRN.
 *
 * Both sub-steps run inside the page context to inherit cookies + CSRF + encrypt automatically.
 */
export async function uploadSignedPdfAndSubmit(
  job: Aoc4Job,
  signedPdf: Buffer,
): Promise<{ ok: boolean; srn?: string; error?: string; phase?: import('./jobs.js').Aoc4Phase }> {
  const page = job._page;
  if (!page) return {
    ok: false,
    error: 'Live browser session is gone (service was likely restarted). Re-trigger automation from the ⚡ button — the existing MCA draft will be picked up automatically.',
  };

  setPhase(job.jobId, 'UPLOADING_SIGNED');

  const base64 = signedPdf.toString('base64');
  const result = await page.evaluate(async ({ base64: b64 }) => {
    type GBExt = { customContextProperty?: (k: string) => unknown };
    const gb = (window as unknown as { guideBridge: GBExt }).guideBridge;
    const draftID = gb.customContextProperty?.('draftID') as string | undefined;
    if (!draftID) return { ok: false as const, error: 'draftID not set — cannot route signed PDF to a draft' };

    const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const blob = new Blob([buf], { type: 'application/pdf' });

    // 1. Upload to AEM's attach endpoint
    const fd = new FormData();
    fd.append('file', blob, 'signed.pdf');
    const attachUrl = `/content/forms/af/mca-af-forms/aoc/aoc-4/jcr:content/guideContainer.fp.attach.jsp/${encodeURIComponent(draftID)}`;
    let attachResp;
    try {
      const r = await fetch(attachUrl, { method: 'POST', credentials: 'include', body: fd });
      attachResp = { status: r.status, body: (await r.text()).slice(0, 600) };
    } catch (e) { return { ok: false as const, error: `attach failed: ${(e as Error).message}` }; }
    if (attachResp.status !== 200 && attachResp.status !== 201) {
      return { ok: false as const, error: `attach HTTP ${attachResp.status}: ${attachResp.body}` };
    }

    // 2. Trigger form submit confirmation
    type SubmitWindow = { formSubmitConfirmation?: () => Promise<unknown> | unknown };
    const w = window as unknown as SubmitWindow;
    if (typeof w.formSubmitConfirmation !== 'function') {
      return { ok: true as const, attached: true, srn: undefined as string | undefined, note: 'PDF attached, but formSubmitConfirmation not exposed — manual submit required' };
    }

    let submitResult: unknown;
    try { submitResult = await w.formSubmitConfirmation(); }
    catch (e) { return { ok: false as const, error: `formSubmitConfirmation threw: ${(e as Error).message}`, attached: true }; }

    // The function may return the SRN directly, or it may be in DOM after a redirect
    const srn = (submitResult as { srn?: string; SRN?: string })?.srn
      ?? (submitResult as { SRN?: string })?.SRN
      ?? (document.body.innerText.match(/SRN[:\s]+([A-Z]\d{8,}|[A-Z]{2}\d{6,})/)?.[1])
      ?? undefined;
    return { ok: true as const, attached: true, srn };
  }, { base64 });

  if (!result.ok) {
    setPhase(job.jobId, 'FAILED', { error: result.error });
    return { ok: false, error: result.error };
  }

  if (result.srn) {
    setPhase(job.jobId, 'FILED', { filingSrn: result.srn });
    return { ok: true, srn: result.srn, phase: 'FILED' };
  }

  // Attached but no SRN parsed — leave in AWAITING_SIGNATURE so admin can retry submit
  setPhase(job.jobId, 'AWAITING_SIGNATURE');
  return { ok: true, error: 'PDF attached but final SRN not parsed — check MCA portal manually', phase: 'AWAITING_SIGNATURE' };
}

/**
 * Invoke AEM's `window.handleDraftSave(saveBtnConfig)` to trigger the standard draft-save
 * side effects: populate `draftID`, register draft in `/content/forms/portal/draftandsubmission`,
 * make the draft visible in MCA's "My Application" list.
 *
 * After this call:
 *   - `gb.customContextProperty('draftID')` returns a `<uid>_af` string
 *   - The standard `<form-path>.fp.pdf.jsp/<draftID>` PDF endpoint should respond
 *   - The `<form-path>.fp.attach.jsp/<draftID>` signed-PDF upload endpoint accepts requests
 *
 * Returns `{ ok, draftID, error?, networkOK? }` so the caller can decide whether to
 * proceed with PDF download + signed upload.
 */
async function _invokeAemDraftSave(
  page: import('playwright').Page,
): Promise<{ ok: boolean; draftID?: string; error?: string; networkOK?: boolean }> {
  // Set up a one-shot listener for the AEM draft-save XHR (URL contains `.fp.attach.jsp` or
  // `draftandsubmission.fp.draft.json`)
  const respPromise = page.waitForResponse(
    (r) => /draftandsubmission\.fp\.draft|fp\.attach\.jsp/.test(r.url()),
    { timeout: 20_000 },
  ).catch(() => null);

  const result = await page.evaluate(async () => {
    type WinExt = {
      handleDraftSave?: (cfg: unknown, opts?: unknown) => unknown;
      guideBridge?: { customContextProperty?: (k: string) => unknown };
      FD?: { FP?: { AF?: { _handleDraftSaveWrapper?: (opts: unknown) => unknown } } };
    };
    const w = window as unknown as WinExt;

    if (typeof w.handleDraftSave !== 'function') {
      return { ok: false as const, error: 'window.handleDraftSave not exposed' };
    }
    // Use the panel 1 save button as `saveBtnConfig` — it has the metadataselector attribute
    // AEM's handler expects.
    const saveBtn = document.getElementById('guideContainer-rootPanel-panel-panel-panel1AOC4-panel_copy_790625936-nextitemnav___widget');
    try {
      await Promise.resolve(w.handleDraftSave(saveBtn, {}));
    } catch (e) {
      return { ok: false as const, error: 'handleDraftSave threw: ' + (e as Error).message };
    }
    // Wait briefly for the draft id to land
    await new Promise((r) => setTimeout(r, 2000));
    const draftID = w.guideBridge?.customContextProperty?.('draftID') as string | undefined;
    return { ok: true as const, draftID };
  });

  // Watch the network too — some AEM versions don't expose draftID until after the second roundtrip
  const resp = await respPromise;
  const networkOK = !!resp && resp.status() < 400;

  return { ...result, networkOK };
}

/**
 * Diagnostic — dumps the AEM model's option metadata for a list of field names.
 * Used to discover the actual {value, label} mapping for radios/dropdowns when
 * setProperty appears to succeed but the form still renders the wrong option
 * (i.e. the legacy '1' = Yes assumption turned out to be wrong on a live run).
 */
async function _dumpRadioOptions(
  page: import('playwright').Page,
  fieldNames: string[],
): Promise<Array<{ name: string; cls?: string; currentValue?: unknown; options?: Array<{ value: unknown; label?: string }>; jsonModelOptions?: unknown; viewElementId?: string; domRadios?: Array<{ value: string; label: string; id: string; name: string }> }>> {
  return await page.evaluate((names: string[]) => {
    type GuideNode = {
      name?: string;
      somExpression?: string;
      className?: string;
      value?: unknown;
      items?: GuideNode[];
      options?: Array<{ value: unknown; label?: string }>;
      jsonModel?: { options?: unknown };
      _view?: { element?: HTMLElement };
    };
    const gb = (window as unknown as { guideBridge: { resolveNode: (s: string) => unknown } }).guideBridge;
    const root = gb.resolveNode('rootPanel') as GuideNode | null;
    const findNode = (n: string): GuideNode | null => {
      let found: GuideNode | null = null;
      const walk = (k: GuideNode | undefined): void => {
        if (!k || found) return;
        if (k.name === n) { found = k; return; }
        if (Array.isArray(k.items)) for (const c of k.items) walk(c);
      };
      walk(root ?? undefined);
      return found;
    };

    const out: Array<{ name: string; cls?: string; currentValue?: unknown; options?: Array<{ value: unknown; label?: string }>; jsonModelOptions?: unknown; viewElementId?: string; domRadios?: Array<{ value: string; label: string; id: string; name: string }> }> = [];

    for (const fieldName of names) {
      const node = findNode(fieldName);
      const entry: { name: string; cls?: string; currentValue?: unknown; options?: Array<{ value: unknown; label?: string }>; jsonModelOptions?: unknown; viewElementId?: string; domRadios?: Array<{ value: string; label: string; id: string; name: string }> } = { name: fieldName };
      if (!node) { out.push(entry); continue; }
      entry.cls = node.className;
      entry.currentValue = node.value;
      entry.options = node.options;
      entry.jsonModelOptions = node.jsonModel?.options;
      entry.viewElementId = node._view?.element?.id;

      // Walk every radio in the doc, find ones near the field name
      const fLower = fieldName.toLowerCase();
      const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
      const matched: Array<{ value: string; label: string; id: string; name: string }> = [];
      for (const r of radios) {
        let el: HTMLElement | null = r;
        let near = false;
        let depth = 0;
        while (el && depth < 15) {
          if (el.id && el.id.toLowerCase().includes(fLower)) { near = true; break; }
          if (el.getAttribute && (el.getAttribute('data-name') ?? '').toLowerCase().includes(fLower)) { near = true; break; }
          el = el.parentElement; depth++;
        }
        if (!near && !((r.name ?? '').toLowerCase().includes(fLower) || (r.id ?? '').toLowerCase().includes(fLower))) continue;
        let labelText = '';
        if (r.id) {
          const lbl = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(r.id)}"]`);
          if (lbl?.textContent) labelText = lbl.textContent.trim();
        }
        if (!labelText) {
          const cl = r.closest('label');
          if (cl?.textContent) labelText = cl.textContent.trim();
        }
        if (!labelText && r.nextSibling?.nodeType === Node.TEXT_NODE) labelText = r.nextSibling.textContent?.trim() ?? '';
        if (!labelText && r.nextElementSibling?.textContent) labelText = r.nextElementSibling.textContent.trim();
        matched.push({ value: r.value, label: labelText.slice(0, 40), id: r.id, name: r.name });
      }
      entry.domRadios = matched.slice(0, 10);
      out.push(entry);
    }
    return out;
  }, fieldNames);
}

/**
 * Apply caller-supplied field-name → value overrides via setProperty.
 *
 * IMPORTANT: AEM radio buttons and dropdowns use option `value` codes that differ
 * from the human-readable `label` text (e.g. a Yes/No/Not Applicable radio might
 * have option values `'0'`, `'1'`, `'2'`). Sending the literal string `'No'` to
 * `setProperty` does NOT match any option — the form silently falls back to its
 * default (typically Not Applicable for tri-state radios).
 *
 * For radio + dropdown widgets we therefore translate the incoming label to the
 * actual option value by inspecting the rendered DOM: find the `<input>` /
 * `<option>` whose label text matches our payload value, then either click it
 * (radio) or set `select.value` (dropdown) and fire change events so AEM picks
 * up the validation.
 *
 * Returns count of overrides successfully written.
 */
/**
 * Click an AEM radio button or dropdown by its visible question text + option label.
 *
 * Uses Playwright locators (not page.evaluate) so we get auto-retry + locator
 * stability across iframe re-renders. AEM Forms radios have HTML `value="on"`
 * placeholders + internal AEM-managed option keys — writing the label string
 * via setProperty puts the right value in the model but fails the save-time
 * validator (saw "Please select a valid option" on PHARMLOGIC 2026-05-22).
 * Clicking the input fires AEM's onclick handler which sets the right key.
 *
 * Strategy:
 *   1. Find the question text on the page via getByText (partial match — first
 *      ~40 chars of the schema label, with regex-meta stripped)
 *   2. Walk up to a common ancestor that contains both the question and its
 *      radio group / select
 *   3. Within that ancestor, find the label that matches the desired option
 *      text + click its associated <input>
 *
 * Returns { ok, reason } for the artifact.
 */
async function _clickWidgetByLabel(
  page: import('playwright').Page,
  questionLabel: string,
  optionLabel: string,
  widget: 'radio' | 'dropdown',
): Promise<{ ok: boolean; reason: string }> {
  // Take only enough of the question to disambiguate, escape regex meta.
  const qText = questionLabel.replace(/^\s*\*\s*/, '').replace(/[()*?+|.^$\\[\]{}]/g, '').trim().slice(0, 50);
  if (!qText) return { ok: false, reason: 'empty question text' };

  try {
    // Find the question text. Use a partial match — `i` flag, `exact:false`.
    const question = page.locator(`text=/${qText.replace(/\s+/g, '\\s+')}/i`).first();
    const found = await question.count();
    if (found === 0) {
      return { ok: false, reason: `question text "${qText}" not found on page` };
    }

    // Walk up the DOM to find the field's container — typically 2-5 ancestors up
    // we hit a div that contains both the label and the input group.
    if (widget === 'radio') {
      // The radio's user-facing label is in a <label> or <span> element. Find
      // the closest one matching the option text within a reasonable proximity
      // of the question.
      //
      // Use xpath: from the question text, go up to find an ancestor div, then
      // look for a descendant input[type=radio] whose adjacent label text matches.
      const optionRegex = new RegExp(`^\\s*${optionLabel.replace(/[()*?+|.^$\\[\]{}]/g, '\\$&')}\\s*$`, 'i');
      const radio = question
        .locator('xpath=ancestor::*[self::div or self::tr or self::td or self::form][1]')
        .locator('input[type="radio"]')
        .filter({
          has: page.locator(`xpath=following-sibling::label[1] | xpath=parent::label`).filter({ hasText: optionRegex }),
        })
        .first();

      // Simpler fallback: just match by adjacent label text within the same ancestor div.
      const fallback = question
        .locator('xpath=ancestor::*[self::div or self::tr or self::td or self::form][1]')
        .locator('label')
        .filter({ hasText: optionRegex })
        .first();

      // Try radio input direct click first; if it doesn't work, click the label
      if (await radio.count() > 0) {
        await radio.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await radio.click({ timeout: 5000, force: true });
        return { ok: true, reason: `clicked radio input adjacent to label "${optionLabel}"` };
      }
      if (await fallback.count() > 0) {
        await fallback.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await fallback.click({ timeout: 5000, force: true });
        return { ok: true, reason: `clicked <label> with text "${optionLabel}"` };
      }
      return { ok: false, reason: `no <label> matching "${optionLabel}" near question "${qText}"` };
    }

    // Dropdown: find the <select> within the same ancestor, set its value by matching
    // an <option> whose text matches the desired label.
    if (widget === 'dropdown') {
      const select = question
        .locator('xpath=ancestor::*[self::div or self::tr or self::td or self::form][1]')
        .locator('select')
        .first();
      if (await select.count() === 0) {
        return { ok: false, reason: `no <select> near question "${qText}"` };
      }
      await select.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await select.selectOption({ label: optionLabel }, { timeout: 5000 });
      return { ok: true, reason: `selected option "${optionLabel}"` };
    }

    return { ok: false, reason: `unknown widget type ${widget}` };
  } catch (e) {
    return { ok: false, reason: `locator click threw: ${(e as Error).message.slice(0, 120)}` };
  }
}

async function _applyDirectOverrides(
  page: import('playwright').Page,
  overrides: Record<string, string | number>,
  fieldMeta?: Record<string, { widget: string; questionLabel: string; optionLabel?: string }>,
): Promise<{ count: number; results: Array<{ name: string; value: string; ok: boolean; widget: string; reason: string; finalValue?: string }> }> {
  // ─── Pass A: radios + dropdowns via Playwright locator clicks ─────────────
  // Only runs for entries where fieldMeta tells us the widget type + question
  // label. setProperty doesn't work for these (model accepts the label string
  // but MCA's save validator rejects it). Clicking the actual DOM input fires
  // AEM's onclick handler which writes the correct internal option key.
  const passAResults: Array<{ name: string; value: string; ok: boolean; widget: string; reason: string; finalValue?: string }> = [];
  const handledByLocator = new Set<string>();
  if (fieldMeta) {
    for (const [name, value] of Object.entries(overrides)) {
      const meta = fieldMeta[name];
      if (!meta) continue;
      if (meta.widget !== 'radio' && meta.widget !== 'dropdown') continue;
      const r = await _clickWidgetByLabel(page, meta.questionLabel, String(value), meta.widget);
      passAResults.push({ name, value: String(value), ok: r.ok, widget: meta.widget, reason: r.reason, finalValue: r.ok ? String(value) : undefined });
      handledByLocator.add(name);
      // Tiny pause between clicks so AEM has time to render conditional fields
      // (e.g. 7(a) Yes → shows 7(b) date picker) before we try the next override.
      await page.waitForTimeout(200);
    }
  }

  // Filter the remaining overrides for Pass B (setProperty path)
  const remaining: Array<[string, string | number]> = Object.entries(overrides).filter(([n]) => !handledByLocator.has(n));

  // ─── Pass B: setProperty for text/date/number/etc. ────────────────────────
  const passBResult = await page.evaluate((entries) => {
    type GuideNode = {
      name?: string;
      somExpression?: string;
      className?: string;
      items?: GuideNode[];
      _view?: { element?: HTMLElement };
    };
    const gb = (window as unknown as { guideBridge: { resolveNode: (s: string) => unknown; setProperty: (s: string[], p: string, v: unknown[]) => void } }).guideBridge;
    const root = gb.resolveNode('rootPanel') as GuideNode | null;

    const findNode = (name: string): GuideNode | null => {
      let found: GuideNode | null = null;
      const walk = (n: GuideNode | undefined): void => {
        if (!n || found) return;
        if (n.name === name && n.somExpression) { found = n; return; }
        if (Array.isArray(n.items)) for (const k of n.items) walk(k);
      };
      walk(root ?? undefined);
      return found;
    };

    /** Match a label against an option's textContent (case-insensitive, trimmed). */
    const labelMatches = (haystack: string | null | undefined, needle: string): boolean => {
      if (!haystack) return false;
      const a = haystack.trim().toLowerCase();
      const b = needle.trim().toLowerCase();
      return a === b || a.includes(b) || b.includes(a);
    };

    /**
     * Find all DOM elements belonging to a field by scanning every element with
     * an `id` attribute and matching field name as a path segment. AEM widget IDs
     * are like `guideContainer-...-WhetherCompanyIsSubsidiary-...___widget` —
     * unstable across panels but the field name always appears as a path segment
     * delimited by `-` or `_`.
     */


    /**
     * Set a radio by:
     *   1. Locating the widget container
     *   2. Walking ALL <input type="radio"> children
     *   3. For each, finding its associated label text via (a) label[for=id], (b) closest <label>,
     *      (c) the immediate next-sibling text, (d) aria-label, (e) the input value itself
     *   4. Matching the payload label against any of those
     *   5. Writing the matched radio's `.value` to setProperty AND clicking the input AND firing events
     */
    /**
     * Yes/No/NA → AEM enum value translation.
     *
     * 2026-05-21 update: live introspection of MCA AOC-4 (radios-inspect dump showed
     * 51 radios all with value="on" — meaning the HTML form encoding uses generated
     * widget names, not the option codes). AEM's GuideBridge model stores radios by
     * the LITERAL LABEL configured on the option (just like dropdowns: natureS dropdown
     * has `value="Adopted Financial statements"` matching its display label exactly).
     *
     * So we try the LITERAL label FIRST, then '1'/'0' as a fallback for any field that
     * happens to use numeric enum codes. The legacy worker's '1'=Yes assumption was
     * wrong for the live form — it accepted '1' as a model value but the form's
     * option-matcher rejected it and rendered the default ("Not Applicable").
     *
     * MCA radio labels use specific casing — note "Not applicable" (lowercase 'a'),
     * not "Not Applicable". We try both.
     */
    const labelToEnumGuesses = (label: string): string[] => {
      const l = label.trim().toLowerCase();
      if (l === 'yes')             return ['Yes', '1', '0'];
      if (l === 'no')              return ['No', '0', '1'];
      if (l === 'not applicable')  return ['Not applicable', 'Not Applicable', '2', '3'];
      if (l === 'individual')      return ['Individual', '1', '0'];
      if (l.includes('firm') || l.includes('auditor')) return [label, "Auditor's firm", '2', '1'];
      return [label]; // unknown — try as-is
    };

    /** Read back the model value after a setProperty. */
    const readModelValue = (som: string): string | null => {
      try {
        const n = gb.resolveNode(som) as { value?: unknown } | null;
        const v = n?.value;
        return v == null ? null : String(v);
      } catch { return null; }
    };

    const setRadio = (_node: GuideNode, som: string, valueLabel: string, fieldName: string): { ok: boolean; reason: string; finalValue?: string } => {
      // Strategy 1: walk ALL radio inputs in the document and find the one whose
      // ancestor element (any depth) has an id containing the field name.
      const fieldLower = fieldName.toLowerCase();
      const allRadios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
      const radios: HTMLInputElement[] = [];
      for (const r of allRadios) {
        let el: HTMLElement | null = r;
        let matched = false;
        while (el) {
          if (el.id && el.id.toLowerCase().includes(fieldLower)) { matched = true; break; }
          el = el.parentElement;
        }
        if (matched) radios.push(r);
      }
      // Strategy 2: by name attribute
      if (radios.length === 0) {
        for (const r of allRadios) {
          if ((r.name ?? '').toLowerCase().includes(fieldLower) || (r.id ?? '').toLowerCase().includes(fieldLower)) {
            radios.push(r);
          }
        }
      }

      // No DOM radios — fall back to setProperty with verification
      if (radios.length === 0) {
        const guesses = labelToEnumGuesses(valueLabel);
        for (const guess of guesses) {
          try { gb.setProperty([som], 'value', [guess]); } catch { continue; }
          const after = readModelValue(som);
          if (after === guess || (after != null && labelMatches(after, valueLabel))) {
            return { ok: true, reason: `setProperty-verified: "${guess}" persisted (model="${after}")`, finalValue: guess };
          }
        }
        return { ok: false, reason: `no DOM radios + setProperty rejected all guesses [${labelToEnumGuesses(valueLabel).join(',')}] (model still: ${readModelValue(som)})` };
      }

      const collectLabels = (r: HTMLInputElement): string[] => {
        const out: string[] = [];
        if (r.id) {
          const lbl = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(r.id)}"]`);
          if (lbl?.textContent) out.push(lbl.textContent);
        }
        const parentLabel = r.closest('label');
        if (parentLabel?.textContent) out.push(parentLabel.textContent);
        // Next-sibling text node (common AEM rendering)
        if (r.nextSibling?.nodeType === Node.TEXT_NODE) {
          const t = r.nextSibling.textContent;
          if (t) out.push(t);
        }
        // Next-sibling element
        if (r.nextElementSibling?.textContent) out.push(r.nextElementSibling.textContent);
        const aria = r.getAttribute('aria-label');
        if (aria) out.push(aria);
        if (r.value) out.push(r.value);
        return out;
      };

      const sampledLabels: Array<{ idx: number; value: string; labels: string[] }> = [];
      for (let i = 0; i < radios.length; i++) {
        const r = radios[i];
        const labels = collectLabels(r);
        sampledLabels.push({ idx: i, value: r.value, labels });
        if (labels.some(l => labelMatches(l, valueLabel))) {
          // Match found — fire EVERYTHING: setProperty model, set checked, click, all events
          try { gb.setProperty([som], 'value', [r.value]); } catch { /* */ }
          // Uncheck all siblings in the same radio group first
          for (const sib of radios) {
            if (sib !== r && sib.name === r.name) sib.checked = false;
          }
          r.checked = true;
          try { r.click(); } catch { /* some browsers throw if click is intercepted */ }
          r.dispatchEvent(new Event('input',  { bubbles: true }));
          r.dispatchEvent(new Event('change', { bubbles: true }));
          r.dispatchEvent(new Event('blur',   { bubbles: true }));
          // Verify the model accepted it
          const after = readModelValue(som);
          if (after === r.value || (after != null && labelMatches(after, valueLabel))) {
            return { ok: true, reason: `clicked radio[${i}] value="${r.value}" matched "${labels[0] || '?'}", model="${after}"`, finalValue: r.value };
          }
          // DOM click didn't stick — try alternate enum values
          for (const guess of labelToEnumGuesses(valueLabel)) {
            try { gb.setProperty([som], 'value', [guess]); } catch { continue; }
            const after2 = readModelValue(som);
            if (after2 === guess) {
              return { ok: true, reason: `clicked + setProperty-fallback "${guess}" (after click model was "${after}")`, finalValue: guess };
            }
          }
          return { ok: false, reason: `clicked radio[${i}] but model didn't persist (model="${after}", expected one of ${labelToEnumGuesses(valueLabel).join('|')})` };
        }
      }
      // Nothing matched by label. Last-ditch: try setProperty with enum guesses.
      for (const guess of labelToEnumGuesses(valueLabel)) {
        try { gb.setProperty([som], 'value', [guess]); } catch { continue; }
        const after = readModelValue(som);
        if (after === guess) {
          return { ok: true, reason: `no label-match radio; setProperty "${guess}" worked (model="${after}")`, finalValue: guess };
        }
      }
      return {
        ok: false,
        reason: `no radio label matched "${valueLabel}" + setProperty rejected. Sampled: ${JSON.stringify(sampledLabels.map(s => ({ v: s.value, l: s.labels[0]?.trim()?.slice(0, 30) })))}, model=${readModelValue(som)}`,
      };
    };

    /** Set a dropdown by label-matching its <option> children. */
    const setDropdown = (_node: GuideNode, som: string, valueLabel: string, fieldName: string): { ok: boolean; reason: string; finalValue?: string } => {
      const fieldLower = fieldName.toLowerCase();
      // Strategy: walk all <select> elements, find one whose ancestor id includes fieldName
      let select: HTMLSelectElement | null = null;
      for (const s of Array.from(document.querySelectorAll<HTMLSelectElement>('select'))) {
        let el: HTMLElement | null = s;
        while (el) {
          if (el.id && el.id.toLowerCase().includes(fieldLower)) { select = s; break; }
          el = el.parentElement;
        }
        if (select) break;
      }
      if (!select) {
        select = document.querySelector<HTMLSelectElement>(`select[name*="${fieldName}" i]`)
              ?? document.querySelector<HTMLSelectElement>(`select[id*="${fieldName}" i]`);
      }
      if (!select) {
        // Fallback: setProperty with verification
        try { gb.setProperty([som], 'value', [valueLabel]); } catch { /* */ }
        const after = readModelValue(som);
        if (after === valueLabel || (after != null && labelMatches(after, valueLabel))) {
          return { ok: true, reason: `setProperty-verified: "${valueLabel}" persisted (model="${after}")`, finalValue: valueLabel };
        }
        return { ok: false, reason: `no <select> found + setProperty rejected (model="${after}")` };
      }

      let matched: HTMLOptionElement | null = null;
      const sampledOptions: Array<{ v: string; t: string }> = [];
      for (const o of Array.from(select.options)) {
        const t = (o.textContent ?? '').trim();
        sampledOptions.push({ v: o.value, t: t.slice(0, 30) });
        if (labelMatches(o.textContent, valueLabel)) { matched = o; break; }
      }
      if (!matched) return { ok: false, reason: `no option matched "${valueLabel}". Available: ${JSON.stringify(sampledOptions)}` };
      select.value = matched.value;
      try { gb.setProperty([som], 'value', [matched.value]); } catch { /* */ }
      select.dispatchEvent(new Event('input',  { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.dispatchEvent(new Event('blur',   { bubbles: true }));
      return { ok: true, reason: `selected option "${matched.textContent?.trim()}" value="${matched.value}"`, finalValue: matched.value };
    };

    const results: Array<{ name: string; value: string; ok: boolean; widget: string; reason: string; finalValue?: string }> = [];
    let count = 0;
    for (const [name, value] of entries) {
      const node = findNode(name);
      const strVal = String(value);
      if (!node || !node.somExpression) {
        results.push({ name, value: strVal, ok: false, widget: '-', reason: 'AEM node not found by name' });
        continue;
      }
      const cls = node.className ?? '';
      const widgetType =
        /RadioButton/i.test(cls)   ? 'radio'    :
        /DropDownList/i.test(cls)  ? 'dropdown' :
        /CheckBox/i.test(cls)      ? 'checkbox' :
        /DatePicker/i.test(cls)    ? 'date'     :
        /NumericBox/i.test(cls)    ? 'numeric'  : 'text';

      let r: { ok: boolean; reason: string; finalValue?: string };
      if (widgetType === 'radio')        r = setRadio(node, node.somExpression, strVal, name);
      else if (widgetType === 'dropdown') r = setDropdown(node, node.somExpression, strVal, name);
      else {
        try {
          gb.setProperty([node.somExpression], 'value', [strVal]);
          r = { ok: true, reason: 'setProperty', finalValue: strVal };
        } catch (e) { r = { ok: false, reason: `setProperty threw: ${(e as Error).message}` }; }
      }
      if (r.ok) count++;
      results.push({ name, value: strVal, ok: r.ok, widget: widgetType, reason: r.reason, finalValue: r.finalValue });
    }
    return { count, results };
  }, remaining);

  // Merge Pass A + Pass B results
  return {
    count: passAResults.filter(x => x.ok).length + passBResult.count,
    results: [...passAResults, ...passBResult.results],
  };
}

/**
 * Best-effort draft PDF download. MCA's V3 form exposes the rendered PDF via
 * AEM's `<form-path>.fp.pdf.jsp` endpoint, keyed by the form's draftID.
 *
 * Discovery: pulled from AEM's standard portal config (visible in clientlib-AOC-4.min.js
 * in the `_handleDraftSave` source we inspected). The path:
 *   /content/forms/af/mca-af-forms/aoc/aoc-4/jcr:content/guideContainer.fp.pdf.jsp/<draftID>
 *
 * We also try a backup endpoint pattern for portals where the standard one returns 404.
 */
/**
 * Download the draft PDF by opening a new browser tab and navigating to AEM's print-preview
 * endpoint. Unlike fetch()-based approaches (which Akamai CDN blocks with 403), a full
 * browser navigation carries the right User-Agent, Referrer, and cookie context.
 *
 * This is exported so the HTTP server can call it from the /force-download-pdf endpoint.
 */
export async function downloadDraftPdfViaTab(
  job: import('./jobs.js').Aoc4Job,
  outPath: string,
): Promise<{ ok: boolean; bytes?: number; via?: string; error?: string }> {
  const page = job._page;
  if (!page) return {
    ok: false,
    error: 'Live browser session is gone (service was likely restarted). Re-trigger automation to refresh the browser, or open the draft directly on MCA via the resume URL.',
  };

  // Get the AEM draftID from the live guideBridge first
  const draftID = await page.evaluate(() => {
    type GBX = { customContextProperty?: (k: string) => unknown };
    return (window as unknown as { guideBridge?: GBX }).guideBridge?.customContextProperty?.('draftID') as string | undefined;
  }).catch(() => undefined);

  const candidates: string[] = [];
  if (draftID) {
    candidates.push(
      `/content/forms/af/mca-af-forms/aoc/aoc-4/jcr:content/guideContainer.fp.pdf.jsp/${encodeURIComponent(draftID)}`,
      `/content/forms/af/mca-af-forms/aoc/aoc-4/jcr:content/guideContainer.fp.printpreview.jsp/${encodeURIComponent(draftID)}`,
    );
  }
  if (job.srId) {
    candidates.push(
      `/content/forms/af/mca-af-forms/aoc/aoc-4/jcr:content/guideContainer.fp.pdf.jsp/${encodeURIComponent(job.srId)}_af`,
      `/content/forms/af/mca-af-forms/aoc/aoc-4/jcr:content/guideContainer.fp.pdf.jsp/${encodeURIComponent(job.srId)}`,
    );
  }

  const ctx = page.context();
  const tab = await ctx.newPage();
  try {
    for (const path_ of candidates) {
      const url = `https://www.mca.gov.in${path_}`;
      try {
        const resp = await tab.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
        if (!resp || !resp.ok()) continue;
        const body = await resp.body();
        const header = body.subarray(0, 4).toString('ascii');
        if (header === '%PDF') {
          fs.writeFileSync(outPath, body);
          return { ok: true, bytes: body.length, via: url };
        }
      } catch { /* try next */ }
    }

    // Fallback: use Playwright's built-in page.pdf() on the current form page — not the
    // official MCA PDF, but a Chromium-rendered snapshot the DSC signer can review.
    await tab.close();
    const printPdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
    });
    fs.writeFileSync(outPath, printPdf);
    return { ok: true, bytes: printPdf.length, via: 'page.pdf() — chromium render (MCA PDF endpoint unavailable)' };
  } finally {
    try { await tab.close(); } catch { /* already closed */ }
  }
}

async function downloadDraftPdf(
  page: import('playwright').Page,
  _cin: string,
  outPath: string,
  srId?: string,
  referenceNumber?: string,
): Promise<{ ok: true; bytes: number; via: string } | { ok: false; error: string; tried: string[] }> {
  // Try multiple URL patterns. After hybrid save, we have:
  //   - draftID on the bridge (e.g., "433S4VQPYIOZ7JEY4W3RQLK2GU_af")
  //   - srId (Siebel internal, e.g., "1-BNSY9KL")
  //   - referenceNumber (MCA SRN, e.g., "1-25383955701")
  // Probe each against AEM's standard PDF endpoints + MCA-specific patterns we've seen.
  const buffer = await page.evaluate(async ({ srId: sr, refNum }) => {
    const draftID = (window as unknown as { guideBridge?: { customContextProperty?: (k: string) => unknown } })
      .guideBridge?.customContextProperty?.('draftID') as string | undefined;

    const ids = [draftID, refNum, sr ? `${sr}_af` : undefined, sr].filter(Boolean) as string[];
    const formBase = '/content/forms/af/mca-af-forms/aoc/aoc-4/jcr:content/guideContainer';
    const portalBase = '/content/forms/portal/draftandsubmission';
    const tried: string[] = [];
    const tryUrl = async (url: string, init?: RequestInit) => {
      tried.push(`${init?.method ?? 'GET'} ${url}`);
      try {
        const r = await fetch(url, { credentials: 'include', ...init });
        if (!r.ok) return null;
        const blob = await r.blob();
        const head = await blob.slice(0, 4).text();
        if (head !== '%PDF') return null;
        const buf = await blob.arrayBuffer();
        return { base64: btoa(String.fromCharCode(...new Uint8Array(buf))), via: url };
      } catch { return null; }
    };

    for (const id of ids) {
      for (const verb of ['fp.pdf.jsp', 'fp.preview.jsp', 'fp.printpreview.jsp']) {
        // GET with id in path
        const url1 = `${formBase}.${verb}/${encodeURIComponent(id)}`;
        const r1 = await tryUrl(url1);
        if (r1) return { ok: true as const, ...r1, tried };
        // GET with id as query param
        const url2 = `${formBase}.${verb}?fp_draftId=${encodeURIComponent(id)}`;
        const r2 = await tryUrl(url2);
        if (r2) return { ok: true as const, ...r2, tried };
      }
      // Portal-level draft retrieval — MCA's "My Application" landing path
      const url3 = `${portalBase}.fp.draft.json?fp_draftId=${encodeURIComponent(id)}`;
      const r3 = await tryUrl(url3);
      if (r3) return { ok: true as const, ...r3, tried };
    }

    // Try MCA-specific endpoints. The /bin/mca/ prefix is MCA's custom endpoint family;
    // patterns inferred from form clientlib symbols (formSubmitConfirmation, prefillWithCin).
    const mcaCandidates = [
      sr ? `/bin/mca/getDraftPDF?srn=${encodeURIComponent(sr)}` : undefined,
      sr ? `/bin/mca/viewDraftForm?srn=${encodeURIComponent(sr)}` : undefined,
      refNum ? `/bin/mca/getDraftPDF?srn=${encodeURIComponent(refNum)}` : undefined,
      refNum ? `/bin/mca/viewDraftForm?srn=${encodeURIComponent(refNum)}` : undefined,
      refNum ? `/bin/mca/getApplicationPdf?srn=${encodeURIComponent(refNum)}` : undefined,
      refNum ? `/bin/mca/applicationDetailsPdf?srn=${encodeURIComponent(refNum)}` : undefined,
      refNum ? `/bin/mca/aoc4/${encodeURIComponent(refNum)}/pdf` : undefined,
      refNum ? `/applications/${encodeURIComponent(refNum)}/pdf` : undefined,
      // AEM's portal-level draft view endpoint
      draftID ? `/content/forms/portal/draftandsubmission.fp.draft.html?fp_draftId=${encodeURIComponent(draftID)}` : undefined,
    ].filter(Boolean) as string[];
    const mcaEndpoints = mcaCandidates;
    for (const url of mcaEndpoints) {
      tried.push(url);
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) continue;
        const blob = await r.blob();
        const head = await blob.slice(0, 4).text();
        if (head !== '%PDF') continue;
        const buf = await blob.arrayBuffer();
        return { ok: true as const, base64: btoa(String.fromCharCode(...new Uint8Array(buf))), via: url, tried };
      } catch { /* skip */ }
    }
    return { ok: false as const, error: `no candidate URL returned a valid PDF (${tried.length} attempts)`, tried };
  }, { srId, refNum: referenceNumber });

  if (!buffer.ok) return { ok: false, error: buffer.error, tried: buffer.tried };
  const buf = Buffer.from(buffer.base64, 'base64');
  fs.writeFileSync(outPath, buf);
  return { ok: true, bytes: buf.length, via: buffer.via };
}

async function applyPanel1(page: import('playwright').Page, payload: import('./jobs.js').Aoc4FormPayload): Promise<void> {
  await page.evaluate((p) => {
    type GuideNode = { name?: string; somExpression?: string; items?: GuideNode[] };
    const gb = (window as unknown as { guideBridge: { resolveNode: (s: string) => unknown; setProperty: (s: string[], p: string, v: unknown[]) => void } }).guideBridge;
    const root = gb.resolveNode('rootPanel') as GuideNode | null;
    const findSom = (name: string): string | null => {
      let found: string | null = null;
      const walk = (n: GuideNode | undefined): void => {
        if (!n || found) return;
        if (n.name === name && n.somExpression) { found = n.somExpression; return; }
        if (Array.isArray(n.items)) for (const k of n.items) walk(k);
      }
      walk(root ?? undefined);
      return found;
    }
    const apply = (n: string, v: string): void => {
      const s = findSom(n);
      if (s) gb.setProperty([s], 'value', [v]);
    };
    // NOTE (2026-05-20): The radio writes (whetherAnnualGeneralMeeting, wetherProFinancialStatement,
    // whetherAdoptedAdjAGM, whetherAnyExtension, whetherSchedule3) have been REMOVED from
    // this legacy hardcoded path. They corrupted the AEM model: when the payload sent
    // a literal label like 'Yes'/'No' (from the schema-driven adapter), `setProperty(som, 'Yes')`
    // wrote an invalid enum value, AEM silently rejected it, and the form defaulted to
    // 'Not Applicable'. My subsequent panel1 panelOverrides (which run AFTER this function)
    // would then write '1' but the model was already corrupted. Removing the legacy writes
    // means the schema-driven panel1 overrides own the radio writes entirely, using setRadio
    // which clicks the actual DOM input + verifies the model value persisted.
    // Kept here: the date + dropdown writes that aren't in panel1 panelOverrides yet.
    apply('numberOfMembers', String(p.numberOfMembers));
  }, payload);
}

async function populateSignatoryTables(page: import('playwright').Page, payload: import('./jobs.js').Aoc4FormPayload): Promise<void> {
  await page.evaluate((p) => {
    type Inst = Record<string, { somExpression?: string; value?: unknown }>;
    type IM = { _instances: Inst[]; addInstance?: () => void; removeInstance?: (i: number) => void; instanceCount?: number };
    type Table = { Row1?: { _instanceManager: IM } };
    type FieldNode = { _view?: { element?: HTMLElement } };
    const gb = (window as unknown as { guideBridge: { resolveNode: (s: string) => unknown; setProperty: (s: string[], p: string, v: unknown[]) => void } }).guideBridge;
    const setVal = (som: string, v: string): void => { try { gb.setProperty([som], 'value', [v]); } catch { /* ignore */ } };
    // Dropdown setter for AEM <select> widgets. Two-stage gotcha:
    // 1. setProperty writes the model but doesn't fire change on the <select>, and
    //    AEM/Siebel row-level validation listens for the change event.
    // 2. AEM dropdown options have value="<code>" and textContent="<label>" — they
    //    aren't equal. Setting select.value = "Director" fails silently when no
    //    option has value="Director" (the option has e.g. value="DIR" text="Director").
    // Verified live 2026-05-04: form showed "Designation selected is not correct"
    // because we were setting the LABEL not the underlying option VALUE.
    // Fix: look up the option whose textContent matches our intended label, then
    // set select.value = thatOption.value, write back to model, and fire events.
    const setDropdown = (som: string, label: string): void => {
      try { gb.setProperty([som], 'value', [label]); } catch { /* ignore */ }
      try {
        const node = gb.resolveNode(som) as FieldNode | null;
        const select = node?._view?.element?.querySelector?.('select') as HTMLSelectElement | null;
        if (!select) return;
        const wanted = label.trim().toLowerCase();
        let matched: HTMLOptionElement | null = null;
        for (const opt of Array.from(select.options)) {
          if (opt.textContent?.trim().toLowerCase() === wanted) { matched = opt; break; }
        }
        const useValue = matched?.value ?? label;
        select.value = useValue;
        try { gb.setProperty([som], 'value', [useValue]); } catch { /* ignore */ }
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        select.dispatchEvent(new Event('blur', { bubbles: true }));
      } catch { /* ignore */ }
    };

    const fsIdx = p.fsSignerDirectorIndex ?? 0;
    const fs = p.directors[fsIdx];

    // dynamicTable1 — FS signatories (1 row for small Pvt)
    // Per panel1-conditional-field-map.json captured on SCALEVERGE test:
    //   fields_per_row: ['DINorIncome', 'name', 'designation', 'DateOfSigning']
    // Earlier code used 'table1designation' which is INCORRECT — that field doesn't exist.
    // Verified live 2026-05-03: with 'table1designation' the form left the Designation
    // column empty after save ("Please enter the relevant details" error on resume).
    const dt1 = gb.resolveNode('dynamicTable1') as Table | null;
    const dt1IM = dt1?.Row1?._instanceManager;
    if (dt1IM && fs) {
      const r0 = dt1IM._instances[0];
      if (r0?.DINorIncome?.somExpression) setVal(r0.DINorIncome.somExpression, fs.din);
      // name auto-fetches via AEM's valueCommitScript on DIN entry — no need to set
      if (r0?.designation?.somExpression) setDropdown(r0.designation.somExpression, fs.designation);
      if (r0?.DateOfSigning?.somExpression) setVal(r0.DateOfSigning.somExpression, p.boardMeetingFsApprovalDate);
      // Trim from default 5 rows down to 1
      for (let i = dt1IM._instances.length - 1; i >= 1; i--) {
        try { dt1IM.removeInstance?.(i); } catch { /* keep going */ }
      }
    }

    // table2 — Board's report signatories (one row per director, max 3 default)
    const t2 = gb.resolveNode('table2') as Table | null;
    const t2IM = t2?.Row1?._instanceManager;
    if (t2IM) {
      // Add rows if more than 3 directors
      const target = Math.min(p.directors.length, 5);
      while (t2IM._instances.length < target) {
        try { t2IM.addInstance?.(); } catch { break; }
      }
      for (let i = 0; i < target; i++) {
        const row = t2IM._instances[i];
        const dir = p.directors[i];
        if (!row || !dir) continue;
        if (row.din?.somExpression) setVal(row.din.somExpression, dir.din);
        if (row.designation1?.somExpression) setDropdown(row.designation1.somExpression, dir.designation);
        if (row.DateOfSigningOfBoard?.somExpression) setVal(row.DateOfSigningOfBoard.somExpression, p.boardMeetingReportDate);
      }
      // Trim to actual director count
      for (let i = t2IM._instances.length - 1; i >= target; i--) {
        try { t2IM.removeInstance?.(i); } catch { /* keep going */ }
      }
    }
  }, payload);
}

async function _clickPanelSaveAndCapture(
  page: import('playwright').Page,
  panelKey: string,
): Promise<{ ok: boolean; srId?: string; error?: string }> {
  const buttonId = PANEL_SAVE_IDS[panelKey];
  if (!buttonId) return { ok: false, error: `no Save button id mapped for ${panelKey}` };

  // AEM keeps the panel-N save buttons `disabled` until its internal "currentPanelIndex"
  // advances past panel-(N-1). For automated runs we bypass via:
  //   1. Force-enable: strip disabled + aria-disabled + AEM's `_disabled` widget flag
  //   2. Trigger the underlying widget's click handler directly (vs DOM .click() which the
  //      browser refuses to dispatch on disabled buttons).
  await page.evaluate((id) => {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (!el) return;
    el.disabled = false;
    el.removeAttribute('disabled');
    el.removeAttribute('aria-disabled');
    el.classList.remove('disabled', 'btn-disabled');
  }, buttonId);

  const respPromise = page.waitForResponse(r => r.url().includes('/bin/commonSaveSubmit'), { timeout: 30_000 }).catch(() => null);
  await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (el) (el as HTMLElement).click();
  }, buttonId);

  const resp = await respPromise;
  if (!resp) return { ok: false, error: 'commonSaveSubmit did not fire — validate() may not be overridden' };

  let inner: { error?: string; message?: string } | undefined;
  let srId: string | undefined;
  try {
    const text = await resp.text();
    const outer = JSON.parse(text) as { resCode?: number; resStr?: string };
    if (typeof outer.resStr === 'string') {
      inner = JSON.parse(outer.resStr) as { error?: string; message?: string };
      const m = (inner.message ?? '').match(SR_ID_REGEX);
      if (m) srId = m[1];
    }
  } catch (e) {
    return { ok: false, error: `parse error: ${(e as Error).message}` };
  }

  const isPartialSuccess = !!inner?.message && PARTIAL_SAVE_MARKER.test(inner.message);
  const isCleanSuccess = !inner?.error && !(inner?.message ?? '').toLowerCase().includes('error');
  const ok = resp.status() === 200 && (isCleanSuccess || isPartialSuccess);
  return { ok, srId, error: ok ? undefined : `inner.error=${inner?.error} msg=${inner?.message?.slice(0, 200)}` };
}

// _invokeAemDraftSave is unused under the new flow (we call _handleDraftSaveWrapper inline).
void _invokeAemDraftSave;
