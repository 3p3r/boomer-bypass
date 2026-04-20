#!/usr/bin/env bash
# smoke.sh — curl-based smoke tests for boomer-bypass
# Starts a local HTTP test server, starts the proxy, runs curl through it,
# then verifies the responses. Tests that the tool works with standard tools.
#
# Usage:
#   bash tests/smoke.sh
#   BB_BINARY=./build/bb-linux bash tests/smoke.sh   # test a compiled binary

set -uo pipefail

# ── colour helpers ──────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0; FAIL=0; SKIP=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; ((PASS++)); }
fail() { echo -e "  ${RED}✗${NC} $1"; ((FAIL++)); }
skip() { echo -e "  ${YELLOW}○${NC} $1 (skipped)"; ((SKIP++)); }

check_contains() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then pass "$name"; else fail "$name — wanted '$expected', got: '$actual'"; fi
}

check_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then pass "$name"; else fail "$name — expected '$expected', got '$actual'"; fi
}

# ── cleanup ─────────────────────────────────────────────────────────────────
PROXY_PID=""
SERVER_PID=""
SSL_CA_DIR=""

cleanup() {
  [[ -n "$PROXY_PID" ]] && kill "$PROXY_PID" 2>/dev/null && wait "$PROXY_PID" 2>/dev/null || true
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null || true
  [[ -n "$SSL_CA_DIR" ]] && rm -rf "$SSL_CA_DIR" || true
  rm -f /tmp/bb-smoke-proxy.log /tmp/bb-smoke-server.log
}
trap cleanup EXIT

# ── port helper (Node.js, guaranteed to be available) ──────────────────────
free_port() {
  node -e "const net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"
}

echo ""
echo "═══════════════════════════════════════════════"
echo "  boomer-bypass curl smoke tests"
echo "═══════════════════════════════════════════════"
echo ""

# ── locate the binary / dev runner ──────────────────────────────────────────
if [[ -n "${BB_BINARY:-}" ]]; then
  if [[ ! -x "$BB_BINARY" ]]; then
    echo "ERROR: BB_BINARY=$BB_BINARY is not executable" >&2
    exit 1
  fi
  RUN_CMD="$BB_BINARY"
  echo "Using binary: $BB_BINARY"
else
  # Dev mode — requires tsx + src/index.ts
  if ! command -v npx >/dev/null 2>&1; then
    echo "ERROR: npx not found. Run from the project root or set BB_BINARY." >&2
    exit 1
  fi
  RUN_CMD="npx tsx src/index.ts"
  echo "Using dev runner: npx tsx src/index.ts"
fi

# ── start a local HTTP test server (pure Node.js, no extra deps) ─────────────
SERVER_PORT=$(free_port)
node -e "
const http = require('http');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/ping') {
    res.writeHead(200, {'content-type':'text/plain','x-powered-by':'boomer-bypass-test'});
    return res.end('pong');
  }

  if (url.pathname === '/method') {
    res.writeHead(200, {'content-type':'text/plain'});
    return res.end(req.method);
  }

  if (url.pathname === '/echo-headers') {
    res.writeHead(200, {'content-type':'application/json'});
    return res.end(JSON.stringify(req.headers));
  }

  if (url.pathname === '/body') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, {'content-type':'application/octet-stream'});
      res.end(Buffer.concat(chunks));
    });
    return;
  }

  if (url.pathname === '/query') {
    res.writeHead(200, {'content-type':'text/plain'});
    return res.end(req.url);
  }

  if (url.pathname === '/custom-response-header') {
    res.writeHead(200, {'content-type':'text/plain','x-smoke-test':'hello-from-server'});
    return res.end('ok');
  }

  if (url.pathname.startsWith('/status/')) {
    const code = parseInt(url.pathname.slice(8), 10) || 200;
    res.writeHead(code, {'content-type':'text/plain'});
    return res.end('status:' + code);
  }

  if (url.pathname === '/slow') {
    res.writeHead(200, {'content-type':'text/plain'});
    let i = 0;
    const t = setInterval(() => {
      res.write('chunk' + i + '\n');
      if (++i >= 5) { clearInterval(t); res.end(); }
    }, 50);
    return;
  }

  if (url.pathname === '/large') {
    const total = 2 * 1024 * 1024; // 2MB
    const chunk = Buffer.alloc(65536, 66);
    res.writeHead(200, {'content-type':'application/octet-stream','content-length':String(total)});
    let sent = 0;
    const send = () => {
      if (sent >= total) return res.end();
      const rem = total - sent;
      res.write(rem < chunk.length ? Buffer.alloc(rem, 66) : chunk);
      sent += Math.min(rem, chunk.length);
      setImmediate(send);
    };
    send();
    return;
  }

  res.writeHead(404, {'content-type':'text/plain'});
  res.end('not found');
});
server.listen($SERVER_PORT, '127.0.0.1', () => {});
process.on('SIGTERM', () => { server.close(); process.exit(0); });
" >"${TMPDIR:-/tmp}/bb-smoke-server.log" 2>&1 &
SERVER_PID=$!

