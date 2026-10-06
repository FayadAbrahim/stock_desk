// Network helpers: timeouts, retries with backoff, and a per-request "data health" log.
import { AsyncLocalStorage } from "node:async_hooks";

export const als = new AsyncLocalStorage();
export const UA = "Mozilla/5.0 (compatible; StockDesk/1.0)";

export function record(name, ok, ms, note) {
  const s = als.getStore();
  if (s && s.health) s.health.push({ name, ok, ms: Math.round(ms), note: note || "" });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostLabel = (url) => { try { const u = new URL(url); return u.hostname.replace(/^(www|query1|query2|api|feeds)\./, "") + u.pathname.split("/").slice(0, 3).join("/"); } catch (e) { return url; } };

// parse: "json" | "text". Retries network errors, 429 and 5xx. 4xx (other than 429) fail at once.
export async function request(url, { label, parse = "json", headers = {}, timeout = 8000, retries = 2, method, body: reqBody } = {}) {
  const name = label || hostLabel(url);
  const t0 = Date.now();
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, { method, body: reqBody, headers: { "User-Agent": UA, Accept: parse === "json" ? "application/json" : "*/*", ...headers }, signal: ctl.signal });
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error("HTTP " + res.status), { retry: true });
      if (!res.ok) throw Object.assign(new Error("HTTP " + res.status), { retry: false });
      const body = parse === "json" ? await res.json() : await res.text();
      record(name, true, Date.now() - t0);
      return body;
    } catch (e) {
      lastErr = e;
      const retryable = e.retry !== false; // network errors and aborts are retryable
      if (!retryable || i === retries) break;
      await sleep(250 * 2 ** i);
    } finally { clearTimeout(timer); }
  }
  record(name, false, Date.now() - t0, String(lastErr && lastErr.message || lastErr).slice(0, 80));
  throw lastErr;
}

export const getJson = (url, opts = {}) => request(url, { ...opts, parse: "json" });
export const getText = (url, opts = {}) => request(url, { ...opts, parse: "text" });
