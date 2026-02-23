import { build } from 'esbuild';

await build({
  entryPoints: ['../daemon/src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: 'resources/daemon-bundle.js',
  format: 'cjs',
  external: [],
  sourcemap: false,
  minify: true,
});
// Copy sql.js WASM file next to the bundle
import { copyFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Find the wasm file via the daemon's node_modules
const wasmCandidates = [
  resolve(__dirname, '../daemon/node_modules/sql.js/dist/sql-wasm.wasm'),
  resolve(__dirname, '../../node_modules/sql.js/dist/sql-wasm.wasm'),
  resolve(__dirname, '../../node_modules/.pnpm/sql.js@1.14.0/node_modules/sql.js/dist/sql-wasm.wasm'),
];
const wasmSrc = wasmCandidates.find(p => existsSync(p));
if (wasmSrc) {
  copyFileSync(wasmSrc, 'resources/sql-wasm.wasm');
  console.log('WASM copied to resources/sql-wasm.wasm');
} else {
  console.warn('WARNING: sql-wasm.wasm not found, cache will fall back to in-memory');
}
console.log('Daemon bundled to resources/daemon-bundle.js');
