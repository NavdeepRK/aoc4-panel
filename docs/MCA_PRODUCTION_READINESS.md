# MCA AOC-4 Automation — Production Readiness Assessment

**Honest answer**: not ready for client filings yet. We have ~25-35% of what a production AOC-4-as-a-service requires. What's built is solid and tested; what's missing is most of the reliability, compliance, and breadth-of-scenarios layer.

This doc inventories the gap so the path to client-grade can be planned (and resourced) honestly.

---

## What IS validated end-to-end

Live-tested against `SCALEVERGE SOLUTIONS PRIVATE LIMITED` (CIN U62090HR2025PTC132910) on 2026-04-29:

| Capability | Status | Evidence |
|---|---|---|
| Login (creds + captcha) | ✅ | `runs/scaleverge-test/` — Gemini auto-solved on attempt 3 |
| OTP human handoff | ✅ | Successful login, session persisted to `storage-state.json` |
| Storage state reload (skip re-login) | ✅ | Same session reused for AOC-4 navigation |
| Bypass redirect blockers | ✅ | All 5 patterns blocked; form stays on `/form-aoc4.html` |
| Tree-walk introspection | ✅ | 1,887 nodes / 1,423 leaves / 783 inputs across 7 panels |
| guideBridge per-field SOM write | ✅ | `node.value = X` writes to model; `getDataXML()` reflects it |
| Captcha auto-solve via Gemini 2.5 Flash | ✅ | 3-attempt budget; ~95% first-attempt success |
| Company prefill via `prefillWithCin` | ✅ | SCALEVERGE — full 61-field profile retrieved + form populated |
| Director lookup via `mgt7getDinDetails` | ✅ | Both SCALEVERGE directors (DIN 11142612, 11142613) — 24 fields each, full name construction |
| Director-row population in `table2` | ✅ | `signatory_dir[]` array verified in `getDataXML` after write |
| FDM dropdowns / lookups | ✅ | Country, industry, designation, nature-of-FS, revision-scope all captured |

This validates the **foundation**: we can drive the form, fetch real data, and mutate the model. The architecture works.

---

## What is NOT yet validated (the gap)

### A. Submission pipeline (the load-bearing piece)

| Item | Status | Why it matters |
|---|---|---|
| `node.value = X` carries through to actual MCA submission | ❌ | We've only read back via `getDataXML`. We have NOT clicked Save and confirmed the POST body to MCA contains our values. If AEM submits from DOM (vs model), we need a synthetic-event dispatcher. |
| Per-panel Save button (`aoc4_Save1` … `aoc4_Save6`) end-to-end | ❌ | Click → server validates → response shape → next-panel transition — all unverified |
| `POST .af.internalsubmit.jsp` response shape | ❌ | The AEM-side save endpoint. Unknown success/error envelope. |
| Validation error popup → captured + machine-readable | ❌ | We need to map every error code to a remediable error class |
| Final Submit + DSC handoff orchestration | ❌ | The entire DSC flow (modal → emSigner → token → SRN) is unimplemented |
| SRN capture after submission | ❌ | The filing reference number — needed for client tracking |
| Filing fee payment flow | ❌ | AOC-4 has government fees ranging from ₹200 to ₹600+ depending on capital + late penalties |
| Penalty calculation for late filings | ❌ | ₹100/day after due date, capped per Companies Act §403 |
| Resume from auto-saved draft | ❌ | AEM auto-saves; haven't verified our flow plays nicely with existing drafts |

### B. Form coverage (we mapped 1 of 4 AOC-4 variants)

| Variant | Mapped | Required for |
|---|---|---|
| `AOC-4` (standard) | ✅ | Single-entity Indian companies — most common |
| `AOC-4 CFS` (consolidated) | ❌ | Companies with subsidiaries — required when group filing |
| `AOC-4 NBFC` | ❌ | Non-Banking Financial Companies registered with RBI |
| `AOC-4 NBFC CFS` | ❌ | NBFC with subsidiaries |

