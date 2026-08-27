import { defineAction, ActionError } from 'astro:actions';
import { z } from 'astro:schema';
import { createHash } from 'node:crypto';
import { env } from '../lib/env';
import { verifyTurnstile } from '../lib/turnstile';
import { rateLimit } from '../lib/ratelimit';
import { storeSubmission } from '../lib/db';
import { sendOwnerEmail, sendCustomerEmail, type LeadEmail } from '../lib/email';

/**
 * The one server-side endpoint on this site: the Book Appointment form, which
 * Gravity Forms used to post to WordPress.
 *
 * **The name must stay flat.** Playbook §3.1: a dot in an action name (from nesting
 * the action inside an object) makes `/_actions/contact.submit` look like a file to
 * Vercel's trailing-slash rules, which 308-redirects it and 404s every submission.
 * `contactSubmit`, not `contact.submit`.
 */

const REQUIRED = 'This field is required.';

/**
 * Every field arrives as text, and every one of them can arrive as `null`.
 *
 * That is Astro's form adapter, not the browser: an input the visitor left empty
 * comes through as `null` rather than `""`, so a bare `z.string()` rejects it with
 * "Expected string, received null" — which is not an error anyone should ever see
 * on a contact form. Normalising here means the field-level messages below are the
 * only ones that can reach the page.
 */
const text = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value == null ? '' : String(value).trim()), schema);

/**
 * Gravity Forms' own validation, field for field.
 *
 * Name and Message are optional and Email / Phone / both selects are required —
 * that is form 1's configuration, read off the `gfield_contains_required` classes
 * in the rendered markup, and it is reproduced rather than tightened. The select
 * values are pinned to the options the markup offers so a hand-built POST cannot
 * write arbitrary text into the client's inbox.
 *
 * Note that the *browser* enforces none of this. Gravity Forms marks its required
 * fields with `aria-required` only, never the HTML `required` attribute, so an
 * empty submit really does reach the server — on the WordPress site too. This is
 * the validation, not a second line of it.
 */
const schema = z.object({
  name: text(z.string().max(200)),
  email: text(z.string().min(1, REQUIRED).email('Please enter a valid email address.').max(320)),
  phone: text(z.string().min(1, REQUIRED).max(50)),
  customerType: text(z.enum(
    ['Yes, I am a potential new customer', 'No, I am an existing customer', 'Neither'],
    { errorMap: () => ({ message: REQUIRED }) },
  )),
  emergency: text(z.enum(['Yes', 'No', 'Maybe'], { errorMap: () => ({ message: REQUIRED }) })),
  message: text(z.string().max(5000)),

  /** Gravity Forms' honeypot, kept and renamed. Never filled by a person. */
  website: text(z.string()),

  /** Cloudflare Turnstile's response token, from the widget in the form. */
  turnstileToken: text(z.string()),

  /** Which page the form was submitted from, for triage. */
  pagePath: text(z.string().max(300)),
});

/** The confirmation Gravity Forms showed. See the README: unverifiable defaults. */
export const CONFIRMATION = 'Thanks for contacting us! We will get in touch with you shortly.';

const clientIp = (request: Request): string =>
  (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() ||
  request.headers.get('x-real-ip') ||
  'unknown';

const hashIp = (ip: string): string | null => {
  const salt = env.ipHashSalt;
  if (!salt || ip === 'unknown') return null;
  return createHash('sha256').update(ip + salt).digest('hex');
};

export const server = {
  contactSubmit: defineAction({
    accept: 'form',
    input: schema,
    async handler(input, context) {
      const { request } = context;
      const ip = clientIp(request);

      // 1. Honeypot, checked first so a bot never costs us a Turnstile call.
      //    It gets the same success the form shows a person: a bot that is told it
      //    failed simply tries again with the field left blank.
      if (input.website.trim()) {
        console.warn('[contact] honeypot filled — dropped silently', { ip: hashIp(ip) });
        return { ok: true, message: CONFIRMATION };
      }

      // 2. Rate limit. Advisory on serverless — see src/lib/ratelimit.ts.
      const limit = rateLimit(ip);
      if (!limit.ok) {
        throw new ActionError({
          code: 'TOO_MANY_REQUESTS',
          message: `Too many messages. Please wait ${limit.retryAfter} seconds and try again.`,
        });
      }

      // 3. CAPTCHA, verified server-side and failing closed.
      const captcha = await verifyTurnstile(input.turnstileToken || undefined, ip);
      if (!captcha.ok) {
        console.warn('[contact] turnstile rejected', captcha.codes);
        throw new ActionError({
          code: 'FORBIDDEN',
          message: 'We could not verify that you are human. Please reload the page and try again.',
        });
      }

      const lead: LeadEmail = {
        name: input.name || null,
        email: input.email,
        phone: input.phone,
        customerType: input.customerType,
        emergency: input.emergency,
        message: input.message || null,
        pagePath: input.pagePath || null,
        submissionId: null,
      };

      // 4. Store first: the database is the source of truth, and a failed write
      //    fails the request (playbook §4c step 5).
      if (env.storeToDb) {
        try {
          lead.submissionId = await storeSubmission({
            name: lead.name,
            email: lead.email,
            phone: lead.phone,
            customerType: lead.customerType,
            emergency: lead.emergency,
            message: lead.message,
            pagePath: lead.pagePath,
            userAgent: request.headers.get('user-agent'),
            ipHash: hashIp(ip),
          });
        } catch (error) {
          console.error('[contact] database write failed', error);
          throw new ActionError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Something went wrong on our end. Please call us on (615) 538-8579.',
          });
        }
      }

      // 5. E-mail second, and never fatal: an outage at Postmark must not lose a
      //    lead that is already stored. The failure goes to the Vercel logs.
      if (env.emailOwner) {
        try { await sendOwnerEmail(lead); }
        catch (error) { console.error('[contact] owner email failed', error); }
      }
      if (env.emailCustomer) {
        try { await sendCustomerEmail(lead); }
        catch (error) { console.error('[contact] customer email failed', error); }
      }

      return { ok: true, message: CONFIRMATION };
    },
  }),
};
