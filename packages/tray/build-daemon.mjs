import { build } from 'esbuild';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: ['../daemon/src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: 'resources/daemon-bundle.js',
  format: 'cjs',
  external: ['better-sqlite3'],
  sourcemap: false,
  minify: true,
});
console.log('Daemon bundled to resources/daemon-bundle.js');
