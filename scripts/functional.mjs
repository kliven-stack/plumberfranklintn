/**
 * Functional tests against the built clone (playbook §2: "plus functional tests").
 *
 * Everything the replaced WordPress JS used to do is exercised here — the parts a
 * computed-style diff cannot see. Build and serve first:
 *
 *   npm run build && PORT=4331 npm run serve      # then, in another shell:
 *   npm run functional
 *
 * The form tests cover every path automation can reach. The happy path cannot be
 * one of them: Turnstile blocks headless browsers, and that is it working
 * (playbook §3.6). A human submits once, end to end, against the deployment.
 */
import { chromium } from 'playwright';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = path.join(ROOT, '.vercel/output/static');
// 127.0.0.1, not `localhost`: on macOS `localhost` resolves to ::1 first, and a
// stale dev server from a sibling site that bound IPv6 answers instead of this one.
const ORIGIN = process.env.CLONE_ORIGIN || 'http://127.0.0.1:4331';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? ' ok ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch();

const open = async (target, width = 1440, height = 900) => {
  const ctx = await browser.newContext({ viewport: { width, height } });
  // Not under test, and their hosts throttle headless traffic.
  for (const pattern of [
    '**://challenges.cloudflare.com/**',
    '**://maps.google.com/**',
    '**://www.google.com/maps/**',
  ]) await ctx.route(pattern, (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
  await page.bringToFront();
  await page.goto(ORIGIN + target, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(700);
  return { ctx, page, errors };
};

/* ------------------------------------------------------- off-canvas menu */
{
  const { ctx, page } = await open('/');
  const state = () => page.evaluate(() => {
    const nav = document.querySelector('nav[id^="pp-menu-"]');
    const toggle = document.querySelector('.pp-menu-toggle');
    return {
      parentIsBody: nav.parentElement === document.body,
      firstChild: document.body.firstElementChild === nav,
      open: nav.classList.contains('pp-menu-open'),
      htmlOpen: document.documentElement.classList.contains('pp-menu-toggle-open'),
      bodyOpen: document.body.classList.contains('pp-menu-open'),
      bodyOffCanvas: document.body.classList.contains('pp-menu--off-canvas'),
      ariaHidden: nav.getAttribute('aria-hidden'),
      expanded: toggle.getAttribute('aria-expanded'),
      active: toggle.classList.contains('pp-active'),
      x: Math.round(nav.getBoundingClientRect().x),
      style: nav.getAttribute('style'),
    };
  });

  const closed = await state();
  check('menu: PowerPack lifts the panel to be <body>\'s first child',
    closed.parentIsBody && closed.firstChild);
  check('menu: closed panel sits off screen to the right',
    closed.x >= 1440, `x=${closed.x}`);
  check('menu: closed panel carries the viewport-height inline style',
    closed.style === 'height: 1050px;', closed.style);
  check('menu: closed panel is aria-hidden and the toggle is not expanded',
    closed.ariaHidden === 'true' && closed.expanded === 'false');

  await page.click('.pp-menu-toggle');
  await page.waitForTimeout(600);
  const open1 = await state();
  check('menu: opens on click', open1.open && open1.x < 1440, `x=${open1.x}`);
  check('menu: open state classes match production',
    open1.htmlOpen && open1.bodyOpen && open1.bodyOffCanvas && open1.active,
    JSON.stringify({ html: open1.htmlOpen, body: open1.bodyOpen, offCanvas: open1.bodyOffCanvas }));
  check('menu: open panel swaps its inline height for the z-index Elementor writes',
    open1.style === 'z-index: 999999;', open1.style);
  check('menu: aria flips with the panel',
    open1.ariaHidden === 'false' && open1.expanded === 'true');

  // SmartMenus annotation
  const sm = await page.evaluate(() => {
    const root = document.querySelector('nav[id^="pp-menu-"] ul.pp-advanced-menu');
    const parent = root.querySelector('li.menu-item-has-children');
    const a = parent.querySelector(':scope > a');
    const sub = parent.querySelector(':scope > ul.sub-menu');
    return {
      rootRole: root.getAttribute('role'),
      hasId: !!root.getAttribute('data-smartmenus-id'),
      liRole: parent.getAttribute('role'),
      aRole: a.getAttribute('role'),
      hasSubmenu: a.classList.contains('has-submenu'),
      haspopup: a.getAttribute('aria-haspopup'),
      controls: a.getAttribute('aria-controls') === sub.id,
      arrow: a.querySelector('.sub-arrow')?.innerHTML,
      subRole: sub.getAttribute('role'),
      subLabelled: sub.getAttribute('aria-labelledby') === a.id,
      subLabel: sub.getAttribute('aria-label'),
    };
  });
  check('menu: SmartMenus annotates the root as a menubar with an instance id',
    sm.rootRole === 'menubar' && sm.hasId);
  check('menu: parent item carries has-submenu, aria-haspopup and aria-controls',
    sm.hasSubmenu && sm.haspopup === 'true' && sm.controls);
  check('menu: parent item gets the configured caret indicator',
    sm.arrow === '<i class="fas fa-caret-down"></i>', sm.arrow);
  check('menu: sub-menu is a labelled role=menu',
    sm.subRole === 'menu' && sm.subLabelled && sm.subLabel === 'Plumbing', sm.subLabel);

  // Sub-menu opens from the arrow (collapsibleBehavior: 'link').
  await page.locator('nav[id^="pp-menu-"] li.menu-item-has-children > a .sub-arrow').first().click();
  await page.waitForTimeout(400);
  const sub = await page.evaluate(() => {
    const parent = document.querySelector('nav[id^="pp-menu-"] li.menu-item-has-children');
    const a = parent.querySelector(':scope > a');
    const ul = parent.querySelector(':scope > ul.sub-menu');
    return {
      style: ul.getAttribute('style'),
      display: getComputedStyle(ul).display,
      expanded: a.getAttribute('aria-expanded'),
      hidden: ul.getAttribute('aria-hidden'),
      highlighted: a.classList.contains('highlighted'),
      items: [...ul.querySelectorAll(':scope > li')].length,
    };
  });
  check('menu: the caret expands the sub-menu, not the link',
    sub.display === 'block' && sub.style === 'width: auto; display: block;', sub.style);
  check('menu: expanded sub-menu updates aria and highlights its parent',
    sub.expanded === 'true' && sub.hidden === 'false' && sub.highlighted);
  check('menu: sub-menu lists all eight plumbing pages', sub.items === 8, `${sub.items} items`);

  // Playbook §3.11 in the negative. SmartMenus only opens on hover in horizontal
  // mode; this is the vertical off-canvas panel, and production leaves the
  // sub-menu shut with the pointer parked on a parent item. An earlier draft of
  // the runtime opened on hover, which is why this is asserted rather than assumed.
  await page.locator('nav[id^="pp-menu-"] li.menu-item-has-children > a .sub-arrow').first().click();
  await page.waitForTimeout(400);
  const collapsed = await page.evaluate(() => getComputedStyle(document.querySelector('nav[id^="pp-menu-"] li.menu-item-has-children > ul.sub-menu')).display);
  check('menu: a second click on the caret collapses the sub-menu', collapsed === 'none', collapsed);

  const parentBox = await page.locator('nav[id^="pp-menu-"] li.menu-item-has-children > a').first().boundingBox();
  await page.mouse.move(parentBox.x + parentBox.width / 2, parentBox.y + parentBox.height / 2);
  await page.waitForTimeout(1200);
  const hovered = await page.evaluate(() => getComputedStyle(document.querySelector('nav[id^="pp-menu-"] li.menu-item-has-children > ul.sub-menu')).display);
  check('menu: hovering a parent item opens nothing, as on production', hovered === 'none', hovered);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('menu: Escape closes the panel', !(await state()).open);

  await ctx.close();
}

/* --------------------------------------------------------------- popup */
{
  const { ctx, page } = await open('/');

  const before = await page.evaluate(() => ({
    templates: document.querySelectorAll('[data-elementor-type="popup"]').length,
    dialogs: document.querySelectorAll('.dialog-widget').length,
  }));
  check('popup: the template is detached at init, as production detaches it',
    before.templates === 0 && before.dialogs === 0, JSON.stringify(before));

  await page.click('a[href*="action%3Dpopup"]');
  await page.waitForTimeout(700);
  const opened = await page.evaluate(() => {
    const widget = document.querySelector('.elementor-popup-modal');
    if (!widget) return null;
    const template = widget.querySelector('[data-elementor-type="popup"]');
    const box = widget.getBoundingClientRect();
    return {
      id: widget.id,
      classes: widget.className,
      modal: widget.getAttribute('aria-modal'),
      fixed: getComputedStyle(widget).position,
      w: Math.round(box.width), h: Math.round(box.height),
      // Playbook §3.12: the attribute survives, and the inline display is what
      // beats `[data-elementor-type=popup]{display:none}`.
      templateDisplay: template && template.style.display,
      templateVisible: template ? getComputedStyle(template).display : null,
      form: !!widget.querySelector('form[data-contact-form]'),
      bodyClasses: ['dialog-body', 'dialog-lightbox-body', 'dialog-container', 'dialog-lightbox-container']
        .every((c) => document.body.classList.contains(c)),
      dialogCss: !!document.querySelector('link[href*="conditionals/dialog.min.css"]'),
    };
  });
  check('popup: opens into Elementor\'s dialog widget', opened && opened.id === 'elementor-popup-modal-189');
  check('popup: the overlay is a fixed, full-viewport layer',
    opened && opened.fixed === 'fixed' && opened.w === 1440 && opened.h === 900,
    opened && `${opened.fixed} ${opened.w}x${opened.h}`);
  check('popup: the conditionally-loaded dialog stylesheet is injected', opened?.dialogCss);
  check('popup: the mounted template is visible despite e-popup.css (playbook §3.12)',
    opened && opened.templateDisplay === 'block' && opened.templateVisible === 'block',
    opened && `inline=${opened.templateDisplay} computed=${opened.templateVisible}`);
  check('popup: <body> carries the four dialog classes production carries', opened?.bodyClasses);
  check('popup: the Book Appointment form is inside it', opened?.form);

  await page.click('.dialog-close-button');
  await page.waitForTimeout(400);
  const closed = await page.evaluate(() => document.querySelector('.elementor-popup-modal').style.display);
  check('popup: the close button hides it', closed === 'none', closed);

  await ctx.close();
}

/* -------------------------------------------------------- reviews carousel */
{
  const { ctx, page } = await open('/');

  const state = await page.evaluate(() => {
    const widget = document.querySelector('[data-widget_type="reviews.default"]');
    const section = widget.closest('.elementor-top-section');
    const c = widget.querySelector('.elementor-main-swiper');
    const wrapper = c.querySelector('.swiper-wrapper');
    const slides = [...wrapper.children];
    return {
      sectionHidden: getComputedStyle(section).display,
      hiddenClasses: ['elementor-hidden-desktop', 'elementor-hidden-tablet', 'elementor-hidden-phone']
        .every((cls) => section.classList.contains(cls)),
      classes: c.className,
      wrapperId: wrapper.id.startsWith('swiper-wrapper-'),
      live: wrapper.getAttribute('aria-live'),
      style: wrapper.getAttribute('style'),
      total: slides.length,
      duplicates: slides.filter((s) => s.classList.contains('swiper-slide-duplicate')).length,
      sized: slides.some((s) => s.style.width),
      indexed: slides.every((s) => s.dataset.swiperSlideIndex !== undefined),
      active: slides.findIndex((s) => s.classList.contains('swiper-slide-active')),
      bullets: widget.querySelectorAll('.swiper-pagination-bullet').length,
      names: [...new Set([...widget.querySelectorAll('.elementor-testimonial__name')].map((n) => n.textContent.trim()))],
    };
  });

  // This widget is invisible on production: the client hid its section at every
  // breakpoint and left Elementor's placeholder content in it. The clone
  // reproduces that (see the README's bug register), so what is testable here is
  // the DOM contract Swiper writes for a zero-width container - which is exactly
  // what a computed-style diff cannot tell apart from "nothing ran".
  check('carousel: its section is hidden at every breakpoint, as on production',
    state.sectionHidden === 'none' && state.hiddenClasses, state.sectionHidden);
  check("carousel: container carries Swiper's initialised classes",
    /swiper-initialized/.test(state.classes) && /swiper-horizontal/.test(state.classes)
    && /swiper-pointer-events/.test(state.classes));
  check('carousel: wrapper gets an id and aria-live', state.wrapperId && state.live === 'off');
  check('carousel: loop duplicates the leading and trailing slides',
    state.duplicates === 6 && state.total === 9, `${state.total} slides, ${state.duplicates} duplicates`);
  check('carousel: every slide is indexed and one is active',
    state.indexed && state.active === 3, `active ${state.active}`);
  check('carousel: bullet pagination is built, one per real slide', state.bullets === 3, `${state.bullets} bullets`);
  check('carousel: a hidden container is indexed but never sized, as Swiper leaves it',
    !state.sized && state.style === 'cursor: grab; transition-duration: 0ms;', state.style);
  check("carousel: it still holds Elementor's placeholder testimonials",
    state.names.length === 1 && state.names[0] === 'John Doe', state.names.join('/'));

  await ctx.close();
}

/* --------------------------------------------------- animated headlines */
{
  const { ctx, page } = await open('/');
  const highlight = await page.evaluate(() => {
    const el = document.querySelector('[data-widget_type="animated-headline.default"] .elementor-headline');
    const svg = el.querySelector('svg');
    return {
      animated: el.classList.contains('e-animated'),
      duration: el.style.getPropertyValue('--animation-duration'),
      viewBox: svg?.getAttribute('viewBox'),
      paths: svg?.querySelectorAll('path').length,
      inWrapper: !!svg?.closest('.elementor-headline-dynamic-wrapper'),
      dash: svg && getComputedStyle(svg.querySelector('path')).strokeDasharray,
    };
  });
  check('headline: the double-underline marker is injected into the dynamic wrapper',
    highlight.paths === 2 && highlight.viewBox === '0 0 500 150' && highlight.inWrapper,
    `${highlight.paths} paths`);
  check('headline: e-animated and the duration variable drive the CSS keyframes',
    highlight.animated && highlight.duration === '1200ms', highlight.duration);
  check('headline: the marker really draws (stroke-dasharray is animating)',
    /\d/.test(highlight.dash || '') && highlight.dash !== '0px, 1500px', highlight.dash);

  const first = await page.evaluate(() => {
    const el = document.querySelector('.elementor-headline--style-rotate');
    const items = [...el.querySelectorAll('.elementor-headline-dynamic-text')];
    return {
      count: items.length,
      active: items.findIndex((i) => i.classList.contains('elementor-headline-text-active')),
      width: el.querySelector('.elementor-headline-dynamic-wrapper').style.width,
    };
  });
  await page.waitForTimeout(2900);
  const second = await page.evaluate(() => {
    const el = document.querySelector('.elementor-headline--style-rotate');
    const items = [...el.querySelectorAll('.elementor-headline-dynamic-text')];
    return {
      active: items.findIndex((i) => i.classList.contains('elementor-headline-text-active')),
      inactive: items.filter((i) => i.classList.contains('elementor-headline-text-inactive')).length,
      width: el.querySelector('.elementor-headline-dynamic-wrapper').style.width,
    };
  });
  check('headline: the rotating headline advances on its 2.5s timer',
    second.active !== first.active, `${first.active} → ${second.active}`);
  check('headline: the phrase it left carries elementor-headline-text-inactive',
    second.inactive >= 1, `${second.inactive} inactive`);
  check('headline: the wrapper is resized to the new phrase',
    second.width !== first.width && /px$/.test(second.width), `${first.width} → ${second.width}`);

  await ctx.close();
}

/* ------------------------------------------------------------ portfolio */
{
  const { ctx, page } = await open('/plumbing/');
  await page.evaluate(() => document.querySelector('.elementor-portfolio').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(900);
  const grid = await page.evaluate(() => {
    const c = document.querySelector('.elementor-portfolio');
    const items = [...c.children];
    const box = items[0].getBoundingClientRect();
    return {
      ratio: c.classList.contains('elementor-has-item-ratio'),
      active: items.every((i) => i.classList.contains('elementor-active')),
      transform: items.every((i) => i.style.transform === 'translate3d(0px, 0px, 0px)'),
      fit: [...new Set(items.map((i) => {
        const t = i.querySelector('.elementor-post__thumbnail');
        return t.classList.contains('elementor-fit-height') ? 'height'
          : t.classList.contains('elementor-fit-width') ? 'width' : 'none';
      }))],
      square: Math.abs(box.width - box.height) < 2,
      count: items.length,
    };
  });
  check('portfolio: container is marked elementor-has-item-ratio', grid.ratio);
  check('portfolio: every item is active and positioned', grid.active && grid.transform);
  check('portfolio: thumbnails pick a fit axis', !grid.fit.includes('none'), grid.fit.join('/'));
  check('portfolio: item_ratio 1 gives square tiles', grid.square, `${grid.count} items`);

  await ctx.close();
}

/* -------------------------------------------------------------- gallery */
{
  const { ctx, page } = await open('/water-heaters/tankless-water-heaters/');
  await page.evaluate(() => document.querySelector('.elementor-gallery__container').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(1200);
  const gallery = await page.evaluate(() => {
    const c = document.querySelector('.elementor-gallery__container');
    const items = [...c.children];
    const image = c.querySelector('.e-gallery-image');
    return {
      classes: c.className,
      style: c.getAttribute('style'),
      coords: items.map((i) => i.getAttribute('style')),
      loaded: image.classList.contains('e-gallery-image-loaded'),
      bg: getComputedStyle(image).backgroundImage.slice(0, 60),
      boxes: items.map((i) => Math.round(i.getBoundingClientRect().width)),
    };
  });
  check('gallery: container gets the e-gallery grid classes',
    /e-gallery-container/.test(gallery.classes) && /e-gallery-grid/.test(gallery.classes)
    && /e-gallery--lazyload/.test(gallery.classes));
  check('gallery: the layout custom properties are written',
    /--columns: 3/.test(gallery.style) && /--aspect-ratio: 66\./.test(gallery.style)
    && /--container-aspect-ratio/.test(gallery.style), gallery.style);
  check('gallery: each item is placed by --column / --row',
    gallery.coords.join(' | ') === '--column: 0; --row: 0; | --column: 1; --row: 0; | --column: 2; --row: 0;',
    gallery.coords.join(' | '));
  check('gallery: items lay out three across at equal width',
    new Set(gallery.boxes).size === 1 && gallery.boxes.length === 3, gallery.boxes.join('/'));
  check('gallery: the lazy background is swapped in from data-thumbnail',
    gallery.loaded && gallery.bg.startsWith('url('), gallery.bg);

  await page.click('.e-gallery-item');
  await page.waitForTimeout(1200);
  const lightbox = await page.evaluate(() => {
    const lb = document.querySelector('.elementor-lightbox');
    if (!lb) return null;
    return {
      slides: lb.querySelectorAll('.elementor-lightbox-item').length,
      counter: lb.querySelector('.elementor-slideshow__counter')?.textContent.replace(/\s+/g, ''),
      title: lb.querySelector('.elementor-slideshow__title')?.textContent,
      img: lb.querySelector('.elementor-lightbox-image')?.getAttribute('src'),
      css: !!document.querySelector('link[href*="conditionals/lightbox.min.css"]')
        && !!document.querySelector('link[href*="swiper/v8/css/swiper.min.css"]'),
      buttons: lb.querySelectorAll('.elementor-swiper-button').length,
    };
  });
  check('lightbox: opens with one slide per gallery image (plus loop clones)',
    lightbox && lightbox.slides >= 3, lightbox && `${lightbox.slides} slides`);
  check('lightbox: the fraction counter reads 1 / 3', lightbox?.counter === '1/3', lightbox?.counter);
  check('lightbox: its two conditional stylesheets are injected', lightbox?.css);
  check('lightbox: prev and next buttons are present', lightbox?.buttons === 2);
  check('lightbox: the footer names the current image', !!lightbox?.title, lightbox?.title);

  await page.click('.elementor-swiper-button-next');
  await page.waitForTimeout(900);
  const advanced = await page.evaluate(() => document.querySelector('.elementor-slideshow__counter')?.textContent.replace(/\s+/g, ''));
  check('lightbox: the next button advances the counter', advanced === '2/3', advanced);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('lightbox: Escape removes it', !(await page.evaluate(() => !!document.querySelector('.elementor-lightbox'))));

  await ctx.close();
}

/* ----------------------------------------------------------------- form */
{
  const { ctx, page } = await open('/contact-us/');

  const form = await page.evaluate(() => {
    const f = document.querySelector('form[data-contact-form]');
    const names = [...f.querySelectorAll('[name]')].map((i) => i.name);
    return {
      action: f.getAttribute('action'),
      target: f.getAttribute('target'),
      names,
      hidden: f.querySelectorAll('input[type="hidden"]').length,
      iframe: document.querySelectorAll('iframe[id^="gform_ajax_frame"]').length,
      recaptcha: document.querySelectorAll('.ginput_recaptcha').length,
      turnstile: document.querySelectorAll('[data-turnstile]').length,
      browserClass: [...document.querySelector('.gform_wrapper').classList].find((c) => c.startsWith('gf_browser_')),
      honeypotHidden: getComputedStyle(f.querySelector('.gform_validation_container')).display,
      required: [...f.querySelectorAll('[aria-required="true"]')].map((i) => i.name),
    };
  });
  check('form: WordPress\'s iframe/AJAX plumbing is gone',
    !form.action && !form.target && form.hidden === 0 && form.iframe === 0,
    `action=${form.action} target=${form.target} hidden=${form.hidden} iframe=${form.iframe}`);
  check('form: fields keep Gravity Forms\' set, under readable names',
    JSON.stringify(form.names) === JSON.stringify(['website', 'name', 'email', 'phone', 'customerType', 'emergency', 'message']),
    form.names.join(','));
  check('form: reCAPTCHA is replaced by the Turnstile placeholder',
    form.recaptcha === 0 && form.turnstile === 1);
  check('form: the browser class is re-derived client-side',
    form.browserClass === 'gf_browser_chrome', form.browserClass);
  check('form: the honeypot stays hidden by Gravity Forms\' own CSS',
    form.honeypotHidden === 'none', form.honeypotHidden);
  check('form: email, phone and both selects are required, as on production',
    JSON.stringify(form.required) === JSON.stringify(['email', 'phone', 'customerType', 'emergency']),
    form.required.join(','));

  // An empty submit still posts, and that is faithful: Gravity Forms marks its
  // required fields with `aria-required` only — never the HTML `required`
  // attribute — so the browser has nothing to block on and the server is what
  // validates. scripts/form-tests.mjs checks what comes back.
  let posted = 0;
  page.on('request', (r) => { if (r.url().includes('/_actions/')) posted++; });
  await page.click('form[data-contact-form] [type="submit"]');
  await page.waitForTimeout(800);
  check('form: an empty submit reaches the server, because the fields are only aria-required',
    posted === 1, `${posted} requests`);

  // A filled form does post — to the trailing-slash action path (playbook §3.1).
  await page.fill('form[data-contact-form] [name="name"]', 'Harness');
  await page.fill('form[data-contact-form] [name="email"]', 'harness@example.com');
  await page.fill('form[data-contact-form] [name="phone"]', '(615) 555-0100');
  await page.selectOption('form[data-contact-form] [name="customerType"]', 'Neither');
  await page.selectOption('form[data-contact-form] [name="emergency"]', 'No');
  const request = page.waitForRequest((r) => r.url().includes('/_actions/'), { timeout: 15000 }).catch(() => null);
  await page.click('form[data-contact-form] [type="submit"]');
  const sent = await request;
  check('form: a valid submit posts to the action', !!sent, sent?.url());
  check('form: the action path keeps its trailing slash (playbook §3.1)',
    !!sent && new URL(sent.url()).pathname === '/_actions/contactSubmit/',
    sent && new URL(sent.url()).pathname);
  check('form: it posts the honeypot and the page path along with the fields',
    !!sent && /name="website"/.test(sent.postData() || '') && /name="pagePath"/.test(sent.postData() || ''));

  await ctx.close();
}

/* ------------------------------------------------ popup reach, faithfully */
{
  const { ctx, page } = await open('/contact-us/');
  const state = await page.evaluate(() => ({
    triggers: document.querySelectorAll('a[href*="action%3Dpopup"]').length,
    liveForms: document.querySelectorAll('form[data-contact-form]').length,
  }));
  // Two things worth pinning, both production's. The popup template is printed on
  // every page but only six of them carry a button that opens it, and /contact-us/
  // is not one; and because Elementor detaches the template at init, the second
  // copy of Gravity Forms' id tree that the served HTML contains never coexists
  // with the first in a live document. See the README's bug register.
  check('popup: /contact-us/ ships the template but has no trigger, as on production',
    state.triggers === 0, `${state.triggers} triggers`);
  check('popup: detaching the template keeps the duplicate form ids out of the live DOM',
    state.liveForms === 1, `${state.liveForms} forms`);

  const raw = await (await fetch(`${ORIGIN}/contact-us/`)).text();
  const copies = (raw.match(/id="gform_wrapper_1"/g) || []).length;
  check('markup: the served HTML still carries both copies, exactly as WordPress serves it',
    copies === 2, `${copies} copies`);
  await ctx.close();
}

/* --------------------------------------------------------------- search */
{
  const { ctx, page } = await open('/search/?s=leak');
  const search = await page.evaluate(() => ({
    heading: document.querySelector('h1.elementor-heading-title')?.textContent.trim(),
    title: document.title,
    input: document.querySelector('input[name="s"]')?.value,
    action: document.querySelector('form.elementor-search-form')?.getAttribute('action'),
    nothing: !!document.querySelector('.elementor-posts-nothing-found'),
  }));
  check('search: the term reaches the heading', search.heading === 'Search Results for: leak', search.heading);
  check('search: the term reaches the document title', /“leak”/.test(search.title), search.title);
  check('search: the term is put back in the input', search.input === 'leak', search.input);
  check('search: the widgets target /search/', search.action === '/search/', search.action);
  check('search: it finds nothing, exactly as production does', search.nothing);
  await ctx.close();
}

/* ------------------------------------------------- search: the legacy URL */
{
  // WordPress served `/?s=<term>`. Vercel matches `index.html` for that path
  // before it ever looks at vercel.json's rewrites — which is why the rewrite this
  // project first shipped did nothing on the deployment while passing locally.
  // The runtime forwards it instead; this asserts the forward, and that the
  // starting point really is the home page, so the harness cannot drift from
  // Vercel's behaviour again.
  const { ctx, page } = await open('/?s=leak');
  await page.waitForURL('**/search/**', { timeout: 10000 }).catch(() => {});
  const url = new URL(page.url());
  check('search: /?s= is forwarded to /search/, preserving the term',
    url.pathname === '/search/' && url.searchParams.get('s') === 'leak', page.url());
  const heading = await page.evaluate(() =>
    document.querySelector('h1.elementor-heading-title')?.textContent.trim());
  check('search: and the forwarded page shows the term', heading === 'Search Results for: leak', heading);
  await ctx.close();
}

/* ------------------------------------------------------ Elementor globals */
{
  const { ctx, page, errors } = await open('/');
  const globals = await page.evaluate(() => ({
    ua: [...document.body.classList].filter((c) => c.startsWith('e--ua-')),
    device: document.body.getAttribute('data-elementor-device-mode'),
    probe: !!document.getElementById('elementor-device-mode'),
    symbols: !!document.querySelector('svg.e-font-icon-svg-symbols'),
  }));
  check('globals: Elementor\'s browser classes are stamped on <body>',
    globals.ua.includes('e--ua-blink') && globals.ua.includes('e--ua-webkit'), globals.ua.join(' '));
  check('globals: the device mode attribute tracks the breakpoint',
    globals.device === 'desktop', globals.device);
  check('globals: the trailing probe span and icon-symbol sprite are appended',
    globals.probe && globals.symbols);
  check('globals: the home page raises no JavaScript errors',
    errors.length === 0, errors.join(' | '));

  // WordPress renders the footer's copyright year on every request; a static build
  // would freeze it. src/scripts/elementor.js keeps it current.
  const year = await page.evaluate(() =>
    document.querySelector('.footer-alright-custom')?.textContent.match(/Copyright\s*\u00a9\s*(\d{4})/)?.[1]);
  check("footer: the copyright year is the current one, not the build's",
    year === String(new Date().getFullYear()), year);

  await ctx.close();
}

/* ---------------------------------------------------- every page loads clean */
{
  const paths = JSON.parse(await readFile(path.join(ROOT, 'src/data/pages.json'), 'utf8'))
    .map((p) => p.path)
    .filter((p) => p !== '/404/');
  const broken = [];
  for (const target of paths) {
    const { ctx, page, errors } = await open(target);
    const state = await page.evaluate(() => ({
      images: [...document.images].filter((i) => {
        const box = i.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && !i.complete;
      }).length,
      title: document.title,
    }));
    if (errors.length || state.images || !state.title) {
      broken.push(`${target}: ${errors.join(' | ')}${state.images ? ` ${state.images} images pending` : ''}`);
    }
    await ctx.close();
  }
  check(`pages: all ${paths.length} load with a title, no console errors and every visible image decoded`,
    broken.length === 0, broken.join(' ;; '));
}

/* ----------------------------------------------- responsive: the burger only */
{
  for (const [label, width] of [['desktop', 1440], ['tablet', 900], ['mobile', 390]]) {
    const { ctx, page } = await open('/', width, 900);
    const visible = await page.evaluate(() => {
      const toggle = document.querySelector('.pp-menu-toggle');
      return {
        toggle: getComputedStyle(toggle).display,
        // There is no desktop menu bar on this site at any width: the widget's
        // breakpoint is `all`, so the panel is the only menu there is.
        bar: document.querySelectorAll('.pp-advanced-menu--main').length,
      };
    });
    check(`responsive: ${label} shows the burger and no inline menu bar`,
      visible.toggle === 'flex' && visible.bar === 0, `${visible.toggle}, ${visible.bar} bars`);
    await ctx.close();
  }
}

/* ------------------------------------------------------- build integrity */
{
  const exists = async (p) => { try { await stat(path.join(DIST, p)); return true; } catch { return false; } };
  check('build: the search page is emitted', await exists('search/index.html'));
  check('build: the 404 template is emitted at dist/404.html', await exists('404.html'));
  check('build: the sitemap is emitted', await exists('sitemap-index.xml'));
  check('build: the mirrored Elementor CSS ships', await exists('wp/css/elementor-post-273.css'));
  check('build: the self-hosted fonts ship', (await readdir(path.join(DIST, 'wp/fonts'))).length === 22);
  check('build: the conditional dialog stylesheet ships',
    await exists('wp-content/plugins/elementor/assets/css/conditionals/dialog.min.css'));
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length} checks, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  FAIL ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exitCode = 1;
}
