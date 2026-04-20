#!/usr/bin/env node
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { BrowserManager } from './browser';
import { findChromeBrowser } from './chrome/FindChrome';
import { startProxy } from './proxy';

const pkg = require('../package.json') as { name: string; version: string; description: string };

async function main() {
  const program = new Command();

  program
    .name('bb')
    .description(pkg.description)
    .version(pkg.version)
    .option('-p, --port <number>', 'proxy port', '8080')
    .option('--host <address>', 'listen address', '0.0.0.0')
    .option('--chrome-path <path>', 'explicit Chrome/Chromium executable path')
    .option('--headless', 'run Chrome in headless mode (default)')
    .option('--no-headless', 'run Chrome in headed mode')
    .option(
      '--ssl-ca-dir <path>',
      'directory for SSL CA certificates',
      path.join(os.homedir(), '.boomer-bypass')
    )
    .option('--ca-cert <path>', 'path to existing CA certificate file')
    .option('--ca-key <path>', 'path to existing CA key file')
    .option('-v, --verbose', 'enable verbose logging');

  program.parse(process.argv);
  const opts = program.opts<{
    port: string;
    host: string;
    chromePath?: string;
    headless: boolean;
    sslCaDir: string;
    caCert?: string;
    caKey?: string;
    verbose?: boolean;
  }>();

  const port = Number.parseInt(opts.port, 10);
  if (Number.isNaN(port) || port < 0 || port > 65535) {
    console.error(`[boomer-bypass] Invalid port: ${opts.port}`);
    process.exit(1);
  }

  // Find Chrome
  let chromePath = opts.chromePath;
  if (!chromePath) {
    console.log('[boomer-bypass] Searching for Chrome/Chromium...');
    chromePath = (await findChromeBrowser()) ?? undefined;
  }

  if (!chromePath) {
    console.error(
      '[boomer-bypass] No Chrome/Chromium installation found.\n' +
        'Install Google Chrome, Chromium, Microsoft Edge, or Brave,\n' +
        'or specify the path with --chrome-path.'
    );
    process.exit(1);
  }

  console.log(`[boomer-bypass] Using Chrome: ${chromePath}`);

  // Launch browser
  const browser = new BrowserManager(chromePath, opts.headless !== false);
  await browser.launch();

  // Start proxy
  const sslCaDir = opts.sslCaDir;
  const proxy = await startProxy({
    port,
    host: opts.host,
    sslCaDir,
    browser,
    verbose: opts.verbose
  });

  const caCertPath = proxy.getCaCertPath();
  console.log(`[boomer-bypass] Proxy listening on http://${opts.host}:${port}`);
  console.log(`[boomer-bypass] CA certificate: ${caCertPath}`);
  console.log('');
  console.log('[boomer-bypass] To trust the CA certificate:');
  console.log(
    `  macOS:   sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${caCertPath}`
  );
  console.log(
    `  Linux:   sudo cp ${caCertPath} /usr/local/share/ca-certificates/boomer-bypass.crt && sudo update-ca-certificates`
  );
  console.log(`  Windows: certutil -addstore Root ${caCertPath}`);
  console.log('');
  console.log(
    '[boomer-bypass] Configure your browser/app to use this proxy, then browse normally.'
  );

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[boomer-bypass] Shutting down...');
    proxy.close();
    await browser.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[boomer-bypass] Fatal error:', err);
  process.exit(1);
});
