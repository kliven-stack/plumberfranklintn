import { chromium } from 'playwright';

const b = await chromium.launch();
for (const [w, h] of [[1440, 900], [900, 900], [390, 844]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  const p = await ctx.newPage();

  await p.goto('https://plumberfranklintn.com/plumbing/', { waitUntil: 'load' });
  await p.waitForTimeout(1000);
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await p.waitForTimeout(2500);
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.waitForTimeout(1500);
  console.log(`\n===== portfolio @${w} =====`);
  console.dir(await p.evaluate(() => {
    const c = document.querySelector('.elementor-portfolio');
    const box = (el) => (({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }))(el.getBoundingClientRect());
    return {
      cls: c.className, style: c.getAttribute('style'), cs: { h: getComputedStyle(c).height, pos: getComputedStyle(c).position },
      box: box(c),
      items: [...c.children].slice(0, 6).map((a) => ({ cls: a.className.replace(/post-\d+|\bpage\b|type-page|status-publish|has-post-thumbnail|hentry/g, '').replace(/\s+/g, ' ').trim(), style: a.getAttribute('style'), box: box(a), pos: getComputedStyle(a).position, wcs: getComputedStyle(a).width })),
      thumb: (() => { const t = c.querySelector('.elementor-post__thumbnail'); return { cls: t.className, style: t.getAttribute('style'), box: box(t), pt: getComputedStyle(t).paddingBottom }; })(),
      imgCls: c.querySelector('img').className,
    };
  }), { depth: 6 });

  await p.goto('https://plumberfranklintn.com/water-heaters/tankless-water-heaters/', { waitUntil: 'load' });
  await p.waitForTimeout(1000);
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await p.waitForTimeout(2500);
  console.log(`===== gallery @${w} =====`);
  console.dir(await p.evaluate(() => {
    const c = document.querySelector('.elementor-gallery__container');
    const box = (el) => (({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }))(el.getBoundingClientRect());
    return {
      cls: c.className, style: c.getAttribute('style'), box: box(c),
      items: [...c.children].map((a) => ({ style: a.getAttribute('style'), box: box(a) })),
      image: (() => { const i = c.querySelector('.e-gallery-image'); return { cls: i.className, style: i.getAttribute('style'), bg: getComputedStyle(i).backgroundImage.slice(0, 120), box: box(i) }; })(),
    };
  }), { depth: 6 });
  await ctx.close();
}
await b.close();
