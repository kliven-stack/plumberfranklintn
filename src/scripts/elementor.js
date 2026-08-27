/**
 * Runtime for the cloned Elementor markup.
 *
 * The pages ship Elementor's compiled CSS verbatim, so the job here is to reproduce
 * the *DOM contract* the WordPress JS created — the classes, inline styles and
 * injected nodes the stylesheets and the layout depend on — not to re-invent the
 * behaviour (playbook §3.12). Every contract below was read off the live site's
 * post-init DOM with the probes in _extract/probe/, then diffed against the served
 * HTML.
 *
 * Replaces: jQuery, elementor-frontend, elementor-pro-frontend, smartmenus,
 * PowerPack's frontend bundle, Swiper, Elementor's dialog/lightbox libraries and
 * the e-gallery jQuery plugin.
 */

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const onReady = (fn) =>
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', fn, { once: true })
    : fn();

/** Elementor serialises widget/section options into `data-settings` as JSON. */
const settingsOf = (el) => {
  try { return JSON.parse(el.getAttribute('data-settings') || '{}'); } catch { return {}; }
};

/** A `{unit,size}` control value, or `fallback` when the size was left blank. */
const sizeOf = (value, fallback) => {
  const size = value && typeof value === 'object' ? value.size : value;
  return size === undefined || size === '' || size === null ? fallback : Number(size);
};

/**
 * Elementor's device mode, from kit 273's active breakpoints (mobile ≤767, tablet
 * ≤1024, desktop above — the values `elementorFrontend.config.responsive` carries
 * on this site, and the ones the playbook pins the clone's breakpoints to).
 */
const deviceMode = () => {
  const w = window.innerWidth;
  if (w <= 767) return 'mobile';
  if (w <= 1024) return 'tablet';
  return 'desktop';
};

/* ------------------------------------------------------------------ *
 * Environment classes
 *
 * Elementor stamps the browser/OS onto <body> and keeps the current breakpoint
 * there too; its stylesheets key rules off `.e--ua-appleWebkit`, so Safari renders
 * differently without them. Live DOM on this site, in Chrome on macOS:
 *   class="… e--ua-blink e--ua-mac e--ua-webkit" data-elementor-device-mode="desktop"
 * ------------------------------------------------------------------ */
function initEnvironment() {
  const ua = navigator.userAgent;
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
  const flags = {
    webkit: /AppleWebKit/i.test(ua),
    blink: /Chrome/i.test(ua) && !/Edge/i.test(ua),
    safari: isSafari,
    appleWebkit: isSafari,
    firefox: /Firefox/i.test(ua),
    gecko: /Gecko\//i.test(ua) && /Firefox/i.test(ua),
    edge: /Edg\//i.test(ua),
    mac: /Mac/i.test(navigator.platform || ua),
    windows: /Win/i.test(navigator.platform || ua),
    linux: /Linux/i.test(navigator.platform || ua) && !/Android/i.test(ua),
  };
  for (const [key, on] of Object.entries(flags)) {
    if (on) document.body.classList.add(`e--ua-${key}`);
  }

  const apply = () => document.body.setAttribute('data-elementor-device-mode', deviceMode());
  apply();
  let last = deviceMode();
  window.addEventListener('resize', () => {
    const now = deviceMode();
    if (now === last) return;
    last = now;
    apply();
  });
}

/* ------------------------------------------------------------------ *
 * Background lazy-load
 *
 * Elementor prints an inline observer that blanks `.e-con.e-parent` background
 * images until the container scrolls within 200px of the viewport, then marks it
 * `.e-lazyloaded`. Without this the guard never lifts and those sections lose their
 * backgrounds entirely. Transcribed from the inline script, margin included.
 * ------------------------------------------------------------------ */
function initLazyBackgrounds() {
  const targets = document.querySelectorAll('.e-con.e-parent:not(.e-lazyloaded)');
  if (!targets.length) return;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('e-lazyloaded');
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '200px 0px 200px 0px' });
  targets.forEach((el) => observer.observe(el));
}

/* ------------------------------------------------------------------ *
 * Nav menu — PowerPack "Advanced Menu", off-canvas at every breakpoint
 *
 * One menu widget per page, in the header. Its `breakpoint` is `all`, so there is
 * no desktop menu bar on this site at any width: every visitor gets the burger and
 * a 300px panel that slides in from the right.
 *
 * PowerPack moves the panel out of the widget and makes it `<body>`'s first child
 * — that is not cosmetic, it is what lets `position: fixed` escape the header's
 * stacking context. Reproduced exactly, or the panel renders inside the header and
 * is clipped.
 *
 * Contract, read off the live DOM with _extract/probe/menu.mjs:
 *
 *   closed   nav: inline `height: <innerHeight + 150>px`, `aria-hidden="true"`
 *            toggle: `aria-expanded="false"`
 *   open     <html> += `pp-menu-toggle-open`
 *            <body> += `pp-menu--off-canvas pp-menu-open`
 *            nav    += `pp-menu-open`, inline style becomes `z-index: 999999`
 *                     (dropping the height, so the stylesheet's 100% wins)
 *            toggle += `pp-active`, `aria-expanded="true"`
 *
 * The panel's inner `<ul>` is a SmartMenus instance; see annotateSmartMenu.
 * ------------------------------------------------------------------ */
function initPPMenu(widget) {
  const wrapper = widget.querySelector('.pp-advanced-menu-main-wrapper');
  const nav = widget.querySelector('nav.pp-advanced-menu__container') || wrapper?.querySelector('nav');
  const toggle = widget.querySelector('.pp-menu-toggle');
  if (!nav) return;

  const offCanvas = nav.classList.contains('pp-menu-off-canvas');
  const settings = settingsOf(widget);
  const subMenuIcon = settings.submenu_icon?.value || '<i class="fas fa-caret-down"></i>';

  annotateSmartMenu(nav.querySelector('ul.pp-advanced-menu'), subMenuIcon);

  // PowerPack lifts the off-canvas panel to the top of <body>.
  if (offCanvas && nav.parentElement !== document.body) document.body.prepend(nav);

  const sizeClosed = () => {
    if (!offCanvas || nav.classList.contains('pp-menu-open')) return;
    // Measured, not derived: PowerPack writes viewport height plus a fixed 150px
    // of slack (900 → 1050, 844 → 994). The panel is off screen while closed, so
    // the number never paints; it is matched so the computed-style diff is clean.
    nav.setAttribute('style', `height: ${window.innerHeight + 150}px;`);
  };

  const setOpen = (open) => {
    document.documentElement.classList.toggle('pp-menu-toggle-open', open);
    document.body.classList.toggle('pp-menu-open', open);
    if (offCanvas) document.body.classList.toggle('pp-menu--off-canvas', open);
    nav.classList.toggle('pp-menu-open', open);
    nav.setAttribute('aria-hidden', String(!open));
    toggle?.classList.toggle('pp-active', open);
    toggle?.setAttribute('aria-expanded', String(open));
    if (open) nav.setAttribute('style', 'z-index: 999999;');
    else sizeClosed();
  };

  sizeClosed();
  window.addEventListener('resize', sizeClosed);
  nav.setAttribute('aria-hidden', 'true');
  toggle?.setAttribute('aria-expanded', 'false');

  const flip = () => setOpen(!nav.classList.contains('pp-menu-open'));
  toggle?.addEventListener('click', flip);
  toggle?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); flip(); }
  });

  const close = nav.querySelector('.pp-menu-close');
  close?.addEventListener('click', () => setOpen(false));
  close?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(false); }
  });

  // Following a real link closes the panel; a parent whose arrow only expands a
  // sub-menu must not.
  nav.addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (link && !event.target.closest('.sub-arrow')) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && nav.classList.contains('pp-menu-open')) setOpen(false);
  });
}

