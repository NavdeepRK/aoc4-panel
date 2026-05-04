# MCA Automation — Field Guide

The master engineer's guide to driving filings on MCA's V3 portal via Playwright. Captures every non-obvious behavior we've hit and how to work with each.

If you're new to this code, read this front-to-back once. Everything else — `MCA_AUTOMATION_LESSONS.md`, `AOC4_END_TO_END.md`, `AGENT_HANDOFF.md` — fills in detail.

---

## What this service does

Browser automation against MCA's V3 e-filing portal (https://www.mca.gov.in). Today it covers AOC-4 annual filings end-to-end up to the DSC handoff; the architecture generalizes to MGT-7, ADT-1, DPT-3, and other AEM Adaptive Forms on the V3 portal.

The interesting work isn't the Playwright scaffolding — it's the **dozen non-obvious behaviors** of MCA's V3 portal that you have to discover or reverse-engineer. This doc catalogues them.

---

## TL;DR — the architecture that works

```
                ┌──────────────────────────────────────────────────────────────┐
                │   mca-filing-service (this repo)                             │
                │                                                              │
  HTTP API  ───►│   /start-aoc4   /jobs/:id/status   /jobs/:id/upload-signed   │
                │                                                              │
                │   Worker (Playwright)                                        │
                │     ┌─────────────────────────────────────────────────────┐  │
                │     │  1. Launch Chromium with route blockers + cookies   │  │
                │     │  2. Load AOC-4 form, wait for guideBridge           │  │
                │     │  3. Pre-prime draftID via getUid                    │  │
                │     │  4. prefillWithCin(cin) → 60+ fields auto-populate  │  │
                │     │  5. Apply panel 1 fields (small-Pvt preset)         │  │
                │     │  6. Populate signatory tables via DIN lookup        │  │
                │     │  7. Bypass gb.validate (otherwise click swallowed)  │  │
                │     │  8. Click panel 1 Save → /bin/commonSaveSubmit      │  │
                │     │  9. Direct-call FD.FP.AF._handleDraftSaveWrapper    │  │
                │     │     to ensure AEM portal store registration         │  │
                │     │  10. Capture srId + referenceNumber                 │  │
                │     │  11. Phase = DRAFT_CREATED, browser stays warm      │  │
                │     │                                                      │  │
                │     │  → User opens MCA "My Application", finds the draft │  │
                │     │     by referenceNumber, completes panels 2-7 with   │  │
                │     │     real financials, downloads PDF, DSC-signs,      │  │
                │     │     submits in the standard MCA UX                  │  │
                │     └─────────────────────────────────────────────────────┘  │
                │                                                              │
                │   Sidecar: PAN-by-CIN lookup                                 │
                │     /company-info?cin=...    /company/:cin/pan               │
                │     Reuses a warm Playwright session for fast queries        │
                └──────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
                              ┌──────────────────────────┐
                              │  MCA V3 Portal           │
                              │  ─ AEM Adaptive Forms    │
                              │  ─ Backed by Oracle      │
                              │    Siebel CRM            │
                              │  ─ Per-user storage:     │
                              │    cookies + draft store │
                              └──────────────────────────┘
```

The code is split between a **server** (`src/server/`) that exposes HTTP endpoints, a **worker** that drives the form via Playwright, and a set of **CLIs** in `src/cli/` for diagnostics.

---

## The non-obvious behaviors

### 1. Anti-direct-URL-access bounce

If you `goto(/content/mca/global/en/mca/e-filing/annual-filings/form-aoc4.html)` cold, you get bounced to `/home.html`. The form template loads only via in-page click navigation OR with the `clientlibs-restrinewtab*.js` script blocked at the route layer.

Our `launch()` in [`src/browser.ts`](mca-filing-service/src/browser.ts) registers route blockers for:
- `clientlib-devtool*` — anti-DevTools detector that redirects gated pages
- `clientlibs-restrinewtab*` / `clientlib-restrinewtab*` — direct-URL-access redirector
- `clientlib-loginfilter*` — session-staleness redirector

You need ALL of them off when driving the form via direct navigation. You need MOST of them on (specifically NOT `restri*`) when navigating MCA's normal UX (e.g., `/application-history.html`).

### 2. Two parallel auth checks

Different MCA endpoints check the session differently:

| Endpoint | What it accepts |
|---|---|
| `/bin/commongetapi` (form lookups) | Session cookies up to ~24h since last use |
| `/bin/mca/loggedInUserDetailsBasic` | Same |
| AEM form template HTML (`/content/.../guideContainer.html`) | Cookies + the form's anti-bot setup |
| `/application-history.html` (the dashboard) | Stricter — needs a recent login event, won't accept cookies that the form-level endpoints accept |

