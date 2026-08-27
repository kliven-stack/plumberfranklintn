/**
 * Corrections to the original site's own bugs.
 *
 * The clone reproduces production exactly, bugs included (playbook §2), so these
 * are **off by default**: nobody has decided yet which of the defects the README
 * lists should be corrected. Set `PUBLIC_APPLY_FIXES=on` to build with them applied.
 *
 * They live here rather than in `src/fragments/` for two reasons:
 *
 *   * `npm run extract` rewrites the fragments from the crawl, so an edit made
 *     there disappears the next time anyone re-runs the pipeline;
 *   * `npm run compare` diffs the build against the live WordPress site, so it can
 *     only be meaningful against an unfixed build — which is the default here.
 *
 * Fixes that need information only the client has are deliberately NOT here. See
 * the README's bug register.
 */

/** Opt in with `PUBLIC_APPLY_FIXES=on`; the default build is a faithful clone. */
export const FIXES_ON = (import.meta.env.PUBLIC_APPLY_FIXES || '') === 'on';

/** One `String.replace` pair, with the reason it exists. */
interface Rewrite {
  /** Which fragments to apply to — matched against the fragment name. */
  match?: RegExp;
  from: string | RegExp;
  to: string;
  why: string;
}

const REWRITES: Rewrite[] = [
  // ---------------------------------------------------------------- bug 1
  {
    match: /^page-contact-us$/,
    from: 'id="gform_wrapper_1"',
    to: 'id="gform_wrapper_1_inline"',
    why:
      'The Book Appointment form is rendered twice on /contact-us/ - once in the ' +
      'page body and once inside popup 189, which every page carries - so the ' +
      'whole `gform_wrapper_1` / `gform_1` / `input_1_*` id tree appears twice in ' +
      'the served HTML. Nothing renders wrong today, because Elementor detaches ' +
      'the popup template at init and /contact-us/ has no button that opens it, ' +
      'so a browser never holds both copies at once. It is still invalid markup ' +
      'that anything reading the source sees - a validator, a scraper, an ' +
      'assistive tool working from the HTML - and it becomes a real bug the ' +
      'moment somebody adds a Book Appointment button to that page. This renames ' +
      'the outer wrapper; the field-level ids are renamed by the rules below.',
  },
  ...['1_1', '1_2', '1_3', '1_4', '1_5', '1_6', '1_8'].flatMap((n) => [
    {
      match: /^page-contact-us$/,
      from: `id='input_${n}'`,
      to: `id='input_${n}_inline'`,
      why: `Field id half of bug 1, for input_${n}.`,
    },
    {
      match: /^page-contact-us$/,
      from: `for='input_${n}'`,
      to: `for='input_${n}_inline'`,
      why: `Label half of bug 1, for input_${n}.`,
    },
  ]),
];

/**
 * Whole elements to drop, by Elementor `data-id`.
 *
 * Empty: every defect found on this site is a markup issue a rewrite above can fix,
 * or a content decision that belongs to the client.
 */
const REMOVE: { match: RegExp; ids: string[]; why: string }[] = [];

/** Removes the element whose `data-id` is `id`, and everything inside it. */
function removeElement(html: string, id: string): string {
  const open = html.indexOf(`data-id="${id}"`);
  if (open === -1) return html;
  const start = html.lastIndexOf('<', open);
  const tag = /^<([a-z0-9]+)/i.exec(html.slice(start))?.[1];
  if (!tag) return html;
  // Walk the tag stack forward to the matching close.
  const scan = new RegExp(`<(/?)${tag}\\b`, 'gi');
  scan.lastIndex = start + 1;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = scan.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) {
      const end = html.indexOf('>', m.index) + 1;
      return html.slice(0, start) + html.slice(end);
    }
  }
  return html;
}

/** Applies every rewrite that targets this fragment. */
export function fixFragment(html: string, name: string): string {
  if (!FIXES_ON) return html;
  let out = html;
  for (const rule of REWRITES) {
    if (rule.match && !rule.match.test(name)) continue;
    out = typeof rule.from === 'string' ? out.split(rule.from).join(rule.to) : out.replace(rule.from, rule.to);
  }
  for (const rule of REMOVE) {
    if (!rule.match.test(name)) continue;
    for (const id of rule.ids) out = removeElement(out, id);
  }
  return out;
}

export interface MetaFix {
  description?: string;
  robots?: string;
}

/**
 * Metadata corrections.
 *
 * WordPress writes this site's head with no SEO plugin at all: core supplies the
 * canonical tag, and that is the whole of it. There is no Open Graph or Twitter
 * block anywhere on the site, and not one page carries a meta description. Writing
 * twenty-one descriptions is a copywriting job for the client, not something to
 * invent here; what *is* safe to correct is the author archive, an empty listing
 * WordPress advertises in its own sitemap.
 */
const META: Record<string, MetaFix> = {
  '/author/relplumbin/': { robots: 'noindex, follow' },
};

export function fixPageMeta(path: string): MetaFix {
  if (!FIXES_ON) return {};
  return META[path] ?? {};
}

/**
 * Nothing to correct: WordPress prints no Open Graph or Twitter block on this
 * site at all, so `seoHead` is empty on every page. Kept so the layout's call site
 * stays the same as the sibling projects'.
 */
export function fixSeoHead(html: string): string {
  return html;
}

/**
 * CSS-level corrections, inlined after the compiled Elementor sheets.
 *
 * Empty on purpose so far — filled in only if the client asks for one of the
 * layout defects in the README to be corrected.
 */
export const FIX_CSS = '';
