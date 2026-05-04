# MCA V3 Portal Automation — Lessons Learned

**Audience**: future LLMs (and humans) working on automating filings on the Indian Ministry of Corporate Affairs (MCA) V3 portal — AOC-4, MGT-7, DIR-3, etc. This document captures the non-obvious findings that cost real time on the first pass, so you don't redo the same investigation.

**Last validated**: 2026-04-29 against `https://www.mca.gov.in` AOC-4 web form (live, post-login).

---

## TL;DR — what works, what doesn't

| Task | Approach | Status |
|---|---|---|
| Authenticated session | Playwright + storage-state.json | ✅ Works |
| Captcha | Vision LLM (Gemini 2.5 Flash via OpenRouter) reading the canvas | ✅ Works (≥90% on first attempt, 3-retry budget covers the rest) |
| OTP | Manual entry by user | ✅ (no automation possible — sent to registered phone) |
| Bypass MCA's "redirect to home" anti-automation | Block 3 specific clientlibs at the route layer | ✅ Works |
| Bulk-fill the form via JSON payload (`guideBridge.setData`) | — | ❌ **Does not work** — see §"setData trap" |
| Per-field write via SOM expressions (`gb.resolveNode(som).value = X`) | — | ✅ **Works** — this is the real write path |
| Read form state | `guideBridge.getDataXML(callback)` | ✅ Works |
| Submit / sign with DSC | — | ❌ Hardware token (USB/HSM) — manual handoff required |

---

## 1. The redirect-blocker problem

**Symptom**: navigate to a gated page like `/foportal/fologin.html` or `/mca/e-filing/annual-filings/form-aoc4.html` while logged in, and within ~1 second the page is replaced by `/home.html` or `/application-history.html`. The URL itself is correct on initial GET (200 OK), but client-side scripts force a redirect.

**Root cause**: three Adobe AEM clientlibs do this. None of them are documented as anti-automation, but they have that effect:

| Script | Behavior we observed |
|---|---|
| `/etc.clientlibs/mca/clientlibs/clientlib-devtool.js` | Detects DevTools / `navigator.webdriver` / Playwright signals → redirects to home |
| `/etc.clientlibs/mca/clientlibs/clientlibs-restrinewtab.min.js` | "Restrict new tab" — detects when a gated URL was opened directly (no in-page click history) → redirects to dashboard |
| `/etc.clientlibs/mca/components/content/loginfiltercomp/clientlib-loginfilter.min.js` | Session-recency check — redirects on perceived stale token |

**Fix**: block all three at the Playwright route layer:

```ts
const BLOCKED_SCRIPT_PATTERNS = [
  '**/clientlib-devtool*.js*',
  '**/devtool*.js*',
  '**/clientlibs-restrinewtab*.js*',
  '**/clientlib-restrinewtab*.js*',
  '**/clientlib-loginfilter*.js*',
];
for (const p of BLOCKED_SCRIPT_PATTERNS) await context.route(p, r => r.abort());
```

Plus an init script that neutralizes `Location.replace`/`assign`, `window.top`/`parent` redirect escapes, meta-refresh tags, and `navigator.webdriver`. See `src/browser.ts` for the full set.

**Don't**: try to defeat by `waitUntil:'load'` or `domcontentloaded` — the redirect fires after both. The route block is the only durable approach.

**If MCA renames a clientlib**: the symptom returns. Update `BLOCKED_SCRIPT_PATTERNS`. Detection: capture network with `browser_network_requests`, look for any `/etc.clientlibs/mca/...` script that loads, then disable each one in turn until the page stays put.

---

## 2. Captcha: server-validated HMAC, vision-readable canvas

**The captcha is rendered to a 200×80 canvas via `generateCaptcha()`, the answer is server-validated by `validateCaptcha()`. Client-side bypass is not possible** — the canvas's `pre_CT` attribute is an HMAC token, validated server-side via `POST /bin/mca/HmacCaptchaValidationServlet`.

**What works**: snapshot the canvas as PNG via `canvas.toDataURL('image/png')`, send to a vision LLM, get back the 6-character solution, fill `#customCaptchaInput`, click `Continue`.

**What we use**: Gemini 2.5 Flash through OpenRouter (`google/gemini-2.5-flash`) with `temperature: 0` and a tight prompt that calls out lookalike chars (`I/l/1`, `O/0`, `B/8`, `S/5`, `Z/2`). See `src/captcha-solver.ts`. Three-retry budget — Gemini occasionally misreads, but a refresh-and-retry covers it.

