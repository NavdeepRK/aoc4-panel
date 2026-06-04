/**
 * Run this with: node inspect-popup.mjs
 * Opens headed browser, logs in to MCA, waits for the "already logged in" popup,
 * then dumps its full HTML and all button selectors.
 */
import { chromium } from 'playwright';

const LOGIN_URL = 'https://www.mca.gov.in/content/mca/global/en/foportal/fologin.html';
const USER_ID = 'Registerkaro.info102@gmail.com';
const PASSWORD = 'QWERTY@123';

const USER_ID_SEL = '#guideContainer-rootPanel-panel_1846244155-guidetextbox___widget';
const PASSWORD_SEL = '#guideContainer-rootPanel-panel_1846244155-guidepasswordbox___widget';
const LOGIN_BTN_SEL = '#guideContainer-rootPanel-panel_1846244155-submit___widget';

const browser = await chromium.launch({ headless: false, slowMo: 80 });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

console.log('Navigating to MCA login...');
await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

// --- Check for iframes ---
const frames = page.frames();
console.log(`\nFrames on page (${frames.length}):`);
for (const f of frames) {
  console.log('  frame url:', f.url());
}

// Wait up to 60s for the AEM user-id field to appear in ANY frame
console.log('\nWaiting for AEM login form to appear in any frame...');
let loginFrame = null;
const deadline = Date.now() + 60_000;

while (Date.now() < deadline) {
  for (const f of page.frames()) {
    try {
      const el = await f.$(USER_ID_SEL);
      if (el) {
        loginFrame = f;
        console.log('  Found login form in frame:', f.url());
        break;
      }
    } catch { /* ignore */ }
  }
  if (loginFrame) break;

  // Also check main page
  try {
    const el = await page.$(USER_ID_SEL);
    if (el) {
      loginFrame = page;
      console.log('  Found login form in main page');
      break;
    }
  } catch { /* ignore */ }

  await page.waitForTimeout(1000);
  process.stdout.write('.');
}

if (!loginFrame) {
  // Dump all inputs across all frames for debugging
  console.log('\n\nCould not find login form. Dumping all frames and inputs:');
  for (const f of page.frames()) {
    console.log('\n--- Frame:', f.url());
    try {
      const inputs = await f.evaluate(() =>
        Array.from(document.querySelectorAll('input, button[type="submit"]')).map(el => ({
          id: el.id, type: el.type, placeholder: el.placeholder,
          classes: el.className.slice(0, 60), visible: !!(el.offsetWidth || el.offsetHeight),
        }))
      );
      for (const i of inputs.filter(i => i.visible)) console.log(' ', JSON.stringify(i));
    } catch (e) { console.log('  (error reading frame:', e.message, ')'); }
  }
  console.log('\nBrowser staying open. Ctrl+C to quit.');
  await page.waitForTimeout(120_000);
  await browser.close();
  process.exit(1);
}

// Give AEM a moment to stabilise
await page.waitForTimeout(1500);

console.log('\nFilling credentials...');
await loginFrame.locator(USER_ID_SEL).fill(USER_ID);
await loginFrame.locator(PASSWORD_SEL).fill(PASSWORD);
await loginFrame.locator(LOGIN_BTN_SEL).click();
console.log('Submitted. Watching for popup / captcha / OTP...');
console.log('(Solve captcha manually in the browser window if it appears)');

// Helper: get ALL text across all frames
async function allText() {
  let text = '';
  for (const f of page.frames()) {
    try { text += await f.evaluate(() => document.body.innerText); } catch { /* ignore */ }
  }
  return text;
}

// Helper: dump popup details from all frames
async function dumpPopup() {
  for (const f of page.frames()) {
    try {
      const bodyText = await f.evaluate(() => document.body.innerText).catch(() => '');
      if (!/already\s*(logged|have)\s*(in|an)|active\s*session|end\s*that\s*session|logging\s*in\s*here/i.test(bodyText)) continue;

      console.log('\n========== POPUP DETECTED IN FRAME:', f.url(), '==========');

      // All buttons with IDs
      const buttons = await f.evaluate(() => {
        return Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"], a[href]')).map(el => ({
          tag: el.tagName,
          id: el.id || null,
          text: (el.textContent || el.value || '').trim().slice(0, 100),
          value: el.value || null,
          classes: el.className.slice(0, 100),
          role: el.getAttribute('role'),
          visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
          outerHTML: el.outerHTML.slice(0, 300),
        }));
      });

      console.log('\n--- ALL CLICKABLE ELEMENTS ---');
      for (const b of buttons) console.log(JSON.stringify(b));

      // Elements containing Yes/No text
      const yesNo = await f.evaluate(() => {
        return Array.from(document.querySelectorAll('*'))
          .filter(el => /^\s*(yes|no|continue|ok|proceed|confirm)\s*$/i.test((el.textContent || '').trim()))
          .map(el => ({
            tag: el.tagName, id: el.id,
            text: el.textContent?.trim(),
            classes: el.className.slice(0, 100),
            role: el.getAttribute('role'),
            visible: !!(el.offsetWidth || el.offsetHeight),
            outerHTML: el.outerHTML.slice(0, 400),
          }));
      });
      console.log('\n--- ELEMENTS WITH yes/no/continue/ok TEXT ---');
      for (const e of yesNo) console.log(JSON.stringify(e));

      // The smallest element containing the popup text
      const section = await f.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('div, section, article, form'));
        const match = nodes
          .filter(el => /already\s*(logged|have)\s*(in|an)|active\s*session|end\s*that\s*session/i.test(el.textContent || ''))
          .sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0))[0];
        return match ? match.outerHTML : 'NOT FOUND';
      });
      console.log('\n--- SMALLEST POPUP CONTAINER HTML ---');
      console.log(section.slice(0, 5000));

      return true;
    } catch (e) {
      console.log('Frame dump error:', e.message);
    }
  }
  return false;
}

// Poll for up to 5 minutes
const popupDeadline = Date.now() + 5 * 60_000;
let found = false;
while (Date.now() < popupDeadline) {
  await page.waitForTimeout(1000);
  const text = await allText();
  if (/already\s*(logged|have)\s*(in|an)|active\s*session|end\s*that\s*session|logging\s*in\s*here/i.test(text)) {
    found = await dumpPopup();
    if (found) break;
  }
  process.stdout.write('.');
}

if (!found) console.log('\nPopup not detected within 5 minutes.');

console.log('\nBrowser staying open for manual inspection. Ctrl+C to quit.');
await page.waitForTimeout(120_000);
await browser.close();
