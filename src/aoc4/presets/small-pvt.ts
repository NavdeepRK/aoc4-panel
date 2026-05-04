/**
 * AOC-4 preset for the 99%-case RegisterKaro client:
 *   - Private Limited or One Person Company (OPC)
 *   - Revenue < ₹1 crore
 *   - Below CSR threshold (Companies Act §135 — needs ₹500 cr turnover / ₹1000 cr net worth / ₹5 cr profit)
 *   - Schedule III applies (not Banking / Insurance / Power / NBFC)
 *   - No subsidiaries / associates / joint ventures
 *   - Listed: No
 *   - INC-20A already filed (or company exempt)
 *
 * For these companies the AOC-4 form's conditional radio chain collapses to mostly "No" / first-option,
 * which makes per-field setProperty drives reliable.
 *
 * Radio values come from the form's `node.jsonModel.options` array — format `"<index>=<label>"`.
 * The VALUE to write is the LHS index as a string, NOT the label. See lessons §5c.
 */

export interface SmallPvtFiling {
  /** CIN, e.g. "U62090HR2025PTC132910" */
  cin: string;
  /** Financial year start, ISO yyyy-MM-dd */
  financialYearFrom: string;
  /** Financial year end, ISO yyyy-MM-dd */
  financialYearTo: string;
  /** Date of board meeting in which financial statements were approved */
  boardMeetingFsApprovalDate: string;
  /** Date of board meeting in which board's report was approved (often same as FS approval) */
  boardMeetingReportDate: string;
  /** Date the auditor signed the audit report (must be ≥ boardMeetingFsApprovalDate per validateExp) */
  auditorSigningDate: string;
  /** Date of AGM (must be ≥ all the above, ≤ today) */
  agmDate: string;
  /** Due date of AGM per Companies Act §96 — usually 6 months from FY end (or 9 months for first AGM) */
  agmDueDate: string;
  /** Number of members (usually = number of directors for small Pvt) */
  numberOfMembers: number;
  /** Directors — 1-5 entries */
  directors: Array<{
    din: string;
    /** "Director" | "Managing Director" | "Whole-time director" | etc. */
    designation: string;
  }>;
  /** Director who signs the FS (typically a director from the list above; default = first) */
  fsSignerDirectorIndex?: number;
  /** Auditor info */
  auditor: AuditorInfo;
  /** "Adopted Financial statements" (default for normal annual filing) | other natureS option */
  natureOfFinancialStatements?: 'Adopted Financial statements' | 'Provisional un-adopted Financial statements' | 'Revised Financial statements u/s 130' | 'Revised Financial statements u/s 131';
}

export interface AuditorInfo {
  srnOfAdt1: string;
  pan: string;
  /** "Individual" | "Auditor's firm" */
  category: 'Individual' | "Auditor's firm";
  /** ICAI membership number for individual, or FRN (e.g. "001122N") for firm */
  membershipNumber: string;
  name: string;
  address: {
    line1: string;
    line2?: string;
    country: string;
    pincode: string;
    city: string;
    district?: string;
    state: string;
  };
  /** When category = firm: name + membership of the partner signing on behalf of the firm */
  signingMember?: { name: string; membershipNumber: string };
}

/**
 * Panel-level field values for the 99% small-Pvt/OPC scenario.
 *
 * Keys are AEM field names (the values written via setProperty). Values are either:
 *  - Radio/dropdown index strings ("0", "1", "2") matching `jsonModel.options[i].split('=')[0]`
 *  - Or literal text/numbers/dates
 *
 * Convention: `__skip` means "do not write this field — let it stay default/auto-prefilled".
 */
export const SMALL_PVT_PANEL1_DEFAULTS: Record<string, string | '__skip'> = {
  // === General company info — most of these come from prefillWithCin ===
  // (CIN, name, address, email, authorizedCapital are auto-populated)

  // === Financial year / approval dates — supplied per-filing ===
  // fromDate, toDate, dateOfBoardForFsApproval, DateOfBoard, dateOfSigningOfReports — set per-filing

  // === Section 4(b) — Nature of FS ===
  // natureS — set to "Adopted Financial statements" (literal label, not index — confirmed working earlier)

  // (iii) Whether provisional FS filed earlier:                       NO for first-time filer
  wetherProFinancialStatement: '1', // 1 = No (was '0' = Yes — wrong for small Pvt first-filer)
  // (iv) Whether adopted in adjourned AGM:                            NO for normal filing
  whetherAdoptedAdjAGM: '1', // 1 = No
  // (v) Date of adjourned AGM:                                        skip (only mandatory if (iv) = Yes)
  dateOfAdjAGM: '__skip',
  // (vii) SRN of form AOC-4:                                          skip (only mandatory for revisions)
  srnOfFormAOC: '__skip',

  // === Section 7 — AGM ===
  // (a) AGM held:                                                     YES for active companies
  whetherAnnualGeneralMeeting: '0', // 0 = Yes
  // (d) Whether extension granted:                                    NO (typical small Pvt)
  whetherAnyExtension: '1', // 1 = No
  // (e) SRN of GNL-1 (extension SRN):                                 skip if no extension
  // (f) Extended due date:                                            skip if no extension

  // === Section 8 — Subsidiary status ===
  // (a) Whether subsidiary company:                                   NO for typical small Pvt
  whetherSubsidiary: '1', // 1 = No (field name TBC — verify against live form)
  // (e) Whether company has subsidiary/associate/JV:                  NO for typical small Pvt
  whetherSubsidiaryAssociate: '1', // 1 = No (field name TBC)
};

