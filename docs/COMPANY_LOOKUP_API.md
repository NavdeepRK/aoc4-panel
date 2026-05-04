# Company Lookup Service — PAN-by-CIN and full company profile

A thin HTTP API on top of MCA's `inc12-withoutassociation` endpoint. Returns the complete public company profile (61+ fields, including PAN, INC-20A status, NIC codes, addresses, capital, ROC) for any CIN.

---

## Architecture

```
caller                    customer-portal-backend-1                mca-filing-service              MCA portal
─────                     ──────────────────────────              ──────────────────              ──────────
GET /api/mca/             routes/mca.js                            POST /bin/commongetapi
  company/:cin   ─────→   controller →                             with encrypted payload  ────→  inc12-without
                          companyLookupService.getCompanyInfo()                                    association
                          ├─ in-memory cache (1h TTL)              ↑
                          └─ axios.get()  ────────────→  GET /company-info?cin=...
                                                          ├─ lazy-warm Playwright session
                                                          ├─ window.encrypt(payload)
                                                          ├─ inject CSRF token
                                                          └─ run fetch() in page context
                          ←──────────  61-field profile  ←────────  unwrap resStr → company info
                          cache write
                          ↓
caller     ←──── { company: {...} } ────  successResponse
```

**Why two layers?** The MCA endpoint requires `window.encrypt()` and a CSRF token from a live AEM form page. We can't reproduce the encryption in raw Node without significant reverse engineering. The mca-filing-service keeps a warm Playwright browser that loads the AOC-4 form once and answers many CIN lookups by `page.evaluate()`-ing `fetch()` inside the page context. After 5 minutes idle the browser closes; it relaunches lazily on next request.

---

## Endpoints

### `GET /api/mca/company/:cin`

Full public profile.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://your-portal/api/mca/company/U62090HR2025PTC132910 | jq .data.company
```

Response (truncated):
```json
{
  "company": {
    "CIN": "U62090HR2025PTC132910",
    "company": "SCALEVERGE SOLUTIONS PRIVATE LIMITED",
    "companyStatus": "Active",
    "classOfCompany": "Private",
    "smallCompanyFlag": "Y",
    "shareCapitalFlag": "Y",
    "dateOfIncorporation": "06-06-2025",
    "authorisedcapital": 100000,
    "paidupCaptail": 10000,
    "PAN": "ABQCS4391A",
    "emailAddress": "*****@lula.chat",
    "numberOfDirectors": 2,
    "ROCName": "ROC Haryana",
    "ROCCode": "Registrar of Companies, Haryana",
    "inc20AFlag": "N",
    "inc24Flag": null,
    "managementDisputeFlag": "N",
    "vanishFlag": null,
    "NICCode1": 62090,
    "NICCode1Desc": "Other information technology and computer service activities",
    "listed": "N",
    "companyAddress": [...]
  }
}
```

### `GET /api/mca/company/:cin/pan`

Lightweight wrapper for the most common single-field need.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://your-portal/api/mca/company/U62090HR2025PTC132910/pan
```

```json
{ "cin": "U62090HR2025PTC132910", "pan": "ABQCS4391A", "companyName": "SCALEVERGE SOLUTIONS PRIVATE LIMITED" }
```

### `GET /api/mca/company/:cin/preflight`

Pre-filing gate check — returns `{ canFile: bool, reasons: [...] }`. Use this before clicking "Start AOC-4 Filing" so the UI can disable the button when there are blocking compliance debts.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://your-portal/api/mca/company/U62090HR2025PTC132910/preflight
```

```json
{
  "canFile": false,
  "reasons": ["INC-20A not filed (Companies Act §10A blocks downstream filings)"],
  "companyStatus": "Active"
}
```

The list of gates is centralised in `services/mca/companyLookupService.js → preflightForFiling()`. Add new ones there as we learn more.

### `POST /api/mca/company/:cin/refresh`  (admin only)

Bust the in-memory cache and force a fresh fetch from MCA. Useful after a known successful filing or when an admin marks a CIN's data stale.

---

## Live results captured 2026-05-01

| CIN | Company | PAN |
|---|---|---|
| `U62090HR2025PTC132910` | SCALEVERGE SOLUTIONS PRIVATE LIMITED | **`ABQCS4391A`** |
| `U69100KA2023PTC177694` | LAUNCHWISE PRIVATE LIMITED | **`AAFCL5256P`** |

Captured via `curl http://127.0.0.1:8090/company/<CIN>/pan` against a live MCA session.

---

## Fields returned (selected)

Every field MCA returns on `inc12-withoutassociation`. Some have server-side typos preserved as-is so consumers don't accidentally diverge from the wire format.

