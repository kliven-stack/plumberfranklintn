/** Site-wide switches a project lead may want to flip without touching markup. */

/**
 * Whether the pages link Elementor's Google-font stylesheets — Ledger and Lato,
 * self-hosted by scripts/build-fonts.mjs.
 *
 * `on` is the default because it is what the WordPress site renders. Elementor's
 * "local Google Fonts" copies here spell every `src: url(...)` `https://`, so
 * nothing is blocked as mixed content and the site's real typography arrives.
 * (Worth re-checking per site: the sibling cefootandankle install spells the same
 * values `http://` on an `https://` page and silently falls back to the system
 * stack, which is a bug that has to be cloned rather than fixed by accident.)
 */
export const WEBFONTS: 'off' | 'on' =
  (import.meta.env.PUBLIC_WEBFONTS as 'off' | 'on') || 'on';

/**
 * Cloudflare Turnstile's public site key, from `PUBLIC_TURNSTILE_SITE_KEY`.
 *
 * Empty until the widget is created (playbook §5.3). The form still works with it
 * empty — `src/lib/turnstile.ts` skips verification with a loud warning until both
 * keys are configured, which is what lets the site deploy before service setup.
 * The key reaches the browser by design; it is the only one that may.
 */
export const TURNSTILE_SITE_KEY = import.meta.env.PUBLIC_TURNSTILE_SITE_KEY || '';

/** Shown in the form's success message and used as the e-mail subject prefix. */
export const SITE_NAME = 'Plumber Franklin TN';
