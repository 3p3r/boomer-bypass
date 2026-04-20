import * as puppeteer from 'puppeteer-core';

export interface RequestOpts {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
}

type OnStartFn = (status: number, headers: Record<string, string>) => void;
type OnChunkFn = (chunk: Buffer) => void;

interface WorkerPage {
  page: puppeteer.Page;
  busy: boolean;
}

const POOL_SIZE = 4;
const CHUNK_SIZE = 65536; // 64KB

export class BrowserManager {
  private browser: puppeteer.Browser | null = null;
  private chromePath: string;
  private headless: boolean;
  private pool: WorkerPage[] = [];
  private launching = false;
  private launchWaiters: Array<() => void> = [];

  constructor(chromePath: string, headless: boolean) {
    this.chromePath = chromePath;
    this.headless = headless;
  }

  async launch(): Promise<void> {
    this.launching = true;
    try {
      this.browser = await puppeteer.launch({
        executablePath: this.chromePath,
        headless: this.headless,
        args: [
          '--no-proxy-server',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage'
        ]
      });

      this.browser.on('disconnected', () => {
        this.browser = null;
        this.pool = [];
        // Auto-restart
        setTimeout(() => {
          this.launch().catch(err => {
            /* c8 ignore next */
            console.error('[boomer-bypass] Browser restart failed:', err);
          });
        }, 1000);
      });

      // Pre-create worker pages
      await Promise.all(Array.from({ length: POOL_SIZE }, () => this.createWorkerPage()));
    } finally {
      this.launching = false;
      const waiters = this.launchWaiters.splice(0);
      for (const waiter of waiters) waiter();
    }
  }

  private async createWorkerPage(): Promise<void> {
    if (!this.browser) return;
    const page = await this.browser.newPage();

    // Navigate to blank
    await page.goto('about:blank');

    // Suppress console errors from worker pages
    page.on('console', () => {});
    page.on('pageerror', () => {});

    this.pool.push({ page, busy: false });
  }

  private async acquirePage(): Promise<WorkerPage> {
    // Wait for browser to be ready
    while (this.launching) {
      await new Promise<void>(resolve => {
        this.launchWaiters.push(resolve);
      });
    }

    // Find a free page
    const free = this.pool.find(p => !p.busy);
    if (free) {
      free.busy = true;
      return free;
    }

    // All pages busy — wait for one to become free
    return new Promise(resolve => {
      const check = () => {
        const available = this.pool.find(p => !p.busy);
        if (available) {
          available.busy = true;
          resolve(available);
        } else {
          setImmediate(check);
        }
      };
      check();
    });
  }

  private releasePage(worker: WorkerPage): void {
    worker.busy = false;
  }

  async fetch(opts: RequestOpts, onStart: OnStartFn, onChunk: OnChunkFn): Promise<void> {
    const worker = await this.acquirePage();
    const { page } = worker;

    // We use a shared queue approach: expose unique per-request callback names
    // to avoid collisions between concurrent requests on different pages.
    // Since pages are exclusive (one request per page from the pool), we can
    // use fixed names per page — they are safe because the page isn't shared.
    const startFnName = '__bb_responseStart';
    const chunkFnName = '__bb_chunk';
    const endFnName = '__bb_end';
    const errorFnName = '__bb_error';

    // Register callbacks (idempotent if already registered — puppeteer throws if re-registered,
    // so we track registration state on the page object)
    const pageAny = page as any;
    if (!pageAny.__bb_registered) {
      await page.exposeFunction(startFnName, (status: number, headersJson: string) => {
        const headers = JSON.parse(headersJson) as Record<string, string>;
        pageAny.__bb_onStart?.(status, headers);
      });
      await page.exposeFunction(chunkFnName, (base64Chunk: string) => {
        const buffer = Buffer.from(base64Chunk, 'base64');
        pageAny.__bb_onChunk?.(buffer);
      });
      await page.exposeFunction(endFnName, () => {
        pageAny.__bb_onEnd?.();
      });
      await page.exposeFunction(errorFnName, (message: string) => {
        pageAny.__bb_onError?.(new Error(message));
      });
      pageAny.__bb_registered = true;
    }

    // Wire up callbacks for this specific request
    pageAny.__bb_onStart = onStart;
    pageAny.__bb_onChunk = onChunk;

    const endPromise = new Promise<void>((resolve, reject) => {
      pageAny.__bb_onEnd = resolve;
      pageAny.__bb_onError = reject;
    });
    // Attach a no-op catch so Node/vitest don't report an unhandled rejection if
    // the error arrives before we reach `await endPromise` below.
    endPromise.catch(() => {});

    try {
      const { url, method, headers, body } = opts;
      const bodyBase64 = body ? body.toString('base64') : null;
      const chunkSize = CHUNK_SIZE;

      await page.evaluate(
        async (
          fetchUrl: string,
          fetchMethod: string,
          fetchHeaders: Record<string, string>,
          fetchBodyBase64: string | null,
          fetchChunkSize: number
        ) => {
          /* c8 ignore start -- executes in Chrome's V8 context, not Node.js */
          const startFn = (globalThis as any).__bb_responseStart;
          const chunkFn = (globalThis as any).__bb_chunk;
          const endFn = (globalThis as any).__bb_end;

          try {
            const init: RequestInit = {
              method: fetchMethod,
              headers: fetchHeaders,
              // Needed so fetch doesn't follow redirects opaquely
              redirect: 'follow'
            };

            if (fetchBodyBase64) {
              // Decode base64 body
              const binaryStr = atob(fetchBodyBase64);
              const bytes = new Uint8Array(binaryStr.length);
              for (let i = 0; i < binaryStr.length; i++) {
                bytes[i] = binaryStr.charCodeAt(i);
              }
              init.body = bytes;
            }

            const response = await fetch(fetchUrl, init);

            // Collect headers
            const responseHeaders: Record<string, string> = {};
            response.headers.forEach((value, key) => {
              responseHeaders[key] = value;
            });

            await startFn(response.status, JSON.stringify(responseHeaders));

            if (!response.body) {
              await endFn();
              return;
            }

            const reader = response.body.getReader();

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              // Stream in chunks to keep base64 overhead manageable
              let offset = 0;
              while (offset < value.byteLength) {
                const slice = value.slice(offset, offset + fetchChunkSize);
                // Convert Uint8Array to base64 string
                let binary = '';
                for (let i = 0; i < slice.byteLength; i++) {
                  binary += String.fromCharCode(slice[i]);
                }
                await chunkFn(btoa(binary));
                offset += fetchChunkSize;
              }
            }

            await endFn();
          } catch (err: any) {
            const errorFn = (globalThis as any).__bb_error;
            await errorFn(err?.message ?? 'fetch failed');
          }
          /* c8 ignore stop */
        },
        url,
        method,
        headers,
        bodyBase64,
        chunkSize
      );

      await endPromise;
    } finally {
      pageAny.__bb_onStart = undefined;
      pageAny.__bb_onChunk = undefined;
      pageAny.__bb_onEnd = undefined;
      pageAny.__bb_onError = undefined;
      this.releasePage(worker);
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      const b = this.browser;
      this.browser = null;
      this.pool = [];
      await b.close().catch(() => {});
    }
  }
}
