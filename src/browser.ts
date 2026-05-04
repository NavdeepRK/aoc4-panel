import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LaunchOptions {
  headless?: boolean;
  slowMoMs?: number;
  storageStatePath?: string;
  /** When true, attempt to load storage-state.json even if it exists. Default: true. */
  loadSession?: boolean;
}

const env = (k: string, d?: string) => process.env[k] ?? d;
const truthy = (v: string | undefined) => v === 'true' || v === '1';

/**
 * Scripts the MCA portal loads that interfere with automation. Blocked at the route layer
 * so they never reach the page.
 *
 * - clientlib-devtool*: anti-devtool detection that redirects gated pages to /home.html
 * - clientlibs-restrinewtab* / clientlib-restrinewtab*: "restrict new tab" — redirects
 *   direct-URL access (no in-page click) to /application-history.html
 * - clientlib-loginfilter*: gates pages on session-token recency; redirects on perceived
 *   stale session
 *
 * If MCA renames or adds new variants, extend this list.
 */
export const BLOCKED_SCRIPT_PATTERNS = [
  '**/clientlib-devtool*.js*',
  '**/devtool*.js*',
  '**/clientlibs-restrinewtab*.js*',
  '**/clientlib-restrinewtab*.js*',
  '**/clientlib-loginfilter*.js*',
] as const;

export async function launch(opts: LaunchOptions = {}): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const headless = opts.headless ?? truthy(env('HEADLESS'));
  const slowMo = opts.slowMoMs ?? Number(env('SLOW_MO_MS', '0'));
  const storagePath = opts.storageStatePath ?? env('STORAGE_STATE_PATH', './storage-state.json')!;
  const loadSession = opts.loadSession ?? true;

  const browser = await chromium.launch({ headless, slowMo });

  const contextOptions: Parameters<typeof browser.newContext>[0] = {
    viewport: { width: 1366, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
  if (loadSession && storagePath && fs.existsSync(storagePath)) {
    contextOptions.storageState = storagePath;
  }
  const context = await browser.newContext(contextOptions);

  for (const pattern of BLOCKED_SCRIPT_PATTERNS) {
    await context.route(pattern, (route) => route.abort());
  }

  await context.addInitScript(() => {
    const log = (m: string) => {
      try {
        // eslint-disable-next-line no-console
        console.warn('[mca-block]', m);
      } catch {}
    };

    try {
      const proto = Location.prototype;
      for (const fn of ['replace', 'assign'] as const) {
        Object.defineProperty(proto, fn, {
          value: function (u: string) {
            log(`${fn}:${u}`);
          },
          configurable: true,
        });
      }
      const hrefDesc = Object.getOwnPropertyDescriptor(proto, 'href');
      if (hrefDesc?.set) {
        Object.defineProperty(proto, 'href', {
          get: hrefDesc.get,
          set: function (u: string) {
            log(`href:${u}`);
          },
          configurable: true,
        });
      }
    } catch (e) {
      log(`proto:${(e as Error).message}`);
    }

    try { Object.defineProperty(window, 'top', { get: () => window }); } catch {}
    try { Object.defineProperty(window, 'parent', { get: () => window }); } catch {}

    const stripMetaRefresh = () => {
      document
        .querySelectorAll('meta[http-equiv="refresh" i]')
        .forEach((m) => {
          log(`meta:${m.getAttribute('content')}`);
          m.remove();
        });
    };
    document.addEventListener('readystatechange', stripMetaRefresh);
    new MutationObserver(stripMetaRefresh).observe(
      document.documentElement || document,
      { childList: true, subtree: true },
    );

    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
      configurable: true,
    });
  });

  const page = await context.newPage();
  return { browser, context, page };
}

export async function persistSession(context: BrowserContext, storagePath?: string): Promise<void> {
  const target = storagePath ?? env('STORAGE_STATE_PATH', './storage-state.json')!;
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await context.storageState({ path: target });
}

export async function teardown(browser: Browser): Promise<void> {
  await browser.close();
}