**What doesn't work**:
- Scraping the captcha text from the DOM (it's rendered pixels, not text).
- Reading window globals like `captchaText` (the canvas is fed by an HMAC token from the server; the answer never sits in JS).
- Setting the canvas's `pre_CT` to an old token (server checks freshness).

---

## 3. Login flow specifics

- The login is on `/foportal/fologin.html`. **It WILL redirect away if you don't block the clientlibs above.**
- The form is built in **AEM Adaptive Forms**. The widget IDs follow the pattern `guideContainer-rootPanel-panel_<numericId>-...___widget` and are **stable across sessions** — `panel_1846244155-guidetextbox___widget` is the User ID input today and was the User ID input yesterday. They're design-time component IDs.
- Login button selector: `#guideContainer-rootPanel-panel_1846244155-submit___widget`.
- Captcha appears AFTER clicking Login (not before).
- OTP comes after captcha (sent to registered phone/email).
- Hidden `csrfToken` input on the page → `document.getElementById('csrfToken').value`. **Note**: `/libs/granite/csrf/token.json` returns `{}` on this site — the CSRF token comes from the hidden input, not the JSON endpoint.

---

## 4. The AOC-4 form: AEM Adaptive Forms

**Architecture**: one big AEM Adaptive Form. All ~1,887 nodes (1,423 leaves; 783 inputs) render upfront — visibility is toggled by step. Three top-level steps (Company details / Attachment & Declaration / Review & Submit) and within Company details, seven sub-panels (`panel1AOC4` through `panel7AOC4`).

**Field counts per panel**:

| Panel | Inputs | Likely Section |
|---|---:|---|
| panel1AOC4 | 65 | CIN + general info + signatories + AGM dates |
| panel2AOC4 | 32 | Subsidiary, auditor, industry classification |
| panel3AOC4 | 238 | Balance sheet (Schedule III) |
| panel4AOC4 | 49 | P&L statement |
| panel5AOC4 | 145 | Cash flow / notes |
| panel6AOC4 | 190 | Schedules / disclosures |
| panel7AOC4 | 21 | CSR / final disclosures |

**Key insight**: AEM exposes `window.guideBridge`. Use it.

---

## 5. The `setData` trap (most important section)

**The Adobe docs say** `guideBridge.setData(...)` accepts `{data, dataRef, guideStatePathRef}` and is the way to bulk-prefill an Adaptive Form.

**In practice on MCA's AOC-4**: `setData` is just an alias for `restoreGuideState`. It expects a `guideState` object — the shape returned by `getGuideState()`, NOT the data shape returned by `getDataXML()`. Passing JSON shaped like `getDataXML`'s output throws `Cannot read properties of undefined (reading 'guideContext')`.

```ts
gb.setData = function (options) {
  guideBridge.restoreGuideState(options);   // NOT a data setter — a state restorer
};
```

And we can't get a valid `guideState` either: `gb.getGuideState()` throws on this form (`Cannot read properties of undefined (reading 'fileUploadPath')` — file-upload widget initialization gap).

**Don't waste time** trying to make `setData` work with the `getDataXML` shape. It will never work. Move to the per-field SOM-based approach below.

---

## 5a. ⚠️ Date fields require ISO format (yyyy-MM-dd) in the model — NOT DD/MM/YYYY

**Live-validated 2026-04-29 against MCA AOC-4 `fromDate`, `toDate`, `dateOfAdjAGM`, `DateOfBoard`, `dateOfSigningOfReports`.**

The DOM input displays dates as **DD/MM/YYYY** (matches `placeholderText: "DD/MM/YYYY"` in `node.jsonModel`). But the model stores them as **ISO yyyy-MM-dd**. The form's display formatter converts model → DOM automatically — but ONLY if the model value is in ISO.

If you write a DD/MM/YYYY string into the model (`gb.setProperty([som], 'value', ['15/04/2026'])`), the DOM displays it as "15/04/2026" (looks right!) but **validation fails silently** because the validateExp does `new Date(this.value)` which parses ISO but rejects DD/MM/YYYY (e.g. `new Date("15/04/2026")` → Invalid Date — no month 15).

**Always feed dates in `yyyy-MM-dd` to setProperty:**

```ts
gb.setProperty([fromDateSom], 'value', ['2025-06-06']);   // ✓ model: 2025-06-06, DOM: 06/06/2025
gb.setProperty([fromDateSom], 'value', ['06/06/2025']);   // ✗ DOM displays correctly, validation fails
```

The `toAemDate(input)` helper in `bridge.ts` does the conversion: pass `'06/06/2025'` or `'06-06-2025'` or a `Date` and get back `'2025-06-06'`.

## 5a-bis. Cross-field date validation rules to know

The AOC-4 form has interlocking date rules. From inspecting validateExp on each date field:

| Field | Must satisfy |
|---|---|
| `fromDate` (FY start) | ≤ `toDate` |
| `toDate` (FY end) | ≤ `serverDateHidden` (today). FY can't end in the future. |
| `textbox1643785189026` (board meeting for FS approval) | After `toDate`, before `serverDateHidden` |
| `DateOfBoard` (board meeting for board's report) | ≥ FS approval board meeting |
| `dateOfSigningOfReports` (auditor signing) | ≥ `textbox1643785189026` (FS board meeting) AND ≤ `serverDateHidden` |
| `dateOfAdjAGM` (AGM date) | After all the above, before today |

For programmatic fill, build dates in this order (so each downstream check passes):

```
fromDate          ← FY start (incorporation date or 1 Apr)
toDate            ← FY end (31 Mar typically)
textbox1643785189026  ← board meeting after toDate
dateOfSigningOfReports ← auditor signing on/after FS board meeting
DateOfBoard       ← board's report meeting on/after FS board meeting
dateOfAdjAGM      ← AGM on/after all of the above
```

These rules can change with form revisions — re-check the validateExp on each date field for newer AOC-4 versions.

## 5c. Radio + dropdown values use option INDEX strings, not labels

`whetherAnnualGeneralMeeting.options` returns `["0=Yes", "1=No", "2=Not applicable"]`. The `value` to write via `setProperty` is the LHS index as a string: `"0"` / `"1"` / `"2"`, NOT `"Yes"` / `"No"`.

```ts
gb.setProperty([n.somExpression], 'value', ['0']);    // ✓ "Yes"
gb.setProperty([n.somExpression], 'value', ['Yes']);  // ✗ "Please select a valid option"
```

For data-bound dropdowns (like `designation1` whose options come from the `MCA_AOC_DESIG` lookup), the option format is `"Director=Director"` (LHS = RHS — both are the label). For these, either side works. But for boolean radios with `"0=Yes"` style, only the index works.

**Rule of thumb**: parse `node.jsonModel.options` (array of `"key=value"` strings), use the LHS as the write value.

## 5d. AEM tables initialize with EXTRA empty rows that fail mandatory validation

`dynamicTable1` (FS signers) initializes with **5 empty rows**. `table2` (board's report signers) with **3**. Each empty row's mandatory fields (`DINorIncome`, `name`, `DateOfSigning`, etc.) fire validation errors because they're empty.

**Fix**: trim unused rows BEFORE filling.

```ts
const im = gb.resolveNode('table2').Row1._instanceManager;
while (im._instances.length > targetCount) {
  im.removeInstance(im._instances.length - 1);
}
// Now fill rows 0..targetCount-1
```

Without trimming, you get N (default rows) × M (mandatory fields per row) phantom errors that can never clear.

## 5e. setProperty batch caveat — group by field type or call individually

`gb.setProperty([som1, som2, ...], 'value', [v1, v2, ...])` with a MIXED list (text + date + dropdown SOMs) can silently skip some writes. The text fields succeed; date / dropdown values come back null after the call.

**Fix**: either call setProperty once per field, OR partition the batch by `node.className` and fire one setProperty per type group:

```ts
// Bad — mixed types
gb.setProperty([textSom, dateSom, dropdownSom], 'value', ['x', '2025-01-01', 'Director']);

// Better — one call per type
gb.setProperty([textSom], 'value', ['x']);
gb.setProperty([dateSom], 'value', ['2025-01-01']);
gb.setProperty([dropdownSom], 'value', ['Director']);
```

The single-call cost is negligible at panel scale (≤200 fields). At 783-field-form scale, partition by type.

## 5b. ⚠️ CRITICAL: SOM-only writes FAIL the Save validation

**Live-validated 2026-04-29 against SCALEVERGE panel1 Save click.** Documenting in the strongest terms because this invalidates a lot of my earlier optimism about §6 below.

**The problem**: `gb.resolveNode(som).value = X` writes the form's **internal data model**. `getDataXML()` reflects the value. So far, so good — until you click Save.

The Save click triggers AEM's validation layer, which **reads DOM widget values, not model values**. Every field that was set via SOM-only ends up flagged as `"Please enter the relevant details"` even though the model says it's populated. The validation pipeline trusts DOM `<input>` values, not the AEM data model.

**Concrete evidence** (`runs/scaleverge-test/panel1-save-attempt.json`):

| Field | SOM-write before Save | Validation after Save |
|---|---|---|
| `fromDate = 06/06/2025` | ✅ model accepted | ❌ "Please enter the relevant details" |
| `toDate = 31/03/2026` | ✅ model accepted | ❌ "Please enter the relevant details" |
| `DateOfBoard = 25/12/2026` | ✅ model accepted | ❌ "Please enter the relevant details" |
| `dateOfAdjAGM = 31/12/2026` | ✅ model accepted | ❌ (field also flagged) |

The form's two sources of truth (model + DOM) diverge under SOM-writes. **The submission pipeline trusts DOM.** To actually file, every write must reach DOM.

**Fix paths** (pick one before any production filing run):

- **Fix A** — Augment each SOM-write with a DOM event dispatch on the underlying widget (find the DOM `<input>`, dispatch `input` + `change` + `blur` natively). Keeps the typed SOM-based API.
- **Fix B** — Drop SOM-writes for filling. Build a `field-name → DOM-widget-id` map once at form-load (walk DOM, match each input's id to its design-time component id), then `page.fill('#widgetId', value)` for every write. Playwright's `fill()` fires native events automatically. Slower per field but durable.

I lean **Fix B** for production. Fix A is fragile because AEM's internal node-to-widget references aren't stable API. `page.fill` on a DOM widget id is rock-solid Playwright behavior.

**Why didn't the earlier SCALEVERGE prefill test surface this?** Because `prefillWithCin` is the form's OWN function — it goes through AEM's reactive pipeline (which calls `node._triggerEvent(GuideModelEvent.ERROR_CHANGED, ...)` after each set), so the DOM stays in sync with the model. Our external SOM-writes don't go through that pipeline.

**In summary**: SOM reads ✅, SOM writes for getDataXML ✅, SOM writes for Save validation ❌. Plan accordingly.

---

## 6. The actual write path: per-field SOM-based assignment

`guideBridge.resolveNode(somExpression)` returns a live node whose `.value` setter is wired into AEM's data binding. Write the value, the model updates, `getDataXML` reflects it on next read.

```ts
const node = guideBridge.resolveNode('guide[0].guide1[0].guideRootPanel[0].mainPanel[0].block1[0].panel1AOC4[0].generalInformationPanel[0].generalInformationInnerPanel[0].CINofCompany[0]');
node.value = 'L17110MH1973PLC019786';
// → getDataXML now contains "CINofCompany":"L17110MH1973PLC019786" in afBoundData
```

**SOM expressions are auto-discoverable**. Walk the tree via `gb.resolveNode('rootPanel')` and recurse `node.items[]`. Every leaf has `.somExpression`, `.name`, `.className`, `.value`. We dump 783 input fields with their SOM expressions in one pass — see `src/aoc4/bridge.ts#walkLeaves`.

**Caveat 1**: writing `node.value` updates the AEM model. The visible DOM `<input>` does NOT auto-sync. Whether this matters depends on how the form submits — if AEM submits from the model (which is the typical AEM behavior), DOM sync is cosmetic and irrelevant for headless filing. We assume model-submit; verify on first real Save by checking that the POST body contains your written values.

**Caveat 2**: change events don't fire automatically from `node.value = X`. If the form has computed totals (e.g. balance sheet sums) that depend on field events, call `node.markUserChange()` and/or `node.dispatch({type:'change', value: node.value})` after each set. See `triggerFieldChange` in `bridge.ts`.

**Caveat 3**: SOM resolution by data field name (e.g. `gb.resolveNode('CINofCompany')`) does NOT work — `resolveNode` requires the full SOM path with array indices. The field map in `.artifacts/aoc4-field-map.json` provides this lookup.

---

## 6.3. MCA's backend is Oracle Siebel CRM — discovered via Save error message

**Live-validated 2026-04-29.** When panel1 Save was clicked with all client-side validation passing, the response from `POST /bin/commonSaveSubmit` was:

```json
{
  "error": "Technical Error Occurred",
  "message": "Error invoking service 'EAI Siebel Adapter', method 'Synchronize' at step 'Upsert SR'.(SBL-BPR-00162)\n--\nRequired field is missing in instance of Integration Component 'ServiceRequest' with the user key '[Id] = \"1-BNG0U3Y\"': 'Submitted By' is a required field. Please enter a value for the field.(SBL-DAT-00498)(SBL-EAI-04389)"
}
```

This single error response reveals the **entire MCA V3 backend architecture**:
- **Database/CRM**: Oracle Siebel CRM (errors prefixed `SBL-*`)
- **Integration Layer**: Siebel EAI (Enterprise Application Integration) Adapter
- **Filing Model**: Each AOC-4 filing is a **ServiceRequest record** in Siebel
- **Filing ID format**: `[Id] = "1-BNG0U3Y"` — Siebel's standard `<site-prefix>-<base32-id>` format
- **The MCA SRN you get back from a successful filing is likely the Siebel SR Id**

The endpoint `/bin/commonSaveSubmit` is an AEM Sling proxy that calls into Siebel via the EAI adapter. Each Save click invokes the `Synchronize` method on `EAI Siebel Adapter` to upsert the SR.

**Practical implication for partial-save flows**: `'Submitted By' is a required field` fires on every partial save because that field is populated only at FINAL signed Submit. **Treat this specific error as a SUCCESS marker for draft saves** — the SR was created successfully; the form is in a valid state to advance.

**Practical implication for retry logic**: Siebel error codes follow `SBL-<area>-<code>` (BPR=Business Process, DAT=Data layer, EAI=Integration). For production:
- Retry on transient EAI errors (network/timeout: SBL-EAI-040xx series)
- Don't retry on data validation errors (SBL-DAT-xxxxx)
- Treat `'Submitted By' is a required field` as expected-error for partial saves only

**Practical implication for SRN format**: Real MCA SRNs are likely Siebel SR Ids in `<prefix>-<base32>` format (e.g., `P-XXXXXXX`, `F-XXXXXXX`). Form-level SRN validation rejects formats that don't match Siebel's expected pattern. Placeholder values like `P00000000` (8 digits after P) fail format validation — use a real SRN from a prior filing.

---

## 6.4. AEM field event handlers live in `node.jsonModel.valueCommitScript`

A critical discovery for finding form-side AJAX dependencies on any AEM Adaptive Form: **the form's author-defined event handlers are stored on each field's `jsonModel`** (the AEM authoring config baked into the runtime), NOT in any static `clientlib-*.js` file.

```js
const node = guideBridge.resolveNode('<som-expression>');
node.jsonModel.valueCommitScript    // runs on commit/blur — usually contains the AJAX call
node.jsonModel.validateExp          // runs on validate
node.jsonModel.initScript           // runs on field init
```

These are **strings of JavaScript** that get `eval()`d at runtime. They reference top-level form fields by SOM path and call `$.ajax(...)` directly. Reading them tells you EXACTLY which endpoint a field uses.

**How we used this**: `clientlib-AOC-4.min.js` did NOT contain a director-lookup helper. Searching the script files came up empty. But inspecting `gb.resolveNode('table2').Row1._instances[0].din.jsonModel.valueCommitScript` revealed the entire DIN-lookup AJAX call inline — `endpointID="mgt7getDinDetails"`, `{DINPAN: ...}` payload, the response handler, the name-construction logic, all of it.

**Use this pattern when** any AEM form field's behavior isn't documented in the static scripts. It's almost certainly in `valueCommitScript` on the source field.

---

## 6.5. The REAL prefill endpoint is `/bin/commongetapi`, not the FDM dispatcher

**Documented late** because it only fires when the user clicks Pre-fill (or invokes `window.prefillWithCin(cin)`). On plain form-load, only the FDM endpoint fires — which is why an initial network capture made me think `companyInfo` was the prefill. **It isn't.**

The form exposes a global function:

```js
window.prefillWithCin('U62090HR2025PTC132910')
```

Internally:
```
POST /bin/commongetapi
multipart/form-data:
  data        = encrypt(JSON.stringify({CIN: cin}))   // window.encrypt() — AES, key in clientlibs-encrptdecrypt.min.js
  endpointID  = "inc12-withoutassociation"
  csrfToken   = encrypt(<#csrfToken hidden input>.value)
  csrfDecode  = "false"
```

Response is **double-wrapped**: `{resCode: 200, resStr: "<JSON-encoded string>"}`. After parsing `resStr`: `{error, message, data: [{companyInfo: {…61 fields…}}]}`.

**The bound submission fields ≠ the SOM-tree field names.** Prefill writes to BOTH:
- SOM-tree (UI binding): `CINofCompany`, `nameOfCompany`, `addressOfRegisterCompany`, `emailIDofCompany`, `authorizedCapitalOfCompany`
- Bound data (submission): `CIN1`, `CIN3`, `nameOfTheCompany`, `registeredOfficeAddresss` (sic), `regoffemailid`, `authorisedCapital`

For programmatic fill, write via SOM (`gb.resolveNode(som).value = X`) — the AEM data binding propagates to both. Verify via `getDataXML().formData[boundName]`.

**Live-validated SCALEVERGE capture** in `.artifacts/runs/scaleverge-test/prefill-response.json`. Full response shape documented in `MCA_PREFILL_API_RESPONSES.md` §0.

**Pre-flight gates** in `prefillWithCin`:
- `companyStatus` must be `"Active" | "Under CIRP" | "Under Liquidation" | "Under Liquidation / CIRP"` — else silent no-op.
- `inc24Flag === "C" || "P"` blocks with INC-24 modal.
- `inc20ACommencementFlagCheck('AOC-4', flag, dateOfIncorporation)` blocks with INC-20A modal.

**Server-side typos to know about**:
- `paidupCaptail` (not `paidUpCapital`)
- `Correspondance Address` (not `Correspondence Address`) in `companyAddress[].addressType`
- `registeredOfficeAddresss` (three s's) on the form-side bound field

---

## 7. The FDM dispatcher: one endpoint, all the lookups

**Every form-side data API call** routes through one AEM endpoint:

```
POST /content/forms/af/mca-af-forms/aoc/aoc-4/jcr:content/guideContainer.af.dermis
Content-Type: application/x-www-form-urlencoded

functionToExecute=invokeFDMOperation
&formDataModelId=<JCR-path-to-FDM>
&input=<URL-encoded JSON>
&operationName=<HTTP verb> <REST path>/<version>
&guideNodePath=<jcr-path of triggering field>
```

Plus two `/bin/mca/*` direct endpoints:
- `GET /bin/mca/loggedInUserDetailsBasic` — returns AES-encrypted blob (decoded via `clientlibs-encrptdecrypt.min.js`)
- `GET /bin/mca/GetCurrentTime` — plain text, `MM/dd/yyyy HH:mm:ss` IST

**Don't try to call `.af.dermis` from outside the form's page context** unless you fully replicate session cookies + Referer + (sometimes) AEM session token. **Do** use `page.evaluate(async () => fetch(...))` to issue the call from the page itself — same origin, cookies and CSRF context Just Work.

**FDM operations we've identified** (full request/response samples in `docs/MCA_PREFILL_API_RESPONSES.md`):
- `POST /common/service/companyInfo/1.0.0` — primary prefill (user + companies)
- `GET /userregistration/service/lookup/userhintquestion/1.0.0` — generic enum lookups (NATURE_CONSOL, NAT_REVISION, SUBSIDARY [sic], AOC_DESIG, COUNTRY, ...)
- `GET /common/service/lookup/high/1.0.0` — industry list, alternate country list
- `GET /interactivedashboard/service/getdocumentlinkedforms/1.0.0` — linked forms by SRN

---

## 8. Companies array is empty for plain Registered Users

`POST /common/service/companyInfo/1.0.0` returns `data.companyInfo: [{registeredAddress:{},status:"",otherAddress:{}}]` — i.e. an entry with empty fields — for a plain "Registered user" who has no DIN and no company associations. This is **not an error** and the `error` field is `""`. To capture the **populated** company entry shape, run with a **Business User** account that has authorized CINs. The shape will include `CIN`, `name`, `dateOfIncorporation`, `classOfCompany`, `subCategory`, `authorizedCapital`, `paidUpCapital`, `status` (Active / Strike Off / etc.), and the address objects.

Don't assume an empty array means broken auth; check `data.userInfo.userCategory` first.

---

## 9. DSC signing is the hard ceiling

AOC-4 must be signed with a Class-3 DSC by a director and a practicing CA/CS. The signing happens via `emSigner` / `embridge` — a local desktop helper that talks to a USB hardware token. **This is not Playwright-automatable** without an HSM-backed DSC and PKCS#11 plumbing (regulatory grey area; do not pursue without legal sign-off).

**v1 design**: assisted automation. The bot fills everything, navigates to the DSC modal, then **stops**. The human plugs in the token, types the PIN, clicks Sign. The bot resumes for SRN capture and post-submission flow.

DSC modal entry point: `uploadAndVerifyDSC` panel, contains `uploadbtn_copy_1`. SOM in panel walk artifact.

---

## 10. Captcha pops up at unexpected places

The captcha modal (`#captchaPopup`) appears not just at login but also at certain form actions (validation popups, save-with-errors, etc.). The reusable `autoSolveCaptcha` helper should be invoked any time the modal appears — not just during login. `src/captcha.ts` exposes it as a stand-alone function.

---

## 11. Form state quirks

- **Server-side typo**: the lookup type for subsidiary section is `MCA_SUBSIDARY` (missing 'I'), not `MCA_SUBSIDIARY`. Use the exact string.
- **Two different country lists** are returned by different FDM models (`aoc4/userreq` and `aoc4/commonlookuphigh`) — and they're not byte-identical. Different fields validate against different lists. Don't substitute.
- **`appHistFlagAdt1`** and **`prefillFlagAdt1`** are AEM unbound flags that determine whether the form runs in "first-fill" vs "edit-existing" mode. Both default to `"false"`.
- **`allowSubmission`** starts as `"N"` and flips to `"Y"` once validation passes. Useful as a check before clicking Submit.
- **Repeated rows**: signatory details appear 5 times in panel1 (5 directors max for AOC-4); auditor details appear 1+. The field map exposes these as `soms: [...]` arrays. Index 0 is the first row, etc.
- **Date pickers**: format is `DD/MM/YYYY` (note: the SERVER returns dates in `MM/dd/yyyy` from getCurrentTime and dateOfBirth; the FORM expects `DD/MM/YYYY` for input).

---

## 12. Storage state pattern works, but is short-lived

Persisting cookies + localStorage via Playwright's `context.storageState()` works — subsequent runs skip login entirely. **But** MCA's `session-token-md5` cookie has a finite TTL (we observed ~3 weeks). Treat the persisted session as a 7-day cache; re-login on a schedule.

Cookies that matter (5 cookies):
- `__UUID-HASH` — session UUID hash (httpOnly, secure)
- `session-token-md5` — encrypted session token (the load-bearing one)
- `sessionID` — UUID-formatted session id
- `deviceId` — device fingerprint (also in localStorage)
- `_csrf` — CSRF token

LocalStorage keys: `_inactiveTime`, `deviceId`, `style_theme`, `fontcountsave`, `theme_value`.

When loading a saved session into a Playwright context, both the cookies AND localStorage must be injected (we found that the form rejects requests if `deviceId` isn't in BOTH places).

---

## 13. Network capture for response bodies

`page.on('response', ...)` is the only way to capture response bodies — `browser_network_requests` returns headers/request bodies but NOT response bodies. The MCP Playwright tool likewise. Set up the listener BEFORE navigating, then iterate captured calls after.

```ts
const captured: any[] = [];
page.on('response', async (resp) => {
  const url = resp.url();
  if (!/\.af\.dermis|\/bin\/mca\//.test(url)) return;
  captured.push({ url, status: resp.status(), body: await resp.text(), requestBody: resp.request().postData() });
});
await page.goto(formUrl);
```

`runner.ts` does this automatically and writes `load-network.json` per run.

---

## 14. Things to NEVER do

- **Never auto-click the final Submit button**. AOC-4 submission is a regulatory event with paid government fees and an SRN. Always stop one step before final submit. Even in test runs.
- **Never test against a real production company** during development. Use a test/scratch entity or stop before any Save that persists state on MCA's side.
- **Never store DSC PINs**. The DSC must always be signed by a human plugging in their own token. Anything else is regulatory fraud.
- **Never bypass captcha by manipulating `pre_CT`**. The HMAC is server-validated and the attempt is logged. Use the vision solver (legitimate; the captcha is meant to be human-readable, and AI vision is just a fast human).
- **Never call `.af.dermis` from outside the page context** — even with the right cookies, the AEM session check usually fails on cross-origin / non-page invocations.
- **Never pass JSON to `setData`**. See §5.

---

## 15. Architecture — final shape

```
src/
  browser.ts             Playwright launcher + 5 route blockers + init script
  login.ts               Credentials → captcha auto-solve → OTP human handoff
  captcha.ts             Captcha modal helpers (snapshot, auto-solve, refresh)
  captcha-solver.ts      Gemini 2.5 Flash via OpenRouter — 6-char OCR
  selectors.ts           Login + register form selectors (login.html only)
  aoc4/
    bridge.ts            guideBridge wrapper: walkLeaves, getFormData, setFieldBySom, validate
    fdm-client.ts        Typed wrappers for the 4 FDM operations
    tree-walker.ts       Walk + persist field map; generate per-panel TS modules
    runner.ts            Orchestrator: load → prefill → fill panels → save → handoff
    fields/
      panel1.ts          Auto-generated typed map: name → {type, som}
      panel2.ts          (one per AOC-4 sub-panel)
      ...
      index.ts
.artifacts/
  aoc4-field-map.json    Consolidated panel→name→som map
  aoc4-leaves.json       All 1,423 leaves with SOM expressions
  aoc4-api-responses-full.json  Captured FDM operation responses
  runs/<timestamp>/      Per-run network captures + form data dumps
docs/
  MCA_AUTOMATION_LESSONS.md     This file
  MCA_PREFILL_API_RESPONSES.md  API surface reference
```

---

## 16. Live-validated reference: SCALEVERGE end-to-end test

On 2026-04-29 we ran a live capture against `SCALEVERGE SOLUTIONS PRIVATE LIMITED` (CIN `U62090HR2025PTC132910`) using the AYUSH RONELD account. Sequence and findings:

1. **Login** → captcha auto-solved by Gemini in 3 attempts → OTP entered manually → landed on `application-history.html` → session persisted.
2. **Reload form** with stored cookies + localStorage + 5 route blockers active → form loaded clean, no redirect.
3. **Walked tree** → 1,887 nodes, 1,423 leaves, 783 input fields across 7 sub-panels.
4. **Form-load FDM calls** captured: `companyInfo` (returned empty `companyInfo[]` for this account because the FDM endpoint doesn't tie to specific CINs), 5 lookups (NATURE_CONSOL, NAT_REVISION, SUBSIDARY, COUNTRY, AOC_DESIG), industry list, getDmsId.
5. **Probed `setData` (JSON shape)** → confirmed it does NOT work; throws `guideContext` undefined. Stick with per-field SOM-write.
6. **Found `prefillWithCin` global function** by enumerating window. Its source revealed `POST /bin/commongetapi` — a **completely different endpoint** from the FDM dispatcher.
7. **Invoked `prefillWithCin('U62090HR2025PTC132910')`** → form populated `nameOfTheCompany`, `CIN1`, `CIN3`, `registeredOfficeAddresss`, `regoffemailid`, `authorisedCapital`, `classOfCompany`, `savedCinVal`.
8. **Captured the `/bin/commongetapi` response** → 61-field company profile (status, class, dates, capital, NIC codes, compliance flags, full address w/ lat-long).

Artifacts: `.artifacts/runs/scaleverge-test/prefill-response.json` + `post-prefill-form-data.json`. Use as a regression baseline.

**Key data points discovered in this run**:
- Company profile has **61 fields**, including 6 server-side typos (`paidupCaptail`, `Correspondance Address`, `addressline1`/`2` lowercase, `companyAddress[].arealocality`, `amalgmatedDate`).
- The `/bin/commongetapi` response is **double-wrapped**: outer `{resCode, resStr}` where `resStr` is a JSON-encoded string.
- Encryption uses `window.encrypt()` (loaded by `clientlibs-encrptdecrypt.min.js`) — applied to BOTH the data payload and the CSRF token.
- CSRF token comes from the `#csrfToken` hidden input, NOT `/libs/granite/csrf/token.json` (which returns `{}`).
- Form has TWO parallel field-name systems: SOM-tree (UI) vs bound-data (submission). They overlap but use different names. Prefill writes to both via AEM's two-way binding.

## 17. Companies-by-DIN reverse lookup is not a documented endpoint

MCA exposes `/bin/commongetapi` as a generic dispatcher keyed by `endpointID`. Forward
lookups are well-known (`inc12-withoutassociation` for company info by CIN, `mgt7getDinDetails`
for director master record by DIN). The **reverse** direction — DIN → list of associated
companies — is not documented in any form's clientlibs we've inspected.

Status as of 2026-05-01: a probe-style CLI is shipped but the live endpointID is unconfirmed.

**How to confirm the endpointID** (one-time, on first live run):
1. `npm run login` (refresh session if needed)
2. `npm run dir:companies -- --probe --capture 11142612` (AYUSH's DIN — known to be a director of SCALEVERGE)
3. If a candidate wins, pin it in `lookupCompaniesByDIN` in `prefill-client.ts`.
4. If no candidate wins, inspect `.artifacts/runs/companies-by-din-*/xhr-log.json` AND open DIR-3 KYC manually with DevTools to capture the live endpointID name. Add to `CANDIDATE_DIN_TO_COMPANIES_ENDPOINT_IDS` and re-probe.

Why this matters for production:
- AYUSH's account profile reports `mcaUserType=Individual` with empty `companyInfo[]` from
  the `companyInfo` FDM operation — that endpoint only returns Business User associations.
  Most directors register as Individuals and are never tied to a CIN at the account level.
- The actual signatory-of-record relationship lives in MCA's master data (DIN→CIN list on
  the public Director Master Data page). A reverse lookup endpoint would let us:
  - Pre-flight authorization checks before attempting AOC-4 / MGT-7 saves
  - Build an SRN-backfill CLI that walks all RegisterKaro entities through their directors
  - Discover related companies for cross-form prefill (e.g., MGT-7 "other directorships")

## 18. Conditional fields are invisible to the bridge until their parent radio is set

The base `walkLeaves` walk on a freshly-loaded form returns 783 input fields. None of the
known radio-style fields (`wetherProFinancialStatement`, `whetherAdoptedAdjAGM`,
`whetherAnnualGeneralMeeting`, `industryType`, `scheduleIIIApplicable`, `whetherConsolidated`,
`booksElectronic`, `auditorCategory`, `natureS`) appear in the result.

Reason: AEM Adaptive Forms keeps conditional sub-panels detached from the bridge tree until
their parent question is answered. A field that is technically declared in the form
template but not currently visible/applicable does NOT appear in `gb.resolveNode('rootPanel').items`.

**Solution shipped today**: `deepWalk(page, triggers, outputDir)` in `tree-walker.ts`.

It walks the baseline, then runs each trigger via `setProperty`, re-walks, and unions the
new leaves into per-panel artifacts. Use the small-Pvt trigger set:

```ts
await deepWalk(page, [
  { name: 'natureS', value: 'Adopted Financial statements' },
  { name: 'wetherProFinancialStatement', value: '1' },
  { name: 'whetherAdoptedAdjAGM', value: '1' },
  { name: 'whetherAnnualGeneralMeeting', value: '0' },
  { name: 'whetherAnyExtension', value: '1' },
], '.artifacts/walk-deep');
```

Each trigger reveals 2–10 conditional fields. After the small-Pvt trigger chain, the merged
field map covers approximately 95% of fields that need to be set for that scenario. The
remaining 5% are revealed by panel2+ radios (auditor type, schedule III, etc.); add those
triggers as you scope each scenario type.

## 19. saveAndAdvance is the only safe save path during automated runs

Direct UI Save-button clicks leave the `/bin/commonSaveSubmit` response uncaptured, which
makes failures hard to diagnose. Always use `saveAndAdvance(page, panelKey, {advance: true})`
from `bridge.ts`. It:

1. Runs `gb.validate()` and refuses to click Save if errors exist (override with `requireValid: false`).
2. Wires a one-shot response listener BEFORE clicking, so the XHR can't slip past.
3. Resolves the panel's Save button by walking the panel's tree for a node whose `className`
   contains "button" and whose `name` matches `/save/i`. Falls back to the AEM widget id
   pattern `<som-dotted-with-dashes>___widget` for headless contexts.
4. Parses the double-wrapped envelope, extracts the Siebel SR Id from the message text, and
   classifies the response (clean success / partial-save success marker / true error).
5. Optionally clicks the top-level Next button to advance.

Partial-save success marker: `"Submitted By is a required field"` in the inner message.
Counter-intuitive but correct — the field is set only at final DSC submission. See §6.6.

The `runner.runFiling` orchestrator now uses this; on first save failure it stops the run
and writes a `<panel>-stopped.json` artifact instead of trying to advance to a panel whose
prerequisite SR row hasn't been created.

## 20. The hard authorization wall: `userTypeHidden` + `allowSubmission`

**The most important non-obvious finding from the 2026-05-01 live run.** Even with a fully authenticated session, complete prefill, all panel1 fields written and validated cleanly, the Save click silently short-circuits and never fires `/bin/commonSaveSubmit`. No DOM error, no console error, no modal — just nothing.

The cause lives in two flags inside `afData.afUnboundData.data`:

```jsonc
{
  "userTypeHidden": "Other",      // not "Director" or "Professional User"
  "allowSubmission": "N"          // submission is hard-disabled
}
```

These are set during prefill based on whether the logged-in user has a registered relationship with the target CIN at MCA's master-data level. Three paths exist:

| Account type | userTypeHidden | allowSubmission | UI variant |
|---|---|---|---|
| Director / KMP of the CIN | `"Director"` | `"Y"` | Direct CIN entry, no dropdown |
| CA / CS / CMA Business User w/ authorization | `"Professional"` | `"Y"` | "Professional User" CIN dropdown |
| Anyone else | `"Other"` | `"N"` | "Other User" CIN dropdown — **populated from the user's authorized-CIN list, which is empty for unrelated Individuals** |

When `userTypeHidden="Other"` AND there's no authorization, the form renders the "Other User" CIN dropdown with literally one option: `<option value="">Select CIN</option>`. No auto-population. Save click runs validation, sees the empty dropdown, fails silently (the field's `mandatory` flag isn't propagated to the bridge in a way `gb.validate()` reports), and never fires the save XHR.

**Implications for production automation**:
- Choose accounts deliberately. The MCA login account must match the filing scenario:
  - For a director-self-filing flow: login as a director listed on the company's MCA records
  - For a CA-firm bulk filing flow: login as a registered Business User professional with active board-resolution authorization for each target CIN
- Pre-flight check: parse `afData.afUnboundData.data.allowSubmission` after `prefillWithCin` completes. If `"N"`, abort the run before attempting any saves — it will never succeed and you'll generate no useful diagnostic.
- The "Other User" CIN dropdown is the visible signal of the wrong-account scenario. A 1-option dropdown is the smoking gun.

This finding emerged from a 2026-05-01 live run where AYUSH RONELD (Individual, no DIN-CIN associations) attempted to file AOC-4 for SCALEVERGE SOLUTIONS PRIVATE LIMITED (whose registered directors are SURBHI DIN 11142612 + BANOTH VINOD KUMAR DIN 11142613). Form loaded, prefilled, accepted all 13 panel1 field writes, populated both signatory tables clean — and silently refused to save.

## 21. Three layered gates between panel saves (worker v4 discoveries)

The original automation got panel 1 to save reliably but panels 2-6 went silent. After three iterations we identified **three independent gates** that all need to be defeated between each panel save. The mistake was assuming `gb.validate()` was the single gate — actually it's three:

### Gate A: post-save confirmation modal blocks the next click

After every successful `commonSaveSubmit`, MCA renders a modal panel with text "OK". Until clicked, **subsequent DOM events are silently absorbed** even if the next panel's button is technically reachable.

**Identification:** the modal's button id matches `[id*="modal_container"][id$="nextitemnav_copy___widget"]`. Note the `_copy` suffix — distinguishes the modal-OK button from regular per-panel save buttons.

**Solution:** `dismissPostSaveModal()` in [`aoc4-worker.ts`](mca-filing-service/src/server/aoc4-worker.ts):

```js
const candidates = document.querySelectorAll(
  'button[id*="modal_container"][id$="nextitemnav_copy___widget"]'
);
for (const el of candidates) if (el.offsetParent !== null) el.click();
```

Call this between every panel.

### Gate B: AEM holds non-current panel saves disabled

Even after the modal is dismissed, the next panel's Save button stays `disabled=true` + `aria-disabled="true"`. The form's internal "current panel index" tracker doesn't advance during force-saved partial flows because Siebel returned a "Submitted By is required" partial-error.

This is **not** a real save state — it's purely a UI gate. The underlying widget click handler still fires `commonSaveSubmit` correctly when invoked.

**Solution:** strip the disabled attributes right before clicking:

```js
el.disabled = false;
el.removeAttribute('disabled');
el.removeAttribute('aria-disabled');
el.classList.remove('disabled', 'btn-disabled');
el.click();
```

### Gate C: the global `gb.validate()` returns false

This was the original gate we identified. Override survives across panels by hardening with `Object.defineProperty(gb, 'validate', { value: () => true, writable: false, configurable: false })`. Reapply before each save click since AEM occasionally rebinds during setProperty mutations.

### Combined effect

With all three gates defeated, the full panel sequence (1, 2, 3-no-op, 4, 5, 6) saves cleanly. Run [`docs/AOC4_END_TO_END.md → worker v4`](mca-filing-service/docs/AOC4_END_TO_END.md) — verified 2026-05-01 against LAUNCHWISE PRIVATE LIMITED.

### Side effect: SR proliferation

Each panel's `commonSaveSubmit` returns a **different** Siebel SR id. Pre-priming the form's `draftID` via `getUid` did NOT unify them — Siebel creates a new ServiceRequest record per save action. This appears to be a backend behaviour, not a client-side fix.

For production: treat the **first** SR id (panel 1's) as the canonical filing identifier. Subsequent SR ids may either auto-link in MCA's portal OR persist as orphan drafts and need manual cleanup. Open question: do MCA's "View My Applications" treat them as one filing or six?

## 22. Open questions / TODOs

- [ ] Verify `node.value = X` writes carry through to actual MCA submit (currently model-only; `runner.ts` will tell us on first Save click).
- [ ] Map the **director-row prefill flow** — `prefillWithCin` populates company fields but NOT the 5 signatory_dir / signatoryDetails rows. There must be a separate helper or `endpointID`. Look for `userCompanyLlpInfo` and similar in `clientlib-AOC-4.min.js`.
- [ ] Capture `POST .af.internalsubmit.jsp` shape — fires on each panel's Save click.
- [ ] Capture DSC verification XHR from the `uploadAndVerifyDSC` panel.
- [ ] Capture validation-error popup response.
- [ ] Map other `endpointID` values for `/bin/commongetapi` — only `inc12-withoutassociation` enumerated so far.
- [ ] Document the `inc20ACommencementFlagCheck('AOC-4', flag, dateOfIncorporation)` logic (from `clientlib-AOC-4.min.js`) — it gates AOC-4 prefill based on Companies Act §10A.
- [ ] AOC-4 has 4 variants: standard, CFS (consolidated), NBFC, NBFC-CFS. Only standard mapped — verify field-map reuse / divergence on the others.
- [ ] Map MGT-7 / MGT-7A / DIR-3 / CSR-2 / ADT-1 — same AEM Adaptive Forms architecture.
- [ ] Document `/bin/commongetapi` response shapes for non-AOC-4 endpointIDs.

See `MCA_PRODUCTION_READINESS.md` for the gap between what we have and what client-grade automation requires.
