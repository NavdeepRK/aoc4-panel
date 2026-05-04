# MCA AOC-4 Prefill API — Captured Response Shapes

**Source**: live capture from `https://www.mca.gov.in/content/mca/global/en/mca/e-filing/annual-filings/form-aoc4.html`
**Captured on**: 2026-04-29
**As user**: `REGISTERKARO.INFO101@GMAIL.COM` (AYUSH RONELD) — *Registered user / Individual / no associated companies*

> Companion to `MCA_AUTOMATION_LESSONS.md`. The lessons doc explains *how* to capture, *why* the API is shaped this way, and *what not to do*. This doc is the response-shape reference.

> Full raw capture: `.artifacts/aoc4-api-responses-full.json`. Live network log (4.5MB): `.artifacts/aoc4-network-raw.txt`.

---

## API surface summary

```
GET  /bin/mca/loggedInUserDetailsBasic           → AES-encrypted blob (~410 bytes)
GET  /bin/mca/GetCurrentTime                     → plain-text "MM/dd/yyyy HH:mm:ss"
POST /bin/commongetapi                           → JSON (multipart, encrypted body)  ← THE REAL PREFILL
POST /content/forms/af/mca-af-forms/aoc/aoc-4
        /jcr:content/guideContainer.af.dermis    → JSON (FDM operation invoker — lookups only)
POST /content/forms/af/mca-af-forms/aoc/aoc-4
        /jcr:content/guideContainer.af.internalsubmit.jsp  → submit pipeline (not yet captured)
```

> **Important distinction**: The earlier-documented `POST /common/service/companyInfo/1.0.0` (via the FDM dispatcher) returns ONLY the logged-in user's profile + their associated companies (empty for Registered users). The **real prefill** for an AOC-4 filing uses `POST /bin/commongetapi` with `endpointID="inc12-withoutassociation"` — a separate endpoint with full company master-data access, captured live for SCALEVERGE SOLUTIONS PRIVATE LIMITED.

The `.af.dermis` endpoint is **the FDM operation invoker** — every form-side data fetch routes through it. Body is `application/x-www-form-urlencoded` with these keys:

| Key | Description |
|---|---|
| `functionToExecute` | Always `invokeFDMOperation` |
| `formDataModelId` | JCR path to the Forms Data Model definition |
| `input` | URL-encoded JSON — the FDM operation's request payload |
| `operationName` | `<HTTP verb> <REST path>/<version>` — the named operation on the FDM |
| `guideNodePath` | JCR path of the form field that triggered this call (informational only) |

---

## 0. `POST /bin/commongetapi` ← THE REAL PREFILL (live-validated against SCALEVERGE)

**Purpose**: returns the FULL company master-data record by CIN. This is what the form's `prefillWithCin(cin)` JavaScript helper invokes. Populates panel1AOC4's company fields directly.

**Discovery**: was NOT visible during plain form-load network capture because it only fires when prefill is explicitly invoked (button click or programmatic call to `window.prefillWithCin`). Captured live by triggering `prefillWithCin('U62090HR2025PTC132910')` from the page console.

### Request

```
POST /bin/commongetapi HTTP/1.1
Host: www.mca.gov.in
Content-Type: multipart/form-data; boundary=----WebKitFormBoundaryXXX
Cookie: <session cookies>

------WebKitFormBoundaryXXX
Content-Disposition: form-data; name="data"

iWm3uj9CcFdiq4Xhkle9LJ0QPME8XUqVbQ%2FbMJrHXdA%3D    ← encrypt(JSON.stringify({CIN: "..."}))
------WebKitFormBoundaryXXX
Content-Disposition: form-data; name="endpointID"

inc12-withoutassociation
------WebKitFormBoundaryXXX
Content-Disposition: form-data; name="csrfToken"

uNZa6ZdzfpI9c3DhW58TD58rxiPNpqiLIAW8AaFtmW%2FnhmBM2ANhCm75uZ%2Br2TNg    ← encrypt(<#csrfToken value>)
------WebKitFormBoundaryXXX
Content-Disposition: form-data; name="csrfDecode"

false
------WebKitFormBoundaryXXX--
```

