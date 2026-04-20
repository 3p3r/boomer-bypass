# boomer-bypass

Boomer Bypass is a proxy to defeat Boomer IT people at their job, which they know nothing about.

## Synopsis

Boomer Bypass is a simple HTTP/HTTPS MITM proxy server that routes all requests through your locally installed web browser (Chrome, Chromium, Edge, or Brave). Traffic appears to originate from your browser rather than a standalone network client — defeating proxy allowlists, certificate pinning checks, and traffic inspection that targets non-browser user agents.

It auto-generates a per-host TLS CA, streams responses chunk-by-chunk (zero full-body buffering), and passes WebSocket connections through natively.

## Stack

- [http-mitm-proxy](https://github.com/joeferner/node-http-mitm-proxy) — MITM proxy core (auto-generates TLS certs, handles CONNECT tunneling)
- [puppeteer-core](https://pptr.dev) — Chrome/Chromium control for routing HTTP(S) requests through the browser
- [commander](https://github.com/tj/commander.js) — CLI argument parsing

## Installation

Download the latest release binary for your operating system from the [releases page](https://github.com/3p3r/boomer-bypass/releases):

| File | Platform |
|------|----------|
| `bb-win.exe` | Windows x64 |
| `bb-mac` | macOS universal (x64 + arm64) |
| `bb-linux` | Linux self-extracting (x64 + arm64, auto-detected) |

Make the binary executable (macOS/Linux):
```sh
chmod +x bb-mac  # or bb-linux
```

## Usage

```
bb [options]

Options:
  -p, --port <number>       proxy port (default: 8080)
  --host <address>          listen address (default: 0.0.0.0)
  --chrome-path <path>      explicit Chrome/Chromium executable path
  --headless                run Chrome in headless mode (default)
  --no-headless             run Chrome in headed mode
  --ssl-ca-dir <path>       directory for SSL CA certificates (default: ~/.boomer-bypass)
  --ca-cert <path>          path to existing CA certificate file
  --ca-key <path>           path to existing CA key file
  -v, --verbose             enable verbose logging
  -V, --version             output the version number
  -h, --help                display help
```

### Quick start

```sh
# Start the proxy (auto-discovers Chrome)
./bb-mac

# Or specify a port and show Chrome window
./bb-mac --port 9090 --no-headless
```

On startup, `boomer-bypass` prints the proxy address and the CA certificate path. Configure your OS or application to use the proxy (`http://127.0.0.1:8080`) and trust the CA certificate.

### Trust the CA certificate

```sh
# macOS
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.boomer-bypass/certs/ca.pem

# Linux (Debian/Ubuntu)
sudo cp ~/.boomer-bypass/certs/ca.pem /usr/local/share/ca-certificates/boomer-bypass.crt
sudo update-ca-certificates

# Windows (run as Administrator)
certutil -addstore Root %USERPROFILE%\.boomer-bypass\certs\ca.pem
```

### Configure your browser/application

Set the HTTP and HTTPS proxy to `http://127.0.0.1:8080` (or whatever port you chose).

**curl example:**
```sh
curl -x http://127.0.0.1:8080 https://example.com
```

**environment variables:**
```sh
export http_proxy=http://127.0.0.1:8080
export https_proxy=http://127.0.0.1:8080
```

## Building from source

```sh
npm install
npm run build        # bundle + compile binary for current platform
npm test             # run E2E tests (requires Chrome)
```

Requires Node.js 18+ and a locally installed Chrome/Chromium.

## Architecture

1. An HTTP/HTTPS MITM proxy listens for connections. CONNECT tunnels are established for HTTPS; per-host TLS certificates are auto-generated.
2. For each intercepted HTTP(S) request, a worker page is acquired from a pool of 4 pre-created `about:blank` Chrome pages.
3. The request is forwarded via `page.evaluate()` → `fetch()` inside Chrome's network stack.
4. The response is streamed back in 64 KB chunks using `page.exposeFunction()` callbacks, decoded from base64, and written directly to the client socket — no full-body buffering.
5. WebSocket connections are passed through natively by `http-mitm-proxy` without browser involvement.