/**
 * Reproduce SmartMenus on the menu's `<ul>`.
 *
 * PowerPack runs the same SmartMenus build Elementor's own nav widget does, and its
 * real options are readable off the live instance:
 *
 *   showOnClick: false         hover opens…
 *   showTimeout: 250           …after a quarter second
 *   hideTimeout: 500           …and closes half a second after the pointer leaves
 *   subIndicators: true        an appended `<span class="sub-arrow">` per parent
 *   subIndicatorsText: '<i class="fas fa-caret-down"></i>'
 *   collapsibleBehavior: 'link'  in the vertical panel the link navigates and the
 *                                arrow is what expands the sub-menu
 *
 * Note what is *not* in that list: hover. SmartMenus only opens on hover in its
 * horizontal mode, and this is the vertical off-canvas panel — production was
 * measured leaving the sub-menu shut with the pointer parked on a parent item.
 * Playbook §3.11's hover-gap bug therefore cannot occur here, and `npm run
 * functional` asserts that hover does nothing so it cannot creep back in.
 *
 * The annotations are part of the contract because the compiled CSS and assistive
 * tech both read them: `has-submenu` on the parent anchor, the `sm-<id>-<n>` id
 * pair, `role="menubar"/"menu"/"menuitem"/"none"`, `aria-haspopup`,
 * `aria-controls`, `aria-expanded`, `aria-hidden`, `aria-labelledby`, and on the
 * open sub-menu the inline `width: auto; display: block;`.
 */
/** SmartMenus' hide delay, still used by the focus-out path. */
const SM_HIDE_TIMEOUT = 500;
const SM_OPEN_STYLE = 'width: auto; display: block;';

let smMenuSeq = 0;

function annotateSmartMenu(root, subIndicatorHtml) {
  if (!root) return;
  const menuId = `${Date.now()}${smMenuSeq++}`;
  root.setAttribute('data-smartmenus-id', menuId);
  root.setAttribute('aria-label', 'Menu');
  root.setAttribute('role', 'menubar');

  for (const li of root.querySelectorAll('li')) li.setAttribute('role', 'none');
  for (const a of root.querySelectorAll('a')) a.setAttribute('role', 'menuitem');

  let seq = 0;
  const state = new Map();

  for (const li of root.querySelectorAll('li.menu-item-has-children')) {
    const anchor = li.querySelector(':scope > a');
    const sub = li.querySelector(':scope > ul.sub-menu');
    if (!anchor || !sub) continue;

    const anchorId = `sm-${menuId}-${++seq}`;
    const subId = `sm-${menuId}-${++seq}`;
    anchor.id = anchorId;
    sub.id = subId;
    anchor.classList.add('has-submenu');
    anchor.setAttribute('aria-haspopup', 'true');
    anchor.setAttribute('aria-controls', subId);
    anchor.setAttribute('aria-expanded', 'false');

    const arrow = document.createElement('span');
    arrow.className = 'sub-arrow';
    arrow.innerHTML = subIndicatorHtml;
    anchor.append(arrow);

    sub.setAttribute('role', 'menu');
    sub.setAttribute('aria-hidden', 'true');
    sub.setAttribute('aria-labelledby', anchorId);
    sub.setAttribute('aria-expanded', 'false');
    sub.setAttribute('aria-label', anchor.firstChild?.textContent?.trim() || '');

    state.set(li, { anchor, sub, arrow, hideTimer: null, open: false });
  }
  if (!state.size) return;

  const setOpen = (li, open) => {
    const s = state.get(li);
    if (!s || s.open === open) return;
    s.open = open;
    s.anchor.classList.toggle('highlighted', open);
    s.anchor.setAttribute('aria-expanded', String(open));
    s.sub.setAttribute('aria-expanded', String(open));
    s.sub.setAttribute('aria-hidden', String(!open));
    if (open) s.sub.setAttribute('style', SM_OPEN_STYLE);
    else s.sub.removeAttribute('style');
  };

  const closeAll = (except) => {
    for (const li of state.keys()) if (li !== except) setOpen(li, false);
  };

  const clearTimers = (s) => {
    clearTimeout(s.hideTimer); s.hideTimer = null;
  };

  for (const [li, s] of state) {
    // `collapsibleBehavior: 'link'` — the anchor navigates, the arrow expands.
    //
    // There is deliberately no hover handler, and that is a correction rather than
    // an omission: an earlier draft opened sub-menus on hover, and measuring
    // production showed it does nothing at all when the pointer rests on a parent
    // item for over a second. SmartMenus only opens on hover in its horizontal
    // mode, and this menu is the vertical off-canvas panel, which runs collapsed.
    //
    // That also takes playbook §3.11 off the table here: there is no gap for a
    // pointer to cross, because nothing opens on hover to begin with. The
    // `showTimeout` / `hideTimeout` values the instance carries (250/500) are real
    // but unreachable on this site; `npm run functional` asserts hover leaves the
    // sub-menu shut, so a future change back to a horizontal bar fails loudly
    // rather than quietly reintroducing the bug.
    s.arrow.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearTimers(s);
      const open = !s.open;
      closeAll(li);
      setOpen(li, open);
    });

    // Keyboard parity: the sub-menu has to be reachable without a pointer.
    s.anchor.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      closeAll(li);
      setOpen(li, true);
      s.sub.querySelector('a')?.focus();
    });
    li.addEventListener('focusout', () => {
      clearTimers(s);
      s.hideTimer = setTimeout(() => {
        if (!li.contains(document.activeElement)) setOpen(li, false);
      }, SM_HIDE_TIMEOUT);
    });
  }

  // `hideOnClick: true` — anything outside the menu closes it.
  document.addEventListener('click', (event) => {
    if (!root.contains(event.target)) closeAll(null);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAll(null);
  });
}

