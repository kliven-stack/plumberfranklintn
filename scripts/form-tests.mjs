/**
 * The form acceptance checklist (playbook §6), as far as automation can take it.
 *
 * `npm run functional` measures the form's *markup* against a static server. This
 * one exercises the Astro action for real: it starts `astro dev`, which is the only
 * local mode that runs the serverless half, and drives the pipeline in
 * src/actions/index.ts end to end.
 *
 *   npm run form
 *
 * What it deliberately does **not** test is the happy path with a real visitor's
 * token. Turnstile blocks headless browsers, and that is it working (playbook
 * §3.6) — a human submits once against the deployment and confirms the row in Neon
 * and the mail at SITE_OWNER_EMAIL. Everything either side of that is here.
 *
 * Nothing here touches the network. Each block starts its own `astro dev` with the
 * environment that isolates what it tests, and the CAPTCHA block points
 * `TURNSTILE_VERIFY_URL` at a local stub of Cloudflare's siteverify endpoint.
 *
 * That stub is the point rather than a shortcut. An earlier version of this file
 * called Cloudflare for real with its published test secrets, and the results were
 * worthless: the service rate-limits repeated calls from one address, so checks
 * failed for reasons unrelated to the code — and worse, the fail-closed check
 * started passing because the connection was being reset rather than because
 * Cloudflare had rejected anything. Against the stub, every branch of
 * src/lib/turnstile.ts is reached deliberately: accepted, rejected, replayed,
 * unreachable.
 *
 * The one thing left for a human is a real widget token end to end (playbook §3.6).
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { unflatten } from 'devalue';

const PORT = Number(process.env.DEV_PORT || 4333);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ACTION = `${ORIGIN}/_actions/contactSubmit/`;
const STUB_PORT = Number(process.env.STUB_PORT || 4334);
const STUB_URL = `http://127.0.0.1:${STUB_PORT}/siteverify`;

const SECRET = 'test-secret-for-the-stub';

/** Nothing should leave the machine except the two deliberate CAPTCHA calls. */
const QUIET = {
  STORE_FORM_DATA_TO_DB: 'false',
  SEND_EMAIL_TO_SITE_OWNER: 'false',
  SEND_EMAIL_TO_CUSTOMER: 'false',
  IP_HASH_SALT: 'form-tests-salt',
};

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? ' ok ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/** Start `astro dev` with a given environment and wait for it to answer. */
async function startDev(env) {
  const child = spawn('npx', ['astro', 'dev', '--port', String(PORT), '--host', '127.0.0.1'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));

  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${ORIGIN}/`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return child;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  child.kill('SIGTERM');
  throw new Error(`astro dev did not start on ${PORT}\n${log.join('')}`);
}

const stop = async (child) => {
  child.kill('SIGTERM');
  await sleep(900);
  if (!child.killed) child.kill('SIGKILL');
};

/** Runs `body` against a dev server with `env`, and always shuts it down. */
async function withServer(env, body) {
  const child = await startDev({ ...QUIET, ...env });
  try { await body(); } finally { await stop(child); }
}

/**
 * A local stand-in for Cloudflare's siteverify endpoint.
 *
 * Answers by token prefix, so a test says what it wants by the token it sends:
 *
 *   good-*    { success: true }
 *   used-*    { success: false, error-codes: ['timeout-or-duplicate'] }  (replay)
 *   anything  { success: false, error-codes: ['invalid-input-response'] }
 *
 * It also records what it was asked, so the tests can assert the secret and the
 * remote IP really are forwarded.
 */
async function startTurnstileStub() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const token = params.get('response') ?? '';
      seen.push({ secret: params.get('secret'), token, remoteip: params.get('remoteip') });
      const answer = token.startsWith('good-')
        ? { success: true }
        : { success: false, 'error-codes': [token.startsWith('used-') ? 'timeout-or-duplicate' : 'invalid-input-response'] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((resolve) => server.listen(STUB_PORT, '127.0.0.1', resolve));
  return { seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * Post a form body to the action and decode Astro's envelope.
 *
 * Two shapes come back, and neither is plain JSON in the way you would guess:
 * a success is the returned value **devalue-encoded** (so `{ok:true}` arrives as
 * `[{"ok":1},true]`), and a failure is `{ type: 'AstroActionInputError', issues }`
 * or `{ type: 'AstroActionError', code, message }`. The browser never sees this —
 * src/scripts/form.js goes through the `astro:actions` client, which unwraps both —
 * but a raw POST has to do it here.
 */
async function submit(fields, { ip = '203.0.113.10' } = {}) {
  const body = new URLSearchParams({
    name: '', email: '', phone: '', customerType: '', emergency: '', message: '',
    website: '',
    // Unique per request: Cloudflare rejects a reused token with
    // `timeout-or-duplicate` even against the always-passes test secret.
    turnstileToken: `probe-${Math.random().toString(16).slice(2)}`,
    pagePath: '/contact-us/',
    ...fields,
  });
  const res = await fetch(ACTION, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      // The rate limiter keys on this, so each case gets its own bucket.
      'x-forwarded-for': ip,
    },
    body,
  });
  const raw = await res.text();
  if (res.ok) {
    try { return { status: res.status, data: unflatten(JSON.parse(raw)), error: null }; }
    catch { return { status: res.status, data: null, error: { message: raw.slice(0, 200) } }; }
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = { message: raw.slice(0, 200) }; }
  // Input errors carry Zod issues; flatten them the way `isInputError` does.
  const fieldErrors = {};
  for (const issue of parsed.issues ?? []) {
    const key = issue.path?.[0];
    if (key) (fieldErrors[key] ??= []).push(issue.message);
  }
  return {
    status: res.status,
    data: null,
    error: { code: parsed.code, type: parsed.type, message: parsed.message, fields: fieldErrors },
  };
}

const VALID = {
  name: 'Harness',
  email: 'harness@example.com',
  phone: '(615) 555-0100',
  customerType: 'Neither',
  emergency: 'No',
  message: 'Automated check.',
};

/* ------------------------------- validation, honeypot, rate limit, success */
await withServer({ TURNSTILE_SECRET_KEY: '' }, async () => {
  {
    const { error } = await submit({}, { ip: '203.0.113.1' });
    const fields = error?.fields ?? {};
    check('validation: an empty submit is rejected with per-field errors',
      error?.type === 'AstroActionInputError', error?.type);
    check('validation: it names email, phone and both selects',
      ['email', 'phone', 'customerType', 'emergency'].every((f) => fields[f]?.length),
      Object.keys(fields).join(','));
    check('validation: name and message stay optional, as on the WordPress form',
      !fields.name && !fields.message, Object.keys(fields).join(','));
  }
  {
    const { error } = await submit({ ...VALID, email: 'not-an-email' }, { ip: '203.0.113.2' });
    check('validation: a malformed email is rejected with the field named',
      error?.fields?.email?.[0] === 'Please enter a valid email address.',
      error?.fields?.email?.[0]);
  }
  {
    const { error } = await submit({ ...VALID, emergency: 'Perhaps' }, { ip: '203.0.113.3' });
    check('validation: a select value the markup never offered is rejected',
      !!error?.fields?.emergency, JSON.stringify(error?.fields ?? {}));
  }
  {
    const { data, error } = await submit({ ...VALID, website: 'https://spam.example' }, { ip: '203.0.113.4' });
    check('honeypot: a filled honeypot is shown success, not an error',
      !error && data?.ok === true, JSON.stringify(error ?? data).slice(0, 120));
    check('honeypot: and it gets the same confirmation a person gets',
      /Thanks for contacting us/.test(data?.message || ''), data?.message);
  }
  {
    const ip = '203.0.113.5';
    const codes = [];
    for (let i = 0; i < 4; i++) {
      const { error } = await submit(VALID, { ip });
      codes.push(error?.code ?? 'ok');
    }
    check('rate limit: the first three are accepted and the fourth is not',
      codes.slice(0, 3).every((c) => c === 'ok') && codes[3] === 'TOO_MANY_REQUESTS',
      codes.join(','));

    const other = await submit(VALID, { ip: '203.0.113.55' });
    check('rate limit: it is per address — a different IP is unaffected',
      !other.error, other.error?.code ?? 'ok');
  }
  {
    const { data, error } = await submit(VALID, { ip: '203.0.113.7' });
    check('pipeline: a valid submission succeeds',
      !error && data?.ok === true, JSON.stringify(error ?? data).slice(0, 160));
    check('pipeline: it returns the confirmation the form displays',
      /Thanks for contacting us/.test(data?.message || ''), data?.message);
  }
  {
    const { data, error } = await submit({ ...VALID, turnstileToken: '' }, { ip: '203.0.113.11' });
    check('captcha: with no secret configured it is skipped, so the site can deploy first',
      !error && data?.ok === true, JSON.stringify(error ?? data).slice(0, 120));
  }
});

/* -------------------------------------------------- captcha, failing closed */
{
  const stub = await startTurnstileStub();
  try {
    await withServer({ TURNSTILE_SECRET_KEY: SECRET, TURNSTILE_VERIFY_URL: STUB_URL }, async () => {
      // Refused before the endpoint is even asked.
      const missing = await submit({ ...VALID, turnstileToken: '' }, { ip: '203.0.113.6' });
      check('captcha: a submission with no token is refused',
        missing.error?.code === 'FORBIDDEN', missing.error?.code);
      check('captcha: and refusing it costs no verification call', stub.seen.length === 0,
        `${stub.seen.length} calls`);

      const good = await submit({ ...VALID, turnstileToken: 'good-token-1' }, { ip: '203.0.113.12' });
      check('captcha: a token the verifier accepts gets through',
        !good.error && good.data?.ok === true, good.error?.code ?? 'ok');
      check('captcha: the secret and the remote address are both forwarded',
        stub.seen.at(-1)?.secret === SECRET && stub.seen.at(-1)?.remoteip === '203.0.113.12',
        JSON.stringify(stub.seen.at(-1)));

      const replay = await submit({ ...VALID, turnstileToken: 'used-token-1' }, { ip: '203.0.113.13' });
      check('captcha: a replayed token (timeout-or-duplicate) is refused',
        replay.error?.code === 'FORBIDDEN', replay.error?.code ?? 'accepted');

      const bad = await submit({ ...VALID, turnstileToken: 'nonsense' }, { ip: '203.0.113.8' });
      check('captcha: a token the verifier rejects fails the request closed',
        bad.error?.code === 'FORBIDDEN', bad.error?.code ?? 'accepted');
    });
  } finally {
    await stub.close();
  }
}

/* ------------------------------------------ captcha, when the verifier is down */
await withServer({ TURNSTILE_SECRET_KEY: SECRET, TURNSTILE_VERIFY_URL: STUB_URL }, async () => {
  // Same configuration, but nothing is listening on STUB_PORT any more. A verifier
  // we cannot reach must not become a verifier that waves everything through.
  const { error } = await submit({ ...VALID, turnstileToken: 'good-token-2' }, { ip: '203.0.113.14' });
  check('captcha: an unreachable verifier fails closed, it does not fail open',
    error?.code === 'FORBIDDEN', error?.code ?? 'accepted');
});

/* --------------------------------------- the database is the source of truth */
await withServer({ TURNSTILE_SECRET_KEY: '', STORE_FORM_DATA_TO_DB: 'true', DATABASE_URL: '' }, async () => {
  const { error } = await submit(VALID, { ip: '203.0.113.9' });
  check('pipeline: a failed store fails the whole request (playbook §4c step 5)',
    error?.code === 'INTERNAL_SERVER_ERROR', error?.code);
  check('pipeline: and the visitor is told to phone instead',
    /538-8579/.test(error?.message || ''), error?.message);
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length} checks, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  FAIL ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exitCode = 1;
}
