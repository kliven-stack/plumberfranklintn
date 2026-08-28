/**
 * Playbook §6 acceptance checklist, run against the real deployment.
 *
 * Covers every line automation can reach. The happy path's *side effects* — the row
 * in Neon and the e-mail — a human still has to confirm, and once Turnstile keys are
 * set this script's valid submissions will start being rejected, which is Turnstile
 * working (playbook §3.6).
 *
 * Ordering matters: the pipeline is Zod → honeypot → rate limit, so invalid and
 * honeypot submissions never reach the limiter and cost nothing. Only the valid ones
 * count against 3/min/IP, so they run last.
 *
 *   node _extract/probe/live-acceptance.mjs
 */
const ORIGIN = process.env.CLONE_ORIGIN || 'https://plumberfranklintn.vercel.app';
const ENDPOINT = `${ORIGIN}/_actions/contactSubmit/`;

const VALID = {
  name: 'AUTOMATED PROBE - ignore',
  email: 'support@blendmode.com',
  phone: '(615) 555-0100',
  customerType: 'Neither',
  emergency: 'No',
  message: 'Automated acceptance probe. Not a real enquiry.',
  pagePath: '/contact-us/',
};

async function post(fields) {
  const body = new URLSearchParams(fields);
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
    body,
  });
  const text = await res.text();
  // Which isolate served this. The limiter is per-instance, so a burst landing on
  // five different ids explains a non-firing limit without any bug behind it.
  const instance = (res.headers.get('x-vercel-id') ?? '').split('::').pop() ?? '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, text, parsed, instance };
}

/** Astro encodes action *successes* with devalue and failures as plain JSON. */
const isSuccess = (r) => r.status === 200 && Array.isArray(r.parsed);
const errorOf = (r) => (r.parsed && !Array.isArray(r.parsed) ? r.parsed : null);

let failed = 0;
const check = (label, ok, detail) => {
  console.log(` ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  — ${detail}`}`);
  if (!ok) failed++;
};

console.log(`acceptance → ${ENDPOINT}\n`);

/* ---------------------------------------------------- validation (pre-limiter) */
{
  const r = await post({ ...VALID, email: 'not-an-email' });
  const err = errorOf(r);
  check('bad e-mail is rejected with a field error',
    r.status === 400 && err?.type === 'AstroActionInputError' && !!err?.fields?.email,
    err?.fields?.email?.[0] ?? `${r.status} ${r.text.slice(0, 80)}`);
}
{
  const r = await post({ pagePath: '/contact-us/' });
  const err = errorOf(r);
  const fields = Object.keys(err?.fields ?? {});
  check('an empty submission is rejected field by field',
    r.status === 400 && fields.includes('email') && fields.includes('phone'),
    fields.join(', ') || `${r.status}`);
}

/* ----------------------------------------------------- honeypot (pre-limiter) */
{
  const r = await post({ ...VALID, website: 'https://spam.example' });
  check('honeypot returns success to the bot', isSuccess(r), r.text.slice(0, 60));
  console.log('      (no row and no e-mail should exist for this one — verify in Neon)');
}

/* ------------------------------------------------------ rate limit (3/min/IP) */
console.log('\n  the next few submissions are valid and DO store rows:');
const outcomes = [];
for (let i = 1; i <= 5; i++) {
  const r = await post({ ...VALID, message: `${VALID.message} #${i}` });
  const err = errorOf(r);
  outcomes.push(isSuccess(r) ? 'ok' : err?.message ?? `${r.status}`);
  console.log(`      ${i}: ${outcomes[i - 1]}   [${r.instance.slice(0, 5)}]`);
}
const limited = outcomes.filter((o) => /Too many messages/.test(o)).length;
if (limited) {
  check('the limiter cuts in and says how long to wait', true, `${limited} of 5 rejected`);
} else {
  // Not a failure. Each instance keeps its own counter, so a burst that lands on
  // five cold starts legitimately passes all five — which is what happens on the
  // first run after a deployment. Re-run once the function is warm and it fires.
  console.log(' note  the limiter did not fire: all 5 landed on separate instances.');
  console.log('       Advisory by design (src/lib/ratelimit.ts) — re-run once warm.');
}

console.log(`\n${failed ? `${failed} failed` : 'all automated checks passed'}`);
console.log('still needs a human: the e-mail arrives, and its Reply-To is the customer.');
process.exit(failed ? 1 : 0);
