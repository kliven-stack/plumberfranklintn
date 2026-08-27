// Self-host the Google families the pages request — and record, in one place, why
// none of them render on the WordPress site.
//
// Elementor's "local Google Fonts" feature already serves this site's families from
// its own origin (/wp-content/uploads/elementor/google-fonts/). But every `src:
// url(...)` in those stylesheets is spelled `http://` while the page is served over
// `https://`, so Chrome blocks all of them as mixed content and the whole site falls
// back to the system stack. That is the original-site bug the README documents; the
// clone reproduces it by default and can switch the fonts on with one env var.
//
// So this script mirrors the real woff2 binaries and rewrites the stylesheets to
// root-relative URLs (which the clone serves over https). BaseLayout decides whether
// to link them, from PUBLIC_WEBFONTS.
//
// Two differences from Elementor's originals, both no-ops for what renders:
//   * only the latin and latin-ext subsets are kept (playbook §2) — the browser's
//     unicode-range gating already meant this English site never fetched the rest;
//   * LiteSpeed minifies the stylesheets and strips the `/* subset */` comments
//     Elementor writes, so subsets are identified by their unicode-range instead.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const HTML = path.join(ROOT, '_extract/html');
const FONTS = path.join(ROOT, 'public/wp/fonts');
const CSSDIR = path.join(ROOT, 'public/wp/css');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Google's latin block always carries U+0000-00FF; latin-ext always U+0100-02BA. */
const KEEP = [/U\+0000-00FF/i, /U\+0100-02BA/i];
const isLatin = (range) => KEEP.some((re) => re.test(range));

await mkdir(FONTS, { recursive: true });
await mkdir(CSSDIR, { recursive: true });

// Which family stylesheets does the site link, and under which handle?
const sheets = new Map(); // handle -> url
for (const f of (await readdir(HTML)).filter((f) => f.endsWith('.html'))) {
  const html = await readFile(path.join(HTML, f), 'utf8');
  for (const m of html.matchAll(/<link[^>]*id='(elementor-gf-local-[^']*)-css'[^>]*href='([^']*)'/g)) {
    if (!sheets.has(m[1])) sheets.set(m[1], m[2]);
  }
}

const get = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
};

let files = 0;
let dropped = 0;
for (const [handle, url] of sheets) {
  const css = await (await get(url)).text();
  const out = [];
  for (const m of css.matchAll(/@font-face\s*\{[^}]*\}/g)) {
    const face = m[0];
    const range = /unicode-range:\s*([^;}]*)/i.exec(face)?.[1] ?? '';
    // A face with no unicode-range covers everything; keep it.
    if (range && !isLatin(range)) { dropped++; continue; }
    out.push(face.replace(/url\(\s*['"]?(\S+?)['"]?\s*\)/g, (_, u) => {
      const name = u.split('/').pop();
      return `url(/wp/fonts/${name})`;
    }));
  }
  await writeFile(path.join(CSSDIR, `${handle}.css`), out.join('\n') + '\n');

  // The woff2 files those blocks now point at, taken from the https spelling of the
  // path the stylesheet used — the http one is exactly what production gets blocked on.
  const names = new Set([...out.join('\n').matchAll(/url\(\/wp\/fonts\/([^)]+)\)/g)].map((m) => m[1]));
  for (const name of names) {
    const dest = path.join(FONTS, name);
    if (existsSync(dest)) continue;
    const src = `https://${new URL(url).host}/wp-content/uploads/elementor/google-fonts/fonts/${name}`;
    await writeFile(dest, Buffer.from(await (await get(src)).arrayBuffer()));
    files++;
  }
  console.log(`${handle.padEnd(36)} ${out.length} faces, ${names.size} files`);
}
console.log(`\n${sheets.size} families, ${files} font files downloaded, ${dropped} non-latin faces dropped`);