**Encryption**: `window.encrypt()` is defined globally on the form page (loaded by `clientlibs-encrptdecrypt.min.js`). It's an AES wrapper — the key is bundled in the clientlib. Decryption is server-side. The same `encrypt()` function is used for both the data payload and the CSRF token.

**CSRF token**: read from the `#csrfToken` hidden input in the DOM (NOT from `/libs/granite/csrf/token.json` which returns `{}` on this site).

**`endpointID` values** observed:
- `inc12-withoutassociation` — company info by CIN, no auth-association required (can fetch any active CIN)
- *(more endpoint IDs likely for other MCA form lookups — enumerate as you walk additional forms)*

### Response (live capture, SCALEVERGE)

The response is **double-wrapped** — outer JSON contains a `resStr` field that is itself a JSON-encoded string.

**Outer wire body**:
```json
{
  "resCode": 200,
  "resStr": "{\"error\":\"\",\"message\":\"Data fetched Successfully\",\"data\":[{\"companyInfo\":{...}}]}"
}
```

**`resStr` parsed** (full company profile):

```jsonc
{
  "error": "",
  "message": "Data fetched Successfully",
  "data": [{
    "companyInfo": {
      // Identity
      "CIN": "U62090HR2025PTC132910",
      "UCIN": "U62090HR2025PTC132910",                  // duplicate of CIN
      "company": "SCALEVERGE SOLUTIONS PRIVATE LIMITED",
      "companyIncorporationName": "SCALEVERGE SOLUTIONS PRIVATE LIMITED",
      "PAN": "ABQCS4391A",
      "registrationNumber": 132910,

      // Status / classification
      "companyStatus": "Active",                        // "Active" | "Strike Off" | "Under CIRP" | "Under Liquidation" | "Under Liquidation / CIRP"
      "status": "Active",                               // duplicate of companyStatus
      "classOfCompany": "Private",                      // "Private" | "Public" | "One Person Company" | "Section 8"
      "companyType": "New Company (Others)",
      "companySubcategory": "Non-government company",
      "companyCategory": "Company limited by shares",
      "companyOrigin": "Indian",                        // "Indian" | "Foreign"
      "smallCompanyFlag": "Y",                          // Y/N — drives Companies Act §2(85) relaxations
      "shareCapitalFlag": "Y",                          // Y/N — Y → authorisedcapital required, numberOfMembers optional
      "type": "Company",
      "listed": "N",
      "whetherListedOrNot": null,

      // Dates (server format: dd-mm-yyyy, except as noted)
      "dateOfIncorporation": "06-06-2025",
      "amalgmatedDate": "06-06-2025",                   // = dateOfIncorporation for non-amalgamated companies
      "statusChangeDate": "06-07-2025",                 // last status change
      "agmDate": null,                                  // populated after AGM filed
      "dateofbalSheet": null,                           // populated after FY filed
      "establishmentDt": null,                          // foreign companies only

      // Capital
      "authorisedcapital": 100000,
      "paidupCaptail": 10000,                           // sic — server typo, NOT "paidUpCapital"
      "unclassifiedAuthShareCap": 0,

      // Members / directors / partners
      "numberOfDirectors": 2,
      "numberOfDesignatedPartners": 0,
      "numberOfPartners": 0,
      "numberOfMembers": null,
      "maximumNumberOfMembers": null,
      "maxNoOfMembersExcludingProposedEmployees": null,
      "NoOfMembersExcludingProposedEmployees": null,

      // Compliance flags
      "inc20AFlag": "N",                                // Declaration of Commencement of Business — gates AOC-4
      "inc24Flag": null,                                // Rectification of name — "C"/"P" BLOCKS AOC-4
      "inc22AFlag": null,                               // ACTIVE compliance — INC-22A
      "companiesINC22Flag": "N",                        // INC-22 (registered office) compliance
      "managementDisputeFlag": "N",                     // Y triggers extra disclosures
      "vanishFlag": null,
      "inspectionFlag": null,
      "section8LicenseNumber": null,
      "obligatedContribution": null,
      "holdingCompanyCIN": null,

      // Industry
      "businessActivity": 62,                           // first 2 digits of NICCode1
      "NICCode1": 62090, "NICCode1Desc": "Other information technology and computer service activities",
      "NICCode2": 63112, "NICCode2Desc": "Web hosting activities",
      "NICCode3": 63999, "NICCode3Desc": "Other information service activities n.e.c.",

      // Contact / location
      "emailAddress": "*****@lula.chat",                // server-masked
      "mobile": 9220402925,
      "phone": null, "fax": null,
      "ROCName": "ROC Haryana",
      "ROCCode": "Registrar of Companies, Haryana",
      "officeType": null,
      "otherOfficeType": null,

      // Addresses (1+ entries — Registered always present, Correspondance optional)
      "companyAddress": [
        {
          "addressType": "Registered Address",
          "addressline1": "PLOT NO 31A UDYOG VIHAR",
          "addressline2": "PHASE 4, SECTOR 18 SARHOL",
          "arealocality": "Palam Road",
          "city": "Palam Road",                         // city often = arealocality for Indian addresses
          "district": "Gurgaon",
          "state": "Haryana",
          "country": "India",
          "pincode": 122015,
          "latitude": 24.52,
          "longitude": 81.32,
          "jurisdictionPoliceStation": null
        },
        {
          "addressType": "Correspondance Address",      // sic — server typo, should be "Correspondence"
          // ... same shape, possibly null lat/long
        }
      ]
    }
  }]
}
```