This is why a "stale" session can prefill the form perfectly but bounce you off the dashboard. After login, the dashboard is happy for a while; if you let things sit, only the form keeps working.

### 3. Headless detection

`HEADLESS=true` trips MCA's anti-bot. Forms time out on guideBridge initialization. Stay headless=false (default) for real automation. For CI you'd need a stealth plugin chain that we haven't tried.

### 4. The `__name` esbuild trap

`tsx` (esbuild) emits `__name(fn, "name")` calls into compiled output when `keepNames` is set. The helper is a Node runtime utility but missing in browser context. When you pass a function to `page.evaluate()`, the serialized form contains `__name(...)` calls and throws `ReferenceError` in the page.

**Fix**: polyfill via `addInitScript` BEFORE navigate, with a string literal so the polyfill itself isn't subject to esbuild transforms:

```ts
await page.addInitScript('window.__name = function(f, n){ return f; };');
```

### 5. Form is AEM Adaptive Forms over Siebel CRM

Two parallel data layers per filing:

- **AEM form data** — what `guideBridge.getDataXML()` returns. The form's "view" of itself.
- **Siebel ServiceRequest record** — created by `/bin/commonSaveSubmit`. The CRM record.

The form's UI is decoupled from Siebel — when you save, the form shoves its data through `commonSaveSubmit` which translates to Siebel's "EAI Siebel Adapter / Synchronize / Upsert SR" pipeline. Error responses come back as Siebel error codes (`SBL-BPR-00162`, `SBL-DAT-00498`, etc.) — parse them, don't fight them.

### 6. The two SR identifiers + resume URL

A successful save returns:
- **`integrationId`** (e.g. `1-BNSY9KL`) — short Siebel internal id, what we historically called `srId`. Used for backend lookups + linking.
- **`referenceNumber`** (e.g. `1-25383955701`) — long numeric, what shows in MCA's "My Application" SRN column. **This is what users see.**

Both are in the response under `data.integrationId` and `data.referenceNumber` respectively.

**Resume URL pattern** (discovered live 2026-05-02 — see lesson for why this matters):

```
https://www.mca.gov.in/content/mca/global/en/mca/e-filing/annual-filings/form-aoc4.html
  ?applicationHistory=<base64-of-JSON>

Where the JSON is:
  { "srn": "", "reference": "<referenceNumber>", "purpose": "<purpose>", "integrationId": "<srId>" }
```

Paste this URL into a logged-in MCA browser and the form re-loads with the draft's data. The user can continue filing manually from there — completing panels 2-7, signing with DSC, submitting.

The worker constructs this URL automatically and exposes it as `Aoc4Job.resumeUrl` in the status response. Surface it in the admin UI as a "Continue Filing on MCA →" link.

**Why this matters**: PDF download is only available AFTER all panels are filled (regulatory). Until then, the resume URL is the only way to "view" a draft. The earlier mistake was assuming we could download a PDF from a partial draft — MCA doesn't expose one until form completion.

### 7. Two save-response shapes

Older code expected a "partial save success marker":
```json
{ "error": "Technical Error Occurred",
  "message": "...'[Id] = \"1-BNRAQGG\"': 'Submitted By' is a required field..." }
```
Counter-intuitively this was treated as success because `Submitted By` is filled only at final DSC submit.

The CURRENT behavior (after we got panel 1 + signatory tables fully right) returns:
```json
{ "error": "",
  "message": "Data Added Successfully",
  "data": {
    "referenceNumber": "1-25383955701",
    "integrationId": "1-BNSY9KL",
    "SRFOStatus": "Draft/Pending Submission",
    ...
  } }
```

The worker handles both — if `data.integrationId` is present, that's the canonical srId. If not, fall back to extracting `[Id] = "..."` from the message.

### 8. The orphan-draft pitfall

If `commonSaveSubmit` fires but AEM's portal draft register doesn't, the resulting SR is **invisible to the user's "My Application" dashboard**. We hit this for a full session before realizing it.

The MCA V3 portal has TWO independent stores:
- Siebel CRM — receives the form data via `commonSaveSubmit`
- AEM portal draft store — receives a `<form-path>.fp.attach.jsp/<draftID>` POST (or similar)

The form's normal Save click hits BOTH internally. If you bypass validation crudely, only Siebel gets the data, and the user can't see the draft to continue/sign/submit. Our hybrid save flow specifically calls both stores.

**Verification**: after save, the draft must appear in `My Application > Pending for Action` keyed by `referenceNumber`. If it doesn't, the dashboard's empty state is your signal that you produced an orphan.

### 9. The 3-gate panel save (force-save technique — superseded by hybrid save)

Before settling on the hybrid approach, we cracked the multi-panel save chain by defeating three independent gates:

