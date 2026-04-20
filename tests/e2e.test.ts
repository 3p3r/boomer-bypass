import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { BrowserManager } from '../src/browser';
import { findChromeBrowser } from '../src/chrome/FindChrome';
import { type BoomerProxy, startProxy } from '../src/proxy';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      server.close(err => {
        if (err) reject(err);
        else resolve(addr.port);
      });
    });
  });
}

/** Make an HTTP request through the given proxy, returning status + body */
function proxyRequest(opts: {
  url: string;
  method?: string;
  body?: string;
  proxyHost: string;
  proxyPort: number;
  headers?: Record<string, string>;
  caCert?: Buffer;
}): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const { url, method = 'GET', body, proxyHost, proxyPort, caCert } = opts;
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';

    const doRequest = (socket?: net.Socket) => {
      const path = parsed.pathname + (parsed.search ?? '');
      const reqOpts: http.RequestOptions = {
        method,
        path,
        headers: {
          host: parsed.host,
          ...(body ? { 'content-length': Buffer.byteLength(body).toString() } : {}),
          ...(opts.headers ?? {})
        }
      };

      let req: http.ClientRequest;
      if (isHttps && socket) {
        // HTTPS over CONNECT tunnel
        const tlsSock = require('node:tls').connect({
          socket,
          servername: parsed.hostname,
          rejectUnauthorized: !!caCert,
          ca: caCert
        });
        req = https.request({ ...reqOpts, createConnection: () => tlsSock });
      } else {
        // Plain HTTP through proxy
        req = http.request({
          host: proxyHost,
          port: proxyPort,
          method,
          path: url,
          headers: {
            host: parsed.host,
            ...(body ? { 'content-length': Buffer.byteLength(body).toString() } : {}),
            ...(opts.headers ?? {})
          }
        });
      }

      req.on('response', res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const respHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') respHeaders[k] = v;
            else if (Array.isArray(v)) respHeaders[k] = v.join(', ');
          }
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            headers: respHeaders
          });
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    };

    if (isHttps) {
      // CONNECT tunnel first
      const connectReq = http.request({
        host: proxyHost,
        port: proxyPort,
        method: 'CONNECT',
        path: `${parsed.hostname}:${parsed.port || 443}`
      });
      connectReq.on('connect', (_res, socket) => {
        doRequest(socket);
      });
      connectReq.on('error', reject);
      connectReq.end();
    } else {
      doRequest();
    }
  });
}