| Field | Meaning |
|---|---|
| `CIN`, `UCIN` | Same value, both populated |
| `company`, `companyIncorporationName` | Company name |
| `companyStatus`, `status` | Same value: `Active` / `Strike Off` / `Under CIRP` / etc. |
| `classOfCompany` | `Private` / `Public` / `One Person Company` / `Section 8` |
| `smallCompanyFlag` | `Y`/`N` — drives small-Pvt filing relaxations (Companies Act §2(85)) |
| `shareCapitalFlag` | `Y`/`N` — drives whether `authorisedcapital` is mandatory |
| `dateOfIncorporation`, `amalgmatedDate` | dd-mm-yyyy |
| `statusChangeDate` | dd-mm-yyyy when companyStatus last changed |
| `authorisedcapital` | Authorised capital (rupees) |
| `paidupCaptail` | **sic** — server typo, should be `paidUpCapital` |
| `unclassifiedAuthShareCap` | Usually 0 |
| `numberOfDirectors`, `numberOfDesignatedPartners`, `numberOfPartners`, `numberOfMembers` | Self-explanatory |
| `registrationNumber` | The 6-digit RoC reg number from the CIN |
| `PAN` | Company PAN — what we just queried for |
| `emailAddress` | **Masked** when caller has no association: `*****@domain.com` |
| `mobile`, `phone`, `fax` | Phone numbers (often null) |
| `ROCName`, `ROCCode` | Registrar of Companies name + code (e.g. "ROC Haryana") |
| `type` | `Company` / `LLP` / `FLLP` |
| `inc20AFlag` | `Y`/`N`/null — INC-20A (Declaration of Commencement) filed? **`N` BLOCKS most filings** |
| `inc24Flag` | `C`/`P`/null — INC-24 rectification pending. Non-null **BLOCKS AOC-4** |
| `inc22AFlag`, `companiesINC22Flag` | ACTIVE compliance flags |
| `managementDisputeFlag`, `vanishFlag`, `inspectionFlag` | Company status flags |
| `whetherListedOrNot`, `listed` | Listed company flag |
| `obligatedContribution`, `section8LicenseNumber` | Section 8 / charity company specifics |
| `NICCode1`, `NICCode2`, `NICCode3` + `Desc` | NIC industry codes (top 3) |
| `businessActivity` | First 2 digits of NICCode1 |
| `agmDate`, `dateofbalSheet` | Last AGM / balance sheet dates |
| `establishmentDt` | Foreign companies only |
| `holdingCompanyCIN` | Parent company CIN if subsidiary |
| `companyAddress` | Array — registered + correspondence address with country/pincode/state/lat/long |

The full TypeScript shape lives in [`mca-filing-service/src/aoc4/prefill-client.ts`](mca-filing-service/src/aoc4/prefill-client.ts) → `interface CompanyInfo`.

---

## Operating notes

### Caching

- 1-hour in-process LRU. Per-CIN. Survives only as long as the Node process; for multi-instance deployments swap `cache` in `services/mca/companyLookupService.js` for a Redis client.
- Cache is keyed by uppercased CIN.
- `noCache: true` option on `getCompanyInfo` for live re-fetch.

### Authentication

- All `/api/mca` routes require an authenticated portal user (global `authenticate` middleware).
- The MCA endpoint underneath is permissive — it returns data regardless of the caller's relationship to the CIN. But it does require a logged-in MCA session (storage-state cookies). Without those cookies, the form-load step times out and the lookup fails.
- For multi-tenant production: spin up a dedicated MCA service-account login that has no DSC, no DIN, no business-user associations — just enough to load the form. Mint storage-state on a cron schedule.

### Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| 502 `mca-filing-service company-info failed` | service down or unreachable | check `MCA_FILING_BASE_URL` and `npm run serve` |
| 502 `Timeout 30000ms exceeded` | session-expired or anti-automation tripped | re-run `npm run login`, leave HEADLESS=false |
| 400 `invalid CIN format` | bad input | regex: `^[A-Z]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$` |
| 502 `resCode=205` (No Active Session) | `storage-state.json` invalidated | `npm run login` |
| `emailAddress: "*****@..."` | masked because login user has no DIN/business-user link to this CIN | this is the public-read view; PAN, address, status, INC flags are all unmasked |

### Rate considerations

MCA's V3 portal doesn't publish rate limits but is observed to throttle aggressively. The 1-hour cache amortises naturally; if you find yourself bursting (e.g., bulk-importing 1000 CINs), space requests at 1 per second and prefer the bulk-prefill path inside an existing automation job rather than a cold tight loop.

---

## Files

| Path | Role |
|---|---|
| `mca-filing-service/src/server/company-lookup.ts` | Lazy-warm Playwright session + `fetchCompanyInfoByCin()` / `fetchPanByCin()` |
| `mca-filing-service/src/server/index.ts` | HTTP routes: `GET /company-info`, `GET /company/:cin/pan` |
| `customer-portal-backend-1/services/mca/companyLookupService.js` | Backend service: cache + preflight + `getCompanyInfo()` / `getPanByCin()` |
| `customer-portal-backend-1/controllers/mca/companyLookupController.js` | REST handlers |
| `customer-portal-backend-1/routes/mca.js` | Routes mounted at `/api/mca` |
| `customer-portal-backend-1/server.js` | Mounts the router |

---

## Quick local test

```bash
# 1. Mint a fresh MCA session (only needed once, lasts ~24h)
cd mca-filing-service
npm run login

# 2. Start the lookup service
npm run serve  # listens on :8090

# 3. Query
curl -s 'http://127.0.0.1:8090/company/U62090HR2025PTC132910/pan' | jq .
# → { "cin": "U62090HR2025PTC132910", "pan": "ABQCS4391A", "companyName": "SCALEVERGE SOLUTIONS PRIVATE LIMITED" }

curl -s 'http://127.0.0.1:8090/company-info?cin=U62090HR2025PTC132910' | jq .company.companyStatus
# → "Active"
```

To go through the customer portal:

```bash
# customer-portal-backend-1 must be running with MCA_FILING_BASE_URL pointing at :8090
curl -H "Authorization: Bearer $TOKEN" \
  https://localhost:5050/api/mca/company/U62090HR2025PTC132910/pan | jq .
```
