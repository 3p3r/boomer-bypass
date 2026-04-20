import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { $, cd } from 'zx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

cd(root);

// Ensure build directory exists
fs.mkdirSync(path.join(root, 'build'), { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const version = pkg.version;

console.log(`[compile] Compiling boomer-bypass v${version} with pkg...`);

// Compile all targets
const targets = [
  { target: 'node18-linux-x64', output: 'bb-linux-x64' },
  { target: 'node18-linux-arm64', output: 'bb-linux-arm64' },
  { target: 'node18-macos-x64', output: 'bb-mac-x64' },
  { target: 'node18-macos-arm64', output: 'bb-mac-arm64' },
  { target: 'node18-win-x64', output: 'bb-win-x64.exe' }
];

const platform = os.platform();
const arch = os.arch();

// In CI, we compile for all targets on corresponding runners.
// Locally, just compile for the current platform by default unless ALL=1.
const compileAll = process.env.ALL === '1';

let targetsToCompile = targets;
if (!compileAll) {
  if (platform === 'linux') {
    targetsToCompile = targets.filter(t =>
      arch === 'arm64' ? t.target === 'node18-linux-arm64' : t.target === 'node18-linux-x64'
    );
  } else if (platform === 'darwin') {
    targetsToCompile = targets.filter(
      t => t.target === 'node18-macos-x64' || t.target === 'node18-macos-arm64'
    );
  } else if (platform === 'win32') {
    targetsToCompile = targets.filter(t => t.target === 'node18-win-x64');
  }
}

for (const { target, output } of targetsToCompile) {
  console.log(`[compile] ${target} → build/${output}`);
  // Use a relative path to avoid backslash-in-template-string issues on Windows.
  // cd(root) above ensures the CWD is always the repo root.
  await $`npx pkg dist/index.js --target ${target} --output build/${output} --compress GZip`;
}

// macOS universal binary via lipo (only on macOS with both arches compiled)
if (platform === 'darwin') {
  const x64 = path.join(root, 'build', 'bb-mac-x64');
  const arm64 = path.join(root, 'build', 'bb-mac-arm64');
  const universal = path.join(root, 'build', 'bb-mac');

  if (fs.existsSync(x64) && fs.existsSync(arm64)) {
    console.log('[compile] Creating macOS universal binary via lipo...');
    await $`lipo -create -output ${universal} ${x64} ${arm64}`;
    await $`chmod +x ${universal}`;
    console.log('[compile] Created build/bb-mac (universal)');
  }
}

// Linux self-extracting wrapper (only if both Linux binaries present)
const linuxX64 = path.join(root, 'build', 'bb-linux-x64');
const linuxArm64 = path.join(root, 'build', 'bb-linux-arm64');
if (fs.existsSync(linuxX64) && fs.existsSync(linuxArm64)) {
  console.log('[compile] Creating Linux self-extracting wrapper...');
  await createLinuxWrapper(root, linuxX64, linuxArm64);
}

console.log('[compile] Done.');

async function createLinuxWrapper(root: string, x64: string, arm64: string) {
  const tarPath = path.join(root, 'build', 'bb-linux-bins.tar.gz');

  // Pack both binaries into a tarball
  await $`tar -czf ${tarPath} -C ${path.join(root, 'build')} bb-linux-x64 bb-linux-arm64`;

  const tarB64 = fs.readFileSync(tarPath, 'base64');
  fs.unlinkSync(tarPath);

  const wrapper = `#!/bin/sh
set -e
ARCH=$(uname -m)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Decode embedded tarball
echo '${tarB64}' | base64 -d > "$TMP/bins.tar.gz"
tar -xzf "$TMP/bins.tar.gz" -C "$TMP"

if [ "$ARCH" = "x86_64" ]; then
  exec "$TMP/bb-linux-x64" "$@"
elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
  exec "$TMP/bb-linux-arm64" "$@"
else
  echo "Unsupported architecture: $ARCH" >&2
  exit 1
fi
`;

  const wrapperPath = path.join(root, 'build', 'bb-linux');
  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  console.log('[compile] Created build/bb-linux (self-extracting wrapper)');
}