/** Proxy a streaming request and collect chunks as they arrive */
function proxyStreamRequest(opts: {
  url: string;
  proxyHost: string;
  proxyPort: number;
  caCert?: Buffer;
}): Promise<{ chunks: Buffer[]; firstChunkTime: number; lastChunkTime: number }> {
  return new Promise((resolve, reject) => {
    const { url, proxyHost, proxyPort } = opts;
    const parsed = new URL(url);

    const req = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'GET',
      path: url,
      headers: { host: parsed.host }
    });

    req.on('response', res => {
      const chunks: Buffer[] = [];
      let firstChunkTime = 0;
      let lastChunkTime = 0;

      res.on('data', (c: Buffer) => {
        if (firstChunkTime === 0) firstChunkTime = Date.now();
        lastChunkTime = Date.now();
        chunks.push(c);
      });
      res.on('end', () => resolve({ chunks, firstChunkTime, lastChunkTime }));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let httpTestServer: http.Server;
let httpsTestServer: https.Server;
let wsTestServer: WebSocketServer;
let wssTestServer: WebSocketServer;
let httpTestPort: number;
let httpsTestPort: number;
let wsTestPort: number;
let wssTestPort: number;
let proxyPort: number;

let browser: BrowserManager;
let proxy: BoomerProxy;
let chromePath: string;

let selfSignedCaCert: Buffer;
let testSslCaDir: string;

beforeAll(async () => {
  // Find Chrome
  chromePath = process.env.CHROME_PATH ?? (await findChromeBrowser()) ?? '';
  if (!chromePath) {
    throw new Error('No Chrome found. Set CHROME_PATH env var or install Chrome/Chromium.');
  }

  // Generate self-signed cert for HTTPS test server (not the proxy CA)
  // We use a pre-generated static cert for simplicity in tests
  const { key, cert } = generateSelfSignedCert();
  selfSignedCaCert = Buffer.from(cert);

  // Allocate ports
  [httpTestPort, httpsTestPort, wsTestPort, wssTestPort, proxyPort] = await Promise.all([
    getFreePort(),
    getFreePort(),
    getFreePort(),
    getFreePort(),
    getFreePort()
  ]);

  // HTTP test server
  httpTestServer = http.createServer(testRequestHandler);
  await new Promise<void>(r => httpTestServer.listen(httpTestPort, '127.0.0.1', r));

  // HTTPS test server
  httpsTestServer = https.createServer({ key, cert }, testRequestHandler);
  await new Promise<void>(r => httpsTestServer.listen(httpsTestPort, '127.0.0.1', r));

  // WS echo server
  wsTestServer = new WebSocketServer({ port: wsTestPort });
  wsTestServer.on('connection', ws => {
    ws.on('message', msg => ws.send(msg));
  });

  // WSS echo server (reuse the https server)
  wssTestServer = new WebSocketServer({ server: httpsTestServer });
  wssTestServer.on('connection', ws => {
    ws.on('message', msg => ws.send(msg));
  });

  // SSL CA dir for proxy
  testSslCaDir = path.join(os.tmpdir(), `bb-test-${Date.now()}`);
  fs.mkdirSync(testSslCaDir, { recursive: true });

  // Launch browser + proxy
  browser = new BrowserManager(chromePath, true);
  await browser.launch();

  proxy = await startProxy({
    port: proxyPort,
    host: '127.0.0.1',
    sslCaDir: testSslCaDir,
    browser,
    verbose: false
  });

  // Wait a moment for proxy to fully initialize
  await new Promise(r => setTimeout(r, 500));
}, 120000);

afterAll(async () => {
  proxy?.close();
  await browser?.close();
  await new Promise<void>(r => httpTestServer?.close(() => r()));
  await new Promise<void>(r => httpsTestServer?.close(() => r()));
  await new Promise<void>(r => wsTestServer?.close(() => r()));
  // Clean up temp dir
  try {
    fs.rmSync(testSslCaDir, { recursive: true });
  } catch {}
}, 30000);

// ---------------------------------------------------------------------------
// Test request handler
// ---------------------------------------------------------------------------

function testRequestHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/ping') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('pong');
    return;
  }

  if (url.pathname === '/method') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(req.method ?? 'UNKNOWN');
    return;
  }

  if (url.pathname === '/query') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(req.url ?? '');
    return;
  }

  if (url.pathname === '/custom-request-header') {
    const val = req.headers['x-test'] ?? 'not-set';
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(Array.isArray(val) ? val.join(',') : val);
    return;
  }

  if (url.pathname === '/custom-response-header') {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'x-custom-response': 'boomer-value'
    });
    res.end('ok');
    return;
  }

  if (url.pathname === '/redirect') {
    res.writeHead(301, { location: '/ping', 'content-type': 'text/plain' });
    res.end('redirecting');
    return;
  }

  if (url.pathname === '/echo') {
    const headers = JSON.stringify(req.headers);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(headers);
    return;
  }

  if (url.pathname === '/stream') {
    const numChunks = 100;
    const chunkData = Buffer.alloc(1024, 'A');
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'x-chunk-count': String(numChunks)
    });
    let sent = 0;
    const sendNext = () => {
      if (sent >= numChunks) {
        res.end();
        return;
      }
      res.write(chunkData);
      sent++;
      setImmediate(sendNext);
    };
    sendNext();
    return;
  }

  if (url.pathname === '/large') {
    const totalBytes = 10 * 1024 * 1024; // 10MB
    const chunkSize = 64 * 1024; // 64KB chunks
    const chunk = Buffer.alloc(chunkSize, 'B');
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(totalBytes)
    });
    let sent = 0;
    const sendNext = () => {
      if (sent >= totalBytes) {
        res.end();
        return;
      }
      const remaining = totalBytes - sent;
      const toSend = remaining < chunkSize ? Buffer.alloc(remaining, 'B') : chunk;
      res.write(toSend);
      sent += toSend.byteLength;
      setImmediate(sendNext);
    };
    sendNext();
    return;
  }

  if (url.pathname === '/body') {
    const bodyChunks: Buffer[] = [];
    req.on('data', (c: Buffer) => bodyChunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(bodyChunks);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(body);
    });
    return;
  }

  if (url.pathname.startsWith('/status/')) {
    const code = Number.parseInt(url.pathname.slice(8), 10);
    res.writeHead(code, { 'content-type': 'text/plain' });
    res.end(`Status ${code}`);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not Found');
}

