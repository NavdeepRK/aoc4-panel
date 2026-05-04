# Agent Handoff — MCA Automation

For any LLM/agent picking up the MCA automation work. This doc deliberately contains **no secrets**. All credentials and session state live in gitignored files; this doc tells you where to find them and how to use them.

## Files that hold secrets (DO NOT echo their contents into prompts, logs, or docs)

| File | Contents | Gitignored | When to read |
|---|---|---|---|
| `.env` | `MCA_USER_ID`, `MCA_PASSWORD`, `OPENROUTER_API_KEY`, `HEADLESS` | yes | Only when launching `npm run login` — let `dotenv` consume it. Never `cat` it into a prompt. |
| `storage-state.json` | 6 cookies (`cookiesession1`, `__UUID-HASH`, `session-token-md5`, `sessionID`, `deviceId`, `_csrf`) + 5 `localStorage` entries | yes | Read at runtime to inject into a Playwright context. Don't log values — log only cookie *names* and the file's mtime. |

If either file is missing or stale, mint a fresh one with `npm run login` (auto-solves captcha; you'll need the OTP from the account-holder's phone).

## Account state (fact-only; no creds)

- Logged-in user: **AYUSH RONELD** (decoded from `loggedInUserDetailsBasic`)
- `mcaUserType`: **Professional** (upgraded from "Individual" on 2026-05-01)
- `userCategory`: "Registered user"
- DIN association: none confirmed yet — the Professional upgrade alone does not associate AYUSH with any specific CIN; that needs a board resolution per CIN.

## Session lifecycle

1. `npm run login` writes a fresh `storage-state.json` after captcha + OTP. Stores 6 cookies; expires per-cookie field varies (`cookiesession1` ~1 yr; rest ~Sept 2026). Server-side idle timeout is shorter and not documented — assume **~24 h** of useful life.
2. Probe with: `GET /bin/mca/loggedInUserDetailsBasic` and decode the encrypted blob via `window.decrypt()` in the page context. `{"resCode":"205","error":"No Active Session"}` means re-login needed.
3. Account-type changes (Individual → Professional) may invalidate the session — re-login after.

## Loading the session into Playwright MCP (when you don't have direct access to the project's `launch()`)

```js
// Inside browser_run_code:
async (page) => {
  // 1. Read storage-state.json from disk via your own bash/file tool BEFORE this call,
  //    pass the parsed cookies array in by templating into the script.
  //    DO NOT print cookie values to the conversation log.
  await page.context().clearCookies();
  await page.context().addCookies(cookies);  // cookies = JSON.parse(...).cookies, with {expires:-1} stripped

  // 2. Block MCA's anti-automation route patterns:
  await page.context().route('**/clientlib-devtool*.js*', r => r.abort());
  await page.context().route('**/devtool*.js*', r => r.abort());
  await page.context().route('**/clientlibs-restrinewtab*.js*', r => r.abort());
  await page.context().route('**/clientlib-restrinewtab*.js*', r => r.abort());
  await page.context().route('**/clientlib-loginfilter*.js*', r => r.abort());

  // 3. Restore localStorage entries on the mca.gov.in origin
  await page.evaluate((entries) => {
    for (const e of entries) localStorage.setItem(e.name, e.value);
  }, localStorageEntries);
}
```

Then navigate to the AOC-4 form: `https://www.mca.gov.in/content/mca/global/en/mca/e-filing/annual-filings/form-aoc4.html`. Wait for `window.guideBridge?.isConnected?.()` and `typeof window.encrypt === 'function'`.

Verification (no secrets in output):

```js
const r = await fetch('/bin/mca/loggedInUserDetailsBasic', { credentials: 'include' });
const parsed = JSON.parse(window.decrypt(decodeURIComponent(await r.text())));
return { resCode: parsed.resCode, isAuth: parsed.resCode === '200', userCategory: parsed.userCategory };
```

## Known regulatory hard-stops

`/bin/commonSaveSubmit` will **not** fire (and the form silently logs `"Error in form"`) when the target CIN's prefill response shows:

- `inc20AFlag === "N"` — INC-20A (Declaration of Commencement) not filed. Both **SCALEVERGE** (`U62090HR2025PTC132910`) and **LAUNCHWISE** (`U69100KA2023PTC177694`) are stuck here as of 2026-05-01.
- `inc24Flag` is `"C"` or `"P"` — INC-24 rectification pending.
- `managementDisputeFlag === "Y"` — disputed signatories.
- `vanishFlag === "Y"` — company struck off register list.

