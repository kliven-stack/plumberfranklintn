import { chromium } from 'playwright';
const b = await chromium.launch();
for (const [label, url] of [['live', 'https://plumberfranklintn.com/'], ['clone', 'http://127.0.0.1:4331/']]) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForTimeout(2500);
  console.log(label, JSON.stringify(await p.evaluate(() => {
    const w = document.querySelector('[data-widget_type="reviews.default"]');
    let el = w;
    while (el && getComputedStyle(el).display !== 'none') el = el.parentElement;
    if (!el) return 'nothing hidden';
    const hits = [];
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      const walk = (list, media) => {
        for (const r of list) {
          if (r.cssRules) { walk(r.cssRules, r.conditionText || media); continue; }
          if (!r.selectorText || !/display\s*:\s*none/.test(r.style?.cssText || '')) continue;
          try { if (!el.matches(r.selectorText)) continue; } catch { continue; }
          hits.push({ sheet: (sheet.href || 'inline').split('/').pop(), media, sel: r.selectorText.slice(0, 120) });
        }
      };
      walk(rules, '');
    }
    return { id: el.getAttribute('data-id'), cls: el.className, inline: el.getAttribute('style'), hits };
  }), null, 1));
  await ctx.close();
}
await b.close();