// ---------------------------------------------------------------------------
// Self-signed cert generation for test HTTPS server
// ---------------------------------------------------------------------------

function generateSelfSignedCert(): { key: string; cert: string } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const forge = require('node-forge') as typeof import('node-forge');

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);

  const attrs = [
    { name: 'commonName', value: 'localhost' },
    { name: 'organizationName', value: 'boomer-bypass test' }
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' }
      ]
    }
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert)
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('boomer-bypass E2E', () => {
  it('HTTP GET - basic request', async () => {
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/echo`,
      proxyHost: '127.0.0.1',
      proxyPort
    });

    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed).toHaveProperty('host');
  }, 30000);

  it('HTTP POST - body echo', async () => {
    const payload = 'hello from post body';
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/body`,
      method: 'POST',
      body: payload,
      proxyHost: '127.0.0.1',
      proxyPort
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe(payload);
  }, 30000);

  it('HTTP status codes - 404', async () => {
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/status/404`,
      proxyHost: '127.0.0.1',
      proxyPort
    });
    expect(result.status).toBe(404);
  }, 30000);

  it('HTTP status codes - 500', async () => {
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/status/500`,
      proxyHost: '127.0.0.1',
      proxyPort
    });
    expect(result.status).toBe(500);
  }, 30000);

  it('HTTP streaming - receives all 100 chunks', async () => {
    const result = await proxyStreamRequest({
      url: `http://127.0.0.1:${httpTestPort}/stream`,
      proxyHost: '127.0.0.1',
      proxyPort
    });

    const totalBytes = result.chunks.reduce((sum, c) => sum + c.byteLength, 0);
    expect(totalBytes).toBe(100 * 1024); // 100 chunks * 1KB
  }, 60000);

  it('HTTP large response - no memory bloat', async () => {
    const before = process.memoryUsage().rss;

    // Request 10MB through proxy
    await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/large`,
      proxyHost: '127.0.0.1',
      proxyPort
    });

    // Force GC if available
    if (global.gc) global.gc();

    const after = process.memoryUsage().rss;
    const growthMB = (after - before) / 1024 / 1024;

    // Should not grow more than 80MB (generous budget for a 10MB transfer + base64 overhead)
    expect(growthMB).toBeLessThan(80);
  }, 60000);

  it('HTTP concurrent requests - 10 parallel', async () => {
    const requests = Array.from({ length: 10 }, (_, i) =>
      proxyRequest({
        url: `http://127.0.0.1:${httpTestPort}/status/${200 + (i % 3 === 0 ? 0 : 0)}`,
        proxyHost: '127.0.0.1',
        proxyPort
      })
    );

    const results = await Promise.all(requests);
    expect(results).toHaveLength(10);
    for (const r of results) expect(r.status).toBe(200);
  }, 60000);

  it('WebSocket passthrough - echo', async () => {
    const received = await new Promise<string>((resolve, reject) => {
      // Connect to WS server through proxy using CONNECT tunnel
      const connectReq = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        method: 'CONNECT',
        path: `127.0.0.1:${wsTestPort}`
      });

      connectReq.on('connect', (_res, socket) => {
        const ws = new WebSocket(`ws://127.0.0.1:${wsTestPort}`, {
          createConnection: () => socket as any
        });

        ws.on('open', () => {
          ws.send('hello websocket');
        });

        ws.on('message', data => {
          ws.close();
          resolve(data.toString());
        });

        ws.on('error', reject);
        setTimeout(() => reject(new Error('WebSocket timeout')), 10000);
      });

      connectReq.on('error', reject);
      connectReq.end();
    });

    expect(received).toBe('hello websocket');
  }, 30000);

  it('Error handling - non-existent host returns 502', async () => {
    const result = await proxyRequest({
      url: 'http://this-host-does-not-exist-at-all.invalid/path',
      proxyHost: '127.0.0.1',
      proxyPort
    });

    expect(result.status).toBe(502);
  }, 30000);
});

