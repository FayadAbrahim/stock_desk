// Lightweight live quote. Finnhub first (real-time US trades on the free plan), Yahoo as backup.
import { getJson } from "./http.js";
import { cached } from "./cache.js";

const clean = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 8);
const ok = (x) => typeof x === "number" && isFinite(x) && x > 0;

async function finnhubQuote(t, key) {
  const q = await getJson(`https://finnhub.io/api/v1/quote?symbol=${t}&token=${key}`, { label: "Finnhub quote", retries: 1, timeout: 4000 });
  if (!ok(q.c)) throw new Error("no quote");
  return { price: q.c, prevClose: ok(q.pc) ? q.pc : null, ts: q.t ? q.t * 1000 : Date.now(), source: "Finnhub" };
}
async function yahooQuote(t) {
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=1d&interval=1m`, { label: "Yahoo quote", retries: 1, timeout: 4000 });
  const m = j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
  if (!m || !ok(m.regularMarketPrice)) throw new Error("no quote");
  return { price: m.regularMarketPrice, prevClose: ok(m.chartPreviousClose) ? m.chartPreviousClose : ok(m.previousClose) ? m.previousClose : null, ts: (m.regularMarketTime || Math.floor(Date.now() / 1000)) * 1000, source: "Yahoo" };
}

export async function quote(rawTicker, env = process.env) {
  const t = clean(rawTicker);
  if (!t || !/^[A-Z]/.test(t)) throw new Error("Enter a valid ticker, like CMG.");
  if (env.MOCK === "1") {
    const base = 30 + ([...t].reduce((a, c) => a + c.charCodeAt(0), 0) % 50);
    const price = Math.round((base + Math.sin(Date.now() / 4000) * 0.6) * 100) / 100;
    return { ticker: t, price, prevClose: base, change: Math.round((price - base) * 100) / 100, changePct: Math.round(((price / base - 1) * 100) * 100) / 100, ts: Date.now(), source: "sample", stale: false };
  }
  const run = async () => {
    const tries = [];
    if (env.FINNHUB_KEY) tries.push(() => finnhubQuote(t, env.FINNHUB_KEY));
    tries.push(() => yahooQuote(t));
    let last;
    for (const f of tries) { try { return await f(); } catch (e) { last = e; } }
    throw last || new Error("No quote for " + t);
  };
  const r = await cached("q:" + t, 3000, run, 60e3);
  const v = r.value;
  const change = v.prevClose ? Math.round((v.price - v.prevClose) * 100) / 100 : null;
  return { ticker: t, price: v.price, prevClose: v.prevClose, change, changePct: v.prevClose ? Math.round((v.price / v.prevClose - 1) * 10000) / 100 : null, ts: v.ts, source: v.source, stale: r.stale };
}
