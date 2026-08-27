// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

const SITE = process.env.PUBLIC_SITE_URL || 'https://plumberfranklintn.com';

export default defineConfig({
  site: SITE,

  /**
   * Static, plus one serverless function for the contact action.
   *
   * `output: 'static'` is the default and stays the default: every page is
   * prerendered at build time. Astro still deploys the action endpoint as a
   * function, which is the whole of the server side here.
   *
   * Playbook §3.3: never set `prerender = false` on a page that renders images —
   * a server-rendered page switches `astro:assets` to the runtime `/_image`
   * endpoint, which 404s on Vercel. No page in this project opts out.
   */
  output: 'static',
  adapter: vercel(),

  trailingSlash: 'always',
  build: { format: 'directory' },

  /**
   * Playbook §3.2. Astro's CSRF middleware compares the browser's `Origin` against
   * the hostname the function sees internally on Vercel; those are never equal, so
   * every legitimate POST 403s. Safe to disable here: the site sets no cookies and
   * has no sessions (what CSRF actually targets), and the Turnstile token the
   * action requires is bound to the hostname that issued it.
   */
  security: { checkOrigin: false },

  integrations: [
    sitemap({
      /**
       * WordPress advertised twenty of these URLs across two sitemaps — nineteen
       * pages plus the author archive. The author archive is an empty listing that
       * nothing links to, and the theme's 404 template is a route here rather than
       * a page, so neither belongs in an index.
       */
      filter: (page) => !/\/(404|author)\//.test(page),
    }),
  ],

  vite: { plugins: [tailwindcss()] },
});
