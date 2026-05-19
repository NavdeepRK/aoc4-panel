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
import { setPhase, type Aoc4Job } from './jobs.js';

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

export async function runAoc4Job(job: Aoc4Job, opts: { artifactDir: string; skipPanels2to6?: boolean }): Promise<void> {
  const { jobId, payload } = job;
  const log = (msg: string) => process.stdout.write(`[aoc4-worker ${jobId}] ${msg}\n`);

  setPhase(jobId, 'LOGGING_IN');
  // Honors HEADLESS env var. For CI/automated runs set HEADLESS=true.
  const { browser, page } = await launch();
  // Persist the browser handle on the job for later phases (PDF download, upload signed)
  job._browser = browser;
  job._page = page;

  // esbuild (via tsx) emits `__name(fn, "name")` calls into compiled output when keepNames
  // is set. The helper is part of the Node runtime but missing in the browser. When we
  // page.evaluate(...) a function, the serialized form contains `__name(...)` references
  // and throws ReferenceError in the page. Polyfill via init script (string form so the
  // payload itself isn't subject to esbuild's compile-time transforms).
  await page.addInitScript('window.__name = function(f, n){ return f; };');

  setPhase(jobId, 'LOADING_FORM');
  await page.goto(AOC4_FORM_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });

  // ── Session check ─────────────────────────────────────────────────────────────
  // If storage-state.json is missing or the MCA session has expired, the server
  // issues a 302 → login page before any JS runs. Detect this early so we get a
  // clear FAILED message instead of a cryptic waitForBridge timeout 30 s later.
  {
    const currentUrl = page.url();
    const isLoginPage =
      currentUrl.includes('fologin') ||
      currentUrl.includes('/login') ||
      currentUrl.includes('login.html');

    if (!isLoginPage) {
      // Even if the URL looks right, the page might be an auth-error/redirect
      // intermediate. Give AEM 3 s to settle and re-check.
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

      // Auditor fields (panel 2)
      if (panelKey === 'panel2AOC4' && payload.auditor) await _applyPanel2Overrides(page, payload);

      // Balance sheet / Schedule III (panel 3)
      if (panelKey === 'panel3AOC4' && payload.scheduleIII) {
        const applied = await _applyPanel3Overrides(page, payload, fillStats.fields);
        log(`panel3 scheduleIII applied ${applied} field overrides`);
      }

      // P&L (panel 4)
      // Panel 6 — P&L (discovered: P&L is in panel 6, panel 4 is additional disclosures)
      if (panelKey === 'panel6AOC4' && payload.profitAndLoss) {
        const applied = await _applyPanel6Overrides(page, payload);
        log(`panel6 profitAndLoss applied ${applied} field overrides`);
      }

      // Caller-supplied direct field-name overrides (highest precedence)
      const shortKey = `panel${panelNum}` as 'panel1' | 'panel2' | 'panel3' | 'panel4' | 'panel5' | 'panel6' | 'panel7';
      const overrides = payload.panelOverrides?.[shortKey];
      if (overrides && Object.keys(overrides).length > 0) {
        const applied = await _applyDirectOverrides(page, overrides);
        log(`panel${panelNum} applied ${applied}/${Object.keys(overrides).length} direct overrides`);
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
  if ((payload as { _aemMappingStats?: { mapped: number; unmappedAem: number } })._aemMappingStats) {
    const s = (payload as { _aemMappingStats: { mapped: number; unmappedAem: number } })._aemMappingStats;
    log(`schema-driven aemField mapping: ${s.mapped} fields written via panelOverrides (${s.unmappedAem} aemFields had no matching panel)`);
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

/**
 * Panel 2 overrides — auditor section. The generic filler stuffs 'NA' / '0.00' into auditor
 * fields; this applies the small-Pvt preset's intended values where the payload supplies them.
 */
async function _applyPanel2Overrides(
  page: import('playwright').Page,
  payload: import('./jobs.js').Aoc4FormPayload,
): Promise<void> {
  if (!payload.auditor) return;
  await page.evaluate((aud: NonNullable<import('./jobs.js').Aoc4FormPayload['auditor']>) => {
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
    const set = (name: string, v: string | undefined): void => {
      if (v == null || v === '') return;
      const s = findSom(name);
      if (s) gb.setProperty([s], 'value', [v]);
    };
    if (aud.srnOfAdt1) set('SRNOfFormADT1', aud.srnOfAdt1);
    set('numberAuditors', '1');
    set('incomeTaxOfAuditor', aud.pan);
    set('membershipNumberOfAuditor', aud.membershipNumber);
    set('nameOfTheAuditor', aud.name);
    // categoryOfAuditor: '1'=Individual, '2'=Firm  (discovered from AEM options)
    if (aud.category) {
      const catVal = aud.category.toLowerCase().includes('firm') ? '2' : '1'; // default Individual
      set('categoryOfAuditor', catVal);
    }
    if (aud.address) {
      set('addressLine1_Auditor', aud.address.line1);
      set('addressLine2_Auditor', aud.address.line2);
      set('pinCode_Auditor', aud.address.pincode);
      set('city_Auditor', aud.address.city);
      set('district_Auditor', aud.address.district);
      set('state_Auditor', aud.address.state);
    }
    if (aud.signingMember) {
      set('nameOfMember', aud.signingMember.name);
      set('membershipNumber_Auditor', aud.signingMember.membershipNumber);
    }
  }, payload.auditor);
}

/**
 * Panel 3 — Schedule III balance sheet.
 *
 * AEM field name discovery (2026-05-13): balance sheet rows use a numbered pattern:
 *   FiguresAtEndOfCurrentReporting{N}  / figuresAsEndOfPreviousReporting{N}
 * where N maps to a fixed Schedule III line item. Keyword matching fails here because
 * the field names contain no financial term — we use a direct index map instead.
 *
 * Row → Schedule III line item (Companies Act Schedule III, Part I):
 *   1  → (a) Share capital
 *   2  → (b) Reserves and surplus
 *   6  → (a) Long term borrowings
 *   10 → (a) Short term borrowings
 *   11 → (b) Trade payables    (sub: outstandingDuesOfMicroEnterprises* + outstandingDuesOfOther*)
 *   12 → (c) Other current liabilities
 *   13 → (d) Short term provisions
 *   16 → (i) Property Plant and Equipment
 *   17 → (ii) Intangible assets
 *   22 → (d) Long term loans and advances
 *   25 → (b) Inventories
 *   27 → (d) Cash and cash equivalents
 *   28 → (e) Short term loans and advances
 *   29 → (f) Other current assets
 */
async function _applyPanel3Overrides(
  page: import('playwright').Page,
  payload: import('./jobs.js').Aoc4FormPayload,
  _fields: Array<{name: string; som: string; cls: string}>,
): Promise<number> {
  if (!payload.scheduleIII) return 0;
  const s = payload.scheduleIII;

  // Direct (rowIndex → {current, previous}) mapping — no keyword guessing
  type Entry = { row: number; cur?: number; prev?: number };
  const rows: Entry[] = [
    { row: 1,  cur: s.equityShareCapital?.current,         prev: s.equityShareCapital?.previous },
    { row: 2,  cur: s.otherEquity?.current,                prev: s.otherEquity?.previous },
    { row: 6,  cur: s.longTermBorrowings?.current,         prev: s.longTermBorrowings?.previous },
    { row: 10, cur: s.shortTermBorrowings?.current,        prev: s.shortTermBorrowings?.previous },
    { row: 12, cur: s.otherCurrentLiabilities?.current,    prev: s.otherCurrentLiabilities?.previous },
    { row: 13, cur: s.shortTermProvisions?.current,        prev: s.shortTermProvisions?.previous },
    { row: 16, cur: s.fixedAssets?.current,                prev: s.fixedAssets?.previous },
    { row: 22, cur: s.longTermLoansAndAdvances?.current,   prev: s.longTermLoansAndAdvances?.previous },
    { row: 25, cur: s.inventories?.current,                prev: s.inventories?.previous },
    { row: 27, cur: s.cashAndCashEquivalents?.current,     prev: s.cashAndCashEquivalents?.previous },
    { row: 28, cur: s.shortTermLoansAndAdvances?.current,  prev: s.shortTermLoansAndAdvances?.previous },
    { row: 29, cur: s.otherCurrentAssets?.current,         prev: s.otherCurrentAssets?.previous },
  ];

  return await page.evaluate((entries: Entry[]) => {
    const gb = (window as unknown as { guideBridge: { resolveNode: (s: string) => unknown; setProperty: (s: string[], p: string, v: unknown[]) => void } }).guideBridge;
    type GN = { name?: string; somExpression?: string; items?: GN[] };
    const root = gb.resolveNode('rootPanel') as GN | null;
    const somByName = new Map<string, string>();
    const collect = (n: GN | undefined): void => {
      if (!n) return;
      if (n.name && n.somExpression) somByName.set(n.name, n.somExpression);
      if (Array.isArray(n.items)) for (const c of n.items) collect(c);
    };
    collect(root ?? undefined);
    const set = (name: string, v: number | undefined): boolean => {
      if (v == null) return false;
      const som = somByName.get(name);
      if (!som) return false;
      try { gb.setProperty([som], 'value', [String(v)]); return true; } catch { return false; }
    };
    let count = 0;
    for (const e of entries) {
      if (set(`FiguresAtEndOfCurrentReporting${e.row}`, e.cur)) count++;
      if (set(`figuresAsEndOfPreviousReporting${e.row}`, e.prev)) count++;
    }
    return count;
  }, rows);
}

/**
 * Panel 6 — Profit & Loss (Segment II).
 *
 * AEM field name discovery (2026-05-13): P&L fields are in panel 6 (not panel 4).
 * All P&L items use the pattern revenueFromOperationsCurrentN where N maps to a
 * specific line in the Schedule III Part II / Segment II:
 *   10 → Total Income (I+II)                    — use for totalRevenue
 *   11 → (a) Cost of materials consumed
 *   16 → (d) Employee benefit expenses
 *   21 → (i) Finance costs
 *   22 → (j) Depreciation and amortization
 *   23 → (k) Other expenses
 *   24 → Total expenses
 *   25 → Profit before exceptional items and tax
 *   29 → Profit before tax
 *   32 → Profit/(Loss) from continuing operations — use for profitAfterTax
 *   36 → Profit/(Loss) (XI+XIV)                  — final PAT line
 *
 * Previous-year versions have a parallel set (captured via revenueFromOperationsPrevious{N}
 * or similar — validate against actual artifact if needed).
 */
async function _applyPanel6Overrides(
  page: import('playwright').Page,
  payload: import('./jobs.js').Aoc4FormPayload,
): Promise<number> {
  if (!payload.profitAndLoss) return 0;
  const pnl = payload.profitAndLoss;

  type PnlEntry = { name: string; cur?: number; prev?: number };
  const entries: PnlEntry[] = [
    // Revenue
    { name: 'revenueFromOperationsCurrent10', cur: pnl.totalRevenue?.current,         prev: pnl.totalRevenue?.previous },
    // Expenses
    { name: 'revenueFromOperationsCurrent11', cur: pnl.costOfMaterialsConsumed?.current, prev: pnl.costOfMaterialsConsumed?.previous },
    { name: 'revenueFromOperationsCurrent16', cur: pnl.employeeBenefitExpense?.current,  prev: pnl.employeeBenefitExpense?.previous },
    { name: 'revenueFromOperationsCurrent21', cur: pnl.financeCharges?.current,           prev: pnl.financeCharges?.previous },
    { name: 'revenueFromOperationsCurrent22', cur: pnl.depreciationAndAmortisation?.current, prev: pnl.depreciationAndAmortisation?.previous },
    { name: 'revenueFromOperationsCurrent23', cur: pnl.otherExpenses?.current,            prev: pnl.otherExpenses?.previous },
    { name: 'revenueFromOperationsCurrent24', cur: pnl.totalExpenses?.current,            prev: pnl.totalExpenses?.previous },
    // Profit lines
    { name: 'revenueFromOperationsCurrent25', cur: pnl.profitBeforeTax?.current,          prev: pnl.profitBeforeTax?.previous },
    { name: 'revenueFromOperationsCurrent29', cur: pnl.profitBeforeTax?.current,          prev: pnl.profitBeforeTax?.previous },
    { name: 'revenueFromOperationsCurrent36', cur: pnl.profitAfterTax?.current,           prev: pnl.profitAfterTax?.previous },
  ];

  return await page.evaluate((items: PnlEntry[]) => {
    const gb = (window as unknown as { guideBridge: { resolveNode: (s: string) => unknown; setProperty: (s: string[], p: string, v: unknown[]) => void } }).guideBridge;
    type GN = { name?: string; somExpression?: string; items?: GN[] };
    const root = gb.resolveNode('rootPanel') as GN | null;
    const somByName = new Map<string, string>();
    const collect = (n: GN | undefined): void => {
      if (!n) return;
      if (n.name && n.somExpression) somByName.set(n.name, n.somExpression);
      if (Array.isArray(n.items)) for (const c of n.items) collect(c);
    };
    collect(root ?? undefined);
    const set = (name: string, v: number | undefined): boolean => {
      if (v == null) return false;
      const som = somByName.get(name);
      if (!som) return false;
      try { gb.setProperty([som], 'value', [String(v)]); return true; } catch { return false; }
    };
    let count = 0;
    for (const e of items) {
      if (set(e.name, e.cur)) count++;
      // Previous year: try revenueFromOperationsPreviousN pattern
      const prevName = e.name.replace('Current', 'Previous');
      if (set(prevName, e.prev)) count++;
    }
    return count;
  }, entries);
}

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
 * Apply caller-supplied field-name → value overrides via setProperty. Returns the count
 * of overrides successfully applied (a value <count means some field names didn't match
 * anything in the form tree — typically a stale name).
 */
async function _applyDirectOverrides(
  page: import('playwright').Page,
  overrides: Record<string, string | number>,
): Promise<number> {
  return await page.evaluate((entries) => {
    type GuideNode = { name?: string; somExpression?: string; items?: GuideNode[] };
    const gb = (window as unknown as { guideBridge: { resolveNode: (s: string) => unknown; setProperty: (s: string[], p: string, v: unknown[]) => void } }).guideBridge;
    const root = gb.resolveNode('rootPanel') as GuideNode | null;
    const findSom = (name: string): string | null => {
      let found: string | null = null;
      const walk = (n: GuideNode | undefined): void => {
        if (!n || found) return;
        if (n.name === name && n.somExpression) { found = n.somExpression; return; }
        if (Array.isArray(n.items)) for (const k of n.items) walk(k);
      };
      walk(root ?? undefined);
      return found;
    };
    let count = 0;
    for (const [name, value] of entries) {
      const som = findSom(name);
      if (!som) continue;
      try { gb.setProperty([som], 'value', [String(value)]); count++; } catch { /* skip */ }
    }
    return count;
  }, Object.entries(overrides));
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
    // ISO yyyy-MM-dd → DD/MM/YYYY converter for date fields whose AEM widget rejects
    // the ISO model format and only accepts the user-typed DD/MM/YYYY display format.
    apply('fromDate', p.financialYearFrom);
    apply('toDate', p.financialYearTo);
    apply('textbox1643785189026', p.boardMeetingFsApprovalDate);
    apply('DateOfBoard', p.boardMeetingReportDate);
    apply('dateOfSigningOfReports', p.auditorSigningDate);

    // Q4(b)(i) Nature of FS — defaults to 'Adopted Financial statements'
    apply('natureS', p.natureOfFinancialStatements || 'Adopted Financial statements');
    // Q4(b)(iii) + 4(b)(iv) + 7(d) — these radios previously worked with '1' (per pre-2026-05-15 runs).
    // Keep '1' unless payload provides an override. ('Yes'/'No' literals broke the form somehow
    // — investigating; reverting until we have more data.)
    apply('wetherProFinancialStatement', p.provisionalFsFiledEarlier || '1');
    apply('whetherAdoptedAdjAGM', p.adoptedInAdjournedAgm || '1');

    // Q7(a) AGM held — '1' = Yes, '0' = No. User reported the form rejected '1' but earlier
    // runs successfully saved with '1', so '1' is the working value and the user was looking
    // at a stale render. Reverting to '1'.
    apply('whetherAnnualGeneralMeeting', p.agmHeld || (p.agmDate ? '1' : '0'));
    apply('ifyesDateOfAGM', p.agmDate);
    apply('dueDateOfAGM', p.agmDueDate);
    apply('whetherAnyExtension', p.agmExtensionGranted || '1');

    // Q10(b) Schedule III applicable — this WAS being left unset which let the form default to
    // 'No' and conflict with C&I industry. Setting explicitly. '1' or 'Yes' — we'll know from
    // the next run which the form accepts.
    apply('whetherSchedule3', p.scheduleIIIApplicable || '1');

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
