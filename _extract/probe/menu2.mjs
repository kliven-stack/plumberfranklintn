import { chromium } from 'playwright';

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false });
const p = await ctx.newPage();
await p.goto('https://plumberfranklintn.com/', { waitUntil: 'load' });
await p.waitForTimeout(3500);

const read = (label) => p.evaluate((label) => {
  const nav = document.querySelector('nav[id^="pp-menu-"]');
  const root = nav.querySelector('ul.pp-advanced-menu');
  const li = nav.querySelector('li.menu-item-has-children');
  const sub = li.querySelector('ul.sub-menu');
  return {
    label,
    navTag: nav.outerHTML.slice(0, nav.outerHTML.indexOf('>') + 1),
    rootTag: root.outerHTML.slice(0, root.outerHTML.indexOf('>') + 1),
    liCls: li.className,
    anchorTag: li.querySelector('a').outerHTML.slice(0, 400),
    subTag: sub.outerHTML.slice(0, sub.outerHTML.indexOf('>') + 1),
    subDisplay: getComputedStyle(sub).display,
    subBox: (({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }))(sub.getBoundingClientRect()),
    smartmenusOpts: (() => { try { return JSON.stringify(window.jQuery(root).data('smartmenus')?.opts ?? null); } catch (e) { return 'n/a: ' + e.message; } })(),
  };
}, label);

console.dir(await read('closed'), { depth: 4 });
await p.click('.pp-menu-toggle');
await p.waitForTimeout(800);
console.dir(await read('panel-open'), { depth: 4 });
await p.hover('nav[id^="pp-menu-"] li.menu-item-has-children > a');
await p.waitForTimeout(1200);
console.dir(await read('hovered'), { depth: 4 });
await p.click('nav[id^="pp-menu-"] li.menu-item-has-children > a .sub-arrow').catch((e) => console.log('arrow click failed', e.message));
await p.waitForTimeout(1200);
console.dir(await read('arrow-clicked'), { depth: 4 });
await b.close();
