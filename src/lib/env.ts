/**
 * Runtime configuration for the contact action.
 *
 * Read at *request* time, never at module scope. Two reasons: the feature flags
 * below are meant to be flipped in the Vercel dashboard and take effect on the next
 * request rather than the next deploy, and `process.env` on Vercel is only fully
 * populated inside the function invocation.
 */

const read = (key: string): string => (process.env[key] ?? '').trim();

/** A flag that is on unless it is explicitly switched off. */
const onUnless = (key: string, fallback: boolean): boolean => {
  const raw = read(key).toLowerCase();
  if (!raw) return fallback;
  return !['0', 'false', 'off', 'no'].includes(raw);
};

export const env = {
  get databaseUrl() { return read('DATABASE_URL'); },

  get postmarkToken() { return read('POSTMARK_SERVER_TOKEN'); },
  get postmarkFrom() { return read('POSTMARK_FROM_EMAIL'); },
  get siteOwnerEmail() { return read('SITE_OWNER_EMAIL'); },

  get turnstileSecret() { return read('TURNSTILE_SECRET_KEY'); },
  get turnstileSiteKey() { return read('PUBLIC_TURNSTILE_SITE_KEY'); },
  /**
   * Where the token is verified. Cloudflare's own endpoint everywhere that
   * matters; overridable so `npm run form` can drive the whole pipeline against a
   * local stub instead of hammering - and being rate-limited by - the real
   * service, which made those checks pass and fail for reasons unrelated to the
   * code. Never set in Vercel.
   */
  get turnstileVerifyUrl() {
    return read('TURNSTILE_VERIFY_URL') || 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
  },

  /**
   * Salt for the one-way hash of the submitter's IP. The raw address is never
   * stored: the hash is only there to spot repeat submissions, and it is useless to
   * anyone who does not have this value.
   */
  get ipHashSalt() { return read('IP_HASH_SALT'); },

  /** Playbook §4c step 7 — flags read per request, with their documented defaults. */
  get storeToDb() { return onUnless('STORE_FORM_DATA_TO_DB', true); },
  get emailOwner() { return onUnless('SEND_EMAIL_TO_SITE_OWNER', true); },
  get emailCustomer() { return onUnless('SEND_EMAIL_TO_CUSTOMER', false); },
};
