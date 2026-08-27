/**
 * Client half of the Book Appointment form.
 *
 * Gravity Forms posted into a hidden iframe and let WordPress re-render the widget;
 * `scripts/extract.mjs` stripped that plumbing out and left the markup intact. This
 * drives the same markup against our Astro action instead, and — this is the point
 * — it writes its states using Gravity Forms' *own* classes, because those are what
 * `gforms_formsmain_css` and PowerPack's `widget-pp-gravity-forms` style. A
 * hand-rolled error style would look nothing like the rest of the form.
 *
 * States reproduced:
 *   submitting   `gform_submission_in_progress` on the wrapper, button disabled
 *   field error  `gfield_error` on the <li>, `aria-invalid`, and a
 *                `.gfield_validation_message` under the input
 *   form error   `.gform_validation_errors` banner above the fields
 *   success      the wrapper is replaced by `.gform_confirmation_wrapper`, which is
 *                what Gravity Forms swaps in after an AJAX submission
 */

import { actions, isInputError } from 'astro:actions';

const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

const siteKey = document.querySelector('meta[name="turnstile-sitekey"]')?.content || '';

/** Load Turnstile once, and only if a form on this page actually needs it. */
let turnstileReady = null;
function loadTurnstile() {
  if (turnstileReady) return turnstileReady;
  turnstileReady = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.turnstile);
    script.onerror = () => reject(new Error('Turnstile failed to load'));
    document.head.append(script);
  });
  return turnstileReady;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fieldOf(form, name) {
  const input = form.querySelector(`[name="${CSS.escape(name)}"]`);
  return { input, li: input?.closest('.gfield') ?? null };
}

function clearErrors(form) {
  form.querySelectorAll('.gfield_error').forEach((li) => li.classList.remove('gfield_error'));
  form.querySelectorAll('.gfield_validation_message').forEach((el) => el.remove());
  form.querySelectorAll('[aria-invalid="true"]').forEach((el) => el.setAttribute('aria-invalid', 'false'));
  const banner = form.querySelector('.gform_validation_errors');
  if (banner) { banner.hidden = true; banner.innerHTML = ''; }
}

function showFieldErrors(form, errors) {
  let first = null;
  for (const [name, messages] of Object.entries(errors)) {
    const { input, li } = fieldOf(form, name);
    if (!li || !input) continue;
    li.classList.add('gfield_error');
    input.setAttribute('aria-invalid', 'true');
    const message = document.createElement('div');
    message.className = 'gfield_validation_message gfield_description validation_message';
    message.id = `validation_message_${input.id || name}`;
    message.textContent = Array.isArray(messages) ? messages[0] : String(messages);
    input.closest('.ginput_container')?.after(message);
    input.setAttribute('aria-describedby', message.id);
    first ??= input;
  }
  first?.focus();
  return Boolean(first);
}

