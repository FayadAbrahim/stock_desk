// Turns a ticker into a full report. No AI involved: live data + a fixed scoring rubric.
// Every data source is optional. If one fails, the report lists it under "missing" and lowers confidence.

import { getJson, getText, record, als, UA } from "./http.js";
import { cached } from "./cache.js";
import { parseRss, dedupe } from "./rss.js";

const num = (x) => (typeof x === "number" && isFinite(x) ? x : null);
const r2 = (x) => Math.round(x * 100) / 100;

/* ---------- price history, technicals ---------- */
export function validateRows(rows) {
  const ok = rows.filter((r) => r.c > 0 && r.h >= r.l && r.h > 0 && r.l > 0);
  if (ok.length < 30) throw new Error("Not enough price history (" + ok.length + " days)");
  return ok;
}
export async function fetchChart(t) {
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=1y&interval=1d`, { label: "Yahoo price" });
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.timestamp) throw new Error("No price data for " + t);
  const q = res.indicators.quote[0];
  const rows = [];
  res.timestamp.forEach((ts, i) => {
    if ([q.close[i], q.high[i], q.low[i]].every((v) => num(v) != null)) rows.push({ t: ts, c: q.close[i], h: q.high[i], l: q.low[i], v: q.volume[i] || 0 });
  });
  return { meta: res.meta, rows: validateRows(rows), source: "Yahoo Finance", delayed: false };
}
// Fallback: Stooq daily CSV. End-of-day only, so the price is the last close, not live.
export async function fetchStooq(t) {
  const sym = t.toLowerCase().replace(/\./g, "-") + ".us";
  const csv = await getText(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=d`, { label: "Stooq price" });
  const lines = csv.trim().split("\n").slice(1);
  const rows = lines.map((l) => l.split(",")).filter((p) => p.length >= 5 && !isNaN(+p[4]))
    .map((p) => ({ t: Math.floor(Date.parse(p[0] + "T21:00:00Z") / 1000), h: +p[2], l: +p[3], c: +p[4], v: +p[5] || 0 })).slice(-260);
  if (!rows.length) throw new Error("No price data for " + t);
  const last = rows[rows.length - 1];
  return { meta: { regularMarketPrice: last.c, regularMarketTime: last.t, longName: t }, rows: validateRows(rows), source: "Stooq (daily close)", delayed: true };
}
export async function fetchQuoteFH(t, key) {
  const q = await getJson(`https://finnhub.io/api/v1/quote?symbol=${t}&token=${key}`, { label: "Finnhub quote" });
  if (!num(q.c) || q.c <= 0) throw new Error("no quote");
  return { price: q.c, ts: q.t ? q.t * 1000 : Date.now(), prevClose: q.pc, changePct: q.dp };
}