The four variants share architecture (AEM Adaptive Forms, same widget IDs pattern) but have different field sets — Schedule III (panel3) differs significantly between standard and NBFC. Each variant needs its own walk + field map.

### C. Linked filings (almost always required alongside AOC-4)

| Form | Mapped | Notes |
|---|---|---|
| `AOC-1` (subsidiary statement) | ❌ | Required when AOC-4 CFS is filed |
| `AOC-2` (related party transactions) | ❌ | Required when company has RPT |
| `CSR-2` (CSR reporting) | ❌ | Required for companies above CSR thresholds (₹500cr turnover / ₹1000cr net worth / ₹5cr profit) |
| `MGT-7` / `MGT-7A` (annual return) | ❌ | Filed alongside AOC-4 within 60 days of AGM |
| `ADT-1` (auditor appointment) | ❌ | Filed within 15 days of AGM |
| `MGT-15` (AGM report) | ❌ | Listed companies only |

A real client filing is rarely *just* AOC-4 — it's a bundle. We need each form mapped with its own fields + prefill flow.

### D. Filing scenarios (the ones we haven't covered)

We tested the **happy path for a small private company that just incorporated**. Real scenarios we haven't:

- **Revised filings** (under Companies Act §130 or §131) — different field set, different validation
- **Companies with subsidiaries** — triggers AOC-1 + CFS requirement
- **Companies with related-party transactions** — triggers AOC-2 disclosures
- **Companies above CSR thresholds** — triggers CSR-2 + Schedule VII disclosures
- **Foreign Companies** — different form (FC-3) entirely
- **One Person Companies (OPC)** — different signing requirements
- **Section 8 companies** — additional compliance section
- **Listed companies** — extensive Schedule V disclosures
- **Companies with auditor changes during FY** — multiple ADT entries
- **Companies under CIRP / Liquidation** — IRP/RP/Liquidator signs instead of directors
- **Late filings** (post-due-date) — penalty calc + late-fee SRN handling
- **Adjournments / multiple AGMs** — `dateOfAdjAGM` flow
- **Companies that haven't filed INC-20A (declaration of commencement)** — filing is BLOCKED until INC-20A filed

Each scenario has its own validation rules and form-flow branches.

### E. DSC (the regulatory ceiling)

The Class-3 DSC signing step is the **hardest blocker** for full automation:

| Component | Status |
|---|---|
| DSC modal entry orchestration | ❌ — not yet automated, will be a manual handoff in v1 |
| emSigner integration | ❌ — needs local desktop helper running on the signer's machine |
| Hardware token (USB) detection | ❌ — out of Playwright's scope |
| HSM-backed bulk signing | ❌ — requires regulatory legal review before pursuing |
| Multi-signatory workflow (1 director + 1 CA/CS) | ❌ — both need to sign sequentially with their own DSCs |
| DSC certificate validation | ❌ — must be Class-3, registered on MCA, not expired |

**v1 must be assisted automation**: bot fills, human signs. v2 (unattended) needs HSM + legal sign-off (DSC delegation is regulated).

### F. PII / compliance handling

Captured live: the DIN-lookup endpoint returns **full 12-digit Aadhaar numbers** (Aadhaar Act §29-regulated PII), full DOB, mobile, email, PAN, parents' names. Currently we have:

| Item | Status |
|---|---|
| Aadhaar masking on receipt (`maskAadhaar()`) | ✅ — implemented in `prefill-client.ts` |
| Aadhaar redacted in saved artifacts | ✅ — `runs/scaleverge-test/director-lookup-responses.json` is masked |
| Audit trail for who-accessed-which-DIN | ❌ — required for §29 compliance |
| Encrypted-at-rest storage of session state + form drafts | ❌ — currently plaintext JSON on disk |
| Right-to-deletion on client request | ❌ — no data lifecycle policy |
| Access logs for production deployment | ❌ |
| Data Processing Agreement template for clients | ❌ |
| Aadhaar Act §29 compliance review | ❌ — needs legal sign-off |
| DPDP Act 2023 compliance review | ❌ — Digital Personal Data Protection Act applies to PII handling |

