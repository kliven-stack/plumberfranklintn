/**
 * Measured fidelity check (playbook §2): load the same page from production and
 * from the local clone at 1440 / 900 / 390 px, then diff landmark bounding boxes
 * and computed styles element by element.
 *
 * Landmarks are matched by Elementor's stable `data-id`, plus a few structural
 * selectors, so the comparison does not depend on DOM order.
 *
 *   node scripts/compare.mjs [--only=/path/] [--width=1440]
 */
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url).pathname;
const LIVE = process.env.LIVE_ORIGIN || 'https://plumberfranklintn.com';
// 127.0.0.1, not `localhost`: on macOS `localhost` resolves to ::1 first, and a
// stale dev server from a sibling site that bound IPv6 will answer instead of this
// one. That is playbook §7.6's trap, and it really happened on this migration —
// :4321 and :4331 were both already owned. The guard below is the belt to this
// braces: it aborts if the clone is not serving this site.
const CLONE = process.env.CLONE_ORIGIN || 'http://127.0.0.1:4331';
const WIDTHS = [1440, 900, 390];
const TOLERANCE = { pos: 3, size: 3 };

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const pages = JSON.parse(await readFile(ROOT + 'src/data/pages.json', 'utf8'));
// `--only=/path/` for one page, `--paths=/a/,/b/` for a set. The set is how the
// narrower widths get measured without re-requesting all 77 pages from a live host
// that starts throttling after a few hundred hits — pick one page per template.
const wanted = args.paths ? new Set(args.paths.split(',')) : null;
const targets = args.only
  ? pages.filter((p) => p.path === args.only)
  : wanted
    ? pages.filter((p) => wanted.has(p.path))
    : pages;
if ((args.only || wanted) && !targets.length) {
  console.error('no pages matched', args.only || args.paths);
  process.exit(1);
}

/** Seconds to wait between pages. The live host degrades under a fast sweep. */
const PACE = Number(process.env.PACE || 0);
const widths = args.width ? [Number(args.width)] : WIDTHS;

