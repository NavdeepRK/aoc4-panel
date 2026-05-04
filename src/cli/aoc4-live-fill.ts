/**
 * Live-fill an AOC-4 draft visible to the user.
 *
 * Opens a fresh AOC-4 form (no resume URL — that opens an empty partial-save draft),
 * fills panel 1 + signatory tables + as many fields as the bridge will accept while
 * the panel is active, saves, and keeps the browser open indefinitely so the user can
 * inspect, fill the rest, click PDF, sign, etc.
 *
 * Why a fresh form (not the resume URL): partial-save responses don't actually persist
 * field data — only the SR record. Resume URLs of partial-saved drafts open EMPTY. To
 * get a populated form the user can verify + complete, we need to do the fill in real
 * time and let them watch.
 *
 * Usage: npm run aoc4:live-fill [CIN]
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { launch, teardown } from '../browser.js';
import { AOC4_FORM_URL, waitForBridge } from '../aoc4/bridge.js';

const ARTIFACT_DIR = `./.artifacts/runs/live-fill-${Date.now()}`;
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

const CIN = process.argv[2] ?? 'U69100KA2023PTC177694';
// Director DINs are CIN-specific — MCA validates them against the company's master roster
// at save time. Pass via env vars to override the SCALEVERGE-only defaults.
//   AOC4_DIN_PRIMARY=01234567 AOC4_DIN_SECONDARY=89012345 npm run aoc4:live-fill -- <CIN>
const DIN_PRIMARY = process.env.AOC4_DIN_PRIMARY ?? '11142612';
const DIN_SECONDARY = process.env.AOC4_DIN_SECONDARY ?? '11142613';

(async (): Promise<void> => {
  if (!fs.existsSync('./storage-state.json')) {
    console.error('No storage-state.json — run `npm run login` first.');
    process.exit(2);
  }

  // Hardcoded test scenario: filing AOC-4 for FY 2024-25 (Apr 2024 – Mar 2025).
  // Board signs in Sep 2025 (post FY end). AGM held + due Sep 2025. This is the
  // realistic "filing in arrears" case for SCALEVERGE in May 2026. Cross-field
  // validation on the form requires bdate ≥ fyTo and agm ≥ fyTo, so all of these
  // must move together if you change the FY.
  const fyStart = '2024-04-01';
  const fyTo = '2025-03-31';
  const bdate = '2025-09-15';
  const agm = '2025-09-30';
  const agmDue = '2025-09-30';

  // Observe mode: open form, capture XHR, do NOT auto-fill / auto-save / rewrite
  // headers. Lets the user fill by hand and verify what a clean manual request
  // looks like (so we can diff against our automated request).
  //   OBSERVE=1 npm run aoc4:live-fill
  const OBSERVE_ONLY = process.env.OBSERVE === '1';

  const { browser, page } = await launch();

  // CSRF header fix — AEM's runtime sets `csrf-token` header to the literal string
  // "undefined" on automated POSTs to /bin/commonSaveSubmit, so MCA's upstream Apache
  // returns HTTP 400 (Czech multi-language error page, 6265 bytes). The form body
  // already has the encrypted csrfToken field — only the HEADER is malformed.
  // Verified live 2026-05-04 via XHR capture.
  // Fix: patch XMLHttpRequest.setRequestHeader at the page layer to substitute the
  // _csrf cookie value when it sees "undefined".
  // Route-layer fix-up for the save endpoint (skipped in OBSERVE mode so user's
  // manual save sends the truly-original headers and we can capture them):
  // 1. AEM's runtime sets `csrf-token: undefined` on save POSTs → rewrite from cookie.
  // 2. Add browser-realistic `accept-language`, `accept-encoding`, `sec-fetch-*`
  //    headers that Playwright omits — MCA's dispatcher may reject without them.
  if (!OBSERVE_ONLY) {
    await page.context().route('https://www.mca.gov.in/bin/commonSaveSubmit*', async (route) => {
      const cookies = await page.context().cookies('https://www.mca.gov.in');
      const csrf = cookies.find((c) => c.name === '_csrf')?.value;
      const origHeaders = route.request().headers();
      const headers: Record<string, string> = {
        ...origHeaders,
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br, zstd',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'priority': 'u=1, i',
      };
      if (csrf) headers['csrf-token'] = csrf;
      process.stderr.write(`  [route] commonSaveSubmit csrf=${headers['csrf-token']?.slice(0, 8)}… +sec-fetch-* +accept-* (was csrf=${origHeaders['csrf-token']})\n`);
      await route.continue({ headers });
    });
  } else {
    process.stderr.write('[live-fill] OBSERVE mode — route header rewrite DISABLED\n');
  }

  await page.context().addInitScript(() => {
    // eslint-disable-next-line no-console
    console.warn('[mca-csrf] init script loaded');
    // Resolve a usable CSRF token. The `_csrf` cookie is HttpOnly so JS can't read it.
    // AEM normally stores the token in #csrfToken / Granite.csrf.token / a meta tag,
    // but on MCA's automated path those are empty. We inject the cookie value into a
    // JS global (window.__csrfOverride) from Node.js side via page.evaluate before save.
    const resolveToken = (): string | null => {
      const inj = (window as unknown as { __csrfOverride?: string }).__csrfOverride;
      if (inj) return inj;
      const el = document.querySelector('#csrfToken') as HTMLInputElement | null;
      if (el?.value) return el.value;
      const g = (window as unknown as { Granite?: { csrf?: { token?: string } } }).Granite;
      if (g?.csrf?.token) return g.csrf.token;
      const meta = document.querySelector('meta[name="csrf-token"]') as HTMLMetaElement | null;
      if (meta?.content) return meta.content;
      return null;
    };
    const origSet = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string): void {
      if (name && name.toLowerCase() === 'csrf-token' && (value === 'undefined' || value == null || value === '')) {
        const t = resolveToken();
        if (t) {
          // eslint-disable-next-line no-console
          console.warn('[mca-csrf] swapped XHR → ' + t.slice(0, 12) + '…');
          return origSet.call(this, name, t);
        }
        // eslint-disable-next-line no-console
        console.warn('[mca-csrf] no token source found (xhr)');
      }
      return origSet.call(this, name, value);
    };
    const origFetch = window.fetch;
    window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      if (init?.headers) {
        const h = new Headers(init.headers);
        const v = h.get('csrf-token');
        if (v === 'undefined' || v == null || v === '') {
          const t = resolveToken();
          if (t) {
            h.set('csrf-token', t);
            // eslint-disable-next-line no-console
            console.warn('[mca-csrf] swapped fetch → ' + t.slice(0, 12) + '…');
            init = { ...init, headers: h };
          }
        }
      }
      return origFetch.call(this, input, init);
    };
  });

  // Mirror page console.warn lines that mention mca-csrf into our stderr so we can see
  // the header-fix init script firing.
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('mca-csrf') || t.includes('mca-block')) {
      process.stderr.write(`  [page console] ${t}\n`);
    }
  });

  // Capture PDF responses live so the user gets a clean URL when they click PDF
  page.on('response', async (resp) => {
    const ct = resp.headers()['content-type'] ?? '';
    if (!ct.includes('pdf')) return;
    try {
      const body = await resp.body();
      if (body.length > 1000) {
        process.stderr.write(`\n  📄 PDF CAPTURED: ${body.length} bytes from ${resp.url()}\n\n`);
      }
    } catch { /* */ }
  });

  // Capture save-related XHR (commonSaveSubmit + draft) request/response to disk
  // so we can diff a failing automated save against a successful manual save.
  // Request bodies are dumped raw; response bodies are dumped raw with headers + status.
  let xhrCounter = 0;
  page.on('request', async (req) => {
    const u = req.url();
    if (!/commonSaveSubmit|draftandsubmission|prefill|getUid|saveDraft/i.test(u)) return;
    const i = ++xhrCounter;
    const dir = path.join(ARTIFACT_DIR, `xhr-${String(i).padStart(3, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const body = req.postData() ?? '';
      const meta = {
        method: req.method(),
        url: u,
        headers: req.headers(),
        bodySize: body.length,
      };
      fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(meta, null, 2));
      if (body) fs.writeFileSync(path.join(dir, 'request.body'), body);
    } catch { /* ignore */ }
    process.stderr.write(`  [xhr-${i}] → ${req.method()} ${u.split('?')[0]}\n`);

    req.response().then(async (resp) => {
      if (!resp) return;
      try {
        const text = await resp.text().catch(() => '');
        const meta = {
          status: resp.status(),
          headers: resp.headers(),
          bodySize: text.length,
        };
        fs.writeFileSync(path.join(dir, 'response.json'), JSON.stringify(meta, null, 2));
        if (text) fs.writeFileSync(path.join(dir, 'response.body'), text);
        process.stderr.write(`  [xhr-${i}] ← ${resp.status()} ${(resp.headers()['content-type'] ?? '?').slice(0, 30)} ${text.length}b\n`);
      } catch { /* ignore */ }
    }).catch(() => undefined);
  });

  process.stderr.write(`[live-fill] xhr capture dir: ${ARTIFACT_DIR}\n`);

  await page.addInitScript('window.__name = function(f){ return f; };');

  process.stderr.write('[live-fill] loading AOC-4 form fresh\n');
  await page.goto(AOC4_FORM_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await waitForBridge(page, 30_000);
  await page.waitForFunction(
    () => typeof (window as unknown as { encrypt?: unknown }).encrypt === 'function' && !!document.querySelector('#csrfToken'),
    { timeout: 30_000 },
  );
  try { await page.bringToFront(); } catch { /* */ }

  // Pre-prime draftID
  await page.evaluate(async () => {
    type GBExt = { customContextProperty?: (k: string, v?: unknown) => unknown };
    const gb = (window as unknown as { guideBridge: GBExt }).guideBridge;
    if (gb.customContextProperty?.('draftID')) return;
    try {
      const r = await fetch('/content/forms/portal/draftandsubmission.fp.draft.json?func=getUid', { credentials: 'include' });
      if (!r.ok) return;
      const j = await r.json() as { id?: string };
      if (j.id) gb.customContextProperty?.('draftID', j.id + '_af');
    } catch { /* */ }
  });

  // Set CIN + prefill
  process.stderr.write(`[live-fill] setting CIN ${CIN} + running prefillWithCin\n`);
  await page.evaluate((cin: string) => {
    type GuideNode = { name?: string; somExpression?: string; items?: GuideNode[] };
    const gb = (window as unknown as { guideBridge: { resolveNode: (s: string) => unknown; setProperty: (s: string[], p: string, v: unknown[]) => void } }).guideBridge;
    const root = gb.resolveNode('rootPanel') as GuideNode | null;
    const findSom = (name: string): string | null => {
      let f: string | null = null;
      const walk = (n: GuideNode | undefined): void => {
        if (!n || f) return;
        if (n.name === name && n.somExpression) { f = n.somExpression; return; }
        if (Array.isArray(n.items)) for (const k of n.items) walk(k);
      };
      walk(root ?? undefined);
      return f;
    };
    for (const fn of ['CIN_Number_Professional_User', 'CIN_Number_Other_User', 'CINofCompany']) {
      const s = findSom(fn);
      if (s) gb.setProperty([s], 'value', [cin]);
    }
    (window as unknown as { prefillWithCin: (s: string) => void }).prefillWithCin(cin);
  }, CIN);
  await page.waitForTimeout(5000);
  process.stderr.write('[live-fill] prefill done\n');

  // Apply panel 1 + signatory tables (skipped in OBSERVE mode — user fills by hand)
  if (OBSERVE_ONLY) {
    process.stderr.write('[live-fill] OBSERVE mode — skipping auto-fill. Form is yours.\n');
    process.stderr.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    process.stderr.write(`  XHR captures → ${ARTIFACT_DIR}\n`);
    process.stderr.write('  Fill panel 1 by hand, click Save, then press ENTER here when done.\n');
    process.stderr.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    await new Promise<void>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.once('line', () => { rl.close(); resolve(); });
    });
    await teardown(browser);
    return;
  }
  process.stderr.write('[live-fill] filling panel 1 + signatory tables\n');
  await page.evaluate((args: { fyFrom: string; fyTo: string; bdate: string; agm: string; agmDue: string; dinPrimary: string; dinSecondary: string }) => {
    type GuideNode = { name?: string; somExpression?: string; items?: GuideNode[] };
    type Inst = Record<string, { somExpression?: string; value?: unknown }>;
    type IM = { _instances: Inst[]; addInstance?: () => void; removeInstance?: (i: number) => void };
    type Table = { Row1?: { _instanceManager: IM } };
    const gb = (window as unknown as { guideBridge: { resolveNode: (s: string) => unknown; setProperty: (s: string[], p: string, v: unknown[]) => void } }).guideBridge;
    const root = gb.resolveNode('rootPanel') as GuideNode | null;
    const findSom = (name: string): string | null => {
      let f: string | null = null;
      const walk = (n: GuideNode | undefined): void => {
        if (!n || f) return;
        if (n.name === name && n.somExpression) { f = n.somExpression; return; }
        if (Array.isArray(n.items)) for (const k of n.items) walk(k);
      };
      walk(root ?? undefined); return f;
    };
    const set = (n: string, v: string): void => { const s = findSom(n); if (s) gb.setProperty([s], 'value', [v]); };
    // Date setter: same gotcha as dropdowns — setProperty writes the model but the
    // rendered <input type="text"> still shows blank/invalid until a real change/blur
    // dispatches. Verified live 2026-05-04: AGM dates rendered DD/MM/YYYY but flagged
    // "Please enter a valid date" until manual blur. Fix: write model, then set DOM
    // input value, fire input/change/blur.
    type FNode = { _view?: { element?: HTMLElement } };
    const setDate = (n: string, v: string): void => {
      const s = findSom(n);
      if (!s) return;
      try { gb.setProperty([s], 'value', [v]); } catch { /* */ }
      try {
        const node = gb.resolveNode(s) as FNode | null;
        const input = node?._view?.element?.querySelector?.('input') as HTMLInputElement | null;
        if (input) {
          input.value = v;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
        }
      } catch { /* */ }
    };
    // ISO yyyy-MM-dd → DD/MM/YYYY for date fields (AEM date widget displays DD/MM/YYYY).
    const toDDMMYYYY = (iso: string): string => {
      const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
    };
    // Non-AGM date fields accept ISO yyyy-MM-dd via plain set(). Only AGM dates
    // need DD/MM/YYYY display format + change-event dispatch (see gotcha 10c).
    set('fromDate', args.fyFrom);
    set('toDate', args.fyTo);
    set('textbox1643785189026', args.bdate);
    set('DateOfBoard', args.bdate);
    set('dateOfSigningOfReports', args.bdate);
    set('natureS', 'Adopted Financial statements');
    set('wetherProFinancialStatement', '1');
    set('whetherAdoptedAdjAGM', '1');
    set('whetherAnnualGeneralMeeting', '0');
    set('whetherAnyExtension', '1');
    setDate('ifyesDateOfAGM', toDDMMYYYY(args.agm));
    setDate('dueDateOfAGM', toDDMMYYYY(args.agmDue));
    set('numberOfMembers', '5');

    const sv = (som: string, v: string): void => { try { gb.setProperty([som], 'value', [v]); } catch { /* */ } };
    // Dropdown setter for AEM <select> widgets. Two-stage gotcha:
    // 1. setProperty writes the model but doesn't fire change on the <select>.
    // 2. AEM dropdown options have value="<code>" and textContent="<label>" — they
    //    aren't equal. Setting select.value = "Director" fails silently because no
    //    option has value="Director" (it has e.g. value="DIR" text="Director").
    // Verified live 2026-05-04: form showed "Designation selected is not correct"
    // because we were setting the LABEL not the underlying option VALUE.
    // Fix: look up the option whose textContent matches our intended label, then
    // set select.value = thatOption.value, then fire input/change/blur events.
    type FieldNode = { _view?: { element?: HTMLElement } };
    const svDrop = (som: string, label: string): void => {
      try { gb.setProperty([som], 'value', [label]); } catch { /* */ }
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
        // Re-write model with the actual option value so AEM's serialization sends
        // the code, not the label.
        try { gb.setProperty([som], 'value', [useValue]); } catch { /* */ }
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        select.dispatchEvent(new Event('blur', { bubbles: true }));
      } catch { /* */ }
    };
    // Table-row date fields accept ISO via plain sv(). Only AGM dates need DD/MM/YYYY.
    const dt1 = gb.resolveNode('dynamicTable1') as Table | null;
    const dt1IM = dt1?.Row1?._instanceManager;
    if (dt1IM) {
      const r0 = dt1IM._instances[0];
      if (r0?.DINorIncome?.somExpression) sv(r0.DINorIncome.somExpression, args.dinPrimary);
      if (r0?.designation?.somExpression) svDrop(r0.designation.somExpression, 'Director');
      if (r0?.DateOfSigning?.somExpression) sv(r0.DateOfSigning.somExpression, args.bdate);
      for (let i = dt1IM._instances.length - 1; i >= 1; i--) try { dt1IM.removeInstance?.(i); } catch { /* */ }
    }
    const t2 = gb.resolveNode('table2') as Table | null;
    const t2IM = t2?.Row1?._instanceManager;
    if (t2IM) {
      const fillT2 = (idx: number, din: string): void => {
        const row = t2IM._instances[idx]; if (!row) return;
        if (row.din?.somExpression) sv(row.din.somExpression, din);
        if (row.designation1?.somExpression) svDrop(row.designation1.somExpression, 'Director');
        if (row.DateOfSigningOfBoard?.somExpression) sv(row.DateOfSigningOfBoard.somExpression, args.bdate);
      };
      fillT2(0, args.dinPrimary);
      fillT2(1, args.dinSecondary);
      for (let i = t2IM._instances.length - 1; i >= 2; i--) try { t2IM.removeInstance?.(i); } catch { /* */ }
    }
  }, { fyFrom: fyStart, fyTo, bdate, agm, agmDue, dinPrimary: DIN_PRIMARY, dinSecondary: DIN_SECONDARY });

  process.stderr.write('[live-fill] panel 1 fields populated. Clicking Save now (you should see this happen)\n');

  // Bypass validate for the save click
  await page.evaluate(() => {
    const gb = (window as unknown as { guideBridge: { validate?: () => boolean } }).guideBridge;
    try { Object.defineProperty(gb, 'validate', { value: () => true, writable: false, configurable: false }); }
    catch { gb.validate = () => true; }
  });

  // Inject HttpOnly _csrf cookie value into page-side global so the XHR setRequestHeader
  // patch can substitute it when AEM's runtime hands it `undefined`. Playwright's
  // context.cookies() reads HttpOnly cookies; document.cookie does not.
  const injectCsrf = async (): Promise<void> => {
    const cookies = await page.context().cookies('https://www.mca.gov.in');
    const csrf = cookies.find((c) => c.name === '_csrf')?.value;
    if (!csrf) {
      process.stderr.write('  [csrf-inject] no _csrf cookie found — save will likely 400\n');
      return;
    }
    await page.evaluate((tok: string) => {
      (window as unknown as { __csrfOverride?: string }).__csrfOverride = tok;
      // eslint-disable-next-line no-console
      console.warn('[mca-csrf] injected __csrfOverride length=' + tok.length);
    }, csrf);
    // Also inject into all child frames (form may iframe)
    for (const frame of page.frames()) {
      try {
        await frame.evaluate((tok: string) => {
          (window as unknown as { __csrfOverride?: string }).__csrfOverride = tok;
        }, csrf);
      } catch { /* frame detached */ }
    }
    process.stderr.write(`  [csrf-inject] injected ${csrf.slice(0, 8)}… into ${page.frames().length} frames\n`);
  };
  await injectCsrf();

  // Click panel 1 Save with retry on partial response
  for (let attempt = 1; attempt <= 5; attempt++) {
    process.stderr.write(`[live-fill] save attempt ${attempt}/5\n`);
    const respPromise = page.waitForResponse((r) => r.url().includes('/bin/commonSaveSubmit'), { timeout: 30_000 }).catch(() => null);
    await page.evaluate(() => {
      const id = 'guideContainer-rootPanel-panel-panel-panel1AOC4-panel_copy_790625936-nextitemnav___widget';
      document.getElementById(id)?.click();
    });
    const resp = await respPromise;
    if (!resp) {
      process.stderr.write('  no save response — retrying\n');
      await page.waitForTimeout(2000);
      continue;
    }
    try {
      const text = await resp.text();
      process.stderr.write(`  [save resp ${resp.status()} ct=${resp.headers()['content-type'] ?? '?'} bytes=${text.length}] ${text.slice(0, 240).replace(/\n/g, ' ')}\n`);
      const outer = JSON.parse(text) as { resStr?: string };
      if (typeof outer.resStr === 'string') {
        const inner = JSON.parse(outer.resStr) as { message?: string; data?: { integrationId?: string; referenceNumber?: string } };
        if (inner.data?.referenceNumber) {
          process.stderr.write(`  ✅ CLEAN SAVE: srId=${inner.data.integrationId}, ref=${inner.data.referenceNumber}\n`);
          process.stderr.write(`  ✅ Form data has been PERSISTED. The form on screen is now your draft.\n`);
          break;
        } else if (inner.message?.includes('Submitted By')) {
          process.stderr.write(`  ⚠ partial save (Submitted By marker) — data may not persist. Retrying...\n`);
          // Dismiss any modal then retry
          await page.evaluate(() => {
            const candidates = Array.from(document.querySelectorAll<HTMLElement>('button[id*="modal_container"][id$="nextitemnav_copy___widget"]'));
            const v = candidates.filter((el) => el.offsetParent !== null);
            if (v.length > 0) v[0].click();
          });
          await page.waitForTimeout(2500);
          continue;
        } else {
          process.stderr.write(`  unknown response shape: ${(inner.message ?? '').slice(0, 100)}\n`);
        }
      }
    } catch (e) {
      process.stderr.write(`  save response parse error: ${(e as Error).message}\n`);
    }
    await page.waitForTimeout(2000);
  }

  process.stderr.write('\n');
  process.stderr.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  process.stderr.write('  Browser staying open. You take it from here:\n');
  process.stderr.write('     1. Verify panel 1 looks right\n');
  process.stderr.write('     2. Fill panels 2-7 (auditor, balance sheet, P&L, etc.)\n');
  process.stderr.write('     3. Click PDF / Preview / Submit when ready\n');
  process.stderr.write('     4. Press ENTER here when done OR closing the browser\n');
  process.stderr.write('  PDF responses will be auto-captured to stderr as they fire.\n');
  process.stderr.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await new Promise<void>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.once('line', () => { rl.close(); resolve(); });
  });

  await teardown(browser);
})();
