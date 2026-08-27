/**
 * Content and quality sweep over the cloned pages, for the README's bug register.
 *
 * `npm run audit` proves every internal reference resolves. This one looks for the
 * things that resolve fine and are still wrong: duplicate titles, missing
 * descriptions, images shipped far larger than they render, empty alt text on
 * content images, skipped heading levels, and sections hidden at every breakpoint.
 *
 * It reports; it never fixes. Everything it finds is production's, and the playbook
 * says clone faithfully and flag (§2).
 *
 *   npm run sweep
 */
import { chromium } from 'playwright';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = path.join(ROOT, '.vercel/output/static');
const ORIGIN = process.env.CLONE_ORIGIN || 'http://127.0.0.1:4331';

const pages = JSON.parse(await readFile(path.join(ROOT, 'src/data/pages.json'), 'utf8'));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
for (const pattern of ['**://maps.google.com/**', '**://www.google.com/**', '**://challenges.cloudflare.com/**']) {
  await ctx.route(pattern, (r) => r.abort());
}

const titles = new Map();
const noDescription = [];
const oversized = [];
const missingAlt = [];
const headingJumps = [];
const hiddenSections = [];
const overflow = [];

for (const page of pages) {
  (titles.get(page.title) ?? titles.set(page.title, []).get(page.title)).push(page.path);
  if (!page.description) noDescription.push(page.path);

  const tab = await ctx.newPage();
  await tab.bringToFront();
  await tab.goto(ORIGIN + page.path, { waitUntil: 'load', timeout: 60000 });
  await tab.evaluate(() => document.fonts?.ready);
  await tab.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await tab.waitForTimeout(1200);
  await tab.evaluate(() => window.scrollTo(0, 0));
  await tab.waitForTimeout(400);

  const found = await tab.evaluate(() => {
    const out = { images: [], alt: [], headings: [], hidden: [] };
    for (const img of document.images) {
      const box = img.getBoundingClientRect();
      if (!img.naturalWidth) continue;
      if (box.width > 0 && img.naturalWidth > box.width * 2.5) {
        out.images.push({ src: img.currentSrc, natural: img.naturalWidth, rendered: Math.round(box.width) });
      }
      // Decorative images legitimately carry alt=""; flag only the ones that are
      // the sole content of a link, where a screen reader is left with nothing.
      const link = img.closest('a');
      if (!img.alt?.trim() && link && !link.textContent.trim()) {
        out.alt.push({ src: img.currentSrc, href: link.href });
      }
    }
    let last = 0;
    for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      if (!h.getBoundingClientRect().height) continue;
      const level = Number(h.tagName[1]);
      if (last && level > last + 1) out.headings.push({ from: last, to: level, text: h.textContent.trim().slice(0, 50) });
      last = level;
    }
    for (const section of document.querySelectorAll('.elementor-top-section, .elementor-widget')) {
      const cls = section.className;
      if (/elementor-hidden-desktop/.test(cls) && /elementor-hidden-tablet/.test(cls) && /elementor-hidden-(phone|mobile)/.test(cls)) {
        out.hidden.push({ id: section.getAttribute('data-id'), text: section.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) });
      }
    }
    return out;
  });

  for (const i of found.images) oversized.push({ path: page.path, ...i });
  for (const a of found.alt) missingAlt.push({ path: page.path, ...a });
  for (const h of found.headings) headingJumps.push({ path: page.path, ...h });
  for (const s of found.hidden) hiddenSections.push({ path: page.path, ...s });

  // Playbook §3.9 — builder overflow between the phone and tablet breakpoints.
  for (const width of [400, 500, 640, 767, 900]) {
    await tab.setViewportSize({ width, height: 900 });
    await tab.waitForTimeout(250);
    const wide = await tab.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
      culprits: [...document.querySelectorAll('*')]
        .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
        .slice(0, 3)
        .map((el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`),
    }));
    if (wide.scroll > wide.client + 1) {
      overflow.push({ path: page.path, width, by: wide.scroll - wide.client, culprits: wide.culprits });
    }
  }
  await tab.setViewportSize({ width: 1440, height: 900 });
  await tab.close();
}
await browser.close();

const report = (label, rows, format) => {
  console.log(`\n=== ${label}: ${rows.length}`);
  for (const row of rows.slice(0, 40)) console.log('   ', format(row));
  if (rows.length > 40) console.log(`    … and ${rows.length - 40} more`);
};

report('pages with no meta description', noDescription, (p) => p);
report('duplicate <title> values', [...titles].filter(([, v]) => v.length > 1),
  ([t, v]) => `${JSON.stringify(t)} on ${v.join(', ')}`);
report('images shipped over 2.5x their rendered width', oversized,
  (r) => `${r.path}  ${r.natural}px natural, ${r.rendered}px rendered  ${r.src.split('/').pop()}`);
report('image-only links with no alt text', missingAlt, (r) => `${r.path}  ${r.src.split('/').pop()} -> ${r.href}`);
report('skipped heading levels', headingJumps, (r) => `${r.path}  h${r.from} -> h${r.to}  ${JSON.stringify(r.text)}`);
report('elements hidden at every breakpoint', hiddenSections, (r) => `${r.path}  #${r.id}  ${JSON.stringify(r.text)}`);
report('horizontal overflow', overflow, (r) => `${r.path} @${r.width}  by ${r.by}px  ${r.culprits.join(', ')}`);

// Byte weight of what ships, so the README can be specific about it.
const uploads = path.join(DIST, 'wp-content/uploads');
let bytes = 0;
let count = 0;
const walk = async (dir) => {
  const { readdir } = await import('node:fs/promises');
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else { bytes += (await stat(full)).size; count++; }
  }
};
await walk(uploads);
console.log(`\n=== mirrored uploads: ${count} files, ${(bytes / 1048576).toFixed(1)} MB`);
