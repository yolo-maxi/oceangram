import { build } from 'esbuild';

build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: 'dist/daemon-bundle.js',
  format: 'cjs',
  external: [],
  minify: false,
  sourcemap: false,
}).then(() => console.log('Daemon bundle complete'));
