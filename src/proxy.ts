import { Proxy as MitmProxy } from 'http-mitm-proxy';
import type { BrowserManager } from './browser';

export interface ProxyOptions {
  port: number;
  host: string;
  sslCaDir: string;
  browser: BrowserManager;
  verbose?: boolean;
}

export class BoomerProxy {
  private proxy: MitmProxy;
  private opts: ProxyOptions;

  constructor(opts: ProxyOptions) {
    this.opts = opts;
    this.proxy = new MitmProxy();
  }

  async start(): Promise<void> {
    const { port, host, sslCaDir, browser, verbose } = this.opts;

    this.proxy.onError((ctx, err) => {
      if (verbose) {
        const url = ctx?.clientToProxyRequest?.url ?? 'unknown';
        console.error(`[boomer-bypass] proxy error on ${url}:`, err?.message);
      }
      try {
        if (ctx?.proxyToClientResponse && !ctx.proxyToClientResponse.headersSent) {
          ctx.proxyToClientResponse.writeHead(502, { 'content-type': 'text/plain' });
          ctx.proxyToClientResponse.end('502 Bad Gateway');
        }
        /* c8 ignore next 3 */
      } catch {
        // ignore
      }
    });

    this.proxy.onRequest((ctx, _callback) => {
      const req = ctx.clientToProxyRequest;
      const res = ctx.proxyToClientResponse;
      const isSSL = ctx.isSSL;

      const host = req.headers['host'] ?? '';
      const reqUrl = req.url ?? '/';

      // Build full URL
      let fullUrl: string;
      if (reqUrl.startsWith('http://') || reqUrl.startsWith('https://')) {
        /* c8 ignore next */
        fullUrl = reqUrl;
      } else {
        const scheme = isSSL ? 'https' : 'http';
        fullUrl = `${scheme}://${host}${reqUrl}`;
      }

      if (verbose) {
        console.log(`[boomer-bypass] ${req.method} ${fullUrl}`);
      }

      // Collect request body
      const bodyChunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        bodyChunks.push(chunk);
      });

      req.on('end', () => {
        const body = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : undefined;

        // Build headers — filter out proxy-specific headers
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (
            key.toLowerCase() === 'proxy-connection' ||
            key.toLowerCase() === 'proxy-authorization'
          ) {
            continue;
          }
          if (Array.isArray(value)) {
            /* c8 ignore next */
            headers[key] = value.join(', ');
          } else if (value !== undefined) {
            headers[key] = value;
          }
        }

        browser
          .fetch(
            {
              url: fullUrl,
              method: req.method ?? 'GET',
              headers,
              body
            },
            (status, responseHeaders) => {
              // Remove transfer-encoding since we're reconstructing the response
              const cleanHeaders: Record<string, string> = {};
              for (const [k, v] of Object.entries(responseHeaders)) {
                if (k.toLowerCase() === 'transfer-encoding') continue;
                cleanHeaders[k] = v;
              }
              try {
                res.writeHead(status, cleanHeaders);
                /* c8 ignore next 4 */
              } catch (err) {
                if (verbose) {
                  console.error('[boomer-bypass] writeHead error:', err);
                }
              }
            },
            (chunk: Buffer) => {
              try {
                res.write(chunk);
                /* c8 ignore next 2 */
              } catch {
                // client disconnected
              }
            }
          )
          .then(() => {
            try {
              res.end();
              /* c8 ignore next 2 */
            } catch {
              // ignore
            }
          })
          .catch(err => {
            if (verbose) {
              console.error('[boomer-bypass] browser fetch error:', err);
            }
            try {
              if (!res.headersSent) {
                res.writeHead(502, { 'content-type': 'text/plain' });
              }
              res.end('502 Bad Gateway');
              /* c8 ignore next 2 */
            } catch {
              // ignore
            }
          });
      });

      req.on('error', err => {
        /* c8 ignore next 3 */
        if (verbose) {
          console.error('[boomer-bypass] request error:', err);
        }
      });

      // The proxy pauses clientToProxyRequest before calling onRequest.
      // Since we never call callback(), we must resume the stream ourselves.
      req.resume();

      // Do NOT call callback() — we handle the response ourselves
    });

    this.proxy.onWebSocketConnection((ctx, callback) => {
      if (verbose) {
        const url = (ctx.clientToProxyWebSocket as any)?.upgradeReq?.url ?? 'unknown';
        console.log(`[boomer-bypass] WebSocket connection: ${url}`);
      }
      // Pass through natively — do not route through browser
      return callback();
    });

    this.proxy.onWebSocketError((ctx, err) => {
      if (verbose) {
        const url = (ctx.clientToProxyWebSocket as any)?.upgradeReq?.url ?? 'unknown';
        console.error(`[boomer-bypass] WebSocket error on ${url}:`, err?.message);
      }
    });

    return new Promise<void>(resolve => {
      this.proxy.listen(
        {
          port,
          host,
          sslCaDir,
          forceSNI: true
        } as any,
        () => resolve()
      );
    });
  }

  close(): void {
    this.proxy.close();
  }

  getCaCertPath(): string {
    return `${this.opts.sslCaDir}/certs/ca.pem`;
  }
}

export async function startProxy(opts: ProxyOptions): Promise<BoomerProxy> {
  const p = new BoomerProxy(opts);
  await p.start();
  return p;
}
