import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { $, cd } from 'zx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

cd(root);

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

const outFile = path.join(root, 'dist', 'index.js');
const size = fs.statSync(outFile).size;
console.log(`[bundle] dist/index.js: ${(size / 1024).toFixed(1)} KB`);
