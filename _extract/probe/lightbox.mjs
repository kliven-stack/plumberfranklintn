import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
await p.goto('https://plumberfranklintn.com/water-heaters/tankless-water-heaters/', { waitUntil: 'load' });
await p.waitForTimeout(1500);
await p.evaluate(() => document.querySelector('.elementor-gallery__container').scrollIntoView({ block: 'center' }));
await p.waitForTimeout(2500);
await p.click('.e-gallery-item');
await p.waitForTimeout(3500);
console.log('BODY:', await p.evaluate(() => document.body.className));
console.log('CSS LINKS ADDED:', await p.evaluate(() => [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.id || l.href).slice(-6)));
const html = await p.evaluate(() => {
  const el = document.querySelector('.elementor-lightbox');
  return el ? el.outerHTML : 'NONE';
});
console.log(html.slice(0, 9000));
await b.close();
