/**
 * Read the live site's post-init DOM.
 *
 * Elementor, PowerPack and Gravity Forms all mutate the served markup after load —
 * Swiper wraps and duplicates slides, the animated headline injects an SVG, the
 * popup is lifted out of the page into a dialog widget, PowerPack's menu stamps its
 * own state classes. The clone has to reproduce that DOM *contract*, not just the
 * behaviour (playbook §3.12), so this dumps what production really ends up with.
 *
 *   node scripts/probe.mjs                 # every page in pages.json
 *   node scripts/probe.mjs /contact-us/    # just these
 */
import { chromium } from 'playwright';
import { writeFile, mkdir, readFile } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url).pathname;
const ORIGIN = process.env.LIVE_ORIGIN || 'https://plumberfranklintn.com';
const OUT = ROOT + '_extract/live-dom/';
const WIDTH = Number(process.env.WIDTH || 1440);
await mkdir(OUT, { recursive: true });

const pages = JSON.parse(await readFile(ROOT + 'src/data/pages.json', 'utf8'));
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : pages.map((p) => p.path).filter((p) => p !== '/404/');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 900 } });
await ctx.route('**/*.{mp4,mov,webm}', (r) => r.abort());

for (const t of targets) {
  const page = await ctx.newPage();
  await page.bringToFront();
  try {
    await page.goto(ORIGIN + t, { waitUntil: 'load', timeout: 90000 });
    await page.waitForTimeout(4000);
    // Open the "Book Appointment" popup so its mounted DOM is captured too — it is
    // the one region of the page that only exists after a click.
    const trigger = page.locator('a[href*="action%3Dpopup"]').first();
    if (await trigger.count()) {
      await trigger.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    const name = (t.replace(/^\/|\/$/g, '') || 'index').replace(/\//g, '__');
    await writeFile(`${OUT}${name}-${WIDTH}.html`, html);
    console.log(name, WIDTH, html.length);
  } catch (err) {
    console.log('FAIL', t, String(err).split('\n')[0]);
  }
  await page.close();
}
await browser.close();