function showFormError(form, text) {
  const banner = form.querySelector('.gform_validation_errors');
  if (!banner) return;
  banner.hidden = false;
  banner.innerHTML =
    `<h2 class="gform_submission_error hide_summary">${escapeHtml(text)}</h2>`;
  banner.setAttribute('role', 'alert');
  banner.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/**
 * Gravity Forms' post-submit markup. Replacing the wrapper — rather than hiding the
 * form and appending a paragraph — is what the plugin does, and it is why the
 * confirmation inherits the widget's own spacing and typography.
 */
function showConfirmation(wrapper, message) {
  const confirmation = document.createElement('div');
  confirmation.className = 'gform_confirmation_wrapper';
  confirmation.innerHTML =
    `<div class="gform_confirmation_message_1 gform_confirmation_message" role="alert">${escapeHtml(message)}</div>`;
  wrapper.replaceWith(confirmation);
  confirmation.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/**
 * Gravity Forms' server-side browser sniff, moved to the client.
 *
 * The plugin stamps one of these classes onto the wrapper from the request's
 * User-Agent, and `gforms_browsers_css` then adjusts the selects' padding and
 * margin per engine. A static page cannot vary with the request, so
 * `scripts/extract.mjs` bakes in `gf_browser_chrome` and this puts the visitor's
 * real one back. Same order of tests as GFCommon::get_browser_class().
 */
const BROWSER_CLASSES = ['gf_browser_chrome', 'gf_browser_gecko', 'gf_browser_safari', 'gf_browser_ie', 'gf_browser_iphone', 'gf_browser_unknown'];

function browserClass() {
  const ua = navigator.userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return 'gf_browser_iphone';
  if (/chrome|crios|edg\//.test(ua)) return 'gf_browser_chrome';
  if (/safari/.test(ua)) return 'gf_browser_safari';
  if (/gecko|firefox/.test(ua)) return 'gf_browser_gecko';
  if (/msie|trident/.test(ua)) return 'gf_browser_ie';
  return 'gf_browser_unknown';
}

function initForm(form) {
  const wrapper = form.closest('.gform_wrapper') ?? form.parentElement;
  wrapper.classList.remove(...BROWSER_CLASSES);
  wrapper.classList.add(browserClass());

  const button = form.querySelector('[type="submit"]');
  const placeholder = form.querySelector('[data-turnstile]');
  let widgetId = null;

  if (placeholder && siteKey) {
    loadTurnstile().then((turnstile) => {
      widgetId = turnstile.render(placeholder, {
        sitekey: siteKey,
        // Renders nothing unless Cloudflare actually wants a challenge, which is
        // the same zero-height footprint Gravity Forms' invisible reCAPTCHA had —
        // so the form's geometry is unchanged from production.
        appearance: 'interaction-only',
        'response-field': false,
      });
    }).catch((error) => console.error('[form] turnstile', error));
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (wrapper.classList.contains('gform_submission_in_progress')) return;

    clearErrors(form);
    // Whatever the browser is willing to check is still worth checking — which on
    // this form is only `type="email"`. Gravity Forms marks its required fields
    // with `aria-required` alone, so an empty submit is the server's to reject,
    // here as on the WordPress site.
    if (!form.checkValidity()) { form.reportValidity(); return; }

    wrapper.classList.add('gform_submission_in_progress');
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }

    try {
      const payload = new FormData(form);
      payload.set('pagePath', location.pathname);

      if (widgetId !== null && window.turnstile) {
        // `interaction-only` still issues a token without showing anything when the
        // visitor passes silently; `getResponse` is empty only if a challenge is
        // still outstanding, in which case `execute` surfaces it.
        let token = window.turnstile.getResponse(widgetId);
        if (!token) {
          await new Promise((resolve) => {
            window.turnstile.execute(widgetId, { callback: resolve, 'error-callback': resolve });
            setTimeout(resolve, 8000);
          });
          token = window.turnstile.getResponse(widgetId);
        }
        if (token) payload.set('turnstileToken', token);
      }

      // Called through Astro's own client rather than a hand-rolled fetch. That
      // is not just tidier: the success payload is devalue-encoded, not plain
      // JSON, and the failure envelope is `{ type: 'AstroActionInputError',
      // issues }` — decoding either by hand is how the first draft of this file
      // reported "something went wrong" on a submission that had actually
      // succeeded. The client also picks the right URL, including the trailing
      // slash `trailingSlash: 'always'` requires (playbook §3.1).
      const { data, error } = await actions.contactSubmit(payload);

      if (!error) {
        showConfirmation(wrapper, data?.message ?? 'Thank you.');
        return;
      }

      const shown = isInputError(error) ? showFieldErrors(form, error.fields) : false;
      if (!shown) showFormError(form, error.message || 'Something went wrong. Please try again.');
      if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
    } catch (err) {
      console.error('[form] submit failed', err);
      showFormError(form, 'We could not send your message. Please call us on (615) 538-8579.');
    } finally {
      wrapper.classList.remove('gform_submission_in_progress');
      if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
    }
  });
}

for (const form of document.querySelectorAll('form[data-contact-form]')) initForm(form);
