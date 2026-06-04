/**
 * Stable selectors for the MCA V3 fologin.html page (AEM Adaptive Forms).
 * Component IDs (panel_1846244155 etc.) are design-time, so they survive across sessions.
 * If MCA reauthors the form they will change — keep this file as the single update site.
 */

export const URLS = {
  HOME: 'https://www.mca.gov.in/',
  LOGIN: 'https://www.mca.gov.in/content/mca/global/en/foportal/fologin.html',
} as const;

export const LOGIN = {
  USER_ID: '#guideContainer-rootPanel-panel_1846244155-guidetextbox___widget',
  PASSWORD: '#guideContainer-rootPanel-panel_1846244155-guidepasswordbox___widget',
  LOGIN_BTN: '#guideContainer-rootPanel-panel_1846244155-submit___widget',
  REGISTER_BTN: '#guideContainer-rootPanel-panel_1846244155-submit_2093963653___widget',
  V2_VPD_BTN: '#guideContainer-rootPanel-panel_1846244155-submit_copy___widget',
  CSRF_TOKEN: '#csrfToken',
} as const;

/**
 * Registration is a multi-panel flow on the same fologin.html page.
 * Each step lives inside `guideContainer-rootPanel-panel_1260208513-...`.
 */
export const REGISTER = {
  // Step 1: confirm user-category panel
  CONFIRM_BTN: '#guideContainer-rootPanel-panel_1260208513-panel1616149598607-panel-panel_1985138084-panel-nextitemnav___widget',
  CANCEL_BTN: '#guideContainer-rootPanel-panel_1260208513-panel1616149598607-panel-panel_1985138084-panel-previtemnav___widget',
  USER_ID_FIELD: '#guideContainer-rootPanel-panel_1260208513-panel1616149598607-panel-panel_1985138084-panel-guidetextbox___widget',

  // Step 2: set + confirm password
  PASSWORD_FIELD: '#guideContainer-rootPanel-panel_1260208513-panel1616149598607-panel1614245041416-panel_1594807323-panel-guidepasswordbox___widget',
  PASSWORD_CONFIRM_FIELD: '#guideContainer-rootPanel-panel_1260208513-panel1616149598607-panel1614245041416-panel_1594807323-panel-guidepasswordbox_867___widget',
  CONFIRM_PASSWORD_BTN: '#guideContainer-rootPanel-panel_1260208513-panel1616149598607-panel1614245041416-panel_1594807323-nextitemnav___widget',
  PASSWORD_BACK_BTN: '#guideContainer-rootPanel-panel_1260208513-panel1616149598607-panel1614245041416-panel-previtemnav_24539204___widget',

  // Captcha (appears within the registration / certain login flows)
  CAPTCHA_INPUT: '#customCaptchaInput',

  // Confirmation modals
  YES_BTN: '#guideContainer-rootPanel-modal_container_copy-nextitemnav_copy_cop___widget',
  NO_BTN: '#guideContainer-rootPanel-modal_container_copy-nextitemnav_copy___widget',
  CONTINUE_BTN: '#guideContainer-rootPanel-modal_container_copy_984288898-nextitemnav_copy___widget',
} as const;

/**
 * "You already have an active session. Logging in here again will end that
 * session. Do you want to continue?" modal on the MCA V3 login screen.
 * Confirmed live 2026-06-04 via DOM capture.
 *
 * The YES button (continue / end the other session) carries the stable author
 * class `killSession`; NO carries `okButton`. Prefer the class-based selector —
 * an author-assigned class survives AEM re-id'ing far better than the
 * auto-generated `modal_container_copy-...` panel id, and — critically — it
 * cannot be confused with the NO button (the two ids differ by a single `_cop`).
 */
export const SESSION_CONFLICT = {
  MODAL:        '#guideContainer-rootPanel-modal_container_copy__',
  YES_BY_CLASS: '.killSession button',                                                    // ← preferred
  YES_BTN:      '#guideContainer-rootPanel-modal_container_copy-nextitemnav_copy_cop___widget',
  YES_BY_ARIA:  'button[aria-label="Yes"]',
  NO_BY_CLASS:  '.okButton button',
  NO_BTN:       '#guideContainer-rootPanel-modal_container_copy-nextitemnav_copy___widget',
} as const;
