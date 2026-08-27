// Split every crawled WordPress page into the pieces Astro re-assembles:
//   header / content / footer fragments, the ordered stylesheet list, and page metadata.
// Fragments keep Elementor's rendered markup verbatim (minus WordPress JS); only URLs
// are rewritten to be root-relative so the clone serves its own assets.
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const HTML = path.join(ROOT, '_extract/html');
const FRAG = path.join(ROOT, 'src/fragments');
const CSSDIR = path.join(ROOT, 'public/wp/css');
const ORIGIN = 'https://plumberfranklintn.com';
const ORIGIN_ESC = 'https:\\/\\/plumberfranklintn.com';

/**
 * Forms.
 *
 * The site has exactly one: Gravity Forms form 1, "Book Appointment", rendered
 * through PowerPack's `pp-gravity-forms` widget. It appears on every page inside
 * Elementor popup 189, and a second time inline in the body of /contact-us/.
 *
 * Gravity Forms posts to WordPress, so it stops delivering the moment WordPress is
 * switched off. This is a BlendMode build (playbook §4c), so the form is rewired to
 * our own serverless action instead — see `rewireForm` below. The *markup* is kept
 * exactly as WordPress rendered it, because that markup is the design: the
 * `gform_wrapper` / `gfield` / `ginput_container` class tree is what
 * `gforms_formsmain_css` and `widget-pp-gravity-forms` style. Only the plumbing is
 * swapped.
 */

// Hosts whose assets we mirror into public/ so the clone has no third-party image
// deps. This site references none — every image is on the WordPress origin.
const MIRRORED_HOSTS = new Set();
const extPath = (u) => '/wp/ext/' + new URL(u).host + new URL(u).pathname;

await rm(FRAG, { recursive: true, force: true });
await mkdir(FRAG, { recursive: true });

const assets = new Set();

/** Rewrite one URL-ish attribute value; records any asset that must be mirrored. */
function rewriteUrl(value) {
  if (!value) return value;
  const v = value.trim();
  if (v.startsWith(ORIGIN)) {
    const u = new URL(v);
    if (u.pathname.startsWith('/wp-content/') || u.pathname.startsWith('/wp-includes/')) assets.add(u.href);
    // /feed/ and wp-json are WordPress-only endpoints; drop them at the callsite instead.
    return u.pathname + u.search + u.hash;
  }
  if (/^https?:\/\//.test(v)) {
    try {
      const u = new URL(v);
      if (MIRRORED_HOSTS.has(u.host)) { assets.add(u.href); return extPath(u.href); }
    } catch { /* not a URL */ }
  }
  return value;
}

const rewriteSrcset = (v) => v.split(',').map((part) => {
  const s = part.trim();
  const sp = s.lastIndexOf(' ');
  if (sp === -1) return rewriteUrl(s);
  return rewriteUrl(s.slice(0, sp)) + s.slice(sp);
}).join(', ');

const URL_ATTRS = ['src', 'href', 'data-src', 'poster', 'content', 'data-thumb', 'data-thumbnail', 'action'];

/**
 * Undo LiteSpeed Cache's lazy-load rewrite.
 *
 * LiteSpeed ships every `<img>` with a 1x1 GIF in `src`, the real URL in `data-src`
 * (plus `data-srcset` / `data-sizes`), and a duplicate `<noscript>` copy for
 * no-JS clients. Its inlined vanilla-lazyload bundle swaps them back on load.
 *
 * The clone drops that bundle, so the swap is done here instead — statically, at
 * extract time. The rendered result is identical to production's post-init DOM
 * (same URLs, same `srcset`, same declared width/height), minus one JS dependency
 * and minus the placeholder flash. Nothing keys off the plugin's state classes:
 * `litespeed-loaded` appears only in its own bundle's config, never in the CSS.
 */
