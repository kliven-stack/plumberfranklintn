// The WordPress uploads are unprocessed exports — 231 MB of JPEG/PNG for a site
// whose largest rendered image is 1180 px wide. Re-encode them in place: same
// filenames, same pixel dimensions, so no markup changes and the fidelity diff is
// unaffected. A manifest keeps the pass idempotent — re-running never re-compresses
// an already-compressed file.
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import sharp from 'sharp';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const UPLOADS = path.join(ROOT, 'public/wp-content/uploads');
const MANIFEST = path.join(ROOT, '_extract/image-manifest.json');

const manifest = existsSync(MANIFEST) ? JSON.parse(await readFile(MANIFEST, 'utf8')) : {};

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const mb = (n) => (n / 1048576).toFixed(1);
let before = 0, after = 0, done = 0, skipped = 0;

for await (const file of walk(UPLOADS)) {
  const ext = path.extname(file).toLowerCase();
  // GIFs are animated here; sharp would flatten them. WebP is already compressed.
  if (!['.jpg', '.jpeg', '.png'].includes(ext)) continue;

  const rel = path.relative(ROOT, file);
  const size = (await stat(file)).size;
  if (manifest[rel] === size) { skipped++; continue; }

  const input = await readFile(file);
  const image = sharp(input, { failOn: 'none' });
  const meta = await image.metadata();

  const output = ext === '.png'
    // Lossless only for PNG: a palette re-encode quantises to 256 colours, which
    // bands the photographic PNGs in the blog posts.
    ? await image.png({ compressionLevel: 9, effort: 10, palette: false }).toBuffer()
    : await image.jpeg({ quality: 82, mozjpeg: true, progressive: true }).toBuffer();

  before += size;
  if (output.length >= size) {
    // Already well compressed — leave the original bytes alone.
    after += size;
    manifest[rel] = size;
    skipped++;
    continue;
  }

  // Paranoia: never let a re-encode change the pixel dimensions the markup declares.
  const check = await sharp(output).metadata();
  if (check.width !== meta.width || check.height !== meta.height) {
    console.warn(`SKIP (size changed) ${rel}`);
    after += size;
    continue;
  }

  await writeFile(file, output);
  after += output.length;
  manifest[rel] = output.length;
  done++;
  if (done % 50 === 0) console.log(`${done} re-encoded…`);
}

await writeFile(MANIFEST, JSON.stringify(manifest, null, 2));
console.log(`re-encoded ${done}, left alone ${skipped}`);
console.log(`${mb(before)} MB → ${mb(after)} MB`);