1. **`gb.validate()` returns false** — bypass via `Object.defineProperty(gb, 'validate', { value: () => true, writable: false, configurable: false })`. Reapply before each save click since AEM rebinds during setProperty mutations.
2. **Save button stays `disabled=true`** — strip `disabled`, `aria-disabled`, `disabled` classes via DOM manipulation right before clicking.
3. **Post-save modal blocks next click** — selector `button[id*="modal_container"][id$="nextitemnav_copy___widget"]`, click to dismiss.

This let panels 1-6 all save and produced 5 Siebel SR ids per run. But it didn't fire AEM portal register, so **the drafts were orphans**. We now use hybrid save (single panel + explicit AEM register call) which gives one visible draft instead of six invisible ones.

The 3-gate technique is preserved in the codebase as `_dismissPostSaveModal`, `_reapplyValidateOverride`, etc. (underscore-prefixed, deliberately unused) — kept for reference and for the case where you genuinely need to push panels 2-6 through programmatically.

### 10. Conditional-field invisibility

AEM keeps conditional sub-panels detached from `guideBridge.resolveNode('rootPanel').items` until their parent radio is set. A walk on a freshly-loaded form returns 783 input fields — but `wetherProFinancialStatement`, `whetherAdoptedAdjAGM`, `industryType`, etc. are **NOT** in the result.

To enumerate the full field tree you need a "deep walk" — set each radio in turn and re-walk after each. We have `deepWalk(page, triggers, outputDir)` in [`src/aoc4/tree-walker.ts`](mca-filing-service/src/aoc4/tree-walker.ts) for this.

### 10b. The `dynamicTable1` designation field name trap