# Give the server a moment
sleep 0.3

# Verify server started
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "ERROR: test server failed to start"
  cat "${TMPDIR:-/tmp}/bb-smoke-server.log"
  exit 1
fi
echo "Test server listening on port $SERVER_PORT (PID $SERVER_PID)"

# ── start boomer-bypass proxy ────────────────────────────────────────────────
PROXY_PORT=$(free_port)
SSL_CA_DIR=$(mktemp -d)

echo "Starting proxy on port $PROXY_PORT..."
$RUN_CMD --port "$PROXY_PORT" --ssl-ca-dir "$SSL_CA_DIR" \
  >"${TMPDIR:-/tmp}/bb-smoke-proxy.log" 2>&1 &
PROXY_PID=$!

# Wait up to 30s for "Proxy listening"
READY=0
for i in $(seq 1 60); do
  if grep -q "Proxy listening" "${TMPDIR:-/tmp}/bb-smoke-proxy.log" 2>/dev/null; then
    READY=1; break
  fi
  if ! kill -0 "$PROXY_PID" 2>/dev/null; then
    echo "ERROR: proxy process exited unexpectedly"
    cat "${TMPDIR:-/tmp}/bb-smoke-proxy.log"
    exit 1
  fi
  sleep 0.5
done

if [[ $READY -eq 0 ]]; then
  echo "ERROR: proxy did not print 'Proxy listening' within 30s"
  cat "${TMPDIR:-/tmp}/bb-smoke-proxy.log"
  exit 1
fi
echo "Proxy ready (PID $PROXY_PID)"
echo ""

PROXY="http://127.0.0.1:$PROXY_PORT"
BASE="http://127.0.0.1:$SERVER_PORT"
CA_CERT="$SSL_CA_DIR/certs/ca.pem"

# ── curl helper ──────────────────────────────────────────────────────────────
# All curl calls go through the proxy; -s=silent, -S=show errors
CURL="curl -s -S --proxy $PROXY --max-time 20"

# ── Section 1: basic HTTP ─────────────────────────────────────────────────────
echo "── Section 1: Basic HTTP ────────────────────────────────"

OUT=$($CURL "$BASE/ping")
check_eq "GET /ping body" "pong" "$OUT"

CODE=$($CURL -o /dev/null -w '%{http_code}' "$BASE/ping")
check_eq "GET /ping status 200" "200" "$CODE"

OUT=$($CURL "$BASE/method")
check_eq "GET method echoed" "GET" "$OUT"

OUT=$($CURL -X POST "$BASE/method")
check_eq "POST method echoed" "POST" "$OUT"

OUT=$($CURL -X PUT "$BASE/method")
check_eq "PUT method echoed" "PUT" "$OUT"

OUT=$($CURL -X DELETE "$BASE/method")
check_eq "DELETE method echoed" "DELETE" "$OUT"

OUT=$($CURL -X PATCH "$BASE/method")
check_eq "PATCH method echoed" "PATCH" "$OUT"

# ── Section 2: request/response bodies ───────────────────────────────────────
echo ""
echo "── Section 2: Bodies ────────────────────────────────────"

OUT=$($CURL -X POST --data 'hello from curl' "$BASE/body")
check_eq "POST body echo" "hello from curl" "$OUT"

OUT=$($CURL -X PUT --data-binary 'put data here' "$BASE/body")
check_eq "PUT body echo" "put data here" "$OUT"

# JSON body
OUT=$($CURL -X POST -H 'Content-Type: application/json' --data '{"key":"value"}' "$BASE/body")
check_eq "POST JSON body echo" '{"key":"value"}' "$OUT"

# ── Section 3: headers ────────────────────────────────────────────────────────
echo ""
echo "── Section 3: Headers ───────────────────────────────────"

# Custom request header reaches server
OUT=$($CURL -H 'X-Smoke-Test: curl-test-123' "$BASE/echo-headers")
check_contains "Custom request header forwarded" "curl-test-123" "$OUT"

# Response header forwarded to curl
OUT=$($CURL -D - "$BASE/custom-response-header" 2>/dev/null | grep -i 'x-smoke-test')
check_contains "Custom response header forwarded" "hello-from-server" "$OUT"

# User-Agent is intentionally overridden by Chrome (traffic looks browser-native)
OUT=$($CURL -A 'MyTestAgent/1.0' "$BASE/echo-headers")
check_contains "Chrome User-Agent replaces curl UA (browser-native traffic)" "Chrome" "$OUT"