/* ------------------------------------------------------------------ *
 * Animated headline
 *
 * Two styles are used on this site, and both animate purely in CSS — the JS only
 * has to inject the marker, set the duration variable, and drive the class cycle
 * (`widget-animated-headline.css` carries the keyframes).
 *
 *   highlight  (21 widgets, one per page — the "24/7 EMERGENCY SERVICES" phone
 *              number in the header) Elementor appends an SVG of the chosen marker
 *              inside `.elementor-headline-dynamic-wrapper` and toggles `e-animated`
 *              on the `<h3>` to run `elementor-headline-dash`. With `loop: yes` it
 *              then adds `e-hide-highlight` for the 400ms fade-out and starts over
 *              `highlight_iteration_delay` later.
 *
 *   rotate     (the home page's "Emergency Plumbing Services / Leak Repairs / …")
 *              the active item carries `elementor-headline-text-active`, the one it
 *              replaced carries `elementor-headline-text-inactive`, and the wrapper
 *              gets an inline `width` equal to the active text's — the CSS
 *              transitions that width, which is what makes the box grow and shrink.
 *              Items never yet shown carry neither class, exactly as on production.
 * ------------------------------------------------------------------ */

/**
 * Elementor's marker shapes, copied from the live DOM rather than re-drawn. Only
 * `double_underline` is used on this site; the rest are here because the widget
 * offers them and a content edit could pick one tomorrow.
 */
const HEADLINE_MARKERS = {
  underline: ['M5,125.4c30.5-3.8,137.9-7.6,177.3-7.6c117.2,0,252.2,4.7,312.7,7.6'],
  double_underline: [
    'M5,125.4c30.5-3.8,137.9-7.6,177.3-7.6c117.2,0,252.2,4.7,312.7,7.6',
    'M26.9,143.8c55.1-6.1,126-6.3,162.2-6.1c46.5,0.2,203.9,3.2,268.9,6.4',
  ],
  underline_zigzag: [
    'M9.3,127.3c49.3-3,150.7-7.6,199.7-7.4c53,0.2,105.6,4.6,158.5,6.9c34.2,1.5,68.6,1.9,102.7-1.7',
    'M7.9,140.5c19.1-2.6,39.5-1.3,58.7-1c22.3,0.4,44.5,1.1,66.8,1.5c40.5,0.8,81,0.9,121.5,1.8c47.4,1.1,94.7,2.1,142.1,2.1c21.6,0,43.2-0.2,64.8-0.6',
  ],
  double: [
    'M6.9,11.4c68.1-4.6,203.4-4.6,278.3-4.6c86,0,180.3,0,209.2,4.6',
    'M6.9,143.8c68.1,4.6,203.4,4.6,278.3,4.6c86,0,180.3,0,209.2-4.6',
  ],
  circle: ['M325,18C228.7,8.3,118.1,21.8,72,34.8C-3.1,56-15.6,84.9,32.5,110c73.6,38.4,315.4,44.8,392.5,7.6c46.2-22.3,32.6-53.9-24.6-70.5C355.5,34,257.2,25.6,199.9,27.3'],
  curly: [
    'M5.1,116.5c0,0,58.2-13.4,88.4-16.6c39-4.2,79.9-3.9,118.5,3.4c33.7,6.4,66.3,20.1,101.1,15.9c25.2-3,50.6-13.6,74.9-20.5c22.6-6.4,45.9-12.4,69.5-11.3c15.6,0.7,30.9,4.3,45.6,9.4',
    'M6.9,143.8c0,0,58.2-13.4,88.4-16.6c39-4.2,79.9-3.9,118.5,3.4c33.7,6.4,66.3,20.1,101.1,15.9c25.2-3,50.6-13.6,74.9-20.5c22.6-6.4,45.9-12.4,69.5-11.3c15.6,0.7,30.9,4.3,45.6,9.4',
  ],
  diagonal: ['M11.5,134.5c35.4-1.9,70.8-3.1,106.2-4.5c22.7-0.9,45.4-1.9,68.1-2.9c26.6-1.2,53.3-2.5,79.9-3.7c25.8-1.2,51.7-2.4,77.5-3.6c20.5-1,41-1.9,61.5-2.9c11.5-0.5,23.1-1.1,34.6-1.6'],
  strikethrough: ['M11.5,75.5c35.4-1.9,70.8-3.1,106.2-4.5c22.7-0.9,45.4-1.9,68.1-2.9c26.6-1.2,53.3-2.5,79.9-3.7c25.8-1.2,51.7-2.4,77.5-3.6c20.5-1,41-1.9,61.5-2.9c11.5-0.5,23.1-1.1,34.6-1.6'],
  x: [
    'M497.4,4.9c-162.9,64.7-345,141.2-457.5,206.1',
    'M40,4.9C202.9,69.6,385,146.1,497.4,211',
  ],
};

function initAnimatedHeadline(widget) {
  const headline = widget.querySelector('.elementor-headline');
  if (!headline) return;
  const s = settingsOf(widget);
  const wrapper = headline.querySelector('.elementor-headline-dynamic-wrapper');
  if (!wrapper) return;

  if (s.headline_style === 'highlight') {
    const paths = HEADLINE_MARKERS[s.marker] || HEADLINE_MARKERS.underline;
    const duration = Number(s.highlight_animation_duration) || 1200;
    const delay = Number(s.highlight_iteration_delay) || 8000;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('viewBox', '0 0 500 150');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    wrapper.append(svg);
    headline.style.setProperty('--animation-duration', `${duration}ms`);

    const draw = () => {
      headline.classList.add('e-animated');
      if (s.loop !== 'yes' || reduceMotion) return;
      setTimeout(() => {
        headline.classList.remove('e-animated');
        headline.classList.add('e-hide-highlight');
        setTimeout(() => {
          headline.classList.remove('e-hide-highlight');
          draw();
        }, 400);
      }, duration + delay);
    };
    draw();
    return;
  }

  if (s.headline_style !== 'rotate') return;

  const items = [...wrapper.querySelectorAll('.elementor-headline-dynamic-text')];
  if (items.length < 2) {
    // One phrase: Elementor still sizes the wrapper to it, and never rotates.
    if (items[0]) sizeRotateWrapper(wrapper, items[0]);
    return;
  }

  let index = items.findIndex((el) => el.classList.contains('elementor-headline-text-active'));
  if (index < 0) index = 0;
  sizeRotateWrapper(wrapper, items[index]);

  const advance = () => {
    const previous = items[index];
    index = (index + 1) % items.length;
    previous.classList.remove('elementor-headline-text-active');
    previous.classList.add('elementor-headline-text-inactive');
    items[index].classList.remove('elementor-headline-text-inactive');
    items[index].classList.add('elementor-headline-text-active');
    sizeRotateWrapper(wrapper, items[index]);
  };

  const delay = Number(s.rotate_iteration_delay) || 2500;
  if (s.loop === 'yes' && !reduceMotion) setInterval(advance, delay);

}