const sma = (a, n) => (a.length >= n ? a.slice(-n).reduce((s, x) => s + x, 0) / n : null);
function rsi(closes, n = 14) {
  if (closes.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; d >= 0 ? (g += d) : (l -= d); }
  g /= n; l /= n;
  for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function atr(rows, n = 14) {
  if (rows.length <= n) return null;
  const tr = rows.slice(1).map((r, i) => Math.max(r.h - r.l, Math.abs(r.h - rows[i].c), Math.abs(r.l - rows[i].c)));
  return tr.slice(-n).reduce((s, x) => s + x, 0) / n;
}
function swings(rows, look = 5) {
  const hi = [], lo = [];
  for (let i = look; i < rows.length - look; i++) {
    const w = rows.slice(i - look, i + look + 1);
    if (rows[i].h === Math.max(...w.map((x) => x.h))) hi.push(rows[i].h);
    if (rows[i].l === Math.min(...w.map((x) => x.l))) lo.push(rows[i].l);
  }
  return { hi, lo };
}

export function technicals(rows, livePrice) {
  const closes = rows.map((r) => r.c);
  const price = num(livePrice) ?? closes[closes.length - 1];
  const sw = swings(rows.slice(-130));
  const vols = rows.slice(-21, -1).map((r) => r.v);
  const avgVol = vols.length ? vols.reduce((s, x) => s + x, 0) / vols.length : null;
  return {
    price,
    sma20: sma(closes, 20), sma50: sma(closes, 50), sma200: sma(closes, 200),
    rsi: rsi(closes), atr: atr(rows),
    hi52: Math.max(...rows.map((r) => r.h)), lo52: Math.min(...rows.map((r) => r.l)),
    avgVol, lastVol: rows[rows.length - 1].v,
    swingHi: sw.hi, swingLo: sw.lo,
  };
}

/* ---------- key levels ---------- */
export function buildLevels(tc) {
  const p = tc.price, a = tc.atr || p * 0.03;
  const near = (arr, below) => {
    const xs = arr.filter((x) => (below ? x < p * 0.995 : x > p * 1.005)).sort((x, y) => (below ? y - x : x - y));
    const out = [];
    xs.forEach((x) => { if (!out.length || Math.abs(x - out[out.length - 1]) / p > 0.015) out.push(x); });
    return out;
  };
  const sup = near([...tc.swingLo, tc.sma50, tc.sma200, tc.lo52].filter((x) => num(x) != null), true).slice(0, 3);
  const res = near([...tc.swingHi, tc.sma50, tc.sma200, tc.hi52].filter((x) => num(x) != null), false).slice(0, 3);
  const levels = [];
  const label = (x) => (Math.abs(x - tc.sma200) / x < 0.01 ? "200-day average" : Math.abs(x - tc.sma50) / x < 0.01 ? "50-day average" : Math.abs(x - tc.hi52) / x < 0.005 ? "52-week high" : Math.abs(x - tc.lo52) / x < 0.005 ? "52-week low" : "recent swing level");
  sup.forEach((x, i) => levels.push({ kind: "support", tag: "Support " + (i + 1), price: r2(x), why: "Buyers stepped in here before (" + label(x) + ")." }));
  res.forEach((x, i) => levels.push({ kind: "resistance", tag: "Resistance " + (i + 1), price: r2(x), why: "Sellers showed up here before (" + label(x) + ")." }));
  let entry = null, stop = null;
  if (sup.length) {
    const s1 = sup[0];
    levels.push({ kind: "entry", tag: "Entry zone", price: r2(s1), price2: r2(s1 + 0.5 * a), why: "Pullback buy area just above the first support." });
    stop = r2(s1 - a);
    levels.push({ kind: "stop", tag: "Stop", price: stop, why: "One ATR (typical daily range) under support. Below this the setup is broken." });
    entry = `Buy a pullback into ${r2(s1)}–${r2(s1 + 0.5 * a)} rather than chasing ${r2(p)}.`;
  }
  const targets = res.slice(0, 2).map((x, i) => `T${i + 1} ${r2(x)}`);
  return {
    levels, entry,
    stop: stop ? `${stop}. Close under it means the thesis is wrong.` : null,
    targets,
    ifBreaks: sup[0] ? `A close below ${r2(sup[0])} opens ${sup[1] ? r2(sup[1]) : r2(tc.lo52)} next.` : null,
  };
}

/* ---------- Finnhub ---------- */
async function finnhub(path, key) {
  return getJson(`https://finnhub.io/api/v1${path}${path.includes("?") ? "&" : "?"}token=${key}`, { label: "Finnhub " + path.split("?")[0].replace("/stock/", "").replace("/calendar/", "") });
}
export async function fetchFundamentals(t, key) {
  const out = { errors: [] };
  const from = new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10), to = new Date().toISOString().slice(0, 10);
  const jobs = {
    profile: `/stock/profile2?symbol=${t}`,
    metric: `/stock/metric?symbol=${t}&metric=all`,
    rec: `/stock/recommendation?symbol=${t}`,
    target: `/stock/price-target?symbol=${t}`,
    insiders: `/stock/insider-transactions?symbol=${t}&from=${from}&to=${to}`,
    earnings: `/calendar/earnings?symbol=${t}&from=${to}&to=${new Date(Date.now() + 120 * 864e5).toISOString().slice(0, 10)}`,
  };
  await Promise.all(Object.entries(jobs).map(async ([k, p]) => {
    try { out[k] = await finnhub(p, key); } catch (e) { out.errors.push(k); }
  }));
  return out;
}

