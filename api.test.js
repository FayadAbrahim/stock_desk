import test from "node:test";
import assert from "node:assert/strict";
import { quote } from "../lib/quote.js";
import { parseAlert, checkSecret, saveAlert, listAlerts, clearAlerts } from "../lib/alerts.js";
import { clearCache } from "../lib/cache.js";
import alertApi from "../api/alert.js";
import alertsApi from "../api/alerts.js";
import quoteApi from "../api/quote.js";

function call(handler, { method = "GET", url = "/", query = {}, body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o, headers: this.headers }); } };
    handler({ method, url, query, body, headers }, res);
  });
}
const withFetch = async (fn, impl) => { const o = globalThis.fetch; globalThis.fetch = impl; try { await fn(); } finally { globalThis.fetch = o; } };

test("quote: Finnhub first, computes change, falls back to Yahoo", async () => {
  clearCache();
  await withFetch(async () => {
    const q = await quote("CMG", { FINNHUB_KEY: "k" });
    assert.equal(q.source, "Finnhub"); assert.equal(q.price, 31.1); assert.equal(q.change, 0.6); assert.equal(q.changePct, 1.97);
  }, async (u) => String(u).includes("finnhub") ? new Response(JSON.stringify({ c: 31.1, pc: 30.5, t: 1790000000 }), { status: 200 }) : new Response("x", { status: 500 }));
  clearCache();
  await withFetch(async () => {
    const q = await quote("CMG", { FINNHUB_KEY: "k" });
    assert.equal(q.source, "Yahoo"); assert.equal(q.price, 40.2);
  }, async (u) => String(u).includes("yahoo") ? new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 40.2, chartPreviousClose: 40, regularMarketTime: 1790000000 } }] } }), { status: 200 }) : new Response("x", { status: 403 }));
});
test("quote: serves saved quote marked stale when sources go down, rejects bad tickers", async () => {
  clearCache();
  await withFetch(async () => { await quote("AAA", {}); }, async () => new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 10, regularMarketTime: 1790000000 } }] } }), { status: 200 }));
  await new Promise((r) => setTimeout(r, 3100));
  await withFetch(async () => { const q = await quote("AAA", {}); assert.equal(q.stale, true); assert.equal(q.price, 10); }, async () => new Response("no", { status: 500 }));
  await assert.rejects(quote("123", {}), /valid ticker/);
});
test("quote API returns 400 for a bad ticker and 200 on sample data", async () => {
  assert.equal((await call(quoteApi, { query: { ticker: "$$" } })).code, 400);
  process.env.MOCK = "1";
  try { const r = await call(quoteApi, { query: { ticker: "CMG" } }); assert.equal(r.code, 200); assert.ok(r.body.price > 0); } finally { delete process.env.MOCK; }
});

test("alert parsing: JSON, plain text, exchange prefix, junk", () => {
  assert.deepEqual({ ...parseAlert('{"ticker":"NASDAQ:INTC","price":"41.5","message":"Breakout"}'), ms: 0 }, { ticker: "INTC", price: 41.5, message: "Breakout", ms: 0 });
  const t = parseAlert("CMG crossing 31.50 on the 1H");
  assert.equal(t.ticker, "CMG"); assert.equal(t.price, null);
  assert.equal(parseAlert({ symbol: "aapl", close: 200, text: "<b>hi</b>" }).message.includes("<"), false);
  assert.throws(() => parseAlert(""), /Empty/);
  assert.ok(parseAlert("x".repeat(5000)).message.length <= 300);
});
test("alert secret check: missing config, wrong key, right key", () => {
  assert.equal(checkSecret("a", {}).code, 503);
  assert.equal(checkSecret("bad", { ALERT_SECRET: "s3cret" }).code, 401);
  assert.equal(checkSecret("", { ALERT_SECRET: "s3cret" }).code, 401);
  assert.equal(checkSecret("s3cret", { ALERT_SECRET: "s3cret" }).ok, true);
});
test("alert webhook end to end: rejects wrong key, stores and lists with the right key", async () => {
  clearAlerts(); process.env.ALERT_SECRET = "s3cret";
  try {
    assert.equal((await call(alertApi, { method: "GET" })).code, 405);
    assert.equal((await call(alertApi, { method: "POST", query: { key: "nope" }, body: "x" })).code, 401);
    assert.equal((await call(alertApi, { method: "POST", query: { key: "s3cret" }, body: "" })).code, 400);
    const ok = await call(alertApi, { method: "POST", query: { key: "s3cret" }, body: '{"ticker":"CMG","price":"31.2","message":"Hit entry"}' });
    assert.equal(ok.code, 200);
    const l = await call(alertsApi, {});
    assert.equal(l.body.alerts.length, 1); assert.equal(l.body.alerts[0].ticker, "CMG"); assert.equal(l.body.configured, true);
  } finally { delete process.env.ALERT_SECRET; clearAlerts(); }
});
test("alerts persist to Redis when configured and survive a bad record", async () => {
  const env = { UPSTASH_REDIS_REST_URL: "https://r.example", UPSTASH_REDIS_REST_TOKEN: "t" };
  const calls = [];
  await withFetch(async () => {
    await saveAlert({ ticker: "X", message: "m", ms: 1 }, env);
    const out = await listAlerts(env);
    assert.equal(out.length, 1); assert.equal(out[0].ticker, "X");
  }, async (u, o) => { const cmds = JSON.parse(o.body); calls.push(cmds[0][0]); assert.equal(o.headers.Authorization, "Bearer t");
    return new Response(JSON.stringify(cmds[0][0] === "LRANGE" ? [{ result: [JSON.stringify({ ticker: "X", message: "m", ms: 1 }), "not json"] }] : [{ result: 1 }, { result: "OK" }]), { status: 200 }); });
  assert.deepEqual(calls, ["LPUSH", "LRANGE"]);
});
