/**
 * What a real visitor sees when they submit the form on the deployment.
 *
 *   CLONE_ORIGIN=https://plumberfranklintn.vercel.app node _extract/probe/live-form.mjs
 */
import { chromium } from 'playwright';

const ORIGIN = process.env.CLONE_ORIGIN || 'https://plumberfranklintn.vercel.app';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
// /contact-us/ embeds a Google Map; its iframe keeps `load` pending well past
// 30s from a headless browser, so it is blocked here. The form is what is under
// test, not the map.
for (const pattern of ['**://maps.google.com/**', '**://www.google.com/maps/**', '**://*.gstatic.com/**']) {
  await ctx.route(pattern, (r) => r.abort());
}
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('  [pageerror]', String(e).split('\n')[0]));

await p.goto(`${ORIGIN}/contact-us/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(2500);

console.log('form present:', await p.evaluate(() => ({
  forms: document.querySelectorAll('form[data-contact-form]').length,
  turnstilePlaceholder: document.querySelectorAll('[data-turnstile]').length,
  turnstileScriptLoaded: !!window.turnstile,
  siteKeyMeta: document.querySelector('meta[name="turnstile-sitekey"]')?.content ?? null,
})));

await p.fill('form[data-contact-form] [name="name"]', 'AUTOMATED DEPLOY CHECK - ignore');
await p.fill('form[data-contact-form] [name="email"]', 'support@blendmode.com');
await p.fill('form[data-contact-form] [name="phone"]', '(615) 555-0100');
await p.selectOption('form[data-contact-form] [name="customerType"]', 'Neither');
await p.selectOption('form[data-contact-form] [name="emergency"]', 'No');
await p.fill('form[data-contact-form] [name="message"]', 'Deployment check from the migration harness. Not a real enquiry.');

const res = p.waitForResponse((r) => r.url().includes('/_actions/'), { timeout: 20000 }).catch(() => null);
await p.click('form[data-contact-form] [type="submit"]');
const response = await res;
console.log('action response:', response ? `${response.status()} ${response.url()}` : 'no request seen');

await p.waitForTimeout(2500);
console.log('what the visitor is shown:', await p.evaluate(() => ({
  confirmation: document.querySelector('.gform_confirmation_message')?.textContent.trim() ?? null,
  banner: document.querySelector('.gform_validation_errors:not([hidden])')?.textContent.trim() ?? null,
  fieldErrors: [...document.querySelectorAll('.gfield_validation_message')].map((e) => e.textContent.trim()),
  buttonDisabled: document.querySelector('form[data-contact-form] [type="submit"]')?.disabled,
})));

await b.close();