### Form fields populated by `prefillWithCin` (observed for SCALEVERGE)

After the function runs, `getDataXML()` shows these bound fields populated in `afData.afBoundData.data.requestBody.formData`:

| Bound field name | Value | Source |
|---|---|---|
| `CIN1`, `CIN3` | `U62090HR2025PTC132910` | direct |
| `nameOfTheCompany` | `SCALEVERGE SOLUTIONS PRIVATE LIMITED` | `companyInfo.company` |
| `registeredOfficeAddresss` (sic, 3 s's) | concatenated | joined `companyAddress[0]` fields |
| `regoffemailid` | `*****@lula.chat` | `companyInfo.emailAddress` |
| `authorisedCapital` | `100000.00` | `companyInfo.authorisedcapital` (formatted) |
| `lTBbondsDebenturesInCurrentDatetest11` / `t12` | `0%` | defaulted on prefill |

And in `afData.afUnboundData.data`:
- `savedCinVal: "U62090HR2025PTC132910"`
- `classOfCompany: "Private"` (from `companyInfo.classOfCompany`)
- `userTypeHidden: "Professional"`

### Key insight: TWO parallel field sets

The form has two field naming systems:

1. **SOM tree fields** (the 1,423 leaves we mapped) — semantic names like `CINofCompany`, `nameOfCompany`, `addressOfRegisterCompany`, `emailIDofCompany`. Used for direct UI binding via `gb.resolveNode(som).value`.
2. **Bound data fields** (76+ fields in `formData`) — names like `CIN1`/`CIN3`, `nameOfTheCompany`, `registeredOfficeAddresss`, `regoffemailid`, `authorisedCapital`. Used for submission to MCA backend.

These OVERLAP but are NOT identical. Specifically:
- `gb.resolveNode('CINofCompany').value = X` writes to the SOM-tree field, but the bound submission uses `CIN1`/`CIN3`.
- `prefillWithCin` populates BOTH the SOM-tree fields AND the bound fields — they stay in sync because the form's data model has two-way binding.
- For bulk programmatic fill, write via SOM (`gb.resolveNode(som).value = X`); verify via `getDataXML().formData[boundName]`.

### Pre-flight gates (from the function source)

`prefillWithCin` won't populate fields if:
- `companyStatus` is NOT one of `"Active" | "Under CIRP" | "Under Liquidation" | "Under Liquidation / CIRP"` → no fields populated, prefill silently no-ops.
- `inc24Flag === "C" || "P"` → modal: *"Form cannot be filed as the company has not filed INC-24 for rectification of name as per RD order"* — populates nothing.
- `inc20ACommencementFlagCheck('AOC-4', inc20AFlag, dateOfIncorporation)` returns false → modal: *"Form filing is not allowed since Declaration for commencement of business is not filed in form INC-20A"* — populates nothing.

For SCALEVERGE: `companyStatus="Active"`, `inc24Flag=null`, and the INC-20A check passed (despite `inc20AFlag="N"`) — likely because the 180-day INC-20A grace period rules differently for AOC-4 than for other forms.

---

## 0b. Director (DIN) lookup — `endpointID: "mgt7getDinDetails"` (same `/bin/commongetapi` endpoint)

**Live-validated** for SCALEVERGE's two directors. Used by the AEM `valueCommitScript` on `table2.Row1.din` to auto-fill name + designation when the user types a DIN.

> ⚠️ **The endpointID is named `mgt7getDinDetails`** but the same endpoint is used by AOC-4. The `mgt7` prefix reflects which form first introduced the helper, not which forms can use it.

### Request

Same multipart shape as the company-info endpoint, just different `endpointID` and a different encrypted payload:

```
POST /bin/commongetapi
multipart/form-data:
  data        = encrypt(JSON.stringify({DINPAN: "11142612"}))
  endpointID  = "mgt7getDinDetails"
  csrfToken   = encrypt(<#csrfToken>)
  csrfDecode  = "false"
```

The field is `DINPAN`, not `DIN` — same field accepts an 8-digit DIN OR a 10-character income-tax PAN (regex `/^[0-9]{8}$/` or `/[a-zA-Z]{5}[0-9]{4}[a-zA-Z]{1}$/`). The form's regex check happens client-side before the call; the server validates server-side.

### Response (live capture, SCALEVERGE directors — Aadhaar masked)

Same double-wrapped envelope as company-info: `{resCode, resStr: "<JSON>"}`.

`resStr` parsed:

```jsonc
{
  "message": "Data fetched Successfully",
  "data": [
    {
      "DIN": 11142612,                          // returned as a NUMBER not a string
      "DINStatus": "Approved",                  // | "Pending" | "Surrendered" | "Disqualified" | "Suspended"
      "DINApprovalDate": "06/06/2025",          // dd/MM/yyyy

      "FirstName": ".",                         // "." or "NA" = no first name on record (single-name director)
      "MiddleName": null,
      "LastName": "SURBHI",
      "FatherFirstName": "JHANDU",
      "FatherMiddleName": null,
      "FatherLastName": "LAL",

      "Gender": "Female",                       // Male | Female | Other
      "DOB": "03/05/1991",                      // dd/MM/yyyy
      "Nationality": "Indian",
      "ResidentOfIndia": "Y",                   // Y/N
      "CitizenOfIndia": "Y",                    // Y/N
      "ContactNationalityCountry": "India",

      "EmailAddress": "app.lula.chat@gmail.com",
      "MobileNumber": "+919220402925",          // E.164 format with +91 prefix

      "PAN": "NPIPS3951C",                      // 10-char Income Tax PAN
      "AadhaarNumber": "XXXXXXXX2268",          // ⚠️ MASKED HERE — server returns FULL 12-digit number
      "PassportNumber": null,
      "DrivingLicenseNumber": null,
      "VotersIdNumber": null,

      "MembershipNumber": null                  // CA/CS/CMA institute number — null for non-professionals
    }
  ]
}
```

### ⚠️ PII / Aadhaar handling — non-negotiable

The `AadhaarNumber` field returns the **full 12-digit Aadhaar number**. Aadhaar disclosure is regulated under the **Aadhaar (Targeted Delivery of Financial and Other Subsidies, Benefits and Services) Act, 2016 §29** — which prohibits disclosure of identity information without consent and limits storage. Mandatory rules for our service:

1. **Mask immediately on receipt** — `maskAadhaar()` in `prefill-client.ts` keeps last 4 digits only.
2. **Never log unmasked Aadhaar.** Any console.log / file write / metric must apply the mask first.
3. **Never persist unmasked Aadhaar to disk.** Captured artifacts (this file, `runs/*/`) must contain masked values only.
4. **The unmasked value should only exist transiently in memory** during the in-flight form-fill pipeline — it's not needed after the form is filled (the form's own model holds it via guideBridge for the actual filing).

