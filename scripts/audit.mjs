/**
 * Link and asset integrity over the built output. Every internal href, src, srcset
 * entry and CSS url() must resolve inside dist/ — a URL that worked on WordPress
 * and 404s here is a regression (playbook §1).
 *
 *   npm run build && node scripts/audit.mjs
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
// The Vercel adapter writes the static site here, not to dist/ (playbook §3.4).
const DIST = path.join(ROOT, '.vercel/output/static');
const redirects = JSON.parse(await readFile(path.join(ROOT, 'vercel.json'), 'utf8')).redirects ?? [];
const redirectSources = new Set(redirects.map((r) => r.source.replace(/\/$/, '')));

/**
 * Links that are broken on the WordPress site too, cloned as-is (playbook: reproduce
 * original-site bugs faithfully, then flag them). Verified 404 on production
 * 2026-08-20. Remove an entry here the moment the client asks for the link to be
 * fixed — anything not listed is a migration regression.
 */
const BROKEN_ON_PRODUCTION = new Set([
  // Nothing yet. Every internal link on this site resolves on production, and the
  // two that a static host would break — `/Testimonials` (wrong case, no trailing
  // slash) and `/services/page/2/` — are carried as redirects in vercel.json.
  // Add an entry here only for a link that 404s on WordPress too.
]);

/**
 * Hosts the markup links to that no longer answer. Populated once the crawl shows
 * which off-site links production itself has already lost; anything not listed and
 * unreachable is a migration regression.
 */
const DEAD_HOSTS = new Set([]);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

/** Where a page lives, so a document-relative href can be resolved against it. */
const dirOf = (file) => '/' + path.relative(DIST, path.dirname(file)).split(path.sep).filter(Boolean).map((s) => s + '/').join('');

const resolveTarget = async (url, from) => {
  const clean = url.split('#')[0].split('?')[0];
  if (!clean || clean.startsWith('data:') || clean.startsWith('mailto:') || clean.startsWith('tel:')) return true;
  if (/^https?:\/\//.test(clean) || clean.startsWith('//')) {
    try { return !DEAD_HOSTS.has(new URL(clean, 'https://x.invalid').host); } catch { return true; }
  }
  // Document-relative: resolve against the page, the way a browser would. The
  // WordPress copy has one of these (see BROKEN_ON_PRODUCTION) and it is a 404 on
  // both sides — worth reporting rather than skipping.
  if (!clean.startsWith('/')) return resolveTarget(new URL(clean, 'https://x.invalid' + dirOf(from)).pathname, from);
  const target = path.join(DIST, decodeURIComponent(clean));
  if (await exists(target)) {
    return (await stat(target)).isDirectory() ? exists(path.join(target, 'index.html')) : true;
  }
  if (await exists(target + '/index.html')) return true;
  if (await exists(target + '.html')) return true;
  return redirectSources.has(clean.replace(/\/$/, ''));
};

const htmlFiles = [];
const cssFiles = [];
for await (const file of walk(DIST)) {
  if (file.endsWith('.html')) htmlFiles.push(file);
  else if (file.endsWith('.css')) cssFiles.push(file);
}

const broken = new Map(); // url -> Set(page)
const note = (url, where) => {
  if (!broken.has(url)) broken.set(url, new Set());
  broken.get(url).add(path.relative(DIST, where));
};

let checked = 0;
for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  const urls = new Set();
  for (const m of html.matchAll(/(?:href|src|poster|data-thumbnail)="([^"]+)"/g)) urls.add(m[1]);
  for (const m of html.matchAll(/srcset="([^"]+)"/g)) {
    for (const part of m[1].split(',')) urls.add(part.trim().split(/\s+/)[0]);
  }
  for (const url of urls) {
    checked++;
    if (!(await resolveTarget(url, file))) note(url, file);
  }
}

for (const file of cssFiles) {
  const css = await readFile(file, 'utf8');
  for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
    checked++;
    if (!(await resolveTarget(m[1], file))) note(m[1], file);
  }
}

console.log(`${htmlFiles.length} pages, ${cssFiles.length} stylesheets, ${checked} references checked`);

const knownBad = ([url, pages]) => {
  const resolved = url.startsWith('/') ? url : new URL(url, 'https://x.invalid/' + [...pages][0].replace(/index\.html$/, '')).pathname;
  if (BROKEN_ON_PRODUCTION.has(resolved.replace(/\/$/, '')) || BROKEN_ON_PRODUCTION.has(url.replace(/\/$/, ''))) return true;
  try { return DEAD_HOSTS.has(new URL(url, 'https://x.invalid').host); } catch { return false; }
};
const expected = [...broken].filter(knownBad);
const regressions = [...broken].filter((entry) => !knownBad(entry));

for (const [url, pages] of expected) {
  console.log(`  known-broken (404s on WordPress too): ${url} — ${pages.size} page(s)`);
}

if (!regressions.length) {
  console.log('no broken internal references beyond the ones production already has');
} else {
  console.log(`\n${regressions.length} REGRESSIONS:`);
  for (const [url, pages] of regressions) {
    console.log(`  ${url}\n      on ${[...pages].slice(0, 4).join(', ')}${pages.size > 4 ? ` (+${pages.size - 4} more)` : ''}`);
  }
  process.exitCode = 1;
}
