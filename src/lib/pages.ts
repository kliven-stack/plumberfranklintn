import pagesData from '../data/pages.json';
import { fixFragment } from './fixes';

export interface CssRef { type: 'file'; name: string }
export interface Favicon { rel: string; href: string; sizes: string | null }

export interface PageRecord {
  slug: string;
  path: string;
  title: string;
  description: string | null;
  robots: string | null;
  bodyClass: string;
  viewport: string;
  lang: string;
  hasSkipLink: boolean;
  header: string | null;
  footer: string | null;
  /** Elementor popup templates the page carries. Every page carries popup 189. */
  popups: string[];
  content: string;
  css: CssRef[];
  favicons: Favicon[];
  /** msapplication-TileImage, as WordPress printed it. */
  tile: string | null;
  /** The Open Graph / Twitter block WordPress printed, origin templated out. */
  seoHead: string;
}

export const pages = pagesData as PageRecord[];

/** Raw Elementor markup, keyed by fragment name (`page-index`, `header-147-…`). */
const fragmentModules = import.meta.glob<string>('../fragments/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const fragments = new Map<string, string>(
  Object.entries(fragmentModules).map(([file, html]) => [
    file.replace(/^.*\/([^/]+)\.html$/, '$1'),
    html,
  ]),
);

export function fragment(name: string | null): string {
  if (!name) return '';
  const html = fragments.get(name);
  if (html === undefined) throw new Error(`Missing fragment: ${name}`);
  // Corrections to the WordPress site's own bugs, applied here rather than in
  // src/fragments/ so that `npm run extract` cannot undo them (see lib/fixes.ts).
  return fixFragment(html, name);
}

export const pageByPath = new Map(pages.map((p) => [p.path, p]));