const PROBE = () => {
  // Force a full style recalculation before reading anything.
  //
  // Chrome resolves `margin-inline: auto` to its used value lazily: on a page whose
  // scripts never invalidate style after first layout — which is exactly what a
  // static clone is — `getComputedStyle(el).marginLeft` keeps answering `0px` for
  // the theme's auto-centred `main#content`, while the box really is at x=150.
  // Production's jQuery/Elementor churn happens to knock that cache over, so the two
  // sides disagreed about a margin they both render identically. Invalidate here so
  // the probe measures what is on screen.
  for (const sheet of document.styleSheets) {
    try {
      sheet.disabled = true;
      void document.documentElement.offsetWidth;
      sheet.disabled = false;
      void document.documentElement.offsetWidth;
    } catch { /* cross-origin */ }
  }

  const out = {};
  const push = (key, el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out[key] = {
      x: Math.round(r.x), y: Math.round(r.y + window.scrollY),
      w: Math.round(r.width), h: Math.round(r.height),
      font: `${cs.fontFamily.split(',')[0].replace(/["']/g, '')} ${cs.fontSize} ${cs.fontWeight}`,
      color: cs.color,
      bg: cs.backgroundColor,
      // Background *images*, not just colours. Comparing only `backgroundColor`
      // let the whole home-page hero go missing unnoticed: it is an Elementor
      // background slideshow, built entirely in JS from a gallery in
      // `data-settings`, so the clone rendered a flat grey box that matched
      // production's flat grey box on every property being compared. Only the
      // filename is kept — the origin differs by construction.
      bgImage: cs.backgroundImage === 'none' ? '' : (cs.backgroundImage.match(/[^/"')]+\.(?:jpe?g|png|webp|avif|gif|svg)/gi) || []).join(','),
      display: cs.display,
      pad: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
      margin: `${cs.marginTop} ${cs.marginRight} ${cs.marginBottom} ${cs.marginLeft}`,
      align: cs.textAlign,
      // Whether this node's geometry is still being driven by a LiteSpeed
      // placeholder rather than by a real image. Production lazy-loads, and the
      // slides a carousel has translated off screen never come into view, so their
      // 1x1 GIF keeps reporting a square aspect — 200px wide where the real
      // portrait renders 167. The clone un-lazies at extract time (see
      // scripts/extract.mjs), so it measures the settled state from the start.
      placeholder: (() => {
        const img = el.tagName === 'IMG' ? el : el.querySelector?.('img');
        return !!img && (img.currentSrc || img.src || '').startsWith('data:');
      })(),
    };
  };
  for (const el of document.querySelectorAll('[data-id]')) {
    // Carousel loop clones repeat their source data-id; measure the real slide.
    if (el.closest('.swiper-slide-duplicate')) continue;
    const key = `id:${el.getAttribute('data-id')}`;
    if (key in out) continue;
    push(key, el);
  }
  // Elementor's own elements all carry a data-id; the theme-rendered pages (the
  // posts, the category archive, and the four pages that use the Hello template)
  // carry none, so those would otherwise be compared as an empty box. Sweep their
  // leaves by document order instead — that is where their text and typography are.
  const LEAVES = 'h1, h2, h3, h4, h5, h6, p, li, a, img, blockquote, time, .entry-title, .page-header, .page-content, .comments-area, .comment-body, .nav-links';
  //
  // Zero-size nodes are skipped, and skipping them is what keeps the index stable.
  // These leaves are matched by position, so any node one side has and the other
  // does not shifts every index after it and turns one real difference into a
  // hundred false ones. /pay-my-bill/ is the case in point: WPForms' phone-country
  // JS builds a 247-item country list that is display:none on production and
  // absent from the clone, which was enough to make the whole page below the form
  // look wrong. Nothing that paints nothing can be a fidelity difference — and a
  // node that is zero-size on one side but real on the other still shows up, as an
  // extra or a missing.
  let leafIndex = 0;
  document.querySelectorAll(LEAVES).forEach((el) => {
    if (el.closest('.swiper-slide-duplicate') || el.closest('.elementor-sticky__spacer')) return;
    const box = el.getBoundingClientRect();
    if (!box.width && !box.height) return;
    const i = leafIndex++;
    push(`leaf:${i}:${el.tagName.toLowerCase()}`, el);
    // innerText, not textContent: with scripting on, a <noscript> block's markup
    // counts as text but renders as nothing, and the clone drops LiteSpeed's
    // <noscript> image twins (see scripts/extract.mjs). innerText compares what is
    // actually painted.
    out[`leaf:${i}:${el.tagName.toLowerCase()}`].text =
      (el instanceof HTMLElement ? el.innerText : el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  });

  for (const sel of ['body', 'header.elementor-location-header', 'footer.elementor-location-footer', 'main#content', '[data-elementor-type="wp-page"]', '[data-elementor-type="single-post"]', '[data-elementor-type="archive"]',
    // The container is CSS-sized, so it is comparable here. The <video> inside it is
    // not: this run blocks media on both sides, and production only sizes its player
    // once the file loads. That geometry is checked by scripts/compare-video.mjs,
    // which loads the videos for real.
    '.elementor-background-video-container']) {
    const el = document.querySelector(sel);
    if (el) push(`sel:${sel}`, el);
  }
  out['__page'] = { h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth };
  return out;
};

let browser = await chromium.launch();

// Never diff against the wrong site. Both origins must serve the page we asked for.
{
  const tab = await (await browser.newContext()).newPage();
  for (const [label, origin] of [['live', LIVE], ['clone', CLONE]]) {
    const res = await tab.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
      .catch(() => null);
    const title = await tab.title().catch(() => '');
    if (!res || !res.ok() || !/Plumber Franklin TN/i.test(title)) {
      console.error(`${label} origin ${origin} is not serving this site (title: ${JSON.stringify(title)}).`);
      console.error(label === 'clone' ? 'Run `npm run build && PORT=4331 npm run serve` first.' : '');
      process.exit(1);
    }
    console.log(`${label.padEnd(5)} ${origin} → ${title}`);
  }
  await tab.close();
}

const report = [];

for (const width of widths) {
  /**
   * Rebuilt from scratch whenever the browser has to be relaunched, so the request
   * blocking below is never silently lost part-way through a run.
   */
  const makeContext = async () => {
    if (!browser?.isConnected()) browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    // Videos never settle and third-party embeds vary run to run; block both sides
    // identically so the geometry is comparable (playbook §7.6).
    await ctx.route('**/*.{mp4,mov,webm}', (r) => r.abort());
    // /book-an-appointment/ paints a YouTube background video into its hero. The
    // player keeps the load event pending long enough to blow a 90s timeout on the
    // live side, so the page was being skipped entirely. The container it sits in
    // is CSS-sized, so blocking the embed on both sides leaves the geometry
    // comparable and the page measurable (playbook §7.6).
    await ctx.route('**://*.youtube.com/**', (r) => r.abort());
    await ctx.route('**://*.youtube-nocookie.com/**', (r) => r.abort());
    await ctx.route('**://*.ytimg.com/**', (r) => r.abort());
    await ctx.route('**://*.googletagmanager.com/**', (r) => r.abort());
    await ctx.route('**://*.google-analytics.com/**', (r) => r.abort());
    // The LeadConnector widgets render differently run to run and their host resets
    // headless traffic at random, so both the forms and the chat bubble are blocked on
    // both sides. The iframe boxes themselves are sized by the page's own CSS, so the
    // geometry stays comparable — and while no Growthmap endpoint is configured both
    // sides serve those same iframes anyway.
    // KEEP_EMBEDS=1 lets the lead widgets load on both sides, to check the geometry
    // they actually produce. Off by default: the host resets headless traffic at
    // random, so a run that keeps them is only meaningful when it succeeds.
    if (!process.env.KEEP_EMBEDS) await ctx.route('**://verified.trustymail.co/**', (r) => r.abort());
    await ctx.route('**://*.leadconnectorhq.com/**', (r) => r.abort());
    await ctx.route('**://links.sybrware.com/**', (r) => r.abort());
    await ctx.route('**://*.googleapis.com/**', (r) => r.abort());
    // Zocdoc's "Book Online" widget is the flakiest thing on the page. Its inline
    // loader swaps the plain link for a hosted image button (238x30 instead of
    // 177x60), and whether it wins the race varies per load — so an unblocked run
    // reports ~550 diffs on the home page one time and 0 the next, purely from which
    // side got the widget. Blocked on both sides, both render the same fallback link.
    await ctx.route('**://*.zocdoc.com/**', (r) => r.abort());
    // The ThreeBestRated award badge is deliberately NOT blocked. Both sides load
    // it from the same external host and it is a fixed 200px SVG, so it measures
    // identically — whereas blocking it leaves two differently-sized broken-image
    // boxes, which is a difference the harness invented rather than found.
    return ctx;
  };

  let ctx = await makeContext();
  let sinceRecycle = 0;

  for (const page of targets) {
    // Recycle the browser every few pages.
    //
    // A single chromium held open across 77 pages x 2 origins grows until macOS
    // kills it — which is how the first two full runs died, mid-run, and reported
    // the rest of the site as "failed 3x". Restarting it periodically keeps the
    // resident set flat and costs about 200ms each time.
    if (sinceRecycle >= 8) {
      await ctx.close().catch(() => {});
      await browser.close().catch(() => {});
      browser = await chromium.launch();
      ctx = await makeContext();
      sinceRecycle = 0;
    }
    sinceRecycle++;

    const measure = async (origin) => {
      const tab = await ctx.newPage();
      await tab.bringToFront();
      try {
        await tab.goto(origin + page.path, { waitUntil: 'load', timeout: 90000 });
        // Text wraps differently against fallback metrics. Production serves large
        // unsubsetted TTFs, so it swaps in noticeably later than the clone's woff2 —
        // measuring before both have settled invents differences that are not there.
        await tab.evaluate(() => document.fonts.ready);
        await tab.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await tab.waitForTimeout(1200);
        await tab.evaluate(() => window.scrollTo(0, 0));
        await tab.waitForTimeout(800);
        // Then wait for the images themselves, rather than assuming the scrolling
        // above was enough. It is off localhost; it is not over the internet, and
        // against the deployments the image-heavy pages measured mid-decode and
        // reported geometry diffs that vanished on a re-run. A half-loaded image
        // has no layout box yet, so this is the difference between measuring the
        // page and measuring the network.
        await tab.evaluate(async () => {
          const pending = () => [...document.images].filter((i) => !i.complete);
          for (let i = 0; i < 60 && pending().length; i++) {
            await new Promise((r) => setTimeout(r, 250));
          }
          await Promise.all([...document.images]
            .filter((i) => i.currentSrc)
            .map((i) => i.decode().catch(() => {})));
        });
        // Carousels autoplay on both sides; pin them to the first slide last of all
        // so the geometry diff is deterministic. Production runs real Swiper, the
        // clone runs the reimplementation in src/scripts/elementor.js — both are
        // asked for loop index 0 with no transition. All three kinds are listed:
        // Pro's testimonial carousel and reviews widget both autoplay every 5s, and
        // the Essential Addons team strip every 2s, so leaving any of them free
        // makes the sections below them unmeasurable.
        await tab.evaluate(() => {
          for (const el of document.querySelectorAll('.elementor-main-swiper, .eael-tm-carousel, [id^="swiper-container-"]')) {
            if (el.swiper) { el.swiper.autoplay?.stop(); el.swiper.slideToLoop(0, 0); }
            else if (el.eCarousel) el.eCarousel.reset();
          }
        });
        await tab.waitForTimeout(250);
        return await tab.evaluate(PROBE);
      } finally { await tab.close(); }
    };

    // The live host resets headless connections at random, so a single timeout is
    // not a result. Retry before believing it, and record a skip rather than
    // inventing diffs if it never answers.
    //
    // A dead *browser* is a different thing from a dead page, and conflating them
    // wasted a whole run: chromium fell over early and the retry loop then churned
    // through all 77 pages reporting "failed 3x" for each. If the browser has gone,
    // relaunch it and rebuild the context before counting the attempt as a failure.
    const attempt = async (origin) => {
      let last;
      for (let i = 0; i < 3; i++) {
        try { return await measure(origin); } catch (error) {
          last = error;
          if (!browser.isConnected() || /browser has been closed|Target page, context or browser/.test(String(error))) {
            console.log('  (browser died — relaunching)');
            try { await browser.close(); } catch { /* already gone */ }
            browser = await chromium.launch();
            ctx = await makeContext();
          }
          await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        }
      }
      console.log(`SKIP ${String(width).padStart(4)} ${page.path} — ${origin} failed 3x: ${String(last).split('\n')[0]}`);
      return null;
    };

    if (PACE) await new Promise((r) => setTimeout(r, PACE * 1000));

    // Sequentially, never concurrently: background tabs throttle layout work.
    const live = await attempt(LIVE);
    const clone = live ? await attempt(CLONE) : null;
    if (!live || !clone) { report.push({ path: page.path, width, skipped: true }); continue; }

    // DUMP=1 writes both sides' raw probe output for the page, so a puzzling diff
    // can be read in context instead of guessed at from a leaf index.
    if (process.env.DUMP) {
      await writeFile(`${ROOT}_extract/dump-${page.slug}-${width}.json`,
        JSON.stringify({ live, clone }, null, 1));
    }

    const diffs = [];
    for (const key of Object.keys(live)) {
      const a = live[key], b = clone[key];
      if (!b) {
        // A node production has and the clone does not, which paints nothing on
        // production either, is not a visual difference. The case this exists for:
        // the Essential Addons TOC script injects a `.eael-toc` panel into the
        // category archives that is never in their HTML and renders inside a
        // `display: none` ancestor — five zero-size nodes, invisible on the live
        // site. Anything with real dimensions still counts as missing.
        if (a.w === 0 && a.h === 0) continue;
        diffs.push({ key, kind: 'missing', live: `${a.w}x${a.h}`, text: a.text });
        continue;
      }
      if (key === '__page') {
        if (Math.abs(a.h - b.h) > 24) diffs.push({ key, kind: 'page-height', live: a.h, clone: b.h });
        continue;
      }
      // Production measured before its lazy image loaded: not a fidelity
      // difference, and verified as such — once the same image loads on the live
      // site it renders exactly the width the clone does.
      if (a.placeholder && !b.placeholder) continue;

      for (const prop of ['x', 'y', 'w', 'h']) {
        const limit = prop === 'x' || prop === 'y' ? TOLERANCE.pos : TOLERANCE.size;
        if (Math.abs(a[prop] - b[prop]) > limit) diffs.push({ key, kind: prop, live: a[prop], clone: b[prop] });
      }
      for (const prop of ['font', 'color', 'bg', 'bgImage', 'display', 'pad', 'margin', 'align', 'text']) {
        if (a[prop] === undefined && b[prop] === undefined) continue;
        if (a[prop] === b[prop]) continue;
        // LiteSpeed ships a <noscript> twin after every lazy-loaded image. With
        // scripting on it renders as nothing, but its markup still counts as text,
        // so production's innerText for those anchors is a literal "<img …>" string.
        // The clone drops the twins at extract time (see scripts/extract.mjs), so
        // this is the one text difference that means the clone is *right*.
        if (prop === 'text' && /^<(img|iframe)\b/.test(a.text || '') && !b.text) continue;
        diffs.push({ key, kind: prop, live: a[prop], clone: b[prop] });
      }
    }
    const extra = Object.keys(clone).filter((k) => !(k in live));
    report.push({ path: page.path, width, checked: Object.keys(live).length, diffs, extra });
    const flag = diffs.length ? 'DIFF' : ' ok ';
    console.log(`${flag} ${String(width).padStart(4)} ${page.path.padEnd(56)} ${Object.keys(live).length} nodes, ${diffs.length} diffs${extra.length ? `, ${extra.length} extra` : ''}`);
  }
  await ctx.close();
}

await browser.close();
await mkdir(ROOT + '_extract', { recursive: true });
const REPORT = ROOT + (process.env.REPORT_PATH || '_extract/compare-report.json');
await writeFile(REPORT, JSON.stringify(report, null, 2));
const skipped = report.filter((r) => r.skipped).length;
const total = report.reduce((n, r) => n + (r.diffs?.length || 0), 0);
console.log(`\n${report.length - skipped} comparisons, ${total} diffs${skipped ? `, ${skipped} skipped` : ''} → ${REPORT}`);