// ---------------------------------------------------------------------------
// HTTP Methods
// ---------------------------------------------------------------------------

describe('HTTP Methods', () => {
  it('PUT with body echo', async () => {
    const payload = 'put-payload-data';
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/body`,
      method: 'PUT',
      body: payload,
      proxyHost: '127.0.0.1',
      proxyPort
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe(payload);
  }, 30000);

  it('DELETE method echoed', async () => {
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/method`,
      method: 'DELETE',
      proxyHost: '127.0.0.1',
      proxyPort
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe('DELETE');
  }, 30000);

  it('PATCH with body echo', async () => {
    const payload = JSON.stringify({ op: 'replace', path: '/name', value: 'boomer' });
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/body`,
      method: 'PATCH',
      body: payload,
      headers: { 'content-type': 'application/json' },
      proxyHost: '127.0.0.1',
      proxyPort
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe(payload);
  }, 30000);

  it('GET method echoed', async () => {
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/method`,
      method: 'GET',
      proxyHost: '127.0.0.1',
      proxyPort
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe('GET');
  }, 30000);

  it('POST method echoed', async () => {
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/method`,
      method: 'POST',
      body: '',
      proxyHost: '127.0.0.1',
      proxyPort
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe('POST');
  }, 30000);

  it('binary body round-trip via PUT', async () => {
    // Create a buffer with all 256 byte values
    const binaryBuf = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/body`,
      method: 'PUT',
      body: binaryBuf.toString('binary'),
      proxyHost: '127.0.0.1',
      proxyPort
    });
    expect(result.status).toBe(200);
    // Verify the body came back correctly as binary
    expect(result.body.length).toBe(256);
  }, 30000);
});

// ---------------------------------------------------------------------------
// Headers & Metadata
// ---------------------------------------------------------------------------

describe('Headers and metadata', () => {
  it('custom request header forwarded to server', async () => {
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/custom-request-header`,
      headers: { 'x-test': 'my-value-123' },
      proxyHost: '127.0.0.1',
      proxyPort
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe('my-value-123');
  }, 30000);

  it('custom response header forwarded to client', async () => {
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/custom-response-header`,
      proxyHost: '127.0.0.1',
      proxyPort
    });
    expect(result.status).toBe(200);
    expect(result.headers['x-custom-response']).toBe('boomer-value');
  }, 30000);

  it('query parameters preserved in URL', async () => {
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/query?foo=bar&baz=123`,
      proxyHost: '127.0.0.1',
      proxyPort
    });
    expect(result.status).toBe(200);
    expect(result.body).toContain('foo=bar');
    expect(result.body).toContain('baz=123');
  }, 30000);

  it('proxy-connection header stripped from forwarded request', async () => {
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/echo`,
      headers: { 'proxy-connection': 'keep-alive' },
      proxyHost: '127.0.0.1',
      proxyPort
    });
    expect(result.status).toBe(200);
    const echoed = JSON.parse(result.body);
    // The proxy-connection header must NOT reach the origin server
    expect(echoed).not.toHaveProperty('proxy-connection');
  }, 30000);

  it('content-type response header forwarded', async () => {
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/echo`,
      proxyHost: '127.0.0.1',
      proxyPort
    });
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toContain('application/json');
  }, 30000);
});

// ---------------------------------------------------------------------------
// Status codes
// ---------------------------------------------------------------------------

describe('Status codes', () => {
  it('201 Created', async () => {
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/status/201`,
      proxyHost: '127.0.0.1',
      proxyPort
    });
    expect(result.status).toBe(201);
  }, 30000);

  it('204 No Content', async () => {
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/status/204`,
      proxyHost: '127.0.0.1',
      proxyPort
    });
    expect(result.status).toBe(204);
  }, 30000);

  it('400 Bad Request', async () => {
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/status/400`,
      proxyHost: '127.0.0.1',
      proxyPort
    });
    expect(result.status).toBe(400);
  }, 30000);

  it('403 Forbidden', async () => {
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/status/403`,
      proxyHost: '127.0.0.1',
      proxyPort
    });
    expect(result.status).toBe(403);
  }, 30000);

  it('301 redirect - Chrome follows, returns final 200', async () => {
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/redirect`,
      proxyHost: '127.0.0.1',
      proxyPort
    });
    // Chrome follows the redirect → /ping → 200 "pong"
    expect(result.status).toBe(200);
    expect(result.body).toBe('pong');
  }, 30000);
});

