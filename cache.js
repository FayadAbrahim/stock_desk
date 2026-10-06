// Small in-memory cache with "serve stale if the source is down" behaviour,
// plus a per-IP rate limiter. In serverless each instance has its own memory; the CDN header in api/ adds a second layer.
const store = new Map();

export async function cached(key, ttlMs, fn, staleMs = 6 * 3600e3) {
  const hit = store.get(key), now = Date.now();
  if (hit && now - hit.t < ttlMs) return { value: hit.v, stale: false, ageMs: now - hit.t };
  try {
    const v = await fn();
    store.set(key, { v, t: now });
    if (store.size > 500) store.delete(store.keys().next().value);
    return { value: v, stale: false, ageMs: 0 };
  } catch (e) {
    if (hit && now - hit.t < staleMs) return { value: hit.v, stale: true, ageMs: now - hit.t };
    throw e;
  }
}
export const clearCache = () => store.clear();

const hits = new Map();
export function rateLimit(ip, max = 40, windowMs = 60000) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(ip, arr); return false; }
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return true;
}