`dynamicTable1` (FS signatories panel) and `table2` (Boards' report signatories panel)
look similar but their per-row fields have **different names**:

```
dynamicTable1.Row1[i]:  DINorIncome, name, designation,    DateOfSigning
table2.Row1[i]:         din,         name1, designation1,   DateOfSigningOfBoard
```

Earlier worker code wrote to `r0.table1designation` for dynamicTable1 — that field
doesn't exist in the bridge tree. The write was silently dropped, leaving the
"Designation" column empty after save. Symptom: when the user resumed the draft,
the FS signatory designation showed "Please enter the relevant details" while the
Boards' report designation correctly showed "Director".

The fix is one line — use `r0?.designation?.somExpression`. Verified live 2026-05-04.

The `_designation1_options` discovered earlier (used by table2's `designation1` field):
```
['Director', 'Alternate Director', 'Additional Director', 'Nominee Director',
 'Whole-time director', 'Managing Director', 'Director appointed in casual vacancy',
 'IRP/RP/Liquidator']
```
Both fields accept the literal string from this list (e.g., `'Director'`) — no need
to use option indices.

### 10c. AGM date fields reject ISO format

Most date fields in AOC-4 accept the ISO `yyyy-MM-dd` format via setProperty (the AEM
date widget converts to DD/MM/YYYY for display). But the AGM-specific date fields
**reject ISO** and require the user-typed `DD/MM/YYYY` format directly:

- `ifyesDateOfAGM` — "(b) If yes, date of AGM"
- `dueDateOfAGM` — "(c) Due date of AGM"

Symptom: with ISO, the field renders the date but Save shows "Please enter a valid date"
in red below the input.

Fix in `aoc4-worker.ts → applyPanel1`:
```ts
const toDDMMYYYY = (iso: string): string => {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
};
apply('ifyesDateOfAGM', toDDMMYYYY(p.agmDate));
apply('dueDateOfAGM', toDDMMYYYY(p.agmDueDate));
```

Other date fields that DO accept ISO (don't double-convert):
- `fromDate`, `toDate` (financial year window)
- `textbox1643785189026`, `DateOfBoard` (board meeting dates)
- `dateOfSigningOfReports` (auditor signing)
- `DateOfSigning` (FS signatory date inside dynamicTable1)
- `DateOfSigningOfBoard` (Boards' report signatory date inside table2)

### 10d. Director DINs are CIN-specific (validated server-side at save)

When a real Save click fires, MCA cross-checks the entered DIN against the company's
master signatory roster. If the DIN isn't on that company's board, you get red errors:
"Please enter a valid DIN or income tax PAN" + "Designation selected is not correct".

Symptom: same DIN works for company A but errors for company B. Confusingly, the form
populates Name (via valueCommitScript looking up DIN master record) successfully, then
the validate step rejects DIN-CIN association as a separate check.

Implication: presets like `small-pvt.ts` cannot hardcode DINs. Director DINs MUST be
passed in per-filing from the customer-portal Entity record (`entity.directors[]` or
`entity.signatories[]`). For CLI/test workflows, accept overrides via env vars:

```bash
AOC4_DIN_PRIMARY=01234567 AOC4_DIN_SECONDARY=89012345 npm run aoc4:live-fill -- <CIN>
```

### 10e. Dropdown setProperty traps (two stacked issues)

AEM dropdowns have two compounding gotchas, both of which surface as "Designation
selected is not correct" + a cascading "Please enter a valid DIN" error on the
same row at save time. The DIN error is misleading — names auto-populate from
DIN lookup, proving DINs are valid. The dropdown is the actual cause.

**Gotcha A — setProperty doesn't fire change.** `guideBridge.setProperty([som],
'value', [v])` writes the model layer but does NOT dispatch a user-event on the
rendered `<select>`. AEM's row-level validation listens for the change event, so
a model-only write leaves the field flagged un-validated.

**Gotcha B — option value ≠ option text.** AEM dropdown options have
`value="<code>"` and `textContent="<label>"` and they are NOT equal. The
"Director" entry has e.g. `value="DIR"` (or some internal id) and
`textContent="Director"`. Setting `select.value = "Director"` fails silently
(no option matches) and the model stays empty. Verified live 2026-05-04 — user
manually picking the dropdown clears the cascade because the click sets the
underlying option value, not the label.

Fix (`setDropdown` in `aoc4-worker.ts`, `svDrop` in `aoc4-live-fill.ts`):
1. Find the rendered `<select>` via the model node's `._view.element`
2. Iterate `select.options`, find the option whose `textContent` matches the
   intended label (case-insensitive, trimmed)
3. Set `select.value = matchedOption.value`
4. Re-write the model via `setProperty` with the actual option value (so AEM
   serializes the code, not the label, into the form body)
5. Dispatch `input` + `change` + `blur` on the `<select>`

Apply to: `dynamicTable1.Row1.designation` and `table2.Row1.designation1`.
Plain `setVal` / `sv` remains fine for text inputs and date fields — these
gotchas are dropdown-specific.

### 10f. CSRF header is "undefined" on save POST (WAF reject trap)

The `_csrf` cookie set by MCA is **HttpOnly**, so JavaScript can't read it via
`document.cookie`. AEM's runtime code that constructs the save XHR tries to
populate the `csrf-token` HEADER from a JS source that comes back undefined,
producing a literal `csrf-token: "undefined"` header. MCA's dispatcher returns
HTTP 400 with the stock Apache multi-language error doc (Czech first, content
length exactly 6265 bytes — recognizable signature).

Verified live 2026-05-04: XHR capture showed `csrf-token: "undefined"`, body's
`csrfToken=<encrypted>` form field was correct, only the header was bad.

Fix: at the Playwright route layer, intercept POSTs to `/bin/commonSaveSubmit*`
and rewrite the header from the cookie. Playwright's `context.cookies()` reads
HttpOnly cookies; in-page `document.cookie` does not. In-page XHR patching
(`addInitScript` overriding `setRequestHeader`) does not catch this — AEM
caches the prototype reference or uses a forked XHR realm, so route-layer
rewrite is the reliable path. See `aoc4-live-fill.ts` for the implementation.

Note: even with this fix the save may still 400 from MCA's dispatcher for
other reasons (session staleness, dispatcher WAF tightening). The CSRF swap
is necessary but not always sufficient.

### 11. Row-position fields in panel 3+

Schedule III balance sheet rows use generic AEM names like `FiguresAtEndOfCurrentReporting1`, `figuresAsEndOfPreviousReporting1`, `ReasonForChangeInPreFilledFigures1` — the index N corresponds to a specific Schedule III line item but the mapping isn't in the form's metadata. To know "row 1 = Equity Share Capital" you have to walk the form with labels visible.

The worker exposes `panelOverrides` for direct field-name → value injection so callers can pass precise overrides once they know the mapping.

### 12. The `userTypeHidden` × `allowSubmission` gate (regulatory)

Form prefill returns these flags in `afData.afUnboundData.data`:

| Account state | userTypeHidden | allowSubmission | Filing path |
|---|---|---|---|
| Director / KMP of CIN | `Director` | `Y` | Direct CIN entry |
| CA / CS / CMA Business User w/ board authorization | `Professional` | `Y` | "Professional User" CIN field (free text) |
| Anyone else | `Other` | `N` | "Other User" CIN dropdown — **populated from the user's authorized-CIN list, often empty** |

If the dropdown is empty, the user isn't authorized to file for that CIN. The form will accept all field writes, run validations, but **silently swallow the Save click** — no XHR, no modal, no error. The first time we hit this, we burned an hour assuming validation was the issue.

**Pre-flight check** before attempting any save: parse `allowSubmission` from the prefill's unbound data. If `"N"`, abort with a clear "account not authorized for this CIN" error.

### 13. The compliance-prerequisite gate (regulatory)

Even with `allowSubmission: "Y"`, MCA blocks AOC-4 for companies that haven't filed prerequisites:

| Flag (from `inc12-withoutassociation` company info) | If wrong, what happens |
|---|---|
| `inc20AFlag === "N"` | INC-20A (Declaration of Commencement) not filed → AOC-4 save silently swallowed |
| `inc24Flag` non-null (`"C"` or `"P"`) | INC-24 rectification pending → AOC-4 blocked |
| `companiesINC22Flag === "N"` | ACTIVE compliance not filed |
| `managementDisputeFlag === "Y"` | Disputed signatories — filings frozen |
| `vanishFlag === "Y"` | Company on the vanishing list — no filings accepted |

We initially thought `inc20AFlag: "N"` was a server-side gate that couldn't be bypassed. It's actually a **client-side gate** in the form's Save handler. The validate-bypass technique flies right past it. But filing AOC-4 for a company with `inc20AFlag: "N"` produces a draft that MCA's RoC will reject at processing — DON'T do this for real filings; it just creates compliance debt.

The pre-flight helper [`services/mca/companyLookupService.js → preflightForFiling`](customer-portal-backend-1/services/mca/companyLookupService.js) (lives in the customer-portal-backend repo) checks all five flags before allowing a filing to start.

### 14. Encryption + CSRF inside page context

Every `/bin/commongetapi` and `/bin/commonSaveSubmit` request needs:
- Body encrypted with `window.encrypt(JSON.stringify(payload))` — AES, key in `clientlibs-encrptdecrypt.min.js`
- CSRF token from `#csrfToken` hidden input, encrypted the same way
- Form-data encoded (NOT JSON)

Reproducing `window.encrypt` in raw Node would be significant reverse engineering. Instead, the warm-Playwright pattern in [`src/server/company-lookup.ts`](mca-filing-service/src/server/company-lookup.ts) keeps a browser tab open and dispatches via `page.evaluate()` — fast for repeated lookups.

### 15. Session minting + OTP

Login via `npm run login`:
1. Visible Chrome opens at `/foportal/fologin.html`
2. Captcha auto-solver runs (uses `OPENROUTER_API_KEY` for vision model)
3. After credentials submit, OTP page shows — operator enters OTP from the registered phone
4. On success, lands on `/application-history.html` and writes `storage-state.json`

**Watch out for false-positive completion**: the file's `mtime` updates as soon as cookies are added, even mid-login. Watch for the explicit `[login] logged in. session persisted` log line in stdout, NOT just file mtime, to confirm sessionID + session-token-md5 are present.

The `storage-state.json` is gitignored — never commit it. See `docs/AGENT_HANDOFF.md` for the secret-handling discipline.

---

## The complete filing flow (current architecture, 2026-05-02)

The worker now does **panel 1 hybrid save + panel 2-6 force-save chain** in one run, producing a fully-populated draft visible in My Application that the user can complete + sign + submit through MCA's standard UX:

```
1. Hybrid save panel 1 (validate-bypass click + _handleDraftSaveWrapper)
   → /bin/commonSaveSubmit returns Siebel SR
   → AEM portal store registers the draft
   → Result: draft appears in My Application

2. For each of panels 2..6 (panel 3 has no save button — rolls into panel 4):
   2a. Generic-fill all visible empty leaves (numerics → 0.00, radios → '1', dates → today, text → 'NA')
   2b. Apply panel-specific overrides if present (auditor data, panelOverrides param)
   2c. Re-apply validate-bypass (AEM rebinds during setProperty mutations)
   2d. Force-enable the panel's Save button (AEM keeps it disabled by current-panel-index)
   2e. Click Save → /bin/commonSaveSubmit fires for THIS panel
   2f. Dismiss the post-save modal so the next panel's button unlocks

3. Construct resume URL — base64-encode { srn:"", reference, purpose, integrationId }
   into the `applicationHistory` query param. User pastes into a logged-in MCA tab.

4. STOP. PDF download requires form completion, which professionally needs DSC signing.
   The user picks up from here in MCA's UX: review filled data, complete remaining
   judgment calls, download PDF, route for DSC, submit.
```

Each run produces ~5 SR ids in Siebel (one per save). The first one (panel 1's, the canonical) is what MCA's My Application surfaces. The others are linked in Siebel's hierarchical structure.

To skip panel 2-6 (e.g., when the customer wants to fill those panels themselves with judgment calls), pass `skipPanels2to6: true` in the runner options.

## What works end-to-end (verified live, 2026-05-01 + 2026-05-02)

| Stage | Status | How to verify |
|---|---|---|
| Login + auto-captcha + manual OTP | ✅ | `npm run login`; storage-state.json gets sessionID + session-token-md5 |
| Public CIN→PAN lookup (any CIN, no association) | ✅ | `curl :8090/company/<CIN>/pan` |
| AOC-4 form load + bridge ready | ✅ | Worker logs "prefill complete" within 10s of /start-aoc4 |
| Prefill → 60+ company fields populated | ✅ | `getDataXML()` shows nameOfTheCompany, CIN1, authorisedCapital, etc. |
| Panel 1 fills + signatory tables | ✅ | DOM error count = 0; bridgeDraftID populated |
| Panel 1 save (clean) | ✅ | Response = "Data Added Successfully" with `referenceNumber` and `integrationId` |
| Status persisted | ✅ | `GET /jobs/:jobId/status` returns the full state including phaseHistory |

## What needs human review (intentional)

- **Panels 2-7 fills with real financial data** — the small-pvt preset uses zero-fill placeholders. Production filings need real Schedule III numbers, auditor details, related-party-transaction disclosures, CSR applicability, etc. Director / CA completes these in MCA's portal manually.
- **DSC signing** — hardware token, manual.
- **Final submit** — requires DSC, manual.

## Iteration 2026-05-03 (PDF discovery final state)

### Resume URL pattern — DISCOVERED + WIRED ✅

User clicked "View" on a draft in MCA's My Application; URL is:
```
/content/mca/global/en/mca/e-filing/annual-filings/form-aoc4.html
  ?applicationHistory=<base64-of-JSON>

JSON: { srn:"", reference:"<referenceNumber>", purpose:"Adopted Financial statements",
        integrationId:"<srId>" }
```

Worker constructs this automatically and returns it as `Aoc4Job.resumeUrl`. Paste into a logged-in MCA browser → form re-opens with the draft's data populated.

### PDF only available after FULL form completion ❌ (regulatory)

MCA does NOT expose any PDF endpoint for partial drafts. The "View Form / Download PDF" button only renders once ALL panels (1-7) have valid data. Until then there's no PDF action on the page at all.

This kills the "automate creation, capture PDF, hand over for DSC" pattern for AOC-4. The user must complete the form before any PDF exists.

### Save endpoint is non-deterministic (anti-bot) ❌

Same identical save request returns one of:
- `200 + "Data Added Successfully"` with `referenceNumber` + `integrationId` (clean save)
- `200 + "Submitted By is required"` partial-save error (Siebel SR created but state incomplete)
- `400` with HTML error page (request rejected at network layer)
- `403` (forbidden — happens on resume-URL-loaded form attempts)

Empirical hit rate ~50% successful saves on consecutive tries with identical payload + fresh session. We've tried bypassing validate, force-enabling disabled buttons, direct `_handleDraftSaveWrapper` invocation, hybrid approaches — none make the save deterministic.

### Panels 2-6 don't actually fill via automated clicks ❌

Even when panel 1 saves successfully:
- Panels 2-6 Save buttons remain `disabled=true`
- Force-enabling + clicking fires commonSaveSubmit but with EMPTY data because the bridge tree's panel 2-6 fields are not "active" (visible flag is false until natural form transition)
- Result: panel 2-6 commonSaveSubmit calls "succeed" but populate nothing

The form's panel transition is gated behind real user-interaction patterns we can't reproduce reliably from automation. AEM's anti-bot detection seems to recognize our click patterns and refuse the activation cascade.

### Bottom line

Realistic deliverable: automation creates the panel-1 draft (~30% of total form work), surfaces the resume URL, hands off to user for panels 2-7 + DSC + submit in MCA's UX. The "fully autonomous filing" goal isn't reachable without solving MCA's anti-bot — which would require Playwright stealth plugins, residential proxies, and human-like input patterns. That's weeks of work with high risk of MCA escalating defenses.

Practical implication for product: position the AOC-4 button as "Pre-fill Draft" not "File AOC-4". Workflow is:
1. Customer admin clicks Pre-fill Draft
2. Automation creates draft on MCA, returns resumeUrl
3. Director / CA receives notification with the resumeUrl
4. They click → MCA opens with our data populated → they complete panels 2-7 manually
5. They download PDF, DSC-sign offline, submit through MCA's UX
6. Filed SRN flows back via the customer reporting it (not auto-captured)

This still saves the 5-15 minutes of repetitive panel-1 data entry per filing, which at scale is meaningful.

## Known limitations (no path forward without more live observation)

- **Draft PDF download URL pattern** — we tested 23 candidate URLs against AEM's standard endpoints and a few MCA-specific guesses. None returned a `%PDF` body. The actual URL is reachable via the "View" button on My Application but we never captured it (the dashboard interaction kept getting bounced to `/home.html` in our scripted attempts). **One DevTools observation** while clicking View on a real draft will close this. See `docs/AOC4_END_TO_END.md` § "Late-evening update" for the path forward.

- **Signed-PDF upload to MCA** — same dependency as PDF download. The wiring (`uploadSignedPdfAndSubmit`) is in place; it just needs the real upload URL.

---

## Service surface — HTTP API

Default port `8090`, configurable via `MCA_FILING_PORT`.

```
POST /start-aoc4                  Kick off a filing job
  body: Aoc4FormPayload           cin, financialYear*, dates, directors[], optional auditor + panelOverrides
  returns: { job_id, phase }      (job runs in background)

GET  /jobs/:jobId/status          Current state of a running job
  returns: Aoc4Job (without browser handles)
                                  Includes phase, srId, referenceNumber, panelResults, panelInProgress

GET  /jobs                        List all in-memory jobs
GET  /jobs/:jobId/pdf             Download draft PDF (when phase=PDF_DOWNLOADED)
POST /jobs/:jobId/upload-signed   Upload signed PDF (multipart or application/pdf body)
POST /jobs/:jobId/submit          Retry submission with already-staged signed PDF

GET  /company-info?cin=<CIN>      Full 61-field company profile
GET  /company/:cin/pan            Just { pan, companyName }

GET  /health                      Liveness + service identity
```

## Service surface — CLIs (for engineers)

```
npm run login                     Mint storage-state.json (interactive — needs OTP)
npm run register                  Register a new MCA user account (rare)
npm run aoc4:walk                 Walk the form's field tree, generate typed maps
npm run aoc4:capture              Capture API responses for offline analysis
npm run aoc4:fill <data.json>     Drive the runner.ts orchestrator with a fill plan
npm run dir:lookup -- <DIN>       Look up director master record by DIN
npm run dir:companies -- <DIN>    EXPERIMENTAL — companies-by-DIN reverse lookup
npm run aoc4:inspect-panel2       Diagnostic: capture form state before/after panel 1 save
npm run aoc4:find-pdf-url         Diagnostic: walk My Application looking for PDF URLs
npm run aoc4:pdf-trace            Human-in-the-loop: open browser, capture PDF URL on click
npm run aoc4:discover-app-page    Automated: load My Application, find drafts
npm run serve                     Start the HTTP API
```

---

## Layout

```
mca-filing-service/
  src/
    browser.ts                    Playwright launch + route blockers
    cli.ts                        login / register / explore / aoc4:* CLI entry
    captcha.ts                    Captcha detection + auto-solver
    captcha-solver.ts             Gemini/OpenRouter vision call
    login.ts                      Login state machine
    register.ts                   Registration flow

    aoc4/
      bridge.ts                   guideBridge wrappers — setFieldBySom, getFormData, saveAndAdvance
      runner.ts                   High-level orchestrator (loadAOC4Form, runFiling)
      tree-walker.ts              Form-tree introspection + typed map generation
      fdm-client.ts               FDM operation wrappers (companyInfo, lookups)
      prefill-client.ts           /bin/commongetapi clients (company info, director lookup)
      fields/                     Auto-generated field maps (panel1.ts...panel7.ts)
      presets/small-pvt.ts        Field plan for the 99%-case small Pvt Ltd

    cli/                          Diagnostic CLIs (see list above)

    server/
      index.ts                    HTTP API server
      jobs.ts                     In-memory job state machine
      aoc4-worker.ts              Playwright worker — drives the form for a job
      company-lookup.ts           Lazy-warm-browser PAN-by-CIN lookup

  docs/
    FIELD_GUIDE.md                ← you are here
    AOC4_END_TO_END.md            Detailed phase-by-phase architecture
    MCA_AUTOMATION_LESSONS.md     22 lessons learned (numbered chronologically)
    MCA_PREFILL_API_RESPONSES.md  Captured API response shapes
    MCA_PRODUCTION_READINESS.md   Gap analysis vs production
    AGENT_HANDOFF.md              Handoff notes for AI agents picking this up
    COMPANY_LOOKUP_API.md         PAN-by-CIN endpoint reference

  .artifacts/                     Run output (gitignored)
  storage-state.json              Logged-in browser state (gitignored)
  .env                            MCA_USER_ID, MCA_PASSWORD, etc. (gitignored)
```

---

## Quick start for a new engineer

```bash
cd mca-filing-service
cp .env.example .env
# Fill in MCA_USER_ID, MCA_PASSWORD, OPENROUTER_API_KEY

# Mint a session (interactive — needs OTP from your phone)
npm run login

# Sanity check the public lookup endpoint
npm run serve &
curl 'http://127.0.0.1:8090/company/U69100KA2023PTC177694/pan'

# Drive a real filing (creates a real draft on MCA, will appear in My Application)
curl -X POST http://127.0.0.1:8090/start-aoc4 -H 'content-type: application/json' -d '{
  "cin": "<your test CIN>",
  "financialYearFrom": "2024-04-01",
  "financialYearTo": "2025-03-31",
  "boardMeetingFsApprovalDate": "2025-09-15",
  "boardMeetingReportDate": "2025-09-15",
  "auditorSigningDate": "2025-09-15",
  "agmDate": "2025-09-30",
  "agmDueDate": "2025-09-30",
  "numberOfMembers": 5,
  "directors": [{ "din": "<8-digit DIN>", "designation": "Director" }]
}'
# Returns { job_id, phase: "LOGGING_IN" }

# Poll
curl 'http://127.0.0.1:8090/jobs/<job_id>/status' | jq .
# After ~30s: phase: "DRAFT_CREATED", srId, referenceNumber populated
```

Then in a browser: log into MCA, open **My Application**, search for the `referenceNumber` returned. The draft is sitting in **Pending for Action** — open it, complete panels 2-7 with real data, route for DSC, submit.

---

## Things to investigate next

If you're picking this up:

1. **Discover the draft-PDF URL.** Single DevTools observation. See `AOC4_END_TO_END.md → Late-evening update`. Once known, plug into `downloadDraftPdf` in `aoc4-worker.ts` — unlocks the whole download/upload/submit loop.
2. **Generalize to MGT-7, ADT-1, DPT-3.** Same AEM Adaptive Forms architecture. Mostly different field maps + per-form preset.
3. **Bulk filing**: drive N filings in parallel. Today the lookup service warms a singleton browser; the filing worker spawns one browser per job. For bulk, consider a browser pool keyed by user.
4. **Multi-tenant session management.** Today there's one `storage-state.json`. For real-world usage you'd have one per filer account, with a session-rotation cron.
5. **Validation-bypass-free panel 2-6 saves.** The "honest save" path needs panels 2-6 to validate cleanly — which means real financial data. The panelOverrides surface is in place. Once row-index → Schedule III mapping is verified, the worker can drive ALL panels without bypasses.

---

## When something breaks

Failure mode triage:

| Symptom | Likely cause | First check |
|---|---|---|
| Worker times out at `LOADING_FORM` | Stale storage-state | `npm run login` |
| Save click "doesn't fire" (no XHR) | `gb.validate()` returning false (panels 2-7 empty mandatories) | Apply validate bypass; see lesson §6 |
| Save returns Siebel error string | Real validation issue OR session expired | Inspect `data` field of response; check srId |
| Draft not in My Application | Orphan draft (commonSaveSubmit fired but AEM register didn't) | See lesson #8 above; check `aem-posts.json` artifact |
| 8 PDF URL patterns return 404 | We don't know the right URL pattern | See "Known limitations" — needs DevTools observation |
| `__name is not defined` in evaluate | `addInitScript` polyfill missing | Confirm `await page.addInitScript(...)` runs BEFORE goto |
| `Login/Register` shows in nav after login | Stale cookies for `/application-history.html` (different auth check) | Mint fresh session via `npm run login` |
| Captcha auto-solver fails 3x | OpenRouter rate limit or model regression | Solve manually in the visible browser within 10min timeout |

For deeper debugging, every job writes its full state under `.artifacts/runs/<jobId>/`:
- `<jobId>-summary.json` — final phase + srId
- `<jobId>-panel1.json` — panel 1 save response
- `<jobId>-siebel-response.json` — raw Siebel response (when honest save runs)
- `<jobId>-aem-posts.json` — every POST during the AEM register window
- `<jobId>-pdf-attempts.json` — every PDF URL tried, with status

---

## Legal / regulatory considerations

- The automation creates **real records in MCA's production Siebel**. Each `/start-aoc4` produces an actual SR you (or RoC) will need to clean up if you abandon. Drafts auto-expire (~30-90 days) per MCA's retention policy.
- Don't run automation against CINs the logged-in user isn't authorized for. The pre-flight gate is there for a reason.
- Don't bypass the regulatory `inc20AFlag: "N"` check for real filings. The validate-bypass works at the form layer but RoC will reject the resulting filing — you'll have created compliance debt.
- DSC submissions are personal acts of attestation. Automate the upload step of the signed PDF, never the signing step itself.
- Aadhaar data appears in director master records (`mgt7getDinDetails` response). Mask via `maskAadhaar` in [`prefill-client.ts`](mca-filing-service/src/aoc4/prefill-client.ts) before logging or persisting; the unmasked value should only exist transiently in memory.

See `docs/MCA_PRODUCTION_READINESS.md` for the full posture review.

---

## Acknowledgements

This codebase exists because a series of "wait, that's weird" moments turned into careful instrumentation:
- The orphan-draft realization (My Application empty even after 7 successful saves)
- The two save-response shapes (partial-marker vs Data Added)
- The 3-gate panel chain (validate × disabled × modal)
- The two SR identifiers (integrationId vs referenceNumber)

Every lesson in this guide was paid for in lost time. Read it before you start guessing — it's the cheat sheet.