/* ---------- options (Yahoo, needs a cookie + crumb) ---------- */
async function yahooSession() {
  const t0 = Date.now();
  try {
    const r = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA }, redirect: "manual" });
    const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie") || ""]).map((c) => c.split(";")[0]).join("; ");
    const crumb = await (await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, Cookie: cookie } })).text();
    if (!crumb || crumb.includes("<") || crumb.length > 40) throw new Error("no crumb");
    record("Yahoo session", true, Date.now() - t0);
    return { cookie, crumb };
  } catch (e) { record("Yahoo session", false, Date.now() - t0, String(e.message || e)); throw e; }
}
export async function fetchOptions(t) {
  const s = await yahooSession();
  const h = { Cookie: s.cookie };
  const first = await getJson(`https://query1.finance.yahoo.com/v7/finance/options/${t}?crumb=${encodeURIComponent(s.crumb)}`, { headers: h, label: "Yahoo options" });
  const root = first.optionChain.result[0];
  const dates = (root.expirationDates || []).slice(0, 3);
  const chains = [root.options[0]];
  for (const d of dates.slice(1)) {
    try { chains.push((await getJson(`https://query1.finance.yahoo.com/v7/finance/options/${t}?date=${d}&crumb=${encodeURIComponent(s.crumb)}`, { headers: h })).optionChain.result[0].options[0]); } catch (e) {}
  }
  let cv = 0, pv = 0, coi = 0, poi = 0;
  const unusual = [];
  chains.forEach((c) => {
    [["call", c.calls], ["put", c.puts]].forEach(([side, list]) => (list || []).forEach((o) => {
      const v = o.volume || 0, oi = o.openInterest || 0;
      side === "call" ? ((cv += v), (coi += oi)) : ((pv += v), (poi += oi));
      if (v >= 500 && oi > 0 && v / oi >= 3) unusual.push({ side, strike: o.strike, exp: new Date(o.expiration * 1000).toISOString().slice(0, 10), vol: v, oi, iv: o.impliedVolatility });
    }));
  });
  unusual.sort((a, b) => b.vol - a.vol);
  return { cv, pv, coi, poi, pcVol: cv ? pv / cv : null, pcOi: coi ? poi / coi : null, unusual: unusual.slice(0, 5), expiries: chains.length };
}