### Form's name-construction logic

Reproduced exactly in `buildDirectorFullName()` in `prefill-client.ts`:

```js
[FirstName, MiddleName, LastName]
  .filter(p => p && p !== 'null' && p !== '.' && p !== 'NA')
  .join(' ')
  .trim()
```

This handles:
- Single-name directors: `FirstName="."`, `LastName="SURBHI"` → `"SURBHI"`
- Standard 3-part names: `FirstName="BANOTH"`, `MiddleName="VINOD"`, `LastName="KUMAR"` → `"BANOTH VINOD KUMAR"`
- Mixed null/placeholder values are filtered

### Form fields populated after director-row write

After writing `din`, `name1`, `designation1`, `DateOfSigningOfBoard` on `table2.Row1._instances[i]`, the bound submission data shows:

```jsonc
"signatory_dir": [
  { "signatory_dir_DIN": "11142612", "signatory_dir_name": "SURBHI", "signatory_dir_designation": "Director", "signatory_dir_dateSigningFS": "06/06/2025" },
  { "signatory_dir_DIN": "11142613", "signatory_dir_name": "BANOTH VINOD KUMAR", "signatory_dir_designation": "Director", "signatory_dir_dateSigningFS": "06/06/2025" },
  {}
]
```

AEM keeps a **minimum of 3 rows** in `table2` (per the field's `initScript`). To populate fewer than 3 directors, leave trailing rows empty (don't delete). To populate more than 3, call `table.Row1._instanceManager.addInstance()` first.

