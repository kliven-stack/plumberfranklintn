/**
 * In-memory rate limit: 3 submissions per minute per IP.
 *
 * Advisory, and documented as such (playbook §4c step 3). Vercel runs each function
 * instance in its own isolate, so this bucket is per-instance rather than global —
 * a burst spread across cold starts can exceed the limit. It is here to stop the
 * obvious hammering, not as a security control; Turnstile is what actually keeps
 * bots out.
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 3;

const hits = new Map<string, number[]>();

export function rateLimit(key: string): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(key, recent);
    return { ok: false, retryAfter: Math.ceil((WINDOW_MS - (now - recent[0])) / 1000) };
  }

  recent.push(now);
  hits.set(key, recent);

  // Keep the map from growing without bound on a long-lived instance.
  if (hits.size > 5000) {
    for (const [k, times] of hits) {
      if (times.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
    }
  }

  return { ok: true, retryAfter: 0 };
}
