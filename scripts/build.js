// Empacota a interface (CodeMirror + app) em dist/.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = path.join(root, 'dist');
fs.mkdirSync(path.join(dist, 'fonts'), { recursive: true });

await build({
  entryPoints: [path.join(root, 'src/renderer/app.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  minify: process.env.NODE_ENV !== 'development',
  sourcemap: true,
  outfile: path.join(dist, 'app.js'),
  logLevel: 'warning',
});
for (const f of ['index.html', 'styles.css']) fs.copyFileSync(path.join(root, 'src/renderer', f), path.join(dist, f));
const fontDir = path.join(path.dirname(require.resolve('@fontsource/courier-prime/package.json')), 'files');
for (const [src, dest] of [['400-normal', '400'], ['700-normal', '700'], ['400-italic', '400-italic'], ['700-italic', '700-italic']]) {
  fs.copyFileSync(path.join(fontDir, `courier-prime-latin-${src}.woff2`), path.join(dist, 'fonts', `courier-prime-${dest}.woff2`));
}
console.log('interface pronta em dist/');