/**
 * The active phrase is `position: relative` and the rest are absolute, so the
 * wrapper would collapse to the widest one's box only by accident. Elementor
 * measures the active phrase and writes the width; the stylesheet transitions it.
 */
/**
 * Layout width, in the fractional pixels the stylesheet resolved it to.
 *
 * Never `getBoundingClientRect().width` here: the flip animation puts a `rotateX`
 * on the phrase, and a bounding box includes the transform — so a measurement taken
 * mid-flight comes back narrower than the text really is and the headline wraps
 * onto an extra line. jQuery's `.width()`, which Elementor uses, reads the same
 * transform-independent value this does.
 */
const layoutWidth = (el) => parseFloat(getComputedStyle(el).width) || 0;

function sizeRotateWrapper(wrapper, active) {
  // Clear first, and force a layout before reading. The wrapper is still carrying
  // the *previous* phrase's width, and the active phrase is `position: relative`
  // inside it - so measuring without clearing measures the old box, and at narrow
  // viewports that is the difference between the headline wrapping onto three
  // lines and four.
  wrapper.style.removeProperty('width');
  void wrapper.offsetWidth;
  wrapper.style.width = `${Math.round(layoutWidth(active) * 1000) / 1000}px`;
}

/* ------------------------------------------------------------------ *
 * Posts / portfolio grid
 *
 * Thirteen service pages carry Elementor Pro's portfolio widget. Its layout is the
 * compiled CSS grid, not JS — the whole DOM contract is three marks:
 *
 *   container += `elementor-has-item-ratio`   (from `item_ratio`, 1 here: square)
 *   each item += `elementor-active` and inline `transform: translate3d(0,0,0)`
 *   each thumb += `elementor-fit-height` or `elementor-fit-width`
 *
 * The fit class is the one that matters visually: it decides which axis the
 * thumbnail is scaled on to cover its square. Elementor picks it by comparing the
 * image's aspect against the container's, which is why the declared width/height
 * are used here rather than waiting for the file — the markup carries both.
 * ------------------------------------------------------------------ */
function initPostsGrid(widget) {
  const container = widget.querySelector('.elementor-posts-container');
  if (!container) return;
  const ratio = sizeOf(settingsOf(widget).item_ratio, 0);
  if (!ratio) return;

  container.classList.add('elementor-has-item-ratio');
  for (const item of container.children) {
    item.classList.add('elementor-active');
    item.style.transform = 'translate3d(0px, 0px, 0px)';

    const thumb = item.querySelector('.elementor-post__thumbnail');
    const img = thumb?.querySelector('img');
    if (!thumb || !img) continue;
    const fit = () => {
      const w = img.naturalWidth || Number(img.getAttribute('width')) || 0;
      const h = img.naturalHeight || Number(img.getAttribute('height')) || 0;
      if (!w || !h) return;
      // `ratio` is the container's height ÷ width. An image relatively wider than
      // the box has to be matched on height to cover it, and vice versa.
      thumb.classList.add(h / w > ratio ? 'elementor-fit-width' : 'elementor-fit-height');
    };
    fit();
  }
}

/* ------------------------------------------------------------------ *
 * Gallery
 *
 * Two water-heater pages carry Elementor Pro's gallery. Unlike the portfolio grid,
 * this one really is laid out from JS: the compiled CSS positions items from custom
 * properties that only the e-gallery plugin writes.
 *
 * Contract off the live DOM:
 *
 *   container += `e-gallery-container e-gallery-grid e-gallery--ltr` (+ `--lazyload`)
 *                and inline `--hgap --vgap --animation-duration --columns --rows
 *                --aspect-ratio --container-aspect-ratio`
 *   each item += inline `--column` / `--row`
 *   each image += `e-gallery-image-loaded` and an inline `background-image` built
 *                 from its own `data-thumbnail`, once it scrolls into view
 * ------------------------------------------------------------------ */
const GALLERY_BREAKPOINTS = [
  { min: 1025, key: '' },
  { min: 768, key: '_tablet' },
  { min: 0, key: '_mobile' },
];

function initGallery(widget) {
  const container = widget.querySelector('.elementor-gallery__container');
  if (!container) return;
  const s = settingsOf(widget);
  const items = [...container.children];
  if (!items.length) return;

  const lazy = s.lazyload === 'yes';
  container.classList.add('e-gallery-container', 'e-gallery-grid', 'e-gallery--ltr');
  if (lazy) container.classList.add('e-gallery--lazyload');

  // `aspect_ratio` is Elementor's "w:h" string; the CSS wants h/w as a percentage.
  const [aw, ah] = String(s.aspect_ratio || '3:2').split(':').map(Number);
  const aspect = (ah / aw) * 100;

  const layout = () => {
    const width = window.innerWidth;
    const bp = GALLERY_BREAKPOINTS.find((b) => width >= b.min);
    const columns = Number(s[`columns${bp.key}`] ?? s.columns ?? 3) || 1;
    const gap = sizeOf(s[`gap${bp.key}`] ?? s.gap, 0);
    const rows = Math.ceil(items.length / columns);

    const containerWidth = container.getBoundingClientRect().width;
    const itemWidth = (containerWidth - gap * (columns - 1)) / columns;
    const itemHeight = itemWidth * (aspect / 100);
    const containerHeight = rows * itemHeight + gap * (rows - 1);

    container.style.cssText =
      `--hgap: ${gap}px; --vgap: ${gap}px; --animation-duration: 350ms; ` +
      `--columns: ${columns}; --rows: ${rows}; --aspect-ratio: ${aspect}%; ` +
      `--container-aspect-ratio: ${containerWidth ? (containerHeight / containerWidth) * 100 : 0}%;`;

    items.forEach((item, i) => {
      item.style.cssText = `--column: ${i % columns}; --row: ${Math.floor(i / columns)};`;
    });
  };

  layout();
  window.addEventListener('resize', layout);

  const show = (image) => {
    const src = image.getAttribute('data-thumbnail');
    if (!src || image.classList.contains('e-gallery-image-loaded')) return;
    image.style.backgroundImage = `url("${src}")`;
    image.classList.add('e-gallery-image-loaded');
  };

  const images = container.querySelectorAll('.e-gallery-image');
  if (!lazy) { images.forEach(show); return; }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      show(entry.target);
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '200px 0px' });
  images.forEach((image) => observer.observe(image));
}

