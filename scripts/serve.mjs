// Static server for dist/, so the fidelity harness measures the production build
// (no dev toolbar, no Vite client) instead of the dev server.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

// The Vercel adapter writes the static site here, not to dist/ (playbook §3.4).
const ROOT = new URL('../.vercel/output/static/', import.meta.url).pathname;
// Honour vercel.json's redirects so local runs behave like production.
const { redirects = [], rewrites = [] } = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
const PORT = Number(process.env.PORT || 4321);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.xml': 'application/xml',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Two of vercel.json's redirects exist because the client asked for those pages to
  // be retired (/home-2/, /template/). A `PUBLIC_ORIGINAL_BUGS=keep` build is there
  // to be diffed against WordPress, where both pages still answer 200 — so honour
  // them as pages, not redirects, in that mode.
  const RETIRED = new Set(['/home-2', '/template']);
  const keepBugs = process.env.PUBLIC_ORIGINAL_BUGS === 'keep';

  // Matched literally, exactly as Vercel matches it — no trailing-slash
  // normalisation on either side. Being more forgiving here than production is
  // how a whole class of broken redirects stayed invisible: every source written
  // without a trailing slash 404s on Vercel for the slash form, which is the
  // canonical form WordPress served and the one in Google's index. vercel.json
  // now carries both spellings; this must stay strict so it cannot drift again.
  // vercel.json's `:param` and `(.*)` patterns, matched the way Vercel matches
  // them: EXACTLY, trailing slash included. Being more forgiving here than
  // production is how a whole class of broken redirects stayed invisible — every
  // source written without a trailing slash 404s on Vercel for the slash form,
  // which is the canonical form WordPress served. Both spellings are now listed in
  // vercel.json; this matcher stays strict so that dropping one fails
  // `npm run functional` instead of production.
  const matchesSource = (source, pathname = url.pathname) => {
    const body = source.includes('(')
      ? source
      : source.replace(/[.+?^${}|[\]\\]/g, '\\$&').replace(/:[a-zA-Z_][\w]*\*/g, '.*').replace(/:[a-zA-Z_][\w]*/g, '[^/]+');
    return new RegExp('^' + body + '$').test(pathname);
  };

  const hit = redirects.find((r) => {
    if (keepBugs && RETIRED.has(r.source)) return false;
    if (!matchesSource(r.source)) return false;
    return (r.has ?? []).every((h) => h.type === 'query' && url.searchParams.has(h.key));
  });
  if (hit) {
    res.writeHead(hit.permanent ? 308 : 307, { location: hit.destination + url.search });
    res.end();
    return;
  }

  // Rewrites — and the ORDER here is the whole point, because getting it wrong
  // hid a real bug. Vercel applies vercel.json's `rewrites` only *after* the
  // filesystem misses; a path that matches a static file is served and the rewrite
  // never runs. An earlier version of this file applied rewrites first, which made
  // a `/` + `?s` rewrite look like it worked locally while the deployment quietly
  // served the home page. Rewrites are therefore resolved below, only once the
  // file lookup has failed.
  const rewriteFor = (pathname) => rewrites.find((r) =>
    matchesSource(r.source, pathname)
    && (r.has ?? []).every((h) => h.type === 'query' && url.searchParams.has(h.key)));

  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
  } catch {
    if (!path.extname(file)) file = path.join(file, 'index.html');
  }
  try {
    const body = await readFile(file);
    const type = TYPES[path.extname(file)] || 'application/octet-stream';

    // Media elements request byte ranges; without 206 support Chrome will not play.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : body.length - 1;
      res.writeHead(206, {
        'content-type': type,
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'accept-ranges': 'bytes',
        'content-length': end - start + 1,
      });
      res.end(body.subarray(start, end + 1));
      return;
    }

    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes' });
    res.end(body);
  } catch {
    // The filesystem missed, which is the point at which Vercel consults
    // vercel.json's rewrites.
    const rewrite = rewriteFor(url.pathname);
    if (rewrite) {
      try {
        const target = path.join(ROOT, decodeURIComponent(rewrite.destination), 'index.html');
        const body = await readFile(target);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
        return;
      } catch { /* destination missing — fall through to the 404 */ }
    }

    // Same as Vercel: unmatched paths get the site's own 404 page.
    let body = '<!doctype html><title>404</title>Not found';
    try { body = await readFile(path.join(ROOT, '404.html')); } catch { /* not built yet */ }
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  }
}).listen(PORT, () => console.log(`dist/ on http://localhost:${PORT}`));