---

## 1. `GET /bin/mca/loggedInUserDetailsBasic`

**Purpose**: returns the user's basic profile for the page header (`Hello AYUSH`).

**Auth**: session cookie.

**Response**: URL-encoded AES ciphertext, ~410 bytes. Decryption is done client-side by `clientlibs-encrptdecrypt.min.js`. Decoded payload contains the same fields as `companyInfo.data.userInfo` (firstName, lastName, emailId, userCategory, mobileNo). Encryption keeps PII off the wire.

```
6KS7nkkyvPEPNKih0ls34sUe9fdxUc5xrAiDGLSyyWOlum2aZbXLNNNNoXWeMnqM4paz...
```

This call fires on every page load. Three calls in our reload capture (header re-renders).

---

## 2. `GET /bin/mca/GetCurrentTime`

**Purpose**: server time (used for the form's clock display + AGM date validation).

**Response**: `text/plain` body in `MM/dd/yyyy HH:mm:ss` (24-hour, IST).

```
04/29/2026 18:58:56
```

---

## 3. `POST /common/service/companyInfo/1.0.0`  ← THE PREFILL

**FDM**: `/content/dam/formsanddocuments-fdm/aoc4/cmpnyinfo`
**Operation**: `POST /common/service/companyInfo/1.0.0`

### Request input

```json
{
  "COMPANY_INFO_REQ": {
    "requestBody": { "userId": "REGISTERKARO.INFO101@GMAIL.COM" }
  }
}
```

`userId` must match the logged-in user's email (uppercase). Calling with a different userId returns the same `error: ""`, `message: "Data Fetched Successfully"`, but with empty `userInfo`.

### Response (Registered user / no companies — captured)

```jsonc
{
  "error": "",
  "message": "Data Fetched Successfully",
  "data": {
    "userInfo": {
      "personalAddress": {
        "addressLine1": "96A, UDYOG VIHAR PHASE 1",
        "addressLine2": "DUNDAHERA",
        "pincode": "122016",
        "city": "Industrial Complex Dundahera",
        "country": "India",
        "state": "Haryana",
        "jurisdictionOfPoliceStation": ""
      },
      "userCategory": "Registered user",      // also: "Business User", "Director/Designated Partner", ...
      "userRole": [],
      "incomeTaxPAN": "ESCPR1257N",
      "DIN_DPIN": "",
      "institute": "",                        // ICAI / ICSI / ICMAI for professionals
      "membershipNumber": "",
      "firstName": "AYUSH",
      "middleName": "",
      "lastName": "RONELD",
      "dateOfBirth": "01/22/2004",            // MM/dd/yyyy
      "gender": "Male",
      "profession": "Other",
      "other": "SELF EMPLOYED",
      "professionalMembershipNo": "",
      "industryOfOperation": "",
      "telephoneNoResidence": "",
      "telephoneNoOffice": "",
      "mobileNo": "+919205020196",
      "emailId": "REGISTERKARO.INFO101@GMAIL.COM",
      "mcaUserType": "Individual"             // also: "Director", "CA", "CS", "CMA"
    },
    "companyInfo": [
      // For this account: 1 entry with all empty objects.
      // For a Business User: 1+ entries fully populated.
      { "registeredAddress": {}, "status": "", "otherAddress": {} }
    ]
  }
}
```

### Field-level notes

| Field | Notes |
|---|---|
| `userInfo.userCategory` | Top-level role classification. Drives panel visibility (Business User unlocks more sections). |
| `userInfo.mcaUserType` | Sub-classification: `Individual`, `Director`, `CA`, `CS`, `CMA`. Determines which CIN-entry path: dropdown of authorized CINs (Director/CA/CS/CMA) vs. typed CIN (Individual/Other). |
| `userInfo.DIN_DPIN` | Director Identification Number. Empty for non-directors. |
| `userInfo.dateOfBirth` | `MM/dd/yyyy` server-side format. The form converts to `DD/MM/YYYY` for display. |
| `userInfo.profession` | One of: `CA`, `CS`, `CMA`, `Director`, `Other`. When `Other`, the `other` field has a free-text description. |
| `userInfo.institute` / `professionalMembershipNo` | Set for CA/CS/CMA users. |
| `companyInfo[]` | One entry per associated CIN. **Empty array** for users with no associations. |

### `companyInfo[]` populated shape (inferred — needs Business User capture)

When the user is associated with at least one company (Business User flow), each entry includes:

```jsonc
{
  "CIN": "L17110MH1973PLC019786",
  "name": "RELIANCE INDUSTRIES LIMITED",
  "registeredAddress": {
    "addressLine1": "...", "addressLine2": "...",
    "pincode": "...", "city": "...", "state": "...", "country": "India",
    "jurisdictionOfPoliceStation": ""
  },
  "otherAddress": { /* same shape — empty if same as registered */ },
  "status": "Active",                    // also: "Strike Off", "Under Process of Striking Off", "Dormant", "Liquidation"
  "dateOfIncorporation": "...",          // MM/dd/yyyy
  "classOfCompany": "Public",            // Public / Private / OPC / Section 8
  "subCategory": "...",                  // Indian Non-Government, Foreign, Government
  "authorizedCapital": "...",
  "paidUpCapital": "..."
  // additional fields likely — capture from a Business User account to confirm
}
```

> ⚠️ The populated shape above is inferred from the AOC-4 form's data binding (the form has fields named `nameOfCompany`, `addressOfRegisterCompany`, `authorizedCapitalOfCompany`, etc., which receive values from this object on prefill). **Capture from a Business User account before relying on this exact shape.**

---

## 4. `GET /userregistration/service/lookup/userhintquestion/1.0.0`

**FDM**: `/content/dam/formsanddocuments-fdm/aoc4/userreq`

Generic enum-list lookup. Input is `{type: "<KEY>"}`, response is `{Message: null|string, data: [{name: ...}], error: ""}`.

### Captured `type` values

#### `MCA_NATURE_CONSOL` — Nature of financial statements

```json
{
  "Message": null,
  "data": [
    {"name": "Provisional un-adopted Financial statements"},
    {"name": "Adopted Financial statements"},
    {"name": "Revised Financial statements u/s 130"},
    {"name": "Revised Financial statements u/s 131"}
  ],
  "error": ""
}
```

#### `MCA_NAT_REVISION` — Revision scope (only after selecting Revised above)

```json
{
  "Message": null,
  "data": [
    {"name": "Financial Statement"},
    {"name": "Director Report"},
    {"name": "Both"}
  ],
  "error": ""
}
```

#### `MCA_SUBSIDARY` — Subsidiary classification (note typo: `SUBSIDARY` not `SUBSIDIARY`)

```json
{
  "Message": null,
  "data": [
    {"name": "Section 2(87)(i)"},
    {"name": "Section 2(87)(ii)"}
  ],
  "error": ""
}
```

#### `MCA_AOC_DESIG` — Signatory designation

```json
{
  "Message": null,
  "data": [
    {"name": "Director"}, {"name": "Manager"}, {"name": "Secretary"},
    {"name": "CEO"}, {"name": "CFO"}, {"name": "IRP/RP/Liquidator"}
  ],
  "error": ""
}
```

#### `COUNTRY` — Country list

240+ entries. Spelling/formatting differs slightly from the `commonlookuphigh` COUNTRY list — these are NOT interchangeable. See full list in `.artifacts/aoc4-api-responses-full.json`. Highlights:

- `Korea` and `Korea, Democratic People's Rep` (cf. `commonlookuphigh` returns `Korea, North` and `Korea, South`)
- `USA` (cf. `commonlookuphigh` returns `United States`)
- `Viet Nam` (cf. `commonlookuphigh` returns `Vietnam`)

---

## 5. `GET /common/service/lookup/high/1.0.0`

Two FDM models point at this operation.

### `aoc4/commonlookuphigh` — alternate country list

Same 240+ countries as `MCA_AOC_USERREQ COUNTRY` but with different spellings (`United States`, `Korea, North`, `Vietnam`). Different fields validate against this vs. the userhintquestion list. Don't mix.

### `user-resigtration-login/get-industry-list` (sic: 'resigtration')

Top-level industry classification for AOC-4. Five buckets:

```json
{
  "data": [
    {"name": "Commercial & Industrial"},
    {"name": "Banking Company"},
    {"name": "Insurance Company"},
    {"name": "Power Company"},
    {"name": "Non banking Financial Company (NBFC) registered with RBI"}
  ],
  "error": "",
  "message": "Data fetched Successfully"
}
```

The selected industry drives which downstream balance-sheet schedule (panel3 / panel5) the form renders. Banking, Insurance, Power, NBFC each have their own schedule formats — Commercial & Industrial uses Schedule III standard.

---

## 6. `GET /interactivedashboard/service/getdocumentlinkedforms/1.0.0`

**FDM**: `/content/dam/formsanddocuments-fdm/aoc4/getdmsid`

**Purpose**: when a previous AOC-4 was filed for the same financial year, this returns the linked forms (CSR-2, AOC-1, AOC-2, etc.) so the new filing can reference them.

### Empty SRN (captured)

Input: `{ "referenceNumber": "" }`

Response:

```json
{ "data": null, "message": "No Data" }
```

### Populated SRN (inferred — not yet captured)

Input: `{ "referenceNumber": "P12345678" }` (an MCA SRN)

Response (expected):

```jsonc
{
  "data": [
    {
      "linkedFormName": "CSR-2",
      "linkedSRN": "...",
      "filingDate": "...",
      "status": "Approved"
    }
    // ...
  ],
  "message": "Data Fetched Successfully"
}
```

Capture pending — needs a real SRN from a prior AOC-4 filing.

---

## Lookup type strings (complete list discovered so far)

| Type | Used by | Returns |
|---|---|---|
| `MCA_NATURE_CONSOL` | userhintquestion | 4 financial statement types |
| `MCA_NAT_REVISION` | userhintquestion | 3 revision scopes |
| `MCA_SUBSIDARY` (sic) | userhintquestion | 2 subsidiary clauses |
| `MCA_AOC_DESIG` | userhintquestion | 6 designations |
| `COUNTRY` | userhintquestion (or commonlookuphigh — different lists!) | 240+ countries |
| `MCA_AOC4_INDUSTRY_TYPE` | get-industry-list | 5 industry buckets |

Other `MCA_*` strings likely exist for non-AOC-4 forms (DIR-3, MGT-7, etc.) — discover by walking those forms.

---

## Capturing more responses

The `runner.ts` orchestrator hooks `page.on('response')` automatically and writes captures to `.artifacts/runs/<timestamp>/load-network.json` for any URL matching `/\.af\.dermis|\/bin\/mca\/|\.af\.internalsubmit/`.

To reproduce a full capture:

```bash
npm run aoc4:capture
# writes lookups-snapshot.json + initial-form-data.json + load-network.json
```

To capture from a Business User account, set `MCA_USER_ID` to a Business User email in `.env` and re-run.

---

## Outstanding captures (priority order)

1. **`companyInfo` with populated `companyInfo[]`** — Business User account.
2. **`.af.internalsubmit.jsp`** — clicking any panel's Save button.
3. **`getDmsId` with real SRN** — second AOC-4 filing for the same FY.
4. **DSC verification XHR** — from the `uploadAndVerifyDSC` panel.
5. **Validation error response** — submit with a deliberately invalid value to capture the error popup's underlying response.
