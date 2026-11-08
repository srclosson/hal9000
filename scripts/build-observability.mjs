import { build } from 'esbuild';
await build({ entryPoints: ['frontend/observability.js'], bundle: true, minify: true, format: 'iife',
  target: ['es2022'], outfile: 'public/assets/observability.js', legalComments: 'none' });
