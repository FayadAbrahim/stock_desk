import test from "node:test";
import assert from "node:assert/strict";
import { technicals, buildLevels, score, verdictOf, validateRows, fetchKadoa, analyze } from "../lib/analyze.js";
import { parseRss, dedupe } from "../lib/rss.js";
import { buildDays, matchWatch, etDate, addDays } from "../lib/calendar.js";
import { cached, clearCache, rateLimit } from "../lib/cache.js";

const mk = (n, f) => Array.from({ length: n }, (_, i) => { const c = f(i); return { t: 1e9 + i * 86400, c, h: c * 1.01, l: c * 0.99, v: 1e6 }; });

test("RSI is 100 on a steady rise and mid-range on a zig-zag", () => {
  assert.equal(Math.round(technicals(mk(60, (i) => 10 + i), 70).rsi), 100);
  const z = technicals(mk(60, (i) => 50 + (i % 2)), 50).rsi;
  assert.ok(z > 40 && z < 60, "zigzag rsi " + z);
});
test("moving averages are right", () => {
  const t = technicals(mk(210, () => 20), 20);
  assert.equal(t.sma50, 20); assert.equal(t.sma200, 20);
});
test("bad price history is rejected", () => {
  assert.throws(() => validateRows(mk(10, () => 5)), /Not enough/);
  assert.equal(validateRows([...mk(40, () => 5), { c: -1, h: 1, l: 2, v: 0 }]).length, 40);
});
test("verdict bands", () => {
  assert.deepEqual([10, 6, 5.9, 3, 2.9, -2.9, -3, -5.9, -6].map(verdictOf),
    ["Strong Buy", "Strong Buy", "Buy", "Buy", "Hold / Neutral", "Hold / Neutral", "Sell", "Sell", "Strong Sell"]);
});
test("levels: supports below price, resistances above, stop under entry", () => {
  const rows = mk(260, (i) => 30 + 5 * Math.sin(i / 12));
  const tc = technicals(rows, rows[rows.length - 1].c);
  const lv = buildLevels(tc);
  lv.levels.filter((l) => l.kind === "support").forEach((l) => assert.ok(l.price < tc.price));
  lv.levels.filter((l) => l.kind === "resistance").forEach((l) => assert.ok(l.price > tc.price));
  const e = lv.levels.find((l) => l.kind === "entry"), s = lv.levels.find((l) => l.kind === "stop");
  if (e) assert.ok(s.price < e.price);
});
test("score stays within -10..10 and handles missing data", () => {
  const rows = mk(260, (i) => 20 + i * 0.1);
  const r = score({ tc: technicals(rows, 46), fund: null, opt: null, congress: [] });
  assert.ok(r.total >= -10 && r.total <= 10);
  assert.equal(r.scores.length, 7);
});
test("RSS parser reads items, strips CDATA and dedupes", () => {
  const xml = `<rss><channel><item><title><![CDATA[Fed holds rates &amp; signals cuts]]></title><link>https://a.com/1</link><pubDate>Mon, 05 Oct 2026 14:00:00 GMT</pubDate></item>
  <item><title>Fed holds rates and signals cuts</title><link>https://b.com/2</link></item><item><title>Bad link</title><link>nope</link></item></channel></rss>`;
  const items = parseRss(xml, "X");
  assert.equal(items.length, 2); assert.equal(items[0].title, "Fed holds rates & signals cuts");
  assert.equal(dedupe(items).length, 1);
});
test("calendar: FOMC day, Thursday claims, impact ordering", () => {
  assert.equal(matchWatch("Consumer Price Index").name, "CPI (inflation)");
  assert.equal(matchWatch("Some Obscure Release"), undefined);
  const start = "2026-10-26"; // Monday
  const econ = [{ date: "2026-10-28", name: "Jobless claims x", time: "8:30 AM", impact: "low", why: "", source: "t" }, { date: "2026-10-28", name: "CPI (inflation)", time: "8:30 AM", impact: "high", why: "", source: "t" }];
  const days = buildDays(start, 7, econ, [{ date: "2026-10-27", symbol: "BIG", size: 9, when: "x" }, { date: "2026-10-27", symbol: "SMALL", size: 1, when: "x" }]);
  assert.equal(days.length, 7);
  assert.ok(days[2].economic.some((e) => /FOMC/.test(e.name)), "FOMC on Oct 28");
  assert.equal(days[2].economic[0].impact, "high");
  assert.equal(days[1].earnings[0].symbol, "BIG");
  assert.ok(days[3].economic.some((e) => /claims/i.test(e.name)), "Thursday claims added");
  assert.ok(days[5].weekend && days[6].weekend);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.match(etDate(), /^\d{4}-\d{2}-\d{2}$/);
});
test("cache serves stale data when the source fails, rate limit blocks bursts", async () => {
  clearCache();
  assert.equal((await cached("k", 0, async () => 1)).value, 1);
  const r = await cached("k", 0, async () => { throw new Error("down"); });
  assert.equal(r.value, 1); assert.equal(r.stale, true);
  await assert.rejects(cached("none", 0, async () => { throw new Error("down"); }));
  for (let i = 0; i < 5; i++) assert.ok(rateLimit("1.1.1.1", 5));
  assert.equal(rateLimit("1.1.1.1", 5), false);
});
test("Kadoa page parser pulls Congress and President rows", async () => {
  const html = `<table><tr><td>Nancy Pelosi D House Purchase Jul 24, 2026 $250,001 - $500,000</td></tr>
  <tr><td>Donald J Trump OGE Sale (Full) May 18, 2026 $15,001 - $50,000</td></tr></table>`;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(html, { status: 200 });
  try {
    const { rows } = await fetchKadoa("INTC");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].side, "Buy"); assert.equal(rows[1].chamber, "President (OGE)"); assert.equal(rows[1].side, "Sell");
  } finally { globalThis.fetch = orig; }
});