// ---------------------------------------------------------------------------
// Proxy internals
// ---------------------------------------------------------------------------

describe('Proxy internals', () => {
  it('getCaCertPath returns path under sslCaDir', () => {
    const caPath = proxy.getCaCertPath();
    expect(caPath).toContain(testSslCaDir);
    expect(caPath).toContain('ca.pem');
  });

  it('startProxy returns a BoomerProxy with getCaCertPath', async () => {
    const p = await startProxy({
      port: await getFreePort(),
      host: '127.0.0.1',
      sslCaDir: testSslCaDir,
      browser,
      verbose: false
    });
    expect(typeof p.getCaCertPath()).toBe('string');
    p.close();
  }, 15000);
});

// ---------------------------------------------------------------------------
// Verbose mode (exercises the verbose logging code paths)
// ---------------------------------------------------------------------------

describe('Verbose mode', () => {
  let verboseProxy: BoomerProxy;
  let verbosePort: number;

  beforeAll(async () => {
    verbosePort = await getFreePort();
    verboseProxy = await startProxy({
      port: verbosePort,
      host: '127.0.0.1',
      sslCaDir: testSslCaDir,
      browser,
      verbose: true
    });
  }, 30000);

  afterAll(() => {
    verboseProxy?.close();
  });

  it('handles successful request with verbose logging', async () => {
    const result = await proxyRequest({
      url: `http://127.0.0.1:${httpTestPort}/ping`,
      proxyHost: '127.0.0.1',
      proxyPort: verbosePort
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe('pong');
  }, 30000);

  it('handles failing request with verbose logging (502)', async () => {
    const result = await proxyRequest({
      url: 'http://this-definitely-does-not-exist.invalid/',
      proxyHost: '127.0.0.1',
      proxyPort: verbosePort
    });
    expect(result.status).toBe(502);
  }, 30000);
});

// ---------------------------------------------------------------------------
// Concurrency - exercising pool queuing (> POOL_SIZE=4 concurrent)
// ---------------------------------------------------------------------------

describe('Concurrency', () => {
  it('8 concurrent requests all complete (exceeds pool size of 4)', async () => {
    const requests = Array.from({ length: 8 }, (_, i) =>
      proxyRequest({
        url: `http://127.0.0.1:${httpTestPort}/status/${200}`,
        proxyHost: '127.0.0.1',
        proxyPort
      })
    );
    const results = await Promise.all(requests);
    expect(results).toHaveLength(8);
    for (const r of results) expect(r.status).toBe(200);
  }, 60000);

  it('mixed method concurrent requests all complete', async () => {
    const requests = [
      proxyRequest({
        url: `http://127.0.0.1:${httpTestPort}/method`,
        method: 'GET',
        proxyHost: '127.0.0.1',
        proxyPort
      }),
      proxyRequest({
        url: `http://127.0.0.1:${httpTestPort}/method`,
        method: 'POST',
        body: '',
        proxyHost: '127.0.0.1',
        proxyPort
      }),
      proxyRequest({
        url: `http://127.0.0.1:${httpTestPort}/method`,
        method: 'PUT',
        body: 'x',
        proxyHost: '127.0.0.1',
        proxyPort
      }),
      proxyRequest({
        url: `http://127.0.0.1:${httpTestPort}/method`,
        method: 'DELETE',
        proxyHost: '127.0.0.1',
        proxyPort
      }),
      proxyRequest({
        url: `http://127.0.0.1:${httpTestPort}/ping`,
        proxyHost: '127.0.0.1',
        proxyPort
      }),
      proxyRequest({
        url: `http://127.0.0.1:${httpTestPort}/ping`,
        proxyHost: '127.0.0.1',
        proxyPort
      })
    ];
    const results = await Promise.all(requests);
    expect(results[0].body).toBe('GET');
    expect(results[1].body).toBe('POST');
    expect(results[2].body).toBe('PUT');
    expect(results[3].body).toBe('DELETE');
    expect(results[4].body).toBe('pong');
    expect(results[5].body).toBe('pong');
  }, 60000);
});

// ---------------------------------------------------------------------------
// WebSocket - additional
// ---------------------------------------------------------------------------

describe('WebSocket additional', () => {
  it('multiple sequential messages echoed', async () => {
    const messages = ['first', 'second', 'third'];
    const received: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const connectReq = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        method: 'CONNECT',
        path: `127.0.0.1:${wsTestPort}`
      });

      connectReq.on('connect', (_res, socket) => {
        const ws = new WebSocket(`ws://127.0.0.1:${wsTestPort}`, {
          createConnection: () => socket as any
        });

        ws.on('open', () => {
          for (const msg of messages) ws.send(msg);
        });

        ws.on('message', data => {
          received.push(data.toString());
          if (received.length === messages.length) {
            ws.close();
            resolve();
          }
        });

        ws.on('error', reject);
        setTimeout(() => reject(new Error('WS multiple messages timeout')), 10000);
      });

      connectReq.on('error', reject);
      connectReq.end();
    });

    expect(received).toEqual(messages);
  }, 30000);

  it('large WebSocket message echoed', async () => {
    const bigMsg = 'X'.repeat(64 * 1024); // 64KB

    const received = await new Promise<string>((resolve, reject) => {
      const connectReq = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        method: 'CONNECT',
        path: `127.0.0.1:${wsTestPort}`
      });

      connectReq.on('connect', (_res, socket) => {
        const ws = new WebSocket(`ws://127.0.0.1:${wsTestPort}`, {
          createConnection: () => socket as any
        });
        ws.on('open', () => ws.send(bigMsg));
        ws.on('message', data => {
          ws.close();
          resolve(data.toString());
        });
        ws.on('error', reject);
        setTimeout(() => reject(new Error('large WS timeout')), 15000);
      });

      connectReq.on('error', reject);
      connectReq.end();
    });

    expect(received).toHaveLength(bigMsg.length);
  }, 30000);
});