/* ---------- Congress (FMP) and president (best effort) ---------- */
export async function fetchCongress(t, key) {
  const rows = [];
  for (const [chamber, ep] of [["Senate", "senate-trades"], ["House", "house-trades"]]) {
    try {
      const j = await getJson(`https://financialmodelingprep.com/stable/${ep}?symbol=${t}&apikey=${key}`, { label: "FMP " + ep });
      (Array.isArray(j) ? j : []).forEach((x) => rows.push({
        who: [x.firstName, x.lastName].filter(Boolean).join(" ") || x.representative || "Unknown",
        party: x.party || undefined, chamber,
        side: /sale|sell/i.test(x.type || "") ? "Sell" : "Buy",
        date: (x.transactionDate || "").slice(0, 10), filed: (x.disclosureDate || "").slice(0, 10), amount: x.amount || "",
      }));
    } catch (e) {}
  }
  return rows;
}
// Reads Kadoa's per-ticker page, which lists Congress and President (OGE) trades. Layout can change, so this is wrapped in try/catch by the caller.
export async function fetchKadoa(t) {
  const html = await getText(`https://www.kadoa.com/congress/ticker/${t}`, { label: "Kadoa trades" });
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<\/(tr|li|div)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ");
  const rows = [];
  text.split("\n").forEach((line) => {
    const m = line.match(/([A-Z][A-Za-z.'\- ]{3,40}?)\s+(?:(?:R|D|I)\s+)?(House|Senate|OGE|Executive)\s+(Purchase|Buy|Sale(?: \((?:Full|Partial)\))?|Sell)\s+(\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2} \d{1,2}, \d{4})[\s\S]*?(\$[\d,K]+\s*[-–]\s*\$[\d,KM]+)/);
    if (m) rows.push({ who: m[1].trim(), chamber: /OGE|Executive/.test(m[2]) ? "President (OGE)" : m[2], side: /sale|sell/i.test(m[3]) ? "Sell" : "Buy", date: new Date(m[4]).toISOString().slice(0, 10), amount: m[5] });
  });
  const summary = text.match(/(\d+)\s+filers?[\s\S]{0,60}?(\d+)\s+buys?[\s\S]{0,20}?(\d+)\s+sells?/i);
  return { rows, summary };
}

/* ---------- scoring ---------- */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export function score(ctx) {
  const { tc, fund, opt, congress } = ctx;
  const s = [];
  const add = (label, v, note) => s.push({ label, score: clamp(Math.round(v), -2, 2), note });

  // 1 trend
  let tr = 0; const tn = [];
  if (tc.sma50 != null) { tc.price > tc.sma50 ? tr++ : tr--; tn.push(tc.price > tc.sma50 ? "above 50-day" : "below 50-day"); }
  if (tc.sma200 != null) { tc.price > tc.sma200 ? tr++ : tr--; tn.push(tc.price > tc.sma200 ? "above 200-day" : "below 200-day"); }
  add("Trend", tr, tn.join(", ") || "not enough history");
  // 2 momentum / stretch
  let mo = 0, mn = "RSI n/a";
  if (tc.rsi != null) { mn = "RSI " + tc.rsi.toFixed(0); mo = tc.rsi >= 70 ? -1 : tc.rsi <= 30 ? 1 : tc.rsi > 55 ? 1 : tc.rsi < 45 ? -1 : 0; if (tc.rsi >= 70) mn += ", overbought"; else if (tc.rsi <= 30) mn += ", oversold bounce setup"; }
  add("Momentum", mo, mn);
  // 3 valuation
  const m = fund && fund.metric && fund.metric.metric ? fund.metric.metric : {};
  const pe = num(m.peTTM) ?? num(m.peNormalizedAnnual), peg = num(m.pegTTM ?? m.pegRatio);
  let va = 0, vn = "no valuation data";
  if (pe != null) { vn = "P/E " + pe.toFixed(1); va = pe < 0 ? -2 : pe < 15 ? 2 : pe < 25 ? 1 : pe < 40 ? 0 : pe < 60 ? -1 : -2; }
  if (peg != null && peg > 0) { vn += ", PEG " + peg.toFixed(1); va += peg < 1 ? 1 : peg > 3 ? -1 : 0; }
  add("Valuation", va, vn);
  // 4 analysts
  let an = 0, ann = "no analyst data";
  const rec = fund && Array.isArray(fund.rec) && fund.rec[0];
  if (rec) {
    const b = (rec.strongBuy || 0) * 2 + (rec.buy || 0), sl = (rec.strongSell || 0) * 2 + (rec.sell || 0), tot = b + sl + (rec.hold || 0);
    const net = tot ? (b - sl) / tot : 0;
    an = net > 0.6 ? 2 : net > 0.25 ? 1 : net < -0.25 ? -1 : 0;
    ann = `${(rec.strongBuy || 0) + (rec.buy || 0)} buy / ${rec.hold || 0} hold / ${(rec.sell || 0) + (rec.strongSell || 0)} sell`;
  }
  const tg = fund && fund.target && num(fund.target.targetMean);
  if (tg) { const up = tg / tc.price - 1; an += up > 0.2 ? 1 : up < -0.05 ? -1 : 0; ann += `, target ${r2(tg)} (${(up * 100).toFixed(0)}%)`; }
  add("Analysts", an, ann);
  // 5 insiders (open-market buys vs sells, last 6 months)
  let ins = 0, inn = "no insider data";
  if (fund && fund.insiders && Array.isArray(fund.insiders.data)) {
    let buy = 0, sell = 0;
    fund.insiders.data.forEach((x) => { const v = Math.abs((x.change || 0) * (x.transactionPrice || 0)); if (x.transactionCode === "P") buy += v; if (x.transactionCode === "S") sell += v; });
    const f = (n) => "$" + (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : (n / 1e3).toFixed(0) + "K");
    inn = `bought ${f(buy)}, sold ${f(sell)} (6 mo)`;
    ins = buy > sell * 1.5 && buy > 50000 ? 2 : buy > sell ? 1 : sell > buy * 5 && sell > 5e6 ? -1 : 0;
    ctx.insiderLines = [`Insiders (Form 4, 6 months): bought ${f(buy)}, sold ${f(sell)}. Routine pre-planned selling is common and weighs less than open-market buying.`];
  }
  add("Insiders", ins, inn);
  // 6 options
  let op = 0, on = "no options data";
  if (opt && opt.pcVol != null) {
    on = `put/call volume ${opt.pcVol.toFixed(2)}`;
    op = opt.pcVol < 0.5 ? 1 : opt.pcVol > 1.2 ? -1 : 0;
    if (opt.pcVol < 0.35) op = 2; if (opt.pcVol > 1.8) op = -2;
  }
  add("Options flow", op, on);
  // 7 congress + president, last 120 days by trade date
  let cg = 0, cn = "no disclosures found";
  if (congress && congress.length) {
    const cut = Date.now() - 120 * 864e5;
    const rec = congress.filter((x) => x.date && Date.parse(x.date) >= cut);
    const b = rec.filter((x) => x.side === "Buy").length, sl = rec.length - b;
    cn = `${b} buys / ${sl} sells in 120 days`;
    cg = b - sl >= 3 ? 2 : b > sl ? 1 : sl - b >= 3 ? -2 : sl > b ? -1 : 0;
  }
  add("Congress and president", cg, cn);

  const raw = s.reduce((x, y) => x + y.score, 0);
  const total = Math.round((raw / (s.length * 2)) * 10 * 10) / 10;
  return { scores: s, total };
}

export const verdictOf = (x) => (x >= 6 ? "Strong Buy" : x >= 3 ? "Buy" : x > -3 ? "Hold / Neutral" : x > -6 ? "Sell" : "Strong Sell");

/* ---------- news for one ticker ---------- */
export async function fetchTickerNews(t, key) {
  const items = [];
  await Promise.all([
    (async () => { items.push(...parseRss(await getText(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${t}&region=US&lang=en-US`, { label: "Yahoo news" }), "Yahoo Finance")); })().catch(() => {}),
    (async () => {
      if (!key) return;
      const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
      const j = await getJson(`https://finnhub.io/api/v1/company-news?symbol=${t}&from=${from}&to=${to}&token=${key}`, { label: "Finnhub news" });
      (Array.isArray(j) ? j : []).slice(0, 15).forEach((x) => x.headline && x.url && items.push({ title: x.headline, url: x.url, source: x.source || "Finnhub", ms: x.datetime ? x.datetime * 1000 : null }));
    })().catch(() => {}),
  ]);
  if (!items.length) throw new Error("no headlines");
  return dedupe(items, 8);
}


/* ---------- main ---------- */
export async function analyze(rawTicker, env = process.env) {
  const t = String(rawTicker || "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 8);
  if (!t || !/^[A-Z]/.test(t)) throw new Error("Enter a valid ticker, like CMG.");
  return als.run({ health: [] }, async () => {
    const health = als.getStore().health;
    const missing = [], warnings = [];
    const mock = env.MOCK === "1";
    const M = mock ? await import("./mock.js") : null;
    const fhKey = env.FINNHUB_KEY;

    // 1. Price. Yahoo first, Stooq end-of-day as backup, Finnhub quote as an independent check.
    let chart;
    if (mock) chart = { ...M.chart(t), source: "sample data", delayed: false };
    else {
      try { chart = (await cached("chart:" + t, 20e3, () => fetchChart(t))).value; }
      catch (e1) {
        try { chart = (await cached("chart2:" + t, 120e3, () => fetchStooq(t))).value; warnings.push("Live price source (Yahoo) failed. Showing the last daily close from Stooq."); }
        catch (e2) { throw new Error("No price data found for " + t + ". Check the ticker."); }
      }
    }
    let livePrice = chart.meta.regularMarketPrice;
    if (!mock && fhKey) {
      try {
        const q = (await cached("fhq:" + t, 15e3, () => fetchQuoteFH(t, fhKey))).value;
        const diff = Math.abs(q.price / livePrice - 1);
        if (diff > 0.03) warnings.push(`Price sources disagree: ${r2(livePrice)} (${chart.source}) vs ${r2(q.price)} (Finnhub). Verify before trading.`);
        else if (chart.delayed && q.ts > chart.meta.regularMarketTime * 1000) livePrice = q.price;
      } catch (e) {}
    }
    if (!(livePrice > 0)) throw new Error("Bad price returned for " + t);
    const tc = technicals(chart.rows, livePrice);
    const asOfMs = chart.meta.regularMarketTime ? chart.meta.regularMarketTime * 1000 : Date.now();
    if (Date.now() - asOfMs > 4 * 864e5) warnings.push("Last price is more than 4 days old. The stock may be halted or delisted.");
    if (chart.rows.length < 200) warnings.push(`Only ${chart.rows.length} days of history, so the 200-day average is missing or weak.`);

    // 2. Everything else in parallel. Each piece is cached, and a failure only removes that section.
    const wrap = async (name, key, ttl, fn) => {
      try { const r = await cached(key, ttl, fn); if (r.stale) warnings.push(name + " is showing saved data from " + Math.round(r.ageMs / 60000) + " minutes ago (source is down)."); return r.value; }
      catch (e) { missing.push(name + " unavailable (" + String(e.message || e).slice(0, 60) + ")"); return null; }
    };
    const [fund, opt, fmp, kad, news] = await Promise.all([
      mock ? M.fund() : fhKey ? wrap("Analyst, valuation and insider data", "fund:" + t, 10 * 60e3, () => fetchFundamentals(t, fhKey)) : (missing.push("Analyst, valuation and insider data: add FINNHUB_KEY"), null),
      mock ? M.opt() : wrap("Options chain", "opt:" + t, 60e3, () => fetchOptions(t)),
      mock ? M.congress() : env.FMP_KEY ? wrap("House and Senate trades", "fmp:" + t, 60 * 60e3, () => fetchCongress(t, env.FMP_KEY)) : (missing.push("House and Senate trades: add FMP_KEY"), null),
      mock ? { rows: [], summary: null } : wrap("President trades", "kadoa:" + t, 60 * 60e3, () => fetchKadoa(t)),
      mock ? [{ title: "Sample headline for " + t, url: "https://example.com", source: "sample", ms: Date.now() }] : wrap("Headlines", "news:" + t, 5 * 60e3, () => fetchTickerNews(t, fhKey)),
    ]);
    if (fund && fund.errors && fund.errors.length) missing.push("Some Finnhub data not returned: " + fund.errors.join(", ") + " (some are paid endpoints)");

    const all = [...(fmp || []), ...((kad && kad.rows) || [])];
    const seen = new Set();
    const trades = all.filter((x) => { if (!x.date || isNaN(Date.parse(x.date))) return false; const k = [x.who.toLowerCase(), x.side, x.date, x.amount].join("|"); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 25);
    if (!trades.length && !missing.some((m) => /trades/.test(m))) missing.push("No Congress or president trades found for this ticker");

    const ctx = { tc, fund, opt, congress: trades };
    const sc = score(ctx);
    const lv = buildLevels(tc);
    const m = fund && fund.metric && fund.metric.metric ? fund.metric.metric : {};

    const investors = [...(ctx.insiderLines || [])];
    investors.push("Big funds (13F): not pulled automatically. Check the SEC link under Sources.");
    const options = [];
    if (opt) {
      options.push(`Call volume ${opt.cv.toLocaleString()} vs put volume ${opt.pv.toLocaleString()} across the next ${opt.expiries} expiries (put/call ${opt.pcVol != null ? opt.pcVol.toFixed(2) : "n/a"}).`);
      options.push(`Open interest: calls ${opt.coi.toLocaleString()}, puts ${opt.poi.toLocaleString()}.`);
      opt.unusual.forEach((u) => options.push(`Unusual: ${u.vol.toLocaleString()} ${u.side}s at ${u.strike} (${u.exp}), ${(u.vol / u.oi).toFixed(1)}x open interest.`));
      options.push("Volume does not say whether trades were bought or sold, and Yahoo options data can be delayed. Treat flow as a clue, not proof.");
    }
    const valuation = [];
    const f1 = (x, s = "") => (num(x) != null ? x.toFixed(1) + s : null);
    [["P/E (TTM)", f1(m.peTTM)], ["Price/sales (TTM)", f1(m.psTTM)], ["PEG", f1(m.pegTTM ?? m.pegRatio)], ["Net margin", f1(m.netProfitMarginTTM, "%")], ["Revenue growth (YoY)", f1(m.revenueGrowthTTMYoy, "%")], ["Debt/equity", f1(m.totalDebt_totalEquityAnnual ?? m["totalDebt/totalEquityAnnual"])]]
      .forEach(([k, v]) => v && valuation.push(`${k}: ${v}`));
    if (fund && fund.target && num(fund.target.targetMean)) valuation.push(`Analyst mean target ${r2(fund.target.targetMean)} (high ${r2(fund.target.targetHigh)}, low ${r2(fund.target.targetLow)})`);

    const up = sc.total;
    const why = sc.scores.filter((x) => x.score !== 0).sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 4).map((x) => `${x.label}: ${x.note}.`);
    const nextEarn = fund && fund.earnings && fund.earnings.earningsCalendar && fund.earnings.earningsCalendar[0];
    const risks = [];
    if (tc.rsi != null && tc.rsi > 70) risks.push("Stretched: RSI above 70, pullbacks are common from here.");
    if (nextEarn) risks.push(`Earnings ${nextEarn.date}. Options and price can gap either way.`);
    if (tc.atr) risks.push(`Typical daily range is about ${r2(tc.atr)} (${((tc.atr / tc.price) * 100).toFixed(1)}%). Size positions to that.`);
    if (m["beta"]) risks.push(`Beta ${r2(m.beta)}: moves ${m.beta > 1 ? "more" : "less"} than the market.`);

    const srcs = [
      { title: "Price history and options: Yahoo Finance", url: `https://finance.yahoo.com/quote/${t}` },
      { title: "Fundamentals, analysts, insiders: Finnhub", url: `https://finnhub.io/` },
      { title: "Congress and president trades: Kadoa", url: `https://www.kadoa.com/congress/ticker/${t}` },
      { title: "Congress trades: Capitol Trades", url: `https://www.capitoltrades.com/trades?search=${t}` },
      { title: "Big fund holders (13F) on SEC EDGAR", url: `https://www.sec.gov/edgar/search/#/q=${t}&forms=13F-HR` },
    ];

    const b = trades.filter((x) => x.side === "Buy").length;
    // Confidence reflects how many of the 7 score inputs had real data, minus warnings.
    const real = sc.scores.filter((x) => !/no .*data|not enough|no disclosures/i.test(x.note)).length;
    const confPts = real - warnings.length;
    return {
      ticker: t,
      company: (fund && fund.profile && fund.profile.name) || chart.meta.longName || chart.meta.shortName || t,
      price: r2(tc.price), asOf: new Date(asOfMs).toISOString(), asOfMs,
      verdict: verdictOf(up), score: up,
      confidence: confPts >= 6 ? "High" : confPts >= 4 ? "Medium" : "Low",
      scores: sc.scores, why, investors, options, valuation,
      levels: lv.levels, entry: lv.entry, stop: lv.stop, targets: lv.targets, ifBreaks: lv.ifBreaks,
      catalyst: nextEarn ? `Earnings ${nextEarn.date}` : "",
      risks, missing, warnings, sources: srcs, news: news || [],
      health: health.slice(0, 40),
      priceSource: chart.source,
      congress: { buys: b, sells: trades.length - b, verdict: trades.length ? (b > trades.length - b ? "Net buying" : b < trades.length - b ? "Net selling" : "Even") : undefined, trades,
        note: "Disclosures are delayed up to about 45 days and amounts are ranges. President rows come from OGE trustee-managed accounts, so they are not necessarily his own picks." },
      generatedMs: Date.now(),
    };
  });
}
