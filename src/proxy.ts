import * as fs from 'node:fs';
import * as path from 'node:path';
import createDebug from 'debug';
import { Proxy as MitmProxy } from 'http-mitm-proxy';
import type { BrowserManager } from './browser';

const log = createDebug('boomer:proxy');
const logReq = createDebug('boomer:proxy:request');
const logWs = createDebug('boomer:proxy:websocket');

export interface ProxyOptions {
  port: number;
  host: string;
  sslCaDir: string;
  browser: BrowserManager;
  verbose?: boolean;
  caCert?: string;
  caKey?: string;
  caPublicKey?: string;
}

export class BoomerProxy {
  private proxy: MitmProxy;
  private opts: ProxyOptions;

  constructor(opts: ProxyOptions) {
    this.opts = opts;
    this.proxy = new MitmProxy();
  }

  async start(): Promise<void> {
    const { port, host, sslCaDir, browser, verbose, caCert, caKey, caPublicKey } = this.opts;
    log('starting proxy on %s:%d (sslCaDir=%s)', host, port, sslCaDir);

    if (caCert && caKey) {
      log('installing custom CA cert from %s', caCert);
      const certsDir = path.join(sslCaDir, 'certs');
      const keysDir = path.join(sslCaDir, 'keys');
      fs.mkdirSync(certsDir, { recursive: true });
      fs.mkdirSync(keysDir, { recursive: true });
      fs.copyFileSync(caCert, path.join(certsDir, 'ca.pem'));
      fs.copyFileSync(caKey, path.join(keysDir, 'ca.private.key'));
      const publicKeyPath = caPublicKey ?? caKey.replace('ca.private.key', 'ca.public.key');
      fs.copyFileSync(publicKeyPath, path.join(keysDir, 'ca.public.key'));
    }

    this.proxy.onError((ctx, err) => {
      const url = ctx?.clientToProxyRequest?.url ?? 'unknown';
      log('proxy error on %s: %O', url, err);
      if (verbose) {
        process.stderr.write(`[boomer] proxy error on ${url}: ${err?.message}\n`);
      }
      try {
        if (ctx?.proxyToClientResponse && !ctx.proxyToClientResponse.headersSent) {
          ctx.proxyToClientResponse.writeHead(502, { 'content-type': 'text/plain' });
          ctx.proxyToClientResponse.end('502 Bad Gateway');
        }
        /* c8 ignore next 3 */
      } catch (writeErr) {
        log('error writing 502 response: %O', writeErr);
      }
    });

    this.proxy.onRequest((ctx, _callback) => {
      const req = ctx.clientToProxyRequest;
      const res = ctx.proxyToClientResponse;
      const isSSL = ctx.isSSL;

      const host = req.headers['host'] ?? '';
      const reqUrl = req.url ?? '/';

      let fullUrl: string;
      if (reqUrl.startsWith('http://') || reqUrl.startsWith('https://')) {
        /* c8 ignore next */
        fullUrl = reqUrl;
      } else {
        const scheme = isSSL ? 'https' : 'http';
        fullUrl = `${scheme}://${host}${reqUrl}`;
      }

      logReq('%s %s', req.method, fullUrl);
      if (verbose) {
        process.stdout.write(`[boomer] ${req.method} ${fullUrl}\n`);
      }

      const bodyChunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        bodyChunks.push(chunk);
      });

      req.on('end', () => {
        const body = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : undefined;

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
              const cleanHeaders: Record<string, string> = {};
              for (const [k, v] of Object.entries(responseHeaders)) {
                if (k.toLowerCase() === 'transfer-encoding') continue;
                cleanHeaders[k] = v;
              }
              try {
                res.writeHead(status, cleanHeaders);
                /* c8 ignore next 4 */
              } catch (err) {
                log('writeHead error for %s: %O', fullUrl, err);
                if (verbose) {
                  process.stderr.write(`[boomer] writeHead error: ${err}\n`);
                }
              }
            },
            (chunk: Buffer) => {
              try {
                res.write(chunk);
                /* c8 ignore next 3 */
              } catch (writeErr) {
                log('chunk write error (client disconnected?) for %s: %O', fullUrl, writeErr);
              }
            }
          )
          .then(() => {
            try {
              res.end();
              /* c8 ignore next 3 */
            } catch (endErr) {
              log('res.end() error for %s: %O', fullUrl, endErr);
            }
          })
          .catch(err => {
            log('browser fetch error for %s: %O', fullUrl, err);
            if (verbose) {
              process.stderr.write(`[boomer] browser fetch error: ${err}\n`);
            }
            try {
              if (!res.headersSent) {
                res.writeHead(502, { 'content-type': 'text/plain' });
              }
              res.end('502 Bad Gateway');
              /* c8 ignore next 3 */
            } catch (writeErr) {
              log('error writing 502 after fetch failure for %s: %O', fullUrl, writeErr);
            }
          });
      });

      req.on('error', err => {
        /* c8 ignore next 3 */
        log('client request error for %s: %O', fullUrl, err);
        if (verbose) {
          process.stderr.write(`[boomer] request error: ${err}\n`);
        }
      });

      req.resume();
    });

    this.proxy.onWebSocketConnection((ctx, callback) => {
      const wsUrl = (ctx.clientToProxyWebSocket as any)?.upgradeReq?.url ?? 'unknown';
      logWs('connection: %s', wsUrl);
      if (verbose) {
        process.stdout.write(`[boomer] WebSocket connection: ${wsUrl}\n`);
      }
      return callback();
    });

    this.proxy.onWebSocketError((ctx, err) => {
      const wsUrl = (ctx.clientToProxyWebSocket as any)?.upgradeReq?.url ?? 'unknown';
      logWs('error on %s: %O', wsUrl, err);
      if (verbose) {
        process.stderr.write(`[boomer] WebSocket error on ${wsUrl}: ${err?.message}\n`);
      }
    });

    return new Promise<void>((resolve, reject) => {
      this.proxy.listen(
        {
          port,
          host,
          sslCaDir,
          forceSNI: true
        } as any,
        (err?: Error) => {
          if (err) {
            log('listen error: %O', err);
            reject(err);
          } else {
            log('listening on %s:%d', host, port);
            resolve();
          }
        }
      );
    });
  }

  close(): void {
    try {
      log('closing proxy');
      this.proxy.close();
    } catch (err) {
      log('error during proxy.close() (likely no HTTPS traffic yet): %O', err);
    }
  }

  getCaCertPath(): string {
    return this.opts.caCert ?? `${this.opts.sslCaDir}/certs/ca.pem`;
  }
}

export async function startProxy(opts: ProxyOptions): Promise<BoomerProxy> {
  const p = new BoomerProxy(opts);
  await p.start();
  return p;
}
