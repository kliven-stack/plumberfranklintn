import { env } from './env';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileResult {
  ok: boolean;
  /** True when verification was skipped because no keys are configured yet. */
  skipped: boolean;
  codes: string[];
}

/**
 * Verify a Turnstile token server-side.
 *
 * **Fails closed.** Once `TURNSTILE_SECRET_KEY` is set, a missing token, a network
 * error or a rejection from Cloudflare all mean "not verified" — never "let it
 * through". The one exception is the deliberate one in playbook §4c step 4: with no
 * secret configured the check is skipped with a loud warning, so the site can be
 * deployed and reviewed before the Turnstile widget exists. That warning is the
 * thing to grep the Vercel logs for if real submissions are getting through
 * unchallenged.
 */
export async function verifyTurnstile(token: string | undefined, ip?: string): Promise<TurnstileResult> {
  const secret = env.turnstileSecret;
  if (!secret) {
    console.warn(
      '[turnstile] TURNSTILE_SECRET_KEY is not set — CAPTCHA verification SKIPPED. ' +
      'Set it in the Vercel project settings (playbook §5.3/§5.4) before this site takes real traffic.',
    );
    return { ok: true, skipped: true, codes: ['skipped-no-secret'] };
  }

  if (!token) return { ok: false, skipped: false, codes: ['missing-input-response'] };

  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);

  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    return {
      ok: json.success === true,
      skipped: false,
      codes: json['error-codes'] ?? [],
    };
  } catch (error) {
    console.error('[turnstile] verification request failed', error);
    return { ok: false, skipped: false, codes: ['verification-request-failed'] };
  }
}