function unlazy($, $el) {
  $el.find('img[data-lazyloaded], iframe[data-lazyloaded]').addBack('[data-lazyloaded]').each((i, el) => {
    const $img = $(el);
    for (const [from, to] of [['data-src', 'src'], ['data-srcset', 'srcset'], ['data-sizes', 'sizes']]) {
      const v = $img.attr(from);
      if (v === undefined) continue;
      $img.attr(to, v);
      $img.removeAttr(from);
    }
    $img.removeAttr('data-lazyloaded');
    // The <noscript> twin follows the image; with the image restored it would be a
    // second copy of the same request for any client that renders noscript content.
    const $twin = $img.next('noscript');
    if ($twin.length && /<img/i.test($twin.html() || '')) $twin.remove();
  });
}

/**
 * The one field-name map between Gravity Forms and our action.
 *
 * Gravity Forms names its inputs `input_<n>`, which says nothing about what they
 * hold; the server code reads better against real names, and the names are the only
 * part of the form markup that no stylesheet selects. Ids, classes, labels and
 * `for` attributes are left exactly as WordPress rendered them.
 */
const FIELD_NAMES = {
  input_8: 'website',      // Gravity Forms' own honeypot, labelled "X/Twitter"
  input_1: 'name',
  input_2: 'email',
  input_3: 'phone',
  input_4: 'customerType', // "are you a new customer?"
  input_5: 'emergency',    // "Is this an emergency?"
  input_6: 'message',
};

/**
 * Point Gravity Forms form 1 at our own backend, without touching its design.
 *
 * The markup Gravity Forms renders *is* the form's design — `gforms_formsmain_css`
 * and PowerPack's `widget-pp-gravity-forms` both style the `gform_wrapper` class
 * tree — so every class, id and label survives this untouched. What goes is the
 * plumbing that only WordPress can answer:
 *
 *   * `action`/`target` — the form posted into a hidden iframe (`gform_ajax`), which
 *     src/scripts/form.js replaces with a fetch to the Astro action. The iframe
 *     itself is removed with it.
 *   * the hidden inputs in the footer — nonce, encrypted state, page numbers,
 *     currency, theme. All of them are WordPress session state.
 *   * `onclick='gform.submission.handleButtonClick(this)'` on the submit button.
 *   * the invisible reCAPTCHA container. Our pipeline uses Cloudflare Turnstile
 *     (playbook 4c / 5.3); the placeholder here is filled in at runtime from
 *     `PUBLIC_TURNSTILE_SITE_KEY` so the key is not baked into a fragment. It is
 *     configured `interaction-only`, which renders nothing unless Cloudflare
 *     actually wants a challenge — the same zero-height footprint the invisible
 *     reCAPTCHA badge had, so the form's geometry is unchanged.
 *
 * The `<noscript>` case is worth naming: Gravity Forms degraded to a plain POST,
 * and an Astro action cannot. Without JavaScript this form now does nothing, which
 * is the same trade the reference implementation makes.
 */
function rewireForm($, $el) {
  $el.find('form[id^="gform_"]').each((i, el) => {
    const $form = $(el);
    $form.removeAttr('target').removeAttr('onsubmit').removeAttr('action');
    $form.attr('method', 'post').attr('data-contact-form', $form.attr('data-formid') || '1');

    $form.find('input[type="hidden"]').remove();

    // Gravity Forms sniffs the request's User-Agent server-side and stamps
    // `gf_browser_chrome` / `_gecko` / `_safari` / `_ie` / `_iphone` / `_unknown`
    // onto the wrapper; `gforms_browsers_css` then nudges the selects' padding and
    // margin per engine. A static clone cannot vary with the request, so the class
    // is pinned here (which also stops the crawl's three cached variants hashing to
    // three fragments) and src/scripts/form.js re-derives the right one in the
    // browser, the same way the plugin does on the server.
    $form.closest('.gform_wrapper')
      .removeClass('gf_browser_chrome gf_browser_gecko gf_browser_safari gf_browser_ie gf_browser_iphone gf_browser_unknown')
      .addClass('gf_browser_chrome');

    // Gravity Forms picks the honeypot's visible label at random on every request
    // ("Name", "X/Twitter", "Comments"...), so the same popup hashed to fourteen
    // different fragments. The label lives inside `.gform_validation_container`,
    // which `gforms_formsmain_css` hides outright, so it never renders — pin it and
    // the popup dedupes to the one fragment it really is.
    $form.find('.gform_validation_container .gform-field-label__text').text('Website');
    $form.find('button[type="submit"], input[type="submit"]').removeAttr('onclick').removeAttr('data-submission-type');

    for (const [from, to] of Object.entries(FIELD_NAMES)) {
      $form.find('[name="' + from + '"]').attr('name', to);
    }

    const $captcha = $form.find('.ginput_recaptcha');
    if ($captcha.length) {
      $captcha.removeClass('ginput_recaptcha').addClass('ginput_turnstile')
        .removeAttr('data-sitekey').removeAttr('data-theme').removeAttr('data-badge')
        .removeAttr('data-size').removeAttr('data-tabindex')
        .attr('data-turnstile', '');
      $captcha.empty();
    }

    // Where src/scripts/form.js writes server-side field errors and the
    // confirmation, in Gravity Forms' own markup.
    $form.prepend('<div class="gform_validation_errors" hidden></div>');
  });
  $el.find('iframe[id^="gform_ajax_frame_"]').remove();
}