# Proxy-related headers NOT forwarded to origin
OUT=$($CURL -H 'Proxy-Authorization: Basic dGVzdA==' "$BASE/echo-headers")
if [[ "$OUT" != *"proxy-authorization"* ]]; then pass "proxy-authorization header stripped"; else fail "proxy-authorization header leaked to origin"; fi

# ── Section 4: status codes ───────────────────────────────────────────────────
echo ""
echo "── Section 4: Status Codes ──────────────────────────────"

for CODE_VAL in 200 201 204 400 403 404 500 503; do
  GOT=$($CURL -o /dev/null -w '%{http_code}' "$BASE/status/$CODE_VAL")
  check_eq "Status $CODE_VAL forwarded" "$CODE_VAL" "$GOT"
done

# ── Section 5: query strings ──────────────────────────────────────────────────
echo ""
echo "── Section 5: Query strings ─────────────────────────────"

OUT=$($CURL "$BASE/query?foo=bar&baz=123")
check_contains "Query param foo=bar forwarded" "foo=bar" "$OUT"
check_contains "Query param baz=123 forwarded" "baz=123" "$OUT"

OUT=$($CURL "$BASE/query?encoded=hello%20world")
check_contains "URL-encoded query param forwarded" "hello%20world" "$OUT"

# ── Section 6: streaming ──────────────────────────────────────────────────────
echo ""
echo "── Section 6: Streaming ─────────────────────────────────"

OUT=$($CURL "$BASE/slow")
check_contains "Slow/chunked response received chunk0" "chunk0" "$OUT"
check_contains "Slow/chunked response received chunk4" "chunk4" "$OUT"

# Large response (2MB) - check size
BYTES=$($CURL "$BASE/large" | wc -c | tr -d ' ')
TARGET=$((2 * 1024 * 1024))
if [[ "$BYTES" -eq "$TARGET" ]]; then
  pass "2MB response received correctly ($BYTES bytes)"
else
  fail "2MB response size wrong: expected $TARGET, got $BYTES"
fi

# ── Section 7: error handling ─────────────────────────────────────────────────
echo ""
echo "── Section 7: Error Handling ────────────────────────────"

CODE=$($CURL -o /dev/null -w '%{http_code}' "http://this-host-absolutely-does-not-exist.invalid/")
check_eq "Non-existent host returns 502" "502" "$CODE"

# ── Section 8: proxy verbosity / startup output ──────────────────────────────
echo ""
echo "── Section 8: Proxy output ──────────────────────────────"

PROXY_LOG=$(cat "${TMPDIR:-/tmp}/bb-smoke-proxy.log")
check_contains "Proxy log contains listening message" "Proxy listening" "$PROXY_LOG"
check_contains "Proxy log contains CA cert path" "ca.pem" "$PROXY_LOG"
check_contains "Proxy log contains trust instructions" "trust" "$PROXY_LOG"

# CA cert was created
if [[ -f "$CA_CERT" ]]; then
  pass "CA certificate file created at $CA_CERT"
else
  fail "CA certificate file NOT found at $CA_CERT"
fi

# ── Section 9: HTTPS via CONNECT tunnel ──────────────────────────────────────
echo ""
echo "── Section 9: HTTPS (via proxy CONNECT) ─────────────────"

# Wait for CA cert to appear (may need a first HTTPS request to trigger it)
# Try a known HTTPS target with -k (insecure, we're just checking tunneling works)
if command -v curl >/dev/null 2>&1; then
  # Use the proxy for HTTPS — -k skips cert verification for the origin server
  # The proxy CA cert trust is separate from the origin server cert
  CODE=$(curl -s -S --proxy "$PROXY" -k --max-time 20 \
    -o /dev/null -w '%{http_code}' \
    "https://127.0.0.1:1/nonexistent" 2>/dev/null || echo "000")
  # We expect either a connection refused (000 from curl) or 502 from proxy
  if [[ "$CODE" == "000" || "$CODE" == "502" || "$CODE" == "503" ]]; then
    pass "HTTPS CONNECT tunnel attempted (got $CODE as expected for refused port)"
  else
    fail "HTTPS CONNECT tunnel unexpected response: $CODE"
  fi
else
  skip "curl not available for HTTPS test"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
printf "  Results: ${GREEN}%d passed${NC}, ${RED}%d failed${NC}, ${YELLOW}%d skipped${NC}\n" "$PASS" "$FAIL" "$SKIP"
echo "═══════════════════════════════════════════════"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo "Proxy log (last 30 lines):"
  tail -30 "${TMPDIR:-/tmp}/bb-smoke-proxy.log"
  exit 1
fi