// ---------------------------------------------------------------------------
// BrowserManager internals — covers launching-waiter path and auto-restart
// ---------------------------------------------------------------------------

describe('BrowserManager internals', () => {
  it('queues fetch while browser is still launching (launchWaiters path)', async () => {
    // Create a fresh manager — DO NOT await launch() before fetching
    const bm = new BrowserManager(chromePath, true);

    // Start launch without awaiting; this sets this.launching=true synchronously
    // then suspends at the first await (puppeteer.launch) returning control to us.
    const launchPromise = bm.launch();

    // Immediately call fetch() while launching is still in progress.
    // acquirePage() will hit the `while (this.launching)` branch and push to launchWaiters.
    const chunks: Buffer[] = [];
    let status = 0;
    const fetchPromise = bm.fetch(
      { url: `http://127.0.0.1:${httpTestPort}/ping`, method: 'GET', headers: {} },
      s => {
        status = s;
      },
      c => {
        chunks.push(c);
      }
    );

    // Both complete: launch finishes → fires waiters → fetch proceeds
    await Promise.all([launchPromise, fetchPromise]);
    expect(status).toBe(200);
    expect(Buffer.concat(chunks).toString()).toBe('pong');

    await bm.close();
  }, 60000);

  it('auto-restarts browser after disconnect', async () => {
    const bm = new BrowserManager(chromePath, true);
    await bm.launch();

    // Access the underlying puppeteer Browser and close it directly.
    // This fires the 'disconnected' event without going through BrowserManager.close(),
    // triggering our auto-restart setTimeout handler (lines 50-59 in browser.ts).
    const puppeteerBrowser = (bm as any).browser;
    await puppeteerBrowser.close();

    // Poll until the pool is repopulated (setTimeout 1000ms + Chrome startup ~3-5s)
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 20000;
      const interval = setInterval(() => {
        if ((bm as any).pool.length === 4) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(interval);
          reject(new Error('Browser did not auto-restart within 20s'));
        }
      }, 100);
    });

    // Verify the restarted browser can serve requests
    const chunks: Buffer[] = [];
    let status = 0;
    await bm.fetch(
      { url: `http://127.0.0.1:${httpTestPort}/ping`, method: 'GET', headers: {} },
      s => {
        status = s;
      },
      c => {
        chunks.push(c);
      }
    );
    expect(status).toBe(200);

    await bm.close();
  }, 60000);
});