/**
 * Point the search widgets at /search/ instead of at /.
 *
 * WordPress served its results from `/?s=<term>`, and the first attempt at keeping
 * that URL alive was a `vercel.json` rewrite from `/` with a `?s` query condition.
 * It does nothing. Vercel checks the filesystem *before* it applies vercel.json
 * rewrites, and `/` matches `index.html` — query strings play no part in that
 * match — so `/?s=leak` served the home page on the deployment while passing
 * locally, because scripts/serve.mjs was applying rewrites first. Both have been
 * corrected: the rewrite is gone, and serve.mjs now matches Vercel's order.
 *
 * So the form's own target moves. The visible behaviour is identical — type a term,
 * get the results page — and the URL gains one path segment. Inbound `/?s=` links
 * still work: src/scripts/elementor.js forwards them.
 */
function retargetSearchForms($, $el) {
  $el.find('form.elementor-search-form[action="/"], form.elementor-search-form[action="' + ORIGIN + '"]')
    .attr('action', '/search/');
}

function cleanFragment($, $el) {
  unlazy($, $el);
  rewireForm($, $el);
  retargetSearchForms($, $el);
  // Every script inside the ported markup is WordPress/Elementor/Gravity Forms
  // plumbing — this site embeds no third-party widget that has to keep running.
  // (The one external script the pages load, Google's reCAPTCHA, belongs to the
  // Gravity Forms submission path that `rewireForm` replaces.) The exception is
  // hand-written structured data, which is content rather than plumbing: dropping
  // it would silently remove the site's rich-result markup.
  $el.find('script').each((i, el) => {
    const $s = $(el);
    if (($s.attr('type') || '').toLowerCase() === 'application/ld+json') return;
    $s.remove();
  });
  // Stylesheets are collected separately, in document order, and re-linked from
  // <head> — including the per-widget <style> blocks Essential Addons prints
  // inline. Leaving the originals here would duplicate every rule.
  $el.find('link[rel="stylesheet"], style').remove();

  $el.find('[src], [href], [data-src], [poster], [data-thumb], [data-thumbnail], [srcset], [data-settings], [data-elementor-lightbox-slideshow], [action]').addBack().each((i, el) => {
    const $e = $(el);
    for (const a of URL_ATTRS) {
      const v = $e.attr(a);
      if (v && (v.startsWith('http') || v.startsWith('//'))) $e.attr(a, rewriteUrl(v));
    }
    for (const a of ['srcset', 'data-srcset', 'imagesrcset']) {
      const v = $e.attr(a);
      if (v) $e.attr(a, rewriteSrcset(v));
    }
    // Elementor stores widget config as a JSON blob (background videos, lightbox
    // slideshows). URLs in there are JSON-escaped, so match both spellings.
    for (const a of ['data-settings', 'data-elementor-lightbox-slideshow']) {
      let v = $e.attr(a);
      if (!v) continue;
      const before = v;
      v = v.split(ORIGIN_ESC).join('').split(ORIGIN).join('');
      if (v !== before) $e.attr(a, v);
      for (const m of v.matchAll(/\\?\/wp-content[^"'& ]+?\.(?:mp4|webm|mov|jpe?g|png|webp|gif|svg)/gi)) {
        assets.add(ORIGIN + m[0].replace(/\\/g, ''));
      }
    }
  });
  // Inline style="...url(...)..." backgrounds
  $el.find('[style]').addBack().each((i, el) => {
    const $e = $(el);
    const s = $e.attr('style');
    if (s && s.includes(ORIGIN)) {
      for (const m of s.matchAll(new RegExp(ORIGIN.replace(/\./g, '\\.') + '[^)\\s"\']*', 'g'))) assets.add(m[0]);
      $e.attr('style', s.split(ORIGIN).join(''));
    }
  });
  // WordPress-only endpoints that do not exist on the clone.
  $el.find('a[href^="/feed"], a[href^="/wp-json"], a[href^="/xmlrpc.php"]').each((i, el) => {
    $(el).attr('href', '/');
  });
  return $.html($el);
}

const inlineCss = new Map(); // filename -> content
function saveInline(id, content) {
  const hash = createHash('sha1').update(content).digest('hex').slice(0, 8);
  const name = `inline-${id.replace(/-inline-css$/, '').replace(/[^a-z0-9-]/gi, '-')}-${hash}`;
  if (content.includes(ORIGIN)) {
    for (const m of content.matchAll(new RegExp(ORIGIN.replace(/\./g, '\\.') + '[^)\\s"\']*', 'g'))) assets.add(m[0]);
    content = content.split(ORIGIN).join('');
  }
  inlineCss.set(name, content);
  return name;
}

/**
 * Pages retired from the clone.
 *
 * Empty: every URL the crawl found answers 200 on production and is wanted. If a
 * page ever does need retiring, do it here rather than by deleting a fragment —
 * `npm run extract` rewrites `src/fragments/` from the crawl, so a deleted file
 * comes straight back — and add the matching 301 to vercel.json.
 */
const RETIRED = new Set([]);

const files = (await readdir(HTML)).filter((f) => f.endsWith('.html')).sort();
const manifest = JSON.parse(await readFile(path.join(ROOT, '_extract/crawl-manifest.json'), 'utf8'));
const pathBySlug = new Map();
for (const m of manifest) if (m.status === 200) {
  const p = new URL(m.finalUrl || m.url).pathname.toLowerCase();
  if (!pathBySlug.has(m.slug.toLowerCase())) pathBySlug.set(m.slug.toLowerCase(), p);
}

const shared = new Map(); // fragment name -> html (header/footer/popup, deduped by id)
const pages = [];

for (const file of files) {
  const slug = file.replace(/\.html$/, '');
  const urlPath = pathBySlug.get(slug.toLowerCase());
  if (!urlPath) { console.warn('no url for', file); continue; }
  if (RETIRED.has(urlPath)) { console.log(`retired ${urlPath}`); continue; }
  const raw = await readFile(path.join(HTML, file), 'utf8');
  const $ = cheerio.load(raw, { decodeEntities: false });

  // --- stylesheet order: external handles and inline blocks, interleaved as authored
  const css = [];
  $('head link[rel="stylesheet"], head style, body link[rel="stylesheet"], body style').each((i, el) => {
    const $e = $(el);
    if (el.tagName === 'link') {
      const id = ($e.attr('id') || '').replace(/-css$/, '');
      if (id) css.push({ type: 'file', name: id });
    } else {
      // Elementor prints one id-less <style> (the background lazy-load guard).
      const id = ($e.attr('id') || 'anon').replace(/-css$/, '');
      const content = $e.html() || '';
      if (!content.trim()) return;
      css.push({ type: 'file', name: saveInline(id, content) });
    }
  });

  // --- regions
  const $header = $('body > header[data-elementor-type="header"]');
  const $footer = $('body > footer[data-elementor-type="footer"]');
  const $popups = $('body > div[data-elementor-type="popup"]');
  const $content = $('body > div[data-elementor-type]:not([data-elementor-type="popup"]), body > main#content');

  // Header/footer markup is shared, but WordPress bakes per-page state into it
  // (current-menu-* classes, and which logo image gets fetchpriority/lazy). Dedupe
  // by content hash so every distinct variant is stored exactly once, verbatim.
  const region = ($el, kind) => {
    if (!$el.length) return null;
    const id = $el.attr('data-elementor-id') || 'x';
    const html = cleanFragment($, $el);
    const name = `${kind}-${id}-${createHash('sha1').update(html).digest('hex').slice(0, 8)}`;
    if (!shared.has(name)) shared.set(name, html);
    return name;
  };

  const headerFrag = region($header, 'header');
  const footerFrag = region($footer, 'footer');
  const popupFrags = $popups.map((i, el) => region($(el), 'popup')).get();

  const contentHtml = $content.length
    ? $content.map((i, el) => cleanFragment($, $(el))).get().join('\n')
    : '';
  const contentName = `page-${slug}`;
  await writeFile(path.join(FRAG, `${contentName}.html`), contentHtml);

  // --- head metadata
  //
  // Selected document-wide rather than under `head`, which costs nothing here and
  // is what the sibling clones do: a WordPress plugin that prints an unknown
  // element into <head> ends the head for every HTML parser, and everything after
  // it silently lands in <body>. This install prints nothing of the kind, so the
  // two selections agree — but the wider one cannot be wrong.
  const favicons = $('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="shortcut icon"]').map((i, el) => ({
    rel: $(el).attr('rel'), href: rewriteUrl($(el).attr('href')), sizes: $(el).attr('sizes') || null,
  })).get();
  const tile = rewriteUrl($('meta[name="msapplication-TileImage"]').attr('content')) || null;

  // Yoast writes the whole SEO head — canonical, Open Graph, Twitter card and the
  // schema.org graph. Rather than re-deriving any of it, keep the block verbatim and
  // re-emit it; only the origin is templated, so a preview deployment is
  // self-consistent.
  const seoHead = $('meta[property^="og:"], meta[name^="twitter:"], meta[property^="article:"], script.yoast-schema-graph, meta[name="google-site-verification"]')
    .map((i, el) => $.html(el).split(ORIGIN).join('__ORIGIN__').split(ORIGIN_ESC).join('__ORIGIN_ESC__'))
    .get().join('\n');

  pages.push({
    slug,
    path: urlPath,
    title: $('head title').text(),
    description: $('head meta[name="description"]').attr('content') || null,
    robots: $('head meta[name="robots"]').attr('content') || null,
    bodyClass: ($('body').attr('class') || '').trim(),
    // /book-an-appointment/ uses Elementor's canvas template, whose head asks for
    // `viewport-fit=cover`; every other page prints the theme's plain viewport.
    viewport: $('meta[name="viewport"]').last().attr('content') || 'width=device-width, initial-scale=1',
    lang: $('html').attr('lang') || 'en-US',
    hasSkipLink: $('body > a.skip-link').length > 0,
    header: headerFrag,
    footer: footerFrag,
    popups: popupFrags,
    content: contentName,
    css,
    favicons,
    tile,
    seoHead,
  });
  console.log(`${slug.padEnd(52)} css:${css.length} ${headerFrag || '-'} ${contentName} ${footerFrag || '-'}${popupFrags.length ? ' +' + popupFrags.join(',') : ''}`);
}

for (const [name, html] of shared) await writeFile(path.join(FRAG, `${name}.html`), html);
await mkdir(CSSDIR, { recursive: true });
for (const [name, content] of inlineCss) await writeFile(path.join(CSSDIR, `${name}.css`), content);

await mkdir(path.join(ROOT, 'src/data'), { recursive: true });
await writeFile(path.join(ROOT, 'src/data/pages.json'), JSON.stringify(pages, null, 2));
await writeFile(path.join(ROOT, '_extract/assets.json'), JSON.stringify([...assets].sort(), null, 2));
console.log(`\n${pages.length} pages, ${shared.size} shared fragments, ${inlineCss.size} inline css, ${assets.size} assets`);