Probe before attempting any saves (uses `inc12-withoutassociation` — works unauthenticated):

```js
const form = new FormData();
form.append('data', window.encrypt(JSON.stringify({ CIN })));
form.append('endpointID', 'inc12-withoutassociation');
form.append('csrfToken', window.encrypt(document.querySelector('#csrfToken').value));
form.append('csrfDecode', 'false');
const r = await fetch('/bin/commongetapi', { method: 'POST', credentials: 'include', body: form });
const ci = JSON.parse(JSON.parse(await r.text()).resStr).data[0].companyInfo;
return { inc20AFlag: ci.inc20AFlag, inc24Flag: ci.inc24Flag, managementDisputeFlag: ci.managementDisputeFlag };
```

If `inc20AFlag !== "Y"`, abort the run — saving will fail silently regardless of user authorization.

## Authorization gate (separate from regulatory)

`afData.afUnboundData.data.allowSubmission` must be `"Y"` before save will fire. It's set by the form during prefill based on the user's relationship to the CIN. Overriding it client-side via `setProperty` does not help — the deeper validator (which is what logs `"Error in form"`) still fails.

For Professional users, MCA expects a board-resolution registration linking the user to the CIN. There is no purely-client bypass.

## What's been validated end-to-end (as of 2026-05-01)

| Layer | Status |
|---|---|
| Cookie injection from `storage-state.json` into Playwright MCP | ✅ |
| Form load + bridge ready (with route blockers) | ✅ |
| Public company-info read (`inc12-withoutassociation`) | ✅ |
| Director master lookup (`mgt7getDinDetails`) | ✅ |
| `prefillWithCin` populates 60+ company fields | ✅ |
| 13 panel1 fields written via `setProperty` | ✅ |
| Signatory table populate + trim (`removeInstance(i)` back-to-front) | ✅ |
| Validation pipeline (DOM errors went 174 → 0 on panel1) | ✅ |
| `commonSaveSubmit` XHR fires | ❌ — blocked by `inc20AFlag: "N"` for both test entities |
| Panels 2–7 fill | ⏸ — pending a saveable test entity |
| DSC handoff | ⏸ — requires hardware token; not automatable |

## Test-entity selection criteria for the next attempt

Pick a CIN where ALL of these are true (verify via the probe above):
- `inc20AFlag === "Y"` (Declaration of Commencement filed)
- `inc24Flag` is `null` (no rectification pending)
- `managementDisputeFlag === "N"`
- `vanishFlag` is `null` or `"N"`
- `companyStatus === "Active"`
- The logged-in account is associated with the CIN as Director, KMP, or Professional with board authorization

Ideally: a company that has filed at least one prior AOC-4. The form auto-populates `signatoryDetails`/`signatory_dir`/`auditorDetails` from that history, saving you the directors-by-DIN lookup chain.

## Files an agent should read before starting

1. `docs/MCA_AUTOMATION_LESSONS.md` — 21 sections of empirically-validated behaviors, including the conditional-field-visibility rule (§18), `saveAndAdvance` contract (§19), authorization wall (§20).
2. `docs/MCA_PREFILL_API_RESPONSES.md` — full request/response shapes for every endpoint we've triggered.
3. `docs/MCA_PRODUCTION_READINESS.md` — gap analysis and prioritized next steps.
4. `src/aoc4/bridge.ts` — `setFieldBySom`, `setFieldsBatch`, `saveAndAdvance`, `runFormValidation`.
5. `src/aoc4/prefill-client.ts` — direct API wrappers (`fetchCompanyInfoDirect`, `lookupDirectorByDIN`, `lookupCompaniesByDIN`).
6. `src/aoc4/presets/small-pvt.ts` — the small-Pvt scenario fill plan with field-name mappings.

## What NOT to do

- Don't paste cookie values, session IDs, or CSRF tokens into prompts, slack messages, or commit messages.
- Don't `cat` `.env` or `storage-state.json` into the conversation. Read them programmatically and pass only what's needed.
- Don't override `allowSubmission` and proceed — the deeper gate will still fail and you'll waste MCA infrastructure quota.
- Don't click Save without first probing `inc20AFlag` for the target CIN.
- Don't attempt the final DSC submission via automation. The hardware DSC token requires the user's physical presence; the docs in `MCA_PRODUCTION_READINESS.md` cover the legal posture.