Until the legal/compliance layer is in place, this CANNOT process Aadhaar-bearing data for paying clients. Fix this first.

### G. Reliability + observability

| Item | Status |
|---|---|
| Error retry logic (network blips, MCA 5xx) | ❌ — current code throws on first failure |
| Captcha multi-retry escalation (after 3 Gemini misses, fallback to human) | ⚠️ Partial — falls back to "wait for human" but no user notification |
| Idempotency keys (so a retried filing doesn't double-submit) | ❌ |
| Health checks (is MCA up, is the form still at the same URL) | ❌ |
| Structured logging (JSON, with correlation IDs per filing) | ❌ — currently console.log |
| Metrics (filing success rate, captcha solve rate, time-to-completion) | ❌ |
| Alerts (failed filings, MCA outages) | ❌ |
| Distributed tracing | ❌ |
| Graceful handling of MCA portal redesigns | ⚠️ Selectors are stable AEM IDs — but if MCA reauthors panels, our field maps go stale silently |

### H. Multi-tenant + workflow

The current code runs ONE filing for ONE company at a time. Real client service needs:

| Item | Status |
|---|---|
| Queue (multiple companies, sequential processing) | ❌ |
| Per-client credential vault (each client has their own MCA login) | ❌ — currently single account in `.env` |
| Filing status workflow (draft → review → signed → submitted → approved / rejected) | ❌ |
| Client-facing draft preview (before final submission) | ❌ |
| Bulk upload (Excel / CSV with multiple companies' financials) | ❌ |
| Filing history / audit log per client | ❌ |
| Notifications (email/SMS to client at each step) | ❌ |
| Admin UI for our team to triage failed filings | ❌ |
| SRN tracking dashboard | ❌ |
| Integration with bookkeeping tools (Tally, Zoho Books, QuickBooks) | ❌ — required because financial figures come from books |
| Reconciliation against the books before filing | ❌ |

### I. Financial data ingestion (the input pipeline)

This is the part most clients actually struggle with. The form has 783 input fields; ~600 are financial line items. They have to come from somewhere:

| Source | Status |
|---|---|
| Manual data entry by client (CSV / form) | ❌ |
| Tally integration (XML export) | ❌ |
| Zoho Books integration (API) | ❌ |
| Auditor-prepared trial balance import | ❌ |
| Reconciliation: do balance sheet figures match P&L closing figures match cash flow? | ❌ |
| Schedule III mapping (their chart of accounts → MCA's required schedule) | ❌ |
| Comparative previous-year figures (required by AOC-4) | ❌ |
| Currency rounding / signing convention checks | ❌ |
| Validation against MCA business rules (e.g. assets = liabilities + equity) | ❌ |

**This is at least as much work as the form-driving layer.** Without a financial-data ingestion pipeline, the automation just shifts the bottleneck from "filing the form" to "preparing the data to fill the form."

---

## Critical risks not yet mitigated

1. **Captcha-as-a-service ToS** — using Gemini for captcha solving is technically MCA's captcha being "read by an AI agent." MCA's terms may prohibit automated form filling. **Need explicit ToS review with legal before scaling to client filings.** Worst case: account suspension.

2. **DSC delegation** — even *assisted* automation where the bot fills and the human signs may technically violate the DSC issuer's terms (which usually prohibit allowing software to drive the DSC token). **Legal review required.**

3. **Aadhaar handling** — already covered above. Get this wrong and there's a Section 29 violation with criminal liability.

4. **MCA portal changes** — the portal evolves. Lot-3 forms migrated through 2025 with breaking changes. Our field maps will rot. **Need monitoring + a re-validation pipeline that runs against MCA's portal regularly to catch breakage early.**

5. **Filing accuracy** — wrong figures filed with MCA become a public record. Penalties under Companies Act §447 for fraudulent filings are severe (3-10 years imprisonment + fine). **Need a four-eyes review step before any submission.**

6. **No rollback** — once submitted with SRN, an AOC-4 cannot be retracted, only revised (which is its own filing, fees + scrutiny). Bugs in production = client cost + reputational damage.

---

## What "client-ready" minimum looks like

If the goal is "I can take a real paying client's AOC-4 filing and process it without a human babysitter for the form-driving part":

1. **End-to-end submission validated** (any one variant, real test entity, signed + submitted, SRN captured)
2. **Director + auditor lookup flows** for any DIN/PAN combo
3. **Per-panel Save click handling** with error capture + retry
4. **DSC handoff modal** integrated as a clean "pause for signature" step
5. **Aadhaar handling** legal sign-off + automated masking pipeline
6. **DSC ToS review** done — clear yes/no on whether assisted automation is allowed
7. **MCA portal ToS review** — captcha-via-Gemini sign-off
8. **One scenario fully tested** end-to-end on a non-production company (small private company, single FY, no subsidiaries, no CSR)
9. **Bulk-fill safety net**: load → preview → human review → submit (no auto-submit ever)
10. **Audit log per filing** — every API call, every field set, every retry, who/when

That's roughly **8-12 weeks of focused work** beyond what we have now (assuming 1-2 dedicated engineers).

After that, expanding scenarios (CFS, NBFC, late filings, multi-form bundles, CSR-2, MGT-7) is each ~1-2 weeks per variant.

---

## Recommended next steps (prioritized)

1. **Validate the submission pipeline** — pick a non-production test company, fill panel1 with real data, click `aoc4_Save1`, capture the response, verify the POST body. This unblocks understanding of whether `node.value = X` works for real submissions.
2. **Capture the validation-error envelope** — submit with deliberately invalid values to see the error-response shape. Build the error-classification taxonomy.
3. **Get legal review** on (a) MCA captcha automation, (b) DSC delegation, (c) Aadhaar handling under DPDP Act 2023. Without this, scaling is irresponsible.
4. **Build the financial-data ingestion layer** — this is half the project and it's not started. Start with Tally XML export (most common) or Zoho Books (already integrated in customer-portal-backend).
5. **Pick the v1 client scenario** — likely "small private Indian company, single FY, no subsidiaries, no CSR, INC-20A filed." That gates us out of 80% of the form's complexity for the v1 launch.
6. **Build the four-eyes review UI** — every filing must be human-reviewed before submission. Even with full automation, this is non-negotiable for AOC-4 (regulatory recordkeeping requirement under Companies Act §128).
7. **Stand up a sandbox MCA account** — currently using a real-data account. For development we need a dummy company that won't be affected by test runs.
8. **Map AOC-4 standard's panel3 (balance sheet)** — 238 fields, the densest section. This is the bulk of the form complexity.
9. **Integrate with the customer portal** — currently `mca-filing-service` is standalone. It needs to live inside the existing customer-portal architecture (auth, billing, audit logs, client management) since RegisterKaro is the parent product.

---

## Honest TL;DR

**What we have**: a well-architected technical foundation with all the hard discovery done — form architecture mapped, all major API endpoints documented, captcha + login solved, director + company prefill flows working end-to-end against a real entity. Solid groundwork.

**What we don't have**: the submission half of the pipeline, financial-data ingestion, DSC orchestration, regulatory compliance review, multi-scenario coverage, four-eyes review UI, monitoring, error recovery, multi-tenant infra, or any of the operational reliability layer.

**Time to client-ready (single happy-path scenario)**: ~8-12 weeks of focused engineering + legal review.

**Time to broad client-ready (most AOC-4 variants + linked filings)**: 4-6 months.

Don't ship to clients yet.