/* ------------------------------------------------------------------ *
 * Swiper
 *
 * One widget type on this site is a Swiper carousel: Elementor Pro's reviews
 * widget, on / and /about-us/. The engine is kept general because Swiper's markup —
 * not just its behaviour — is what the compiled CSS lays out against: without it
 * the `.swiper-slide` children keep their CSS width and only the first is visible.
 * The lightbox below drives the same engine.
 *
 * Contract read off the live DOM:
 *
 *   container   + `swiper-initialized swiper-horizontal swiper-pointer-events`,
 *                 and `swiper-backface-hidden` while the total slide count is under
 *                 Swiper's `maxBackfaceHiddenSlides` (10)
 *   wrapper       `cursor: grab; transition-duration: <ms>; transform: translate3d(x,0,0)`
 *                 plus an id and `aria-live="off"`
 *   loop          `slidesPerView` duplicates on each side — the last N slides
 *                 prepended, the first N appended — each keeping the source's
 *                 `data-swiper-slide-index` and `aria-label="n / total"`
 *   slides        inline `width` = (containerWidth - space*(spv-1)) / spv, and
 *                 `margin-right` = spaceBetween when that is non-zero
 *   classes       active / next / prev on the real run, and duplicate-active /
 *                 duplicate-next / duplicate-prev on the elements that mirror them
 *
 * A container that is `display:none` at every breakpoint measures 0 wide, and
 * Swiper then skips sizing entirely: it still duplicates the slides and indexes
 * them, but writes no width, no margin and no `aria-label`.
 * ------------------------------------------------------------------ */

const CAROUSEL_BREAKPOINTS = [
  { min: 1025, key: '' },
  { min: 768, key: '_tablet', fallbackSpace: 10 },
  { min: 0, key: '_mobile', fallbackSpace: 10 },
];

/**
 * Per-widget `slidesPerView` fallback, desktop / tablet / mobile. Elementor's own
 * defaults are not serialised into `data-settings`; the reviews widget carries
 * explicit values for desktop and tablet and falls back to 1 on mobile.
 */
const CAROUSEL_DEFAULT_PER_VIEW = {
  'reviews.default': [3, 2, 1],
};

function initSwiper(container, cfg) {
  const wrapper = container.querySelector('.swiper-wrapper');
  if (!wrapper) return null;

  const originals = [...wrapper.children];
  const total = originals.length;
  if (!total) return null;

  const {
    speed = 300, loop = false, autoplayDelay = 0,
    pauseOnHover = false, pauseOnInteraction = false,
    next = null, prev = null, pagination = null, bullets = null,
    onChange = null,
  } = cfg;

  originals.forEach((slide, i) => { slide.dataset.swiperSlideIndex = String(i); });

  container.classList.add('swiper-initialized', 'swiper-horizontal', 'swiper-pointer-events');
  if (!container.hasAttribute('role')) {
    container.setAttribute('role', 'region');
    container.setAttribute('aria-roledescription', 'carousel');
    container.setAttribute('aria-label', 'Slides');
  }
  wrapper.id = `swiper-wrapper-${Math.random().toString(16).slice(2, 18)}`;
  wrapper.setAttribute('aria-live', 'off');

  let slides = originals;
  let activeIndex = 0;
  let realIndex = 0;
  let step = 0;
  let animating = false;
  let autoplayTimer = null;
  let autoplayStopped = false;

  const setTranslate = (x, ms) => {
    wrapper.style.cssText = `cursor: grab; transition-duration: ${ms}ms; transform: translate3d(${x}px, 0px, 0px);`;
  };

  // Bullet pagination is markup Swiper *creates*, not markup it decorates: the
  // server renders an empty container, and its height only exists once the spans
  // are in it — leave it empty and the section below moves up.
  if (bullets) {
    bullets.classList.add('swiper-pagination-clickable', 'swiper-pagination-bullets', 'swiper-pagination-horizontal');
    bullets.replaceChildren(...Array.from({ length: total }, (_, i) => {
      const dot = document.createElement('span');
      dot.className = 'swiper-pagination-bullet';
      dot.tabIndex = 0;
      dot.setAttribute('role', 'button');
      dot.setAttribute('aria-label', `Go to slide ${i + 1}`);
      const go = () => slideBy(i - realIndex);
      dot.addEventListener('click', go);
      dot.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
      return dot;
    }));
  }

  // Fraction pagination is created too: the server renders the container empty and
  // Swiper fills it with the two spans.
  if (pagination && !pagination.querySelector('.swiper-pagination-current')) {
    pagination.classList.add('swiper-pagination-fraction', 'swiper-pagination-horizontal');
    pagination.innerHTML =
      '<span class="swiper-pagination-current">1</span> / <span class="swiper-pagination-total">1</span>';
  }

  const paint = () => {
    if (pagination) {
      const current = pagination.querySelector('.swiper-pagination-current');
      const totalEl = pagination.querySelector('.swiper-pagination-total');
      if (current) current.textContent = String(realIndex + 1);
      if (totalEl) totalEl.textContent = String(total);
    }
    if (bullets) {
      [...bullets.children].forEach((dot, i) => {
        const on = i === realIndex;
        dot.classList.toggle('swiper-pagination-bullet-active', on);
        if (on) dot.setAttribute('aria-current', 'true');
        else dot.removeAttribute('aria-current');
      });
    }
    onChange?.(realIndex);
  };

  const markClasses = () => {
    for (const slide of slides) {
      slide.classList.remove('swiper-slide-active', 'swiper-slide-next', 'swiper-slide-prev',
        'swiper-slide-duplicate-active', 'swiper-slide-duplicate-next', 'swiper-slide-duplicate-prev');
    }
    const active = slides[activeIndex];
    active?.classList.add('swiper-slide-active');
    slides[activeIndex + 1]?.classList.add('swiper-slide-next');
    slides[activeIndex - 1]?.classList.add('swiper-slide-prev');
    paint();
    if (!loop) return;

    // Swiper mirrors the active/next/prev marks onto the matching duplicate — or
    // onto the real slide, when the marked one is itself a duplicate.
    const mirror = (index, cls, source) => {
      const wanted = source?.classList.contains('swiper-slide-duplicate')
        ? ':not(.swiper-slide-duplicate)'
        : '.swiper-slide-duplicate';
      wrapper.querySelectorAll(`.swiper-slide${wanted}[data-swiper-slide-index="${index}"]`)
        .forEach((el) => el.classList.add(cls));
    };
    mirror(realIndex, 'swiper-slide-duplicate-active', active);
    mirror((realIndex + 1) % total, 'swiper-slide-duplicate-next', slides[activeIndex + 1]);
    mirror((realIndex - 1 + total) % total, 'swiper-slide-duplicate-prev', slides[activeIndex - 1]);
  };

  const duplicate = (el) => {
    const copy = el.cloneNode(true);
    copy.classList.add('swiper-slide-duplicate');
    return copy;
  };

  const layout = () => {
    const { perView, space } = cfg.layout();

    // Rebuild the loop copies whenever the count changes with the breakpoint.
    if (loop) {
      for (const el of [...wrapper.children]) {
        if (el.classList.contains('swiper-slide-duplicate')) el.remove();
      }
      const before = originals.slice(Math.max(0, total - perView)).map(duplicate);
      const after = originals.slice(0, perView).map(duplicate);
      wrapper.prepend(...before);
      wrapper.append(...after);
      activeIndex = before.length + realIndex;
    } else {
      activeIndex = realIndex;
    }
    slides = [...wrapper.children];

    container.classList.toggle('swiper-backface-hidden', slides.length < 10);

    const width = container.clientWidth;
    if (!width) {
      // A container that is `display: none` measures 0 wide, and Swiper then skips
      // sizing entirely: it duplicates and indexes the slides, writes `cursor:
      // grab; transition-duration: 0ms;` on the wrapper — and no transform, no
      // slide width, no margin, no `aria-label`. Measured off production's own
      // reviews widget, which sits in a section hidden at every breakpoint.
      wrapper.style.cssText = 'cursor: grab; transition-duration: 0ms;';
      markClasses();
      return;
    }
    const slideWidth = Math.round(((width - space * (perView - 1)) / perView) * 1000) / 1000;
    step = slideWidth + space;
    for (const slide of slides) {
      slide.style.width = `${slideWidth}px`;
      if (space) slide.style.marginRight = `${space}px`;
      else slide.style.removeProperty('margin-right');
      const index = Number(slide.dataset.swiperSlideIndex);
      slide.setAttribute('aria-label', `${index + 1} / ${total}`);
      if (!slide.hasAttribute('role')) {
        slide.setAttribute('role', 'group');
        slide.setAttribute('aria-roledescription', 'slide');
      }
    }

    setTranslate(-step * activeIndex, 0);
    markClasses();
  };

  const slideBy = (delta) => {
    if (animating || !step) return;
    const target = activeIndex + delta;
    if (!loop && (target < 0 || target >= slides.length)) return;
    animating = true;
    activeIndex = target;
    realIndex = (realIndex + (delta % total) + total) % total;
    setTranslate(-step * activeIndex, speed);
    markClasses();
    setTimeout(() => {
      animating = false;
      if (!loop) return;
      // Loop fix: hop back onto the real run without a transition, exactly as
      // Swiper does once the duplicate has scrolled into place.
      const perView = cfg.layout().perView;
      if (activeIndex >= perView + total || activeIndex < perView) {
        activeIndex = perView + realIndex;
        setTranslate(-step * activeIndex, 0);
        markClasses();
      }
    }, speed);
  };

  const stopAutoplay = () => { clearInterval(autoplayTimer); autoplayTimer = null; };
  const startAutoplay = () => {
    if (!autoplayDelay || autoplayStopped || reduceMotion || autoplayTimer) return;
    autoplayTimer = setInterval(() => slideBy(1), autoplayDelay);
  };

  const arrow = (el, delta) => el?.addEventListener('click', () => {
    // Swiper's `disableOnInteraction: true` — a manual move ends autoplay for good.
    if (pauseOnInteraction) { autoplayStopped = true; stopAutoplay(); }
    slideBy(delta);
  });
  arrow(next, 1);
  arrow(prev, -1);

  if (pauseOnHover) {
    container.addEventListener('mouseenter', stopAutoplay);
    container.addEventListener('mouseleave', startAutoplay);
  }

  layout();
  window.addEventListener('resize', layout);
  startAutoplay();

  const api = {
    slideBy,
    /** Lets scripts/compare.mjs pin the carousel to a deterministic first slide. */
    reset() { autoplayStopped = true; stopAutoplay(); realIndex = 0; layout(); },
  };
  container.eCarousel = api;
  return api;
}

