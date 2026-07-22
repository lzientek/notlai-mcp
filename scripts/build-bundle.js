import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/bundle.cjs',
  sourcemap: true,
  minify: false,
  external: [],
});

console.log('✅ Bundle built → dist/bundle.cjs');
