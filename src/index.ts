#!/usr/bin/env node
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import createDebug from 'debug';
import { BrowserManager } from './browser';
import { findChromeBrowser } from './chrome/FindChrome';
import { startProxy } from './proxy';

const log = createDebug('boomer:cli');

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
    .option('--ca-cert <path>', 'path to an existing PEM CA certificate file')
    .option('--ca-key <path>', 'path to the matching PEM CA private key file')
    .option(
      '--ca-public-key <path>',
      'path to the PEM CA public key file (default: derived from --ca-key path)'
    )
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
    caPublicKey?: string;
    verbose?: boolean;
  }>();

  const port = Number.parseInt(opts.port, 10);
  if (Number.isNaN(port) || port < 0 || port > 65535) {
    process.stderr.write(`[boomer] Invalid port: ${opts.port}\n`);
    process.exit(1);
  }

  // Find Chrome
  let chromePath = opts.chromePath;
  if (!chromePath) {
    log('searching for Chrome/Chromium...');
    chromePath = (await findChromeBrowser()) ?? undefined;
  }

  if (!chromePath) {
    process.stderr.write(
      '[boomer] No Chrome/Chromium installation found.\n' +
        'Install Google Chrome, Chromium, Microsoft Edge, or Brave,\n' +
        'or specify the path with --chrome-path.\n'
    );
    process.exit(1);
  }

  log('using Chrome at %s', chromePath);

  // Launch browser
  const browser = new BrowserManager(chromePath, opts.headless !== false);
  await browser.launch();

  // Validate custom CA cert/key — both must be provided together
  if (!!opts.caCert !== !!opts.caKey) {
    process.stderr.write('[boomer] --ca-cert and --ca-key must be provided together.\n');
    process.exit(1);
  }

  // Start proxy
  const sslCaDir = opts.sslCaDir;
  const proxy = await startProxy({
    port,
    host: opts.host,
    sslCaDir,
    browser,
    caCert: opts.caCert,
    caKey: opts.caKey,
    caPublicKey: opts.caPublicKey,
    verbose: opts.verbose
  });

  const caCertPath = proxy.getCaCertPath();
  process.stdout.write(`[boomer] Proxy listening on http://${opts.host}:${port}\n`);
  process.stdout.write(`[boomer] CA certificate: ${caCertPath}\n`);
  process.stdout.write('\n');
  process.stdout.write('[boomer] To trust the CA certificate:\n');
  process.stdout.write(
    `  macOS:   sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${caCertPath}\n`
  );
  process.stdout.write(
    `  Linux:   sudo cp ${caCertPath} /usr/local/share/ca-certificates/boomer.crt && sudo update-ca-certificates\n`
  );
  process.stdout.write(`  Windows: certutil -addstore Root ${caCertPath}\n`);
  process.stdout.write('\n');
  process.stdout.write(
    '[boomer] Configure your browser/app to use this proxy, then browse normally.\n'
  );

  // Graceful shutdown
  const shutdown = async () => {
    process.stdout.write('\n[boomer] Shutting down...\n');
    log('shutdown signal received');
    proxy.close();
    await browser.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  log('fatal error: %O', err);
  process.stderr.write(`[boomer] Fatal error: ${err}\n`);
  process.exit(1);
});