/** Elementor Pro's reviews widget — its options come from `data-settings`. */
function initElementorCarousel(widget) {
  const container = widget.querySelector('.elementor-main-swiper');
  if (!container) return;
  const s = settingsOf(widget);
  const perViewDefaults = CAROUSEL_DEFAULT_PER_VIEW[widget.getAttribute('data-widget_type')] || [3, 2, 1];

  const settingFor = (name, bp, fallback) => {
    const value = s[`${name}${bp.key}`] ?? (bp.key ? undefined : s[name]);
    return sizeOf(value, fallback);
  };

  initSwiper(container, {
    speed: Number(s.speed) || 300,
    loop: s.loop === 'yes',
    autoplayDelay: s.autoplay === 'yes' ? Number(s.autoplay_speed) || 5000 : 0,
    pauseOnHover: s.pause_on_hover === 'yes',
    pauseOnInteraction: s.pause_on_interaction === 'yes',
    next: widget.querySelector('.elementor-swiper-button-next'),
    prev: widget.querySelector('.elementor-swiper-button-prev'),
    pagination: s.pagination === 'fraction' ? widget.querySelector('.swiper-pagination') : null,
    bullets: s.pagination === 'bullets' ? widget.querySelector('.swiper-pagination') : null,
    layout() {
      const width = window.innerWidth;
      const index = CAROUSEL_BREAKPOINTS.findIndex((b) => width >= b.min);
      const bp = CAROUSEL_BREAKPOINTS[index];
      return {
        perView: settingFor('slides_per_view', bp, perViewDefaults[index]),
        space: settingFor('space_between', bp, bp.fallbackSpace ?? 0),
      };
    },
  });
}

/* ------------------------------------------------------------------ *
 * Dialog widget
 *
 * Elementor's popups and its image lightbox are the same component underneath —
 * `dialog.min.css` styles both, and it is loaded *conditionally*: it is in no
 * page's `<link>` list and only arrives when something opens. Without it
 * `.dialog-type-lightbox` is not a fixed full-viewport overlay and the popup lays
 * out in flow at the foot of the page, so the sheet is injected on first open from
 * the path it is mirrored at (see scripts/fetch-media.mjs).
 * ------------------------------------------------------------------ */
const CONDITIONAL_CSS = {
  dialog: '/wp-content/plugins/elementor/assets/css/conditionals/dialog.min.css',
  lightbox: '/wp-content/plugins/elementor/assets/css/conditionals/lightbox.min.css',
  swiper: '/wp-content/plugins/elementor/assets/lib/swiper/v8/css/swiper.min.css',
};