/**
 * Panel-2 radio/dropdown semantic names (industryType, scheduleIIIApplicable, etc.) are NOT
 * present in the auto-generated `PANEL2_FIELDS` map because the tree-walker filtered them out.
 * Re-walk with `includeStatic: true` (or expand the type filter in `walkLeaves`) to populate
 * them. Until then, the runner skips these keys silently — callers should treat them as TODO.
 */
export const SMALL_PVT_PANEL2_DEFAULTS_TODO_RADIOS: Record<string, string | '__skip'> = {
  // === Section 10 — General Info ===
  industryType: 'Commercial & Industrial', // dropdown — name TBC
  scheduleIIIApplicable: '0',               // 0 = Yes — radio — name TBC
  // === Section 11 — Consolidated FS ===
  whetherConsolidated: '1',                 // 1 = No (no subsidiaries) — radio — name TBC
  // === Section 12 — Books in electronic form ===
  booksElectronic: '0',                     // 0 = Yes (modern small Pvt) — radio — name TBC
};

/** Auditor-section text/dropdown defaults that DO map to PANEL2_FIELDS. */
export const SMALL_PVT_PANEL2_DEFAULTS: Record<string, string | '__skip'> = {
  // (Auditor + general-info fields supplied per-filing — see AuditorInfo)
  // No radios here — those live in SMALL_PVT_PANEL2_DEFAULTS_TODO_RADIOS until the field map
  // is expanded.
};

/**
 * Balance Sheet (Part B) — for a newly-incorporated small Pvt with paid-up capital sitting as cash.
 * All values in absolute Rupees. Generates a balanced minimal balance sheet.
 *
 * For an active company with operations, replace with real trial-balance-derived figures.
 */
export interface BalanceSheetMinimal {
  /** Issued/subscribed/paid-up share capital (matches companyInfo.paidupCaptail) */
  shareCapital: number;
  /** Reserves and surplus (typically 0 for new company) */
  reserves: number;
  /** Cash + bank balance (must balance assets = equity for the minimal case) */
  cashAndEquivalents: number;
}

export function buildBalanceSheet(values: BalanceSheetMinimal): Record<string, string> {
  const total = values.shareCapital + values.reserves;
  const totalStr = total.toFixed(2);
  const cashStr = values.cashAndEquivalents.toFixed(2);
  return {
    // Equity & Liabilities
    shareCapitalCurrentDate: values.shareCapital.toFixed(2),
    reservesAndSurplusCurrentDate: values.reserves.toFixed(2),
    totalEquityLiabCurrentDate: totalStr,
    // Assets — minimal: just cash
    cashAndCashEquivalentsCurrentDate: cashStr,
    totalAssetsCurrentDate: totalStr,
    // Previous year — 0 for first FY
    shareCapitalPreviousDate: '0.00',
    reservesAndSurplusPreviousDate: '0.00',
    totalEquityLiabPreviousDate: '0.00',
    cashAndCashEquivalentsPreviousDate: '0.00',
    totalAssetsPreviousDate: '0.00',
  };
}

/**
 * P&L (Part B) — for a newly-incorporated company with no operations yet.
 * Replace with real figures for active companies.
 */
export const PNL_MINIMAL: Record<string, string> = {
  revenueFromOperationsCurrent: '0.00',
  revenueFromOperationsPrevious: '0.00',
  totalRevenueCurrent: '0.00',
  totalRevenuePrevious: '0.00',
  totalExpensesCurrent: '0.00',
  totalExpensesPrevious: '0.00',
  profitBeforeTaxCurrent: '0.00',
  profitBeforeTaxPrevious: '0.00',
  profitAfterTaxCurrent: '0.00',
  profitAfterTaxPrevious: '0.00',
};

/** CSR section — all "Not applicable" for sub-threshold companies */
export const CSR_NOT_APPLICABLE: Record<string, string> = {
  csrApplicability: 'Not applicable',
};

/** Default secretarial audit / cost records for small Pvt — both not applicable */
export const COMPLIANCE_NOT_APPLICABLE: Record<string, string> = {
  secretarialAudit: '1', // 1 = No
  costRecordsMandatory: '1', // 1 = No
};

/** Related party transactions — typical small Pvt has none */
export const RPT_NONE: Record<string, string> = {
  whetherRelatedPartyTransactions: '1', // 1 = No
};

/**
 * Builds a full AOC-4 fill plan for a small-Pvt/OPC client.
 * Returns a panel-by-panel field-name → value map.
 */
