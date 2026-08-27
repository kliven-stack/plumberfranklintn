import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
await p.goto('https://plumberfranklintn.com/', { waitUntil: 'load' });

for (const t of [900, 1600, 2600, 4200, 9200, 11000]) {
  await p.waitForTimeout(t === 900 ? 900 : 0);
  const snap = await p.evaluate(() => {
    const hl = document.querySelector('.elementor-headline--style-highlight .elementor-headline');
    const svg = hl?.querySelector('svg');
    const path = svg?.querySelector('path');
    const rot = document.querySelector('.elementor-headline--style-rotate .elementor-headline');
    const wrap = rot?.querySelector('.elementor-headline-dynamic-wrapper');
    return {
      t: Math.round(performance.now()),
      hlCls: hl?.className,
      svgAttrs: svg && [...svg.attributes].map((a) => `${a.name}="${a.value}"`).join(' '),
      pathD: path?.getAttribute('d')?.slice(0, 60),
      pathStyle: path?.getAttribute('style'),
      pathCs: path && (({ strokeDasharray, strokeDashoffset, transition, stroke, strokeWidth, fill }) => ({ strokeDasharray, strokeDashoffset, transition, stroke, strokeWidth, fill }))(getComputedStyle(path)),
      svgCs: svg && (({ width, height, top, left, position }) => ({ width, height, top, left, position }))(getComputedStyle(svg)),
      rotWrapStyle: wrap?.getAttribute('style'),
      rotWrapCs: wrap && getComputedStyle(wrap).transition,
      rotActive: rot && [...rot.querySelectorAll('.elementor-headline-dynamic-text')].map((s) => s.className.replace('elementor-headline-dynamic-text', '').trim() || '-'),
    };
  });
  console.dir(snap, { depth: 4 });
  if (t !== 900) await p.waitForTimeout(700);
  else await p.waitForTimeout(0);
  await p.waitForTimeout(0);
}
await b.close();
