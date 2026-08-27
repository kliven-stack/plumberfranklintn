import { chromium } from 'playwright';
const b = await chromium.launch();
for (const [label, origin] of [['live', 'https://plumberfranklintn.com'], ['clone', 'http://127.0.0.1:4331']]) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(origin + '/', { waitUntil: 'load' });
  await p.waitForTimeout(3000);
  await p.evaluate(() => document.querySelector('[data-widget_type="reviews.default"]')?.scrollIntoView({ block: 'center' }));
  await p.waitForTimeout(1500);
  console.log(label, JSON.stringify(await p.evaluate(() => {
    const w = document.querySelector('[data-widget_type="reviews.default"]');
    const c = w.querySelector('.elementor-main-swiper');
    const box = (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
    const slides = [...c.querySelector('.swiper-wrapper').children];
    const arrow = w.querySelector('.elementor-swiper-button-next');
    return {
      widgetBox: box(w), widgetDisplay: getComputedStyle(w).display,
      containerBox: box(c), clientWidth: c.clientWidth,
      wrapperStyle: c.querySelector('.swiper-wrapper').getAttribute('style'),
      slideCount: slides.length,
      slideStyle: slides[0].getAttribute('style'),
      slideBox: box(slides[0]),
      arrow: arrow ? { box: box(arrow), display: getComputedStyle(arrow).display, vis: getComputedStyle(arrow).visibility, op: getComputedStyle(arrow).opacity } : null,
      ancestorHidden: (() => {
        let el = w, out = [];
        while (el && el !== document.body) {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.overflow === 'hidden') out.push(el.className.slice(0, 40) + ':' + cs.display + '/' + cs.overflow);
          el = el.parentElement;
        }
        return out;
      })(),
    };
  })));
  await ctx.close();
}
await b.close();