function loadConditionalCss(name) {
  const href = CONDITIONAL_CSS[name];
  if (!href || document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.append(link);
}

/**
 * Build the shell both the popup and the lightbox mount into.
 *
 * Structure copied node for node off the live DOM; `dialog-type-buttons` and the
 * empty header / buttons wrapper are part of it even though nothing fills them.
 */
function createDialog({ id, modifier, animation = '' }) {
  loadConditionalCss('dialog');
  const widget = document.createElement('div');
  widget.className = `dialog-widget dialog-lightbox-widget dialog-type-buttons dialog-type-lightbox ${modifier}`;
  widget.id = id;
  widget.setAttribute('aria-modal', 'true');
  widget.setAttribute('role', 'document');
  widget.tabIndex = 0;
  widget.innerHTML =
    `<div class="dialog-widget-content dialog-lightbox-widget-content${animation ? ' ' + animation : ''}">` +
    '<a role="button" tabindex="0" aria-label="Close" href="#" class="dialog-close-button dialog-lightbox-close-button">' +
    '<i class="eicon-close"></i></a>' +
    '<div class="dialog-header dialog-lightbox-header"></div>' +
    '<div class="dialog-message dialog-lightbox-message"></div>' +
    '<div class="dialog-buttons-wrapper dialog-lightbox-buttons-wrapper"></div>' +
    '</div>';

  // dialog.js stamps these on <body> when the first dialog is constructed and
  // leaves them there; production carries all four from then on.
  document.body.classList.add('dialog-body', 'dialog-lightbox-body', 'dialog-container', 'dialog-lightbox-container');

  const close = () => { widget.style.display = 'none'; };
  widget.querySelector('.dialog-close-button').addEventListener('click', (event) => {
    event.preventDefault();
    close();
  });
  // Clicking the backdrop closes; clicking the content does not.
  widget.addEventListener('click', (event) => {
    if (event.target === widget) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && widget.style.display !== 'none') close();
  });

  return {
    widget,
    message: widget.querySelector('.dialog-message'),
    show() { widget.style.display = ''; widget.focus(); },
    hide: close,
  };
}

/* ------------------------------------------------------------------ *
 * Popup
 *
 * Popup 189, "Book Appointment", is printed on every page and opened by the two
 * "Book Appointment" buttons on the service pages and the home page.
 *
 * Two details are load-bearing, and both were measured rather than assumed:
 *
 *   * Elementor **detaches** the template from the document at init and only puts
 *     it back when the popup opens. Production's DOM genuinely has no
 *     `[data-elementor-type="popup"]` node until you click. Leaving it in place is
 *     what the first computed-style diff caught: five clone-only elements the live
 *     page did not have.
 *   * `e-popup.css` carries
 *     `[data-elementor-type=popup]:not(.elementor-edit-area){display:none}`, and
 *     Elementor does *not* strip the attribute when it mounts — it writes an inline
 *     `display: block` that outranks the rule (playbook §3.12). Miss that and the
 *     popup opens as an empty grey overlay.
 * ------------------------------------------------------------------ */
function initPopups() {
  const templates = new Map();
  for (const el of document.querySelectorAll('body > [data-elementor-type="popup"]')) {
    templates.set(el.getAttribute('data-elementor-id') || 'x', el);
    el.remove();
  }
  if (!templates.size) return;

  const dialogs = new Map();
  const open = (id) => {
    let entry = dialogs.get(id);
    if (!entry) {
      const template = templates.get(id) ?? [...templates.values()][0];
      if (!template) return;
      const dialog = createDialog({
        id: `elementor-popup-modal-${id}`,
        modifier: 'elementor-popup-modal',
        animation: 'animated',
      });
      dialog.message.append(template);
      template.style.display = 'block';
      document.body.append(dialog.widget);
      entry = dialog;
      dialogs.set(id, entry);
    }
    entry.show();
  };

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href*="action%3Dpopup"], a[href*="action=popup"]');
    if (!link) return;
    const settings = readActionHash(link.getAttribute('href'));
    if (!settings || !settings.id) return;
    event.preventDefault();
    open(String(settings.id));
  });
}

/**
 * Elementor encodes widget actions into the href as
 * `#elementor-action:action=<name>&settings=<base64 json>`, sometimes
 * percent-encoded and sometimes not.
 */
function readActionHash(href) {
  if (!href) return null;
  const decoded = decodeURIComponent(href);
  const match = /settings=([^&]+)/.exec(decoded);
  if (!match) return null;
  try { return JSON.parse(atob(match[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; }
}

/* ------------------------------------------------------------------ *
 * Image lightbox
 *
 * The two gallery pages open Elementor's slideshow lightbox. Its markup is the
 * dialog shell above with a Swiper inside, and it is built entirely at click time —
 * together with two stylesheets that no page links (`lightbox.min.css` and Swiper
 * v8's own), both mirrored under public/ and injected here.
 *
 * Contract off the live DOM: header with share / zoom / fullscreen controls and a
 * `swiper-pagination-fraction` counter, one `.swiper-slide.elementor-lightbox-item`
 * per image wrapping a `.swiper-zoom-container`, prev/next buttons, and a footer
 * carrying the current image's title.
 * ------------------------------------------------------------------ */
function initLightbox() {
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-elementor-open-lightbox="yes"]');
    if (!link) return;
    event.preventDefault();
    openLightbox(link);
  });
}

