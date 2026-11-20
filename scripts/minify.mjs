// ── DEPLOY-TIME MINIFY (ManGO:IT 1.18.5) ──
// Writes minified copies of the given web files into an output folder with the
// same paths, so index.html, the ?v= busters and the SW SHELL need no change.
// Sources are never edited. ES modules keep their own scope, so local AND
// top-level names may shrink; imports/exports keep their names. Already-
// minified vendor files (*.min.js, /vendor/) are copied as they are.
//   node scripts/minify.mjs <outDir> <file> [file …]
import fs from 'node:fs';
import path from 'node:path';
import { transformSync } from 'esbuild';

const [outDir, ...files] = process.argv.slice(2);
if (!outDir || !files.length) { console.error('usage: node scripts/minify.mjs <outDir> <file> [file …]'); process.exit(1); }
const isModule = (code) => /^\s*(import\s|export\s)/m.test(code) || /\bimport\(/.test(code);
let before = 0, after = 0, failed = 0;
for (const f of files) {
  const src = fs.readFileSync(f);
  const dest = path.join(outDir, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const ext = path.extname(f).toLowerCase();
  let out = src;
  try {
    // the service worker ships as written: tiny, and the live smoke reads its CACHE + SHELL text
    const vendored = f.split(path.sep).join('/').includes('/vendor/') || f.endsWith('.min.js') || path.basename(f) === 'service-worker.js';
    if ((ext === '.js' || ext === '.mjs') && !vendored) {
      const code = src.toString('utf8');
      out = Buffer.from(transformSync(code, { loader: 'js', minify: true, target: 'es2022', legalComments: 'none', format: isModule(code) ? 'esm' : undefined }).code);
    } else if (ext === '.css') {
      out = Buffer.from(transformSync(src.toString('utf8'), { loader: 'css', minify: true, legalComments: 'none' }).code);
    }
  } catch (e) { console.error(`MINIFY FAILED ${f}: ${e.message.split('\n')[0]}`); failed++; continue; }
  fs.writeFileSync(dest, out);
  before += src.length; after += out.length;
}
if (failed) process.exit(1);
console.log(`minified ${files.length} files: ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB`);
