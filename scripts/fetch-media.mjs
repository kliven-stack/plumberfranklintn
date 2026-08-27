// Mirror every asset the pages reference into public/, preserving the original
// path so srcset entries and CSS url() references keep working unchanged.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PUB = path.join(ROOT, 'public');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
   * Percent-decoded, deliberately. Five of the patient-form PDFs have spaces in
   * their filenames, so their URLs arrive as `CE%20-%20Financial%20Policy.pdf`.
   * Writing that verbatim puts a file called `CE%20-%20…` on disk, which every
   * server then fails to find once it decodes the request path — the links 404 in
   * production while the bytes sit right there. The URL in the markup is left
   * encoded; only the filename is decoded.
   */
const localPath = (u) => {
  const url = new URL(u);
  const rel = decodeURIComponent(url.pathname);
  return url.host === 'plumberfranklintn.com'
    ? path.join(PUB, rel)
    : path.join(PUB, 'wp/ext', url.host, rel);
};

/**
 * Files the markup never links but the site still serves.
 *
 * Elementor loads these *conditionally* - none is in any page's <link> list, and
 * they only arrive once something opens. `dialog.min.css` is what makes
 * `.dialog-type-lightbox` a fixed, full-viewport overlay; without it the "Book
 * Appointment" popup lays out in flow at the foot of the page. The other two are
 * the image lightbox on the two water-heater gallery pages.
 * src/scripts/elementor.js injects the same <link> tags on first open, so the
 * files have to exist at their original paths.
 */
const EXTRA = [
  'https://plumberfranklintn.com/wp-content/plugins/elementor/assets/css/conditionals/dialog.min.css',
  'https://plumberfranklintn.com/wp-content/plugins/elementor/assets/css/conditionals/lightbox.min.css',
  'https://plumberfranklintn.com/wp-content/plugins/elementor/assets/lib/swiper/v8/css/swiper.min.css',
];

const urls = [...JSON.parse(await readFile(path.join(ROOT, '_extract/assets.json'), 'utf8')), ...EXTRA];
let ok = 0, cached = 0, failed = [];
const queue = [...urls];
const workers = Array.from({ length: 8 }, async () => {
  while (queue.length) {
    const u = queue.pop();
    const out = localPath(u);
    try { if ((await stat(out)).size > 0) { cached++; continue; } } catch { /* not cached */ }
    try {
      const res = await fetch(u, { headers: { 'user-agent': UA, referer: 'https://plumberfranklintn.com/' } });
      if (!res.ok) { failed.push([res.status, u]); continue; }
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, Buffer.from(await res.arrayBuffer()));
      ok++;
    } catch (e) { failed.push([String(e), u]); }
  }
});
await Promise.all(workers);
console.log(`downloaded ${ok}, cached ${cached}, failed ${failed.length}`);
for (const [s, u] of failed) console.log('  FAIL', s, u);
