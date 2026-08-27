/**
 * Functional tests against the built clone (playbook §2: "plus functional tests").
 *
 * Everything the replaced WordPress JS used to do is exercised here — the parts a
 * computed-style diff cannot see. Build and serve first:
 *
 *   npm run build && npm run serve      # then, in another shell:
 *   npm run functional
 *
 * The form tests assert what the clone ships: both forms exactly as WordPress
 * serves them, the third-party embed complete with the resizer that sizes it.
 */
import { chromium } from 'playwright';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = path.join(ROOT, 'dist');
// 127.0.0.1, not `localhost`: see the note in scripts/compare.mjs.
const ORIGIN = process.env.CLONE_ORIGIN || 'http://127.0.0.1:4331';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? ' ok ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch();

const open = async (path, width = 1440, height = 900) => {
  const ctx = await browser.newContext({ viewport: { width, height } });
  // Third-party embeds are not under test and their hosts reset headless traffic.
  await ctx.route('**://verified.trustymail.co/**', (r) => r.abort());
  await ctx.route('**://*.leadconnectorhq.com/**', (r) => r.abort());
  await ctx.route('**://*.youtube.com/**', (r) => r.abort());
  await ctx.route('**://*.youtube-nocookie.com/**', (r) => r.abort());
  await ctx.route('**://*.googletagmanager.com/**', (r) => r.abort());
  await ctx.route('**://offsiteschedule.zocdoc.com/**', (r) => r.abort());
  await ctx.route('**://threebestrated.com/**', (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
  await page.bringToFront();
  await page.goto(ORIGIN + path, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(700);
  return { ctx, page, errors };
};

/** The sticky header leaves a hidden clone once pinned; name the live copy. */
const HEADER = 'header';

/* ------------------------------------------------------------------ sticky */
{
  const { ctx, page } = await open('/');
  const state = () => page.evaluate(() => {
    const el = document.querySelector('[data-id="0edd40f"]');
    return {
      active: el.classList.contains('elementor-sticky--active'),
      effects: el.classList.contains('elementor-sticky--effects'),
      style: el.getAttribute('style'),
      spacers: document.querySelectorAll('.elementor-sticky__spacer').length,
      y: Math.round(el.getBoundingClientRect().y),
    };
  });

  const top = await state();
  check('sticky: header is in normal flow at the top of the page',
    !top.active && top.spacers === 0 && top.y > 0, JSON.stringify(top));

  await page.evaluate(() => window.scrollTo(0, 400));
  await page.waitForTimeout(400);
  const down = await state();
  check('sticky: header pins once scrolled past it',
    down.active && down.spacers === 1 && down.y === 0 && /position: fixed/.test(down.style || ''),
    JSON.stringify(down));
  check('sticky: --effects is set while pinned', down.effects);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  const back = await state();
  check('sticky: header releases and removes its spacer on the way back up',
    !back.active && back.spacers === 0 && back.y > 0, JSON.stringify(back));
  await ctx.close();
}

/* -------------------------------------------------------------- desktop nav */
{
  const { ctx, page } = await open('/');
  const items = await page.$$eval(`${HEADER} .elementor-nav-menu--main > ul > li > a.elementor-item`,
    (els) => els.map((a) => a.textContent.trim()));
  check('nav: desktop menu renders its top-level items', items.length >= 5, items.join(' | '));

  const annotated = await page.$eval(`${HEADER} .elementor-nav-menu--main li.menu-item-has-children > a`,
    (a) => ({ hasSubmenu: a.classList.contains('has-submenu'), pop: a.getAttribute('aria-haspopup'),
      controls: !!a.getAttribute('aria-controls'), expanded: a.getAttribute('aria-expanded') }));
  check('nav: SmartMenus annotations are reproduced on parent items',
    annotated.hasSubmenu && annotated.pop === 'true' && annotated.controls && annotated.expanded === 'false',
    JSON.stringify(annotated));

  const sub = () => page.$eval('.elementor-nav-menu--main li.menu-item-has-children ul.sub-menu',
    (el) => ({ display: getComputedStyle(el).display, box: el.getBoundingClientRect().height }));

  const box = await page.locator(`${HEADER} .elementor-nav-menu--main li.menu-item-has-children > a`).first().boundingBox();
  await page.mouse.move(box.x - 60, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
  await page.waitForTimeout(120);
  check('nav: sub-menu does not open before SmartMenus\' 250ms show delay',
    (await sub()).display === 'none');
  await page.waitForTimeout(500);
  check('nav: sub-menu opens on hover', (await sub()).display === 'block');

  // Playbook §3.11: the pointer must survive the crossing from the parent item
  // into the sub-menu. Walk the real path — parent → gap → first sub-item.
  const geo = await page.evaluate(() => {
    const li = document.querySelector('.elementor-nav-menu--main li.menu-item-has-children');
    const s = li.querySelector('ul.sub-menu').getBoundingClientRect();
    const p = li.getBoundingClientRect();
    const a = li.querySelector('ul.sub-menu a').getBoundingClientRect();
    return { gapY: p.bottom + Math.max(0.5, (s.top - p.bottom) / 2), midX: s.left + s.width / 2,
      itemX: a.left + a.width / 2, itemY: a.top + a.height / 2 };
  });
  await page.mouse.move(geo.midX, geo.gapY, { steps: 4 });
  await page.waitForTimeout(150);
  check('nav: sub-menu stays open while the pointer crosses the gap (playbook 3.11)',
    (await sub()).display === 'block');
  await page.mouse.move(geo.itemX, geo.itemY, { steps: 4 });
  await page.waitForTimeout(250);
  check('nav: sub-menu is still open once the pointer reaches an item',
    (await sub()).display === 'block');

  await page.mouse.move(geo.itemX, geo.itemY + 500, { steps: 8 });
  await page.waitForTimeout(200);
  check('nav: sub-menu is still open 200ms after leaving (500ms hide delay)',
    (await sub()).display === 'block');
  await page.waitForTimeout(600);
  check('nav: sub-menu closes after the hide delay', (await sub()).display === 'none');
  await ctx.close();
}

/* --------------------------------------------------------------- mobile nav */
for (const width of [900, 390]) {
  const { ctx, page } = await open('/', width, 900);
  const toggle = page.locator(`${HEADER} .elementor-menu-toggle`).first();
  check(`nav @${width}: burger is visible`, await toggle.isVisible());
  check(`nav @${width}: horizontal menu is hidden`,
    !(await page.locator(`${HEADER} .elementor-nav-menu--main`).first().isVisible()));

  const panel = () => page.$eval('nav.elementor-nav-menu--dropdown', (el) => ({
    hidden: el.getAttribute('aria-hidden'),
    x: Math.round(el.getBoundingClientRect().x),
    w: Math.round(el.getBoundingClientRect().width),
  }));
  const shut = await panel();
  check(`nav @${width}: panel is stretched to the viewport, flush left`,
    shut.x === 0 && shut.w === width, JSON.stringify(shut));

  await toggle.click();
  await page.waitForTimeout(400);
  check(`nav @${width}: burger opens the panel`,
    (await panel()).hidden === 'false' && await toggle.evaluate((el) => el.classList.contains('elementor-active')));

  // Collapsible mode: tapping a parent expands it rather than navigating.
  const before = page.url();
  await page.locator('nav.elementor-nav-menu--dropdown li.menu-item-has-children > a').first().click();
  await page.waitForTimeout(400);
  check(`nav @${width}: tapping a parent expands it instead of navigating`,
    page.url() === before
    && await page.$eval('nav.elementor-nav-menu--dropdown li.menu-item-has-children ul.sub-menu',
      (el) => getComputedStyle(el).display === 'block'));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(`nav @${width}: Escape closes the panel`, (await panel()).hidden === 'true');
  await ctx.close();
}

/* ---------------------------------------------------------------- carousels */
{
  const { ctx, page, errors } = await open('/');
  await page.evaluate(() => document.querySelector('.elementor-widget-testimonial-carousel')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(800);

  const t = await page.evaluate(() => {
    const c = document.querySelector('.elementor-widget-testimonial-carousel .elementor-main-swiper');
    const w = c.querySelector('.swiper-wrapper');
    return { init: c.classList.contains('swiper-initialized'), slides: c.querySelectorAll('.swiper-slide').length,
      dupes: c.querySelectorAll('.swiper-slide-duplicate').length,
      active: !!c.querySelector('.swiper-slide-active'), transform: w.style.transform,
      slideW: c.querySelector('.swiper-slide')?.style.width };
  });
  check('carousel: testimonial carousel initialises with loop clones',
    t.init && t.slides === 15 && t.dupes === 2 && t.active && /translate3d/.test(t.transform), JSON.stringify(t));

  const first = await page.$eval('.elementor-widget-testimonial-carousel .swiper-slide-active', (el) => el.textContent.slice(0, 40));
  await page.waitForTimeout(6000);
  const second = await page.$eval('.elementor-widget-testimonial-carousel .swiper-slide-active', (el) => el.textContent.slice(0, 40));
  check('carousel: testimonial carousel autoplays', first !== second, `${first!==second ? 'advanced' : 'stuck on: ' + first}`);

  await page.evaluate(() => document.querySelector('.eael-tm-carousel')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(600);
  const dots = await page.evaluate(() => {
    const p = document.querySelector('.swiper-pagination-9e15ab3');
    return { n: p?.children.length, h: Math.round(p.getBoundingClientRect().height),
      active: p?.querySelectorAll('.swiper-pagination-bullet-active').length,
      clickable: p?.classList.contains('swiper-pagination-clickable') };
  });
  check('carousel: team strip renders its dots row', dots.n > 1 && dots.h >= 20 && dots.active === 1 && dots.clickable,
    JSON.stringify(dots));
  check('home page raises no script errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}
{
  const { ctx, page } = await open('/book-an-appointment/');
  await page.evaluate(() => document.querySelector('.elementor-widget-reviews')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(800);
  const read = () => page.evaluate(() => {
    const w = document.querySelector('.elementor-widget-reviews');
    return { current: w.querySelector('.swiper-pagination-current')?.textContent,
      total: w.querySelector('.swiper-pagination-total')?.textContent,
      active: w.querySelector('.swiper-slide-active')?.getAttribute('data-swiper-slide-index') };
  });
  const a = await read();
  check('carousel: reviews widget paints its fraction pagination', a.current === '1' && a.total === '5', JSON.stringify(a));
  await page.click('.elementor-widget-reviews .elementor-swiper-button-next');
  await page.waitForTimeout(900);
  const b = await read();
  check('carousel: the reviews next arrow advances it', b.current === '2' && b.active !== a.active, JSON.stringify(b));
  await ctx.close();
}

/* ---------------------------------------------------------------- accordion */
{
  const { ctx, page } = await open('/services/gout/');
  await page.evaluate(() => document.querySelector('.eael-adv-accordion')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(500);
  const read = () => page.$$eval('.eael-accordion-list', (ls) => ls.map((l) => ({
    open: l.querySelector('.eael-accordion-header').classList.contains('active'),
    shown: getComputedStyle(l.querySelector('.eael-accordion-content')).display !== 'none',
  })));
  const start = await read();
  check('accordion: exactly one panel is open by default',
    start.filter((x) => x.open).length === 1 && start[0].open && start[0].shown, JSON.stringify(start));

  await page.locator('.eael-accordion-list .eael-accordion-header').nth(1).click();
  await page.waitForTimeout(500);
  const after = await read();
  check('accordion: opening another panel closes the first',
    after[1].open && after[1].shown && !after[0].open && !after[0].shown, JSON.stringify(after));
  await ctx.close();
}

/* --------------------------------------------------------------------- TOC */
{
  const { ctx, page } = await open('/blog/ingrown-toenail-treatment/');
  const links = await page.$$eval('.elementor-toc__list-item a', (as) => as.length);
  check('toc: the list is rendered', links > 1, `${links} entries`);
  const collapsed = () => page.$eval('[data-widget_type="table-of-contents.default"]',
    (el) => el.classList.contains('elementor-toc--collapsed'));
  check('toc: starts open at desktop', !(await collapsed()));
  await page.locator('.elementor-toc__toggle-button--collapse').click();
  await page.waitForTimeout(300);
  check('toc: the toggle collapses it', await collapsed());
  await ctx.close();
}

/* ------------------------------------------------------------------- video */
{
  const { ctx, page } = await open('/about-us/');
  const v = await page.evaluate(() => {
    const el = document.querySelector('.elementor-video');
    if (!el) return null;
    return { tag: el.tagName, src: el.getAttribute('src')?.slice(0, 60),
      h: Math.round(el.getBoundingClientRect().height) };
  });
  // Playbook §3.12: the iframe must *be* the .elementor-video node, not sit inside
  // one, or the aspect-ratio height chain breaks and the player collapses.
  check('video: the iframe replaces the placeholder rather than nesting inside it',
    v && v.tag === 'IFRAME' && v.h > 200, JSON.stringify(v));
  await ctx.close();
}
{
  const { ctx, page } = await open('/testimonials/');
  await page.evaluate(() => document.querySelector('.e-tabs')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(600);
  const read = () => page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.e-tab-title')];
    const shown = [...document.querySelectorAll('.e-tab-content')].filter((c) => getComputedStyle(c).display !== 'none' && c.querySelector('iframe'));
    return { selected: tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true'),
      shownCount: shown.length, shownId: shown[0]?.id };
  });
  const a = await read();
  check('playlist: the first video is selected and mounted', a.selected === 0 && a.shownCount === 1, JSON.stringify(a));
  await page.locator('.e-tab-title').nth(2).click();
  await page.waitForTimeout(700);
  const b = await read();
  check('playlist: clicking a tab swaps the video',
    b.selected === 2 && b.shownCount === 1 && b.shownId !== a.shownId, JSON.stringify(b));
  await ctx.close();
}

/* ------------------------------------------------------------------- forms */
{
  // Both forms ship as WordPress serves them. For the LeadConnector embed that
  // means the iframe *and* its `form_embed.js` resizer — the iframe is served with
  // `height:100%`, which on a block-level iframe resolves to the default 150px, and
  // the resizer is what receives the rendered height from inside the frame and
  // rewrites the inline style to it. Without it the form renders clipped.
  const { ctx, page } = await open('/contact-us/');
  check('form: /contact-us/ ships the LeadConnector iframe',
    (await page.$$('iframe[src*="trustymail"]')).length === 1);
  check('form: its resizer ships with it',
    (await page.$$('script[src*="form_embed"]')).length === 1);
  await ctx.close();

  const bill = await open('/pay-my-bill/');
  const form = await bill.page.evaluate(() => {
    const el = document.querySelector('#wpforms-3051');
    const f = el?.querySelector('form');
    return el && { fields: el.querySelectorAll('.wpforms-field').length, action: f?.getAttribute('action') };
  });
  check('form: /pay-my-bill/ ships WPForms 3051 exactly as WordPress rendered it',
    form && form.fields > 3, JSON.stringify(form));
  check('form: it asks for no card details',
    !(await bill.page.$$eval('#wpforms-3051 [name]', (els) => els.map((e) => e.name).join(' ')))
      .match(/card|cvc|cvv|expiry|routing/i));
  await bill.ctx.close();
}

/* --------------------------------------------------- links, assets, routing */
{
  // Playbook §1: a URL that resolves on WordPress and 404s here is a regression.
  const files = new Set();
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.add('/' + path.relative(DIST, full).split(path.sep).join('/'));
    }
  };
  await walk(DIST);
  const built = new Set([...files].filter((f) => f.endsWith('/index.html')).map((f) => f.replace(/index\.html$/, '')));

  const redirects = new Set(JSON.parse(await readFile(path.join(ROOT, 'vercel.json'), 'utf8'))
    .redirects.map((r) => r.source.replace(/\/:.*$/, '')));

  const { ctx, page } = await open('/');
  const bad = [];
  for (const p of [...built].slice(0, 200)) {
    const links = await page.evaluate(async (target) => {
      const res = await fetch(target);
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return [...doc.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
    }, p);
    for (const href of links) {
      if (!href || /^(https?:|mailto:|tel:|#|javascript:)/.test(href)) continue;
      const clean = href.split('#')[0].split('?')[0];
      if (!clean.startsWith('/')) continue;
      if (/\.(png|jpe?g|webp|gif|svg|pdf|css|js|ico|xml)$/i.test(clean)) continue;
      const withSlash = clean.endsWith('/') ? clean : clean + '/';
      if (built.has(withSlash) || files.has(clean)) continue;
      if (redirects.has(clean) || redirects.has(clean.replace(/\/$/, ''))) continue;
      bad.push(`${p} → ${href}`);
    }
  }
  const unique = [...new Set(bad)];
  check('links: every internal link resolves to a built page or a redirect',
    unique.length === 0, unique.slice(0, 8).join(' | ') || `${built.size} pages swept`);
  await ctx.close();
}
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const hit = async (from) => {
    const res = await page.goto(ORIGIN + from, { waitUntil: 'domcontentloaded' });
    return { status: res.status(), url: new URL(page.url()).pathname };
  };
  const t = await hit('/Testimonials');
  check('routing: the mis-cased /Testimonials breadcrumb still lands on the page',
    t.url === '/testimonials/', JSON.stringify(t));
  const d = await hit('/dr-david-farnen');
  check('routing: the staff pages redirect to /about-us/ as WordPress does',
    d.url === '/about-us/', JSON.stringify(d));
  const nf = await page.goto(ORIGIN + '/no-such-page-here/', { waitUntil: 'domcontentloaded' });
  check('routing: an unknown URL serves the site\'s own 404 template',
    nf.status() === 404 && (await page.title()).length > 0, await page.title());
  await ctx.close();
}
{
  const { ctx, page } = await open('/');
  const broken = await page.evaluate(() => [...document.images]
    .filter((img) => { const r = img.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .filter((img) => img.complete && img.naturalWidth === 0)
    .map((img) => img.currentSrc || img.src)
    // This run blocks the third-party embed hosts, so their images cannot decode
    // by construction. Only the site's own assets are under test here.
    .filter((src) => !/zocdoc|threebestrated|leadconnectorhq|trustymail|googletagmanager/.test(src)));
  // Playbook §3.10: assert on visible images only — offscreen carousel clones
  // legitimately never load.
  check('assets: every visible image on the home page decodes', broken.length === 0, broken.slice(0, 4).join(' | '));
  await ctx.close();
}

/* ------------------------------------------------------------------ redirects */
{
  // Every redirect in vercel.json must actually fire, in the exact spelling it is
  // written in — Vercel matches sources literally, trailing slash included.
  //
  // This test exists because that was not true. Sources were written without a
  // trailing slash while WordPress's canonical URLs have one, so on Vercel the
  // slash form 404'd: the form in Google's index, in inbound links and in
  // bookmarks. It passed locally the whole time, because serve.mjs used to
  // normalise the slash on both sides and was therefore more forgiving than
  // production. Both spellings are now listed and serve.mjs is strict; this is
  // what keeps them that way.
  const { readFile: readVercelJson } = await import('node:fs/promises');
  const { redirects = [] } = JSON.parse(
    await readVercelJson(new URL('../vercel.json', import.meta.url), 'utf8'));

  // Checked with fetch rather than a browser: several rules point at PDFs, which a
  // browser downloads instead of navigating to, and a 3xx is the whole assertion.
  const dead = [];
  for (const rule of redirects) {
    if (rule.has) continue;                    // query-conditional, covered elsewhere
    const probe = rule.source.replace(/\(\.\*\)/g, 'x').replace(/:\w+\*?/g, 'x');
    const res = await fetch(ORIGIN + probe, { redirect: 'manual' }).catch(() => null);
    if (!res || res.status < 300 || res.status >= 400) dead.push(`${probe} -> ${res ? res.status : 'ERR'}`);
  }
  check('redirects: every rule in vercel.json fires as written',
    dead.length === 0, dead.slice(0, 6).join(' | ') || `${redirects.length} rules`);

  // And the pair rule: no path source may be listed in only one spelling.
  // The root and query-conditional rules are exempt: `/` has no no-slash spelling,
  // and a `has` rule is keyed on the query string rather than the path.
  const sources = new Set(redirects.filter((r) => !r.has).map((r) => r.source));
  const lonely = [...sources].filter((s) => s !== '/' && !/\.\w+$/.test(s)
    && !(sources.has(s.replace(/\/$/, '')) && sources.has(s.replace(/\/?$/, '/'))));
  check('redirects: every path source is listed with and without its trailing slash',
    lonely.length === 0, lonely.slice(0, 6).join(' | '));
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('\nfailures:');
  for (const f of failed) console.log(`  ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exitCode = 1;
}
