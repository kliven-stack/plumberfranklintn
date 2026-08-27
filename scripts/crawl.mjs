// Crawl the live WordPress site: fetch every page in wp-sitemap plus anything
// linked from a crawled page on the same host. Saves raw HTML to _extract/html/
// and a manifest of what was found.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ORIGIN = 'https://plumberfranklintn.com';
const OUT = new URL('../_extract/', import.meta.url).pathname;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, { tries = 4 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml' }, redirect: 'follow' });
      const body = await res.text();
      return { status: res.status, url: res.url, body, type: res.headers.get('content-type') || '' };
    } catch (err) {
      if (i === tries - 1) return { status: 0, url, body: '', type: '', error: String(err) };
      await sleep(800 * (i + 1));
    }
  }
}

// slug for a URL path: "/" -> "index", "/blog/foo/" -> "blog__foo"
export const slugOf = (pathname) => {
  const p = pathname.replace(/^\/+|\/+$/g, '');
  return p === '' ? 'index' : p.replace(/\//g, '__');
};

const norm = (u) => {
  try {
    const url = new URL(u, ORIGIN);
    if (url.origin !== ORIGIN) return null;
    if (/\.(jpe?g|png|gif|svg|webp|avif|pdf|mp4|zip|css|js|xml|ico)$/i.test(url.pathname)) return null;
    if (/^\/(wp-admin|wp-json|wp-content|wp-includes|feed)/.test(url.pathname)) return null;
    if (url.pathname.includes('/feed')) return null;
    url.hash = '';
    url.search = '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.href;
  } catch { return null; }
};

async function sitemapUrls() {
  // Yoast serves sitemap_index.xml; core WordPress serves wp-sitemap.xml. Try both.
  let idx = { body: '' };
  for (const name of ['sitemap_index.xml', 'wp-sitemap.xml']) {
    const r = await get(`${ORIGIN}/${name}`);
    if (r.status === 200 && r.body.includes('<loc>')) { idx = r; break; }
  }
  const maps = [...idx.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const urls = new Set();
  for (const m of maps) {
    const r = await get(m);
    for (const u of [...r.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((x) => x[1])) {
      const n = norm(u);
      if (n) urls.add(n);
    }
  }
  return [...urls];
}

const run = async () => {
  await mkdir(path.join(OUT, 'html'), { recursive: true });
  const seeds = await sitemapUrls();
  // Roots WordPress serves that Yoast's sitemap omits and no page links to.
  // A URL that resolves on WordPress and 404s here after cutover is a regression,
  // not an out-of-scope note (playbook §1). Every entry is probed against
  // production and kept only if it really answers 200 with content.
  //
  //   /author/relplumbin/  the site's one author archive. WordPress's own
  //                        wp-sitemap-users-1.xml advertises it, but the page
  //                        sitemap does not, and nothing on the site links to it.
  const extras = [
    '/author/relplumbin/',
    ...(process.env.EXTRAS || '').split(',').filter(Boolean),
  ].map((p) => ORIGIN + p);
  const queue = [...new Set([...seeds, ...extras])];
  const seen = new Set(queue);
  const manifest = [];

  // Slugs already written, lowercased. WordPress answers 200 on a mis-cased slug
  // (`/Testimonials` is linked from two breadcrumbs and serves /testimonials/ with
  // that page's canonical), but a static host is case-sensitive and macOS's
  // filesystem is not — left alone, the mis-cased fetch silently overwrites the
  // real page's HTML with a copy of itself. Record it as the redirect it behaves
  // like, so vercel.json can reproduce it, and never write a second file.
  const written = new Set();

  for (let i = 0; i < queue.length; i++) {
    const url = queue[i];
    const slug = slugOf(new URL(url).pathname);
    const file = path.join(OUT, 'html', slug + '.html');
    if (written.has(slug.toLowerCase()) && !written.has(slug)) {
      const canonical = new URL(url);
      canonical.pathname = canonical.pathname.toLowerCase();
      manifest.push({
        url, status: 200, finalUrl: canonical.href, slug: slugOf(canonical.pathname),
        redirect: true, caseVariant: true, fromSitemap: false,
      });
      console.log(`200 case  ${url} -> ${canonical.pathname}`);
      continue;
    }
    let res;
    if (existsSync(file) && !process.env.FORCE) {
      res = { status: 200, url, body: await readFile(file, 'utf8'), cached: true };
      written.add(slug.toLowerCase());
    } else {
      res = await get(url);
      // A URL that redirects is not a page of its own — WordPress resolves it to
      // one we already have. Record it so vercel.json can reproduce the redirect,
      // but do not save a second copy of the target's HTML.
      const redirected = res.url && new URL(res.url).pathname !== new URL(url).pathname;
      if (res.status === 200 && /html/.test(res.type) && !redirected) {
        await writeFile(file, res.body);
        written.add(slug.toLowerCase());
      }
      await sleep(250);
    }
    const finalPath = new URL(res.url || url).pathname;
    manifest.push({
      url, status: res.status, finalUrl: res.url, slug: slugOf(finalPath),
      redirect: new URL(res.url || url).pathname !== new URL(url).pathname,
      fromSitemap: seeds.includes(url),
    });
    console.log(`${res.status} ${res.cached ? 'cache' : 'fetch'} ${url}`);
    if (res.status !== 200) continue;

    // Discover more same-host links (pagination, archives, orphan pages).
    for (const m of res.body.matchAll(/href=["']([^"']+)["']/g)) {
      const n = norm(m[1]);
      if (n && !seen.has(n)) { seen.add(n); queue.push(n); }
    }
  }

  // The theme's 404 template, so unknown URLs land on the site's own page rather
  // than the host's default. Fetched from a URL WordPress is guaranteed to miss.
  const notFound = await get(`${ORIGIN}/this-page-does-not-exist-clone-probe/`);
  if (notFound.status === 404) {
    await writeFile(path.join(OUT, 'html', '404.html'), notFound.body);
    manifest.push({ url: `${ORIGIN}/404/`, status: 200, finalUrl: `${ORIGIN}/404/`, slug: '404', fromSitemap: false });
    console.log('404 template captured');
  }

  await writeFile(path.join(OUT, 'crawl-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n${manifest.length} urls, ${manifest.filter((m) => m.status === 200).length} ok`);
};

if (import.meta.url === `file://${process.argv[1]}`) await run();
