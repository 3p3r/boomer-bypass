#!/usr/bin/env node
/**
 * Binary smoke tests for boomer-bypass.
 * Usage: node tests/e2e-binary.mjs [path-to-binary]
 * If no path is given, auto-detects the compiled binary under ./build/ for the current platform.
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function detectBinaryPath() {
  const platform = os.platform();
  const arch = os.arch();
  const buildDir = path.join(root, 'build');
  let name;
  if (platform === 'linux') {
    name = arch === 'arm64' ? 'bb-linux-arm64' : 'bb-linux-x64';
  } else if (platform === 'darwin') {
    // prefer universal, fall back to arch-specific
    if (fs.existsSync(path.join(buildDir, 'bb-mac'))) {
      name = 'bb-mac';
    } else {
      name = arch === 'arm64' ? 'bb-mac-arm64' : 'bb-mac-x64';
    }
  } else if (platform === 'win32') {
    name = 'bb-win-x64.exe';
  } else {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
  }
  return path.join(buildDir, name);
}

const binaryPath = process.argv[2] ?? detectBinaryPath();

if (!fs.existsSync(binaryPath)) {
  console.error(`Binary not found: ${binaryPath}`);
  console.error('Run "npm run build" first, or pass the path as an argument.');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      server.close(err => {
        if (err) reject(err);
        else resolve(addr.port);
      });
    });
  });
}

async function run() {
  console.log(`Testing binary: ${binaryPath}\n`);

  // Test 1: --help exits 0
  console.log('Test: --help exits with code 0');
  {
    const result = spawnSync(binaryPath, ['--help'], { timeout: 10000, encoding: 'utf-8' });
    assert(result.status === 0, '--help exits 0');
    assert(
      result.stdout.includes('bb') || result.stdout.includes('boomer'),
      '--help output contains expected text'
    );
  }

  // Test 2: --version exits 0 and contains version
  console.log('\nTest: --version exits with code 0 and shows version');
  {
    const result = spawnSync(binaryPath, ['--version'], { timeout: 10000, encoding: 'utf-8' });
    assert(result.status === 0, '--version exits 0');
    const output = (result.stdout + result.stderr).trim();
    assert(/\d+\.\d+\.\d+/.test(output), `--version output contains semver: "${output}"`);
  }

  // Test 3: starts and listens on --port 0
  console.log('\nTest: starts proxy and listens');
  {
    const port = await getFreePort();
    const proc = spawn(binaryPath, ['--port', String(port), '--headless'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000
    });

    let started = false;
    let output = '';

    const startPromise = new Promise((resolve, reject) => {
      proc.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output.includes('Proxy listening')) {
          started = true;
          resolve();
        }
      });
      proc.stderr.on('data', chunk => {
        output += chunk.toString();
        if (output.includes('Proxy listening')) {
          started = true;
          resolve();
        }
      });
      setTimeout(() => reject(new Error(`Timeout waiting for start. Output: ${output}`)), 25000);
      proc.on('error', reject);
    });

    try {
      await startPromise;
      assert(started, 'Binary starts and prints "Proxy listening"');
      assert(output.includes(String(port)), `Output contains port ${port}`);

      // Check that the port is actually listening
      const isListening = await new Promise(resolve => {
        const sock = net.createConnection(port, '127.0.0.1', () => {
          sock.destroy();
          resolve(true);
        });
        sock.on('error', () => resolve(false));
        sock.setTimeout(3000, () => {
          sock.destroy();
          resolve(false);
        });
      });
      assert(isListening, 'Proxy port is actually accepting connections');
    } catch (err) {
      assert(false, `Binary failed to start: ${err.message}`);
    } finally {
      // Test 4: SIGTERM stops cleanly
      console.log('\nTest: SIGTERM causes clean shutdown');
      const shutdownPromise = new Promise(resolve => {
        proc.on('exit', code => {
          assert(code === 0 || code === null, `SIGTERM exit code is 0 or null (got ${code})`);
          resolve();
        });
        setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 5000);
      });

      proc.kill('SIGTERM');
      await shutdownPromise;
    }
  }

  // Summary
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
