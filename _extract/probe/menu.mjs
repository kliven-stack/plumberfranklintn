import { chromium } from 'playwright';

const b = await chromium.launch();
for (const [w, h] of [[1440, 900], [390, 844]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  const p = await ctx.newPage();
  await p.goto('https://plumberfranklintn.com/', { waitUntil: 'load' });
  await p.waitForTimeout(3500);

  const snap = () => p.evaluate(() => {
    const nav = document.querySelector('nav[id^="pp-menu-"]');
    const wrap = document.querySelector('.pp-advanced-menu-main-wrapper');
    const toggle = document.querySelector('.pp-menu-toggle');
    const pick = (el) => el && ({ cls: el.className, style: el.getAttribute('style'), aria: el.getAttribute('aria-hidden') ?? el.getAttribute('aria-expanded'), box: (({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }))(el.getBoundingClientRect()), vis: getComputedStyle(el).visibility, disp: getComputedStyle(el).display, tr: getComputedStyle(el).transform, op: getComputedStyle(el).opacity });
    const li = document.querySelector('nav[id^="pp-menu-"] li.menu-item-has-children');
    return {
      body: document.body.className,
      html: document.documentElement.className + '|' + (document.documentElement.getAttribute('style') || ''),
      nav: pick(nav), wrap: pick(wrap), toggle: pick(toggle),
      submenuParent: li && { cls: li.className, aCls: li.querySelector('a').className, arrow: li.querySelector('.pp-menu-toggle-icon,.pp-submenu-icon,.pp-has-submenu-container')?.outerHTML?.slice(0, 220) },
      sub: li && (({ cls, style }) => ({ cls, style }))({ cls: li.querySelector('ul').className, style: li.querySelector('ul').getAttribute('style') }),
      subDisp: li && getComputedStyle(li.querySelector('ul')).display,
      overlay: document.querySelector('.pp-menu-overlay, .pp-advanced-menu-overlay')?.outerHTML?.slice(0, 200) ?? null,
      innerH: window.innerHeight, docH: document.documentElement.clientHeight,
    };
  });

  console.log(`\n======== ${w}x${h} CLOSED ========`);
  console.dir(await snap(), { depth: 5 });

  await p.click('.pp-menu-toggle');
  await p.waitForTimeout(900);
  console.log(`======== ${w}x${h} OPEN ========`);
  console.dir(await snap(), { depth: 5 });

  // open a submenu
  const arrow = p.locator('nav[id^="pp-menu-"] li.menu-item-has-children > a').first();
  await arrow.click().catch(() => {});
  await p.waitForTimeout(700);
  console.log(`======== ${w}x${h} SUBMENU ========`);
  console.dir(await snap(), { depth: 5 });
  await ctx.close();
}
await b.close();
