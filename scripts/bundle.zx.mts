import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { $, cd } from 'zx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

cd(root);

// Ensure dist directory exists
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });

console.log('[bundle] Bundling src/index.ts → dist/index.js with esbuild...');

await $`npx esbuild \
  src/index.ts \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node18 \
  --outfile=dist/index.js \
  --external:puppeteer-core \
  --external:puppeteer \
  --log-level=info`;

console.log('[bundle] Done.');

// Verify output exists
const outFile = path.join(root, 'dist', 'index.js');
if (!fs.existsSync(outFile)) {
  console.error('[bundle] ERROR: dist/index.js was not created!');
  process.exit(1);
}

const size = fs.statSync(outFile).size;
console.log(`[bundle] dist/index.js: ${(size / 1024).toFixed(1)} KB`);