export function buildSmallPvtFillPlan(filing: SmallPvtFiling, balanceSheet: BalanceSheetMinimal): {
  panel1: Record<string, string>;
  panel2: Record<string, string>;
  panel3: Record<string, string>;
  panel5: Record<string, string>;
  panel6: Record<string, string>;
  panel7: Record<string, string>;
  signatoryRows: { dt1: Array<{ din: string; designation: string; date: string }>; t2: Array<{ din: string; designation: string; date: string }> };
} {
  const fsSignerIdx = filing.fsSignerDirectorIndex ?? 0;
  const fsSigner = filing.directors[fsSignerIdx];

  const panel1: Record<string, string> = {
    fromDate: filing.financialYearFrom,
    toDate: filing.financialYearTo,
    textbox1643785189026: filing.boardMeetingFsApprovalDate, // Board meeting for FS approval
    DateOfBoard: filing.boardMeetingReportDate, // Board meeting for board's report
    dateOfSigningOfReports: filing.auditorSigningDate,
    natureS: filing.natureOfFinancialStatements ?? 'Adopted Financial statements',
    numberOfMembers: String(filing.numberOfMembers),
    ifyesDateOfAGM: filing.agmDate,
    dueDateOfAGM: filing.agmDueDate,
    ...Object.fromEntries(Object.entries(SMALL_PVT_PANEL1_DEFAULTS).filter(([, v]) => v !== '__skip')),
  };

  // Field names below correspond exactly to PANEL2_FIELDS keys (auto-generated from the form walk).
  // Radio fields (auditorCategory, scheduleIIIApplicable, whetherConsolidated, booksElectronic,
  // industryType) are tracked in SMALL_PVT_PANEL2_DEFAULTS_TODO_RADIOS and applied separately
  // by the runner once the field map is expanded.
  const panel2: Record<string, string> = {
    ...SMALL_PVT_PANEL2_DEFAULTS,
    // Auditor section — the keys on the right are real PANEL2_FIELDS keys
    SRNOfFormADT1: filing.auditor.srnOfAdt1,
    numberAuditors: '1',
    incomeTaxOfAuditor: filing.auditor.pan,
    membershipNumberOfAuditor: filing.auditor.membershipNumber,
    nameOfTheAuditor: filing.auditor.name,
    addressLine1_Auditor: filing.auditor.address.line1,
    addressLine2_Auditor: filing.auditor.address.line2 ?? '',
    pinCode_Auditor: filing.auditor.address.pincode,
    city_Auditor: filing.auditor.address.city,
    district_Auditor: filing.auditor.address.district ?? '',
    state_Auditor: filing.auditor.address.state,
    ...(filing.auditor.signingMember ? {
      nameOfMember: filing.auditor.signingMember.name,
      membershipNumber_Auditor: filing.auditor.signingMember.membershipNumber,
    } : {}),
  };

  const panel3 = buildBalanceSheet(balanceSheet);
  const panel5 = { ...PNL_MINIMAL };
  const panel6 = { ...RPT_NONE };
  const panel7 = { ...CSR_NOT_APPLICABLE, ...COMPLIANCE_NOT_APPLICABLE };

  return {
    panel1, panel2, panel3, panel5, panel6, panel7,
    signatoryRows: {
      dt1: [{ din: fsSigner.din, designation: fsSigner.designation, date: filing.boardMeetingFsApprovalDate }],
      t2: filing.directors.map(d => ({ din: d.din, designation: d.designation, date: filing.boardMeetingReportDate })),
    },
  };
}

/** SCALEVERGE-specific test data using realistic dummies for first-FY filing. */
export const SCALEVERGE_TEST_FILING: SmallPvtFiling = {
  cin: 'U62090HR2025PTC132910',
  financialYearFrom: '2025-06-06',
  financialYearTo: '2026-03-31',
  boardMeetingFsApprovalDate: '2026-04-10',
  boardMeetingReportDate: '2026-04-10',
  auditorSigningDate: '2026-04-10',
  agmDate: '2026-04-15',
  agmDueDate: '2026-12-31', // First AGM has 9-month grace period (Companies Act §96(1))
  numberOfMembers: 2,
  directors: [
    { din: '11142612', designation: 'Director' }, // SURBHI
    { din: '11142613', designation: 'Director' }, // BANOTH VINOD KUMAR
  ],
  natureOfFinancialStatements: 'Adopted Financial statements',
  auditor: {
    srnOfAdt1: 'P00000000', // Placeholder — replace with actual ADT-1 SRN before filing
    pan: 'AAACA0000A',
    category: "Auditor's firm",
    membershipNumber: '001122N', // Sample FRN format
    name: 'ABC AND ASSOCIATES',
    address: {
      line1: 'PLACEHOLDER',
      country: 'India',
      pincode: '110001',
      city: 'New Delhi',
      state: 'Delhi',
    },
    signingMember: { name: 'PLACEHOLDER CA', membershipNumber: '123456' },
  },
};

export const SCALEVERGE_BALANCE_SHEET: BalanceSheetMinimal = {
  shareCapital: 10000, // = paid-up capital from companyInfo
  reserves: 0,
  cashAndEquivalents: 10000, // matches share capital — balanced
};