// ---------------------------------------------------------------------------
// Verbose mode — additional WebSocket and proxy-level error coverage
// ---------------------------------------------------------------------------

describe('Verbose mode - WebSocket and proxy errors', () => {
  let verboseProxy2: BoomerProxy;
  let verbosePort2: number;

  beforeAll(async () => {
    verbosePort2 = await getFreePort();
    verboseProxy2 = await startProxy({
      port: verbosePort2,
      host: '127.0.0.1',
      sslCaDir: testSslCaDir,
      browser,
      verbose: true
    });
  }, 30000);

  afterAll(() => {
    verboseProxy2?.close();
  });

  it('verbose WebSocket connection (onWebSocketConnection verbose log)', async () => {
    // Connect a WebSocket through the verbose proxy → triggers the verbose log at line 153-154
    await new Promise<void>((resolve, reject) => {
      const connectReq = http.request({
        host: '127.0.0.1',
        port: verbosePort2,
        method: 'CONNECT',
        path: `127.0.0.1:${wsTestPort}`
      });

      connectReq.on('connect', (_res, socket) => {
        const ws = new WebSocket(`ws://127.0.0.1:${wsTestPort}`, {
          createConnection: () => socket as any
        });
        ws.on('open', () => ws.send('hello'));
        ws.on('message', () => {
          ws.close();
        });
        ws.on('close', () => resolve());
        ws.on('error', reject);
        setTimeout(() => reject(new Error('verbose WS connect timeout')), 10000);
      });

      connectReq.on('error', reject);
      connectReq.end();
    });
  }, 30000);

  it('verbose WebSocket error (onWebSocketError verbose log)', async () => {
    // Connect WS through verbose proxy to a port with no WS server.
    // The proxy calls onWebSocketConnection (callback()), then tries to forward
    // to the target which refuses → triggers onWebSocketError verbose log (lines 161-163).
    const noServerPort = await getFreePort();
    // Do NOT start any server on noServerPort

    await new Promise<void>(resolve => {
      const connectReq = http.request({
        host: '127.0.0.1',
        port: verbosePort2,
        method: 'CONNECT',
        path: `127.0.0.1:${noServerPort}`
      });

      connectReq.on('connect', (_res, socket) => {
        const ws = new WebSocket(`ws://127.0.0.1:${noServerPort}`, {
          createConnection: () => socket as any
        });
        ws.on('error', () => resolve());
        ws.on('close', () => resolve());
        setTimeout(() => resolve(), 3000); // fallback: error may arrive differently
      });

      connectReq.on('error', () => resolve());
      connectReq.end();
    });

    // Give proxy a moment to process the error event
    await new Promise(r => setTimeout(r, 300));
  }, 30000);

  it('verbose proxy-level error (onError verbose log)', async () => {
    // http-mitm-proxy stores onError handlers in an internal array.
    // We call it directly to exercise the verbose onError branch (lines 25-33)
    // without relying on hard-to-trigger network-level errors.
    const internalProxy = (verboseProxy2 as any).proxy;
    const handlers: Array<(ctx: any, err: Error) => void> = internalProxy.onErrorHandlers ?? [];
    expect(handlers.length).toBeGreaterThan(0);

    const fakeCtx = {
      clientToProxyRequest: { url: '/test-error' },
      proxyToClientResponse: {
        headersSent: false,
        writeHead: () => {},
        end: () => {}
      }
    };
    // Invoking the handler covers: verbose log (25-28), try block (29), if check (30),
    // writeHead call (31), end call (32).
    handlers[0](fakeCtx, new Error('test proxy error'));
  }, 5000);
});