function openLightbox(link) {
  const slideshow = link.getAttribute('data-elementor-lightbox-slideshow');
  const group = slideshow
    ? [...document.querySelectorAll(`a[data-elementor-lightbox-slideshow="${CSS.escape(slideshow)}"]`)]
    : [link];
  const start = Math.max(0, group.indexOf(link));

  loadConditionalCss('swiper');
  loadConditionalCss('lightbox');

  const dialog = createDialog({
    id: `elementor-lightbox-slideshow-${slideshow || 'single'}`,
    modifier: 'elementor-lightbox',
  });
  dialog.message.classList.add('animated', 'zoomIn');

  const total = group.length;
  const slides = group.map((a) => {
    const title = a.getAttribute('data-elementor-lightbox-title') || '';
    return '<div class="swiper-slide elementor-lightbox-item" data-e-action-hash="' +
      (a.getAttribute('data-e-action-hash') || '') + '"><div class="swiper-zoom-container">' +
      `<img class="elementor-lightbox-image elementor-lightbox-prevent-close" data-title="${escapeHtml(title)}" ` +
      `alt="${escapeHtml(title)}" src="${a.getAttribute('href')}"></div></div>`;
  }).join('');

  dialog.message.innerHTML =
    '<div class="swiper">' +
    '<header class="elementor-slideshow__header elementor-lightbox-prevent-close">' +
    '<i class="eicon-share-arrow" role="button" tabindex="0" aria-label="Share" aria-expanded="false"><span></span></i>' +
    '<div class="elementor-slideshow__share-menu"><div></div></div>' +
    '<i role="switch" tabindex="0" aria-checked="false" aria-label="Zoom" class="eicon-zoom-in-bold"></i>' +
    '<i role="switch" tabindex="0" aria-checked="false" aria-label="Fullscreen" class="eicon-frame-expand"><span></span><span></span></i>' +
    `<span class="elementor-slideshow__counter swiper-pagination-fraction swiper-pagination-horizontal"><span class="swiper-pagination-current">1</span> / <span class="swiper-pagination-total">${total}</span></span>` +
    '</header>' +
    `<div class="swiper-wrapper">${slides}</div>` +
    '<div class="elementor-swiper-button elementor-swiper-button-next elementor-lightbox-prevent-close" tabindex="0" role="button" aria-label="Next slide"><i class="eicon-chevron-right" aria-hidden="true"></i><span class="screen-reader-text">Next</span></div>' +
    '<div class="elementor-swiper-button elementor-swiper-button-prev elementor-lightbox-prevent-close" tabindex="0" role="button" aria-label="Previous slide"><i class="eicon-chevron-left" aria-hidden="true"></i><span class="screen-reader-text">Previous</span></div>' +
    '<footer class="elementor-slideshow__footer elementor-lightbox-prevent-close">' +
    '<div class="elementor-slideshow__title"></div><div class="elementor-slideshow__description"></div>' +
    '</footer>' +
    '<span class="swiper-notification" aria-live="assertive" aria-atomic="true"></span>' +
    '</div>';

  document.body.append(dialog.widget);

  const container = dialog.message.querySelector('.swiper');
  const titleEl = dialog.message.querySelector('.elementor-slideshow__title');
  const swiper = initSwiper(container, {
    speed: 500,
    loop: total > 1,
    next: dialog.message.querySelector('.elementor-swiper-button-next'),
    prev: dialog.message.querySelector('.elementor-swiper-button-prev'),
    pagination: dialog.message.querySelector('.elementor-slideshow__counter'),
    layout: () => ({ perView: 1, space: 100 }),
    onChange(index) {
      titleEl.textContent = group[index]?.getAttribute('data-elementor-lightbox-title') || '';
    },
  });
  if (start) swiper?.slideBy(start);

  // Zoom and fullscreen are switches on the live widget; both are one class.
  const zoom = dialog.message.querySelector('.eicon-zoom-in-bold');
  zoom?.addEventListener('click', () => {
    const on = zoom.getAttribute('aria-checked') !== 'true';
    zoom.setAttribute('aria-checked', String(on));
    zoom.classList.toggle('eicon-zoom-in-bold', !on);
    zoom.classList.toggle('eicon-zoom-out-bold', on);
    container.classList.toggle('elementor-zoom-mode', on);
    for (const img of container.querySelectorAll('.elementor-lightbox-image')) {
      img.style.transform = on ? 'scale(1.5)' : '';
    }
  });
  const full = dialog.message.querySelector('.eicon-frame-expand');
  full?.addEventListener('click', () => {
    const on = full.getAttribute('aria-checked') !== 'true';
    full.setAttribute('aria-checked', String(on));
    if (on) dialog.widget.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  });

  // Elementor removes the whole widget on close rather than hiding it, so a second
  // click builds a fresh one — which is why the slideshow always reopens on the
  // image that was clicked.
  const remove = () => dialog.widget.remove();
  dialog.widget.querySelector('.dialog-close-button').addEventListener('click', remove);
  dialog.widget.addEventListener('click', (event) => { if (event.target === dialog.widget) remove(); });
  document.addEventListener('keydown', (event) => {
    if (!dialog.widget.isConnected) return;
    if (event.key === 'Escape') remove();
    if (event.key === 'ArrowRight') swiper?.slideBy(1);
    if (event.key === 'ArrowLeft') swiper?.slideBy(-1);
  });

  dialog.show();
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------ *
 * Anchors
 *
 * Elementor intercepts same-page hash links and scrolls smoothly. This site has no
 * sticky header, so there is no offset to subtract — but the smooth scroll itself
 * is production's behaviour and a plain jump is visibly different.
 * ------------------------------------------------------------------ */
function initAnchors() {
  const scrollToId = (id) => {
    const target = document.getElementById(id) || document.querySelector(`[name="${CSS.escape(id)}"]`);
    if (!target) return false;
    const top = target.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top, behavior: reduceMotion ? 'auto' : 'smooth' });
    return true;
  };

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href*="#"]');
    if (!link || link.target === '_blank') return;
    if (link.getAttribute('href')?.includes('elementor-action')) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || url.pathname !== location.pathname) return;
    const id = url.hash.slice(1);
    if (!id || id === 'content') return;
    if (!scrollToId(id)) return;
    event.preventDefault();
    history.pushState(null, '', url.hash);
  });

  if (location.hash.length > 1) {
    onReady(() => setTimeout(() => scrollToId(location.hash.slice(1)), 0));
  }
}

/* ------------------------------------------------------------------ *
 * Trailing nodes
 *
 * Elementor appends two elements to <body> on init:
 *
 *   <span id="elementor-device-mode" class="elementor-screen-only">
 *     The breakpoint probe. elementor-frontend.css gives it a `content` per
 *     breakpoint so scripts can read the active device off it.
 *
 *   <svg style="display:none" class="e-font-icon-svg-symbols">
 *     The sprite sheet Elementor fills with any icon rendered as inline SVG. This
 *     site renders its icons as Font Awesome webfont glyphs, so it stays empty
 *     here exactly as it is empty on production.
 * ------------------------------------------------------------------ */
function initTrailingNodes() {
  if (!document.getElementById('elementor-device-mode')) {
    const probe = document.createElement('span');
    probe.id = 'elementor-device-mode';
    probe.className = 'elementor-screen-only';
    document.body.append(probe);
  }
  if (!document.querySelector('svg.e-font-icon-svg-symbols')) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('style', 'display: none;');
    svg.setAttribute('class', 'e-font-icon-svg-symbols');
    document.body.append(svg);
  }
}

/* ------------------------------------------------------------------ */

const WIDGETS = {
  'pp-advanced-menu.default': initPPMenu,
  'animated-headline.default': initAnimatedHeadline,
  'portfolio.default': initPostsGrid,
  'archive-posts.archive_classic': initPostsGrid,
  'gallery.default': initGallery,
  'reviews.default': initElementorCarousel,
};

function initWidgets(root) {
  for (const [type, init] of Object.entries(WIDGETS)) {
    for (const widget of root.querySelectorAll(`[data-widget_type="${type}"]`)) {
      try { init(widget); } catch (error) { console.error(`[elementor] ${type}`, error); }
    }
  }
}

onReady(() => {
  initEnvironment();
  initLazyBackgrounds();
  initWidgets(document);
  initPopups();
  initLightbox();
  initAnchors();
  initTrailingNodes();
});
