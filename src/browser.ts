import createDebug from 'debug';
import * as puppeteer from 'puppeteer-core';

const log = createDebug('boomer:browser');
const logPool = createDebug('boomer:browser:pool');
const logFetch = createDebug('boomer:browser:fetch');

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
    log('launching Chrome at %s (headless=%s)', this.chromePath, this.headless);
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
          '--disable-dev-shm-usage',
          // Trust self-signed certs on localhost — common for local dev HTTPS servers
          '--allow-insecure-localhost'
        ]
      });

      this.browser.on('disconnected', () => {
        log('Chrome disconnected — restarting in 1 s');
        this.browser = null;
        this.pool = [];
        setTimeout(() => {
          this.launch().catch(err => {
            /* c8 ignore next */
            log('browser restart failed: %O', err);
          });
        }, 1000);
      });

      // Pre-create worker pages
      await Promise.all(Array.from({ length: POOL_SIZE }, () => this.createWorkerPage()));
      log('browser ready, pool size %d', this.pool.length);
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

    // Suppress console noise from worker pages in non-debug mode
    page.on('console', msg => logPool('page console [%s] %s', msg.type(), msg.text()));
    page.on('pageerror', err => logPool('page error: %O', err));

    this.pool.push({ page, busy: false });
    logPool('worker page created (pool size now %d)', this.pool.length);
  }

  private async acquirePage(): Promise<WorkerPage> {
    // Wait for browser to be ready
    while (this.launching) {
      logPool('waiting for browser launch...');
      await new Promise<void>(resolve => {
        this.launchWaiters.push(resolve);
      });
    }

    // Find a free page
    const free = this.pool.find(p => !p.busy);
    if (free) {
      free.busy = true;
      logPool('acquired free page immediately');
      return free;
    }

    // All pages busy — wait for one to become free
    logPool('all %d pages busy — queuing', this.pool.length);
    return new Promise(resolve => {
      const check = () => {
        const available = this.pool.find(p => !p.busy);
        if (available) {
          available.busy = true;
          logPool('acquired previously-busy page');
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
    logFetch('%s %s', opts.method, opts.url);
    const worker = await this.acquirePage();
    const { page } = worker;

    // Register callbacks once per page. Pages are pool-exclusive (one request at a time),
    // so fixed function names are safe. Puppeteer throws if exposeFunction is called twice
    // with the same name, so we guard with a flag on the page object.
    const pageAny = page as any;
    if (!pageAny.__bb_registered) {
      await page.exposeFunction('__bb_responseStart', (status: number, headersJson: string) => {
        const headers = JSON.parse(headersJson) as Record<string, string>;
        pageAny.__bb_onStart?.(status, headers);
      });
      await page.exposeFunction('__bb_chunk', (base64Chunk: string) => {
        const buffer = Buffer.from(base64Chunk, 'base64');
        pageAny.__bb_onChunk?.(buffer);
      });
      await page.exposeFunction('__bb_end', () => {
        pageAny.__bb_onEnd?.();
      });
      await page.exposeFunction('__bb_error', (message: string) => {
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
      logFetch('done %s %s', opts.method, opts.url);
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      log('closing browser');
      const b = this.browser;
      this.browser = null;
      this.pool = [];
      await b.close().catch(err => {
        log('error closing browser: %O', err);
      });
    }
  }
}
