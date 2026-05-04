import 'dotenv/config';
import * as fs from 'node:fs';
import { launch, persistSession, teardown } from './browser.js';
import { login } from './login.js';
import { startRegistration } from './register.js';
import { URLS } from './selectors.js';
import { walkAndPersist } from './aoc4/tree-walker.js';
import { loadAOC4Form, captureOnly, runFiling, prefillFromUserInfo } from './aoc4/runner.js';

const cmd = process.argv[2];
const env = (k: string, d?: string) => process.env[k] ?? d;
const ts = () => new Date().toISOString().split('T')[1].slice(0, 12);

async function runLogin() {
  const userId = env('MCA_USER_ID');
  const password = env('MCA_PASSWORD');
  if (!userId || !password) {
    console.error('Missing MCA_USER_ID / MCA_PASSWORD in .env');
    process.exit(2);
  }
  const { browser, context, page } = await launch({ loadSession: false });
  try {
    console.log(`[${ts()}] [login] submitting credentials for ${userId}`);
    const result = await login(page, { userId, password }, {
      onStep: (obs) => {
        console.log(`[${ts()}] [login] step → ${obs.step}${obs.errorMessage ? ` (${obs.errorMessage})` : ''}  @ ${obs.url}`);
        if (obs.step === 'captcha') console.log('   ↳ auto-solving via Gemini if OPENROUTER_API_KEY set, else solve manually');
        if (obs.step === 'otp') console.log('   ↳ enter the OTP in the open browser');
      },
    });
    if (result.step === 'logged-in') {
      await persistSession(context);
      console.log(`[${ts()}] [login] logged in. session persisted to ./storage-state.json`);
      console.log(`[${ts()}] [login] landed at: ${result.url}`);
      console.log(`[${ts()}] [login] press Ctrl+C to exit`);
      await new Promise(() => {});
    } else if (result.step === 'invalid-credentials') {
      console.error(`[${ts()}] [login] invalid credentials: ${result.errorMessage}`);
      process.exit(1);
    } else {
      console.error(`[${ts()}] [login] unexpected outcome: ${result.step}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`[${ts()}] [login] error:`, e);
    await teardown(browser);
    process.exit(1);
  }
}

async function runRegister() {
  const userId = env('MCA_USER_ID');
  const password = env('MCA_PASSWORD');
  if (!userId || !password) {
    console.error('Missing MCA_USER_ID / MCA_PASSWORD in .env');
    process.exit(2);
  }
  const { browser, page } = await launch({ loadSession: false });
  try {
    const outcome = await startRegistration(page, { userId, password, autofillPasswords: false });
    console.log(`[${ts()}] [register]`, outcome);
    console.log(`[${ts()}] [register] press Ctrl+C when finished`);
    await new Promise(() => {});
  } catch (e) {
    console.error(`[${ts()}] [register] error:`, e);
    await teardown(browser);
    process.exit(1);
  }
}

async function runExplore() {
  const { page } = await launch();
  await page.goto(URLS.HOME, { waitUntil: 'domcontentloaded' });
  console.log(`[${ts()}] [explore] browser open at MCA home. Drive manually. Ctrl+C to exit.`);
  await new Promise(() => {});
}

async function runAoc4Walk() {
  if (!fs.existsSync('./storage-state.json')) {
    console.error('No storage-state.json — run `npm run login` first');
    process.exit(2);
  }
  const { browser, page } = await launch();
  try {
    const { artifactDir } = await loadAOC4Form(page);
    console.log(`[${ts()}] [aoc4:walk] form loaded — walking tree`);
    const result = await walkAndPersist(page, './.artifacts');
    console.log(`[${ts()}] [aoc4:walk] ${result.inputCount} input fields across ${Object.keys(result.byPanel).length} panels`);
    console.log(JSON.stringify(result.byPanel, null, 2));
    console.log(`[${ts()}] [aoc4:walk] artifacts written to ./.artifacts and run logs to ${artifactDir}`);
  } finally { await teardown(browser); }
}

async function runAoc4Capture() {
  if (!fs.existsSync('./storage-state.json')) {
    console.error('No storage-state.json — run `npm run login` first');
    process.exit(2);
  }
  const { browser, page } = await launch();
  try {
    const { artifactDir } = await captureOnly(page);
    console.log(`[${ts()}] [aoc4:capture] FDM lookups + form data captured to ${artifactDir}`);
  } finally { await teardown(browser); }
}

async function runAoc4Prefill() {
  if (!fs.existsSync('./storage-state.json')) {
    console.error('No storage-state.json — run `npm run login` first');
    process.exit(2);
  }
  const userId = env('MCA_USER_ID');
  if (!userId) { console.error('Missing MCA_USER_ID'); process.exit(2); }
  const { browser, page } = await launch();
  try {
    const { artifactDir } = await loadAOC4Form(page);
    console.log(`[${ts()}] [aoc4:prefill] form loaded`);
    const data = await prefillFromUserInfo(page, userId.toUpperCase());
    fs.writeFileSync(`${artifactDir}/companyInfo.json`, JSON.stringify(data, null, 2));
    console.log(`[${ts()}] [aoc4:prefill] companyInfo:`, JSON.stringify({
      userCategory: data?.data?.userInfo?.userCategory,
      mcaUserType: data?.data?.userInfo?.mcaUserType,
      companies: data?.data?.companyInfo?.length ?? 0,
    }));
    console.log(`[${ts()}] [aoc4:prefill] full response in ${artifactDir}/companyInfo.json`);
  } finally { await teardown(browser); }
}

async function runAoc4Open() {
  if (!fs.existsSync('./storage-state.json')) {
    console.error('No storage-state.json — run `npm run login` first');
    process.exit(2);
  }
  const { page } = await launch();
  await loadAOC4Form(page, { captureLookups: false });
  console.log(`[${ts()}] [aoc4:open] form is open. Drive manually. Ctrl+C to exit.`);
  await new Promise(() => {});
}

async function runAoc4Fill() {
  const dataPath = process.argv[3];
  if (!dataPath || !fs.existsSync(dataPath)) {
    console.error('Usage: npm run aoc4:fill -- <path-to-filing-data.json>');
    process.exit(2);
  }
  if (!fs.existsSync('./storage-state.json')) {
    console.error('No storage-state.json — run `npm run login` first');
    process.exit(2);
  }
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const { browser, page } = await launch();
  try {
    const { artifactDir } = await runFiling(page, data, {
      fieldMapPath: './.artifacts/aoc4-field-map.json',
      captureLookups: true,
    });
    console.log(`[${ts()}] [aoc4:fill] done. Artifacts in ${artifactDir}`);
    console.log(`[${ts()}] [aoc4:fill] form is open at the Save/Submit point — plug in DSC and submit manually.`);
    await new Promise(() => {});
  } catch (e) {
    console.error(`[${ts()}] [aoc4:fill] error:`, e);
    await teardown(browser);
    process.exit(1);
  }
}

(async () => {
  switch (cmd) {
    case 'login': await runLogin(); break;
    case 'register': await runRegister(); break;
    case 'explore': await runExplore(); break;
    case 'aoc4:open': await runAoc4Open(); break;
    case 'aoc4:walk': await runAoc4Walk(); break;
    case 'aoc4:capture': await runAoc4Capture(); break;
    case 'aoc4:prefill': await runAoc4Prefill(); break;
    case 'aoc4:fill': await runAoc4Fill(); break;
    default:
      console.log('Usage: npm run [login|register|explore|aoc4:open|aoc4:walk|aoc4:capture|aoc4:prefill|aoc4:fill]');
      process.exit(2);
  }
})();