// Whole-pipeline behaviour with a fake network.
const csv = "Date,Open,High,Low,Close,Volume\n" + Array.from({ length: 80 }, (_, i) => { const d = new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10); const c = 30 + i * 0.05; return `${d},${c},${c + 0.4},${c - 0.4},${c},1000000`; }).join("\n");
test("falls back to Stooq when Yahoo is down and says so", async () => {
  clearCache();
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => String(u).includes("stooq.com") ? new Response(csv, { status: 200 }) : new Response("err", { status: 404 });
  try {
    const r = await analyze("ZZZ", {});
    assert.match(r.priceSource, /Stooq/);
    assert.ok(r.warnings.some((w) => /Yahoo/.test(w)));
    assert.ok(r.missing.length >= 3, "missing sections are listed");
    assert.ok(r.health.some((h) => !h.ok) && r.health.some((h) => h.ok));
    assert.equal(r.confidence, "Low");
  } finally { globalThis.fetch = orig; }
});
test("warns when two price sources disagree", async () => {
  clearCache();
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => {
    u = String(u);
    if (u.includes("stooq.com")) return new Response(csv, { status: 200 });
    if (u.includes("finnhub.io/api/v1/quote")) return new Response(JSON.stringify({ c: 45, t: Math.floor(Date.now() / 1000), pc: 33 }), { status: 200 });
    return new Response("err", { status: 404 });
  };
  try {
    const r = await analyze("QQQQ", { FINNHUB_KEY: "x" });
    assert.ok(r.warnings.some((w) => /disagree/.test(w)), JSON.stringify(r.warnings));
  } finally { globalThis.fetch = orig; }
});
test("unknown or invalid tickers give a clear error", async () => {
  clearCache();
  await assert.rejects(analyze("!!!", {}), /valid ticker/);
  const orig = globalThis.fetch; globalThis.fetch = async () => new Response("no", { status: 404 });
  try { await assert.rejects(analyze("NOPE", {}), /No price data/); } finally { globalThis.fetch = orig; }
});
