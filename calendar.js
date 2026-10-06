// Daily market calendar: economic releases, earnings, and headlines. All times are US Eastern.
import { getJson, getText, als } from "./http.js";
import { cached } from "./cache.js";
import { parseRss, dedupe } from "./rss.js";

// FOMC meeting end dates (decision day, 2:00 pm ET). Source: federalreserve.gov calendar. Re-check yearly.
export const FOMC_2026 = ["2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09"];

// FRED release names we care about, with the usual release time (ET) and a one-line plain-English meaning.
export const WATCH = [
  { re: /^Consumer Price Index/i, name: "CPI (inflation)", time: "8:30 AM", impact: "high", why: "Hotter than expected pushes rate-cut hopes out and hits stocks." },
  { re: /^Employment Situation/i, name: "Jobs report (nonfarm payrolls)", time: "8:30 AM", impact: "high", why: "Strong jobs can mean higher-for-longer rates. Weak jobs raise recession worries." },
  { re: /^Gross Domestic Product/i, name: "GDP", time: "8:30 AM", impact: "high", why: "Size of the economy. Big surprises move the whole market." },
  { re: /^Personal Income and Outlays/i, name: "PCE inflation (Fed's preferred gauge)", time: "8:30 AM", impact: "high", why: "The inflation number the Fed watches most." },
  { re: /^Producer Price Index/i, name: "PPI (wholesale inflation)", time: "8:30 AM", impact: "medium", why: "Early read on what companies pay, feeds into later CPI." },
  { re: /^Advance Monthly Sales for Retail/i, name: "Retail sales", time: "8:30 AM", impact: "medium", why: "Consumer spending. Matters for restaurants, retail and travel names." },
  { re: /^Unemployment Insurance Weekly Claims/i, name: "Jobless claims", time: "8:30 AM", impact: "low", why: "Weekly layoffs check." },
  { re: /^Job Openings and Labor Turnover/i, name: "JOLTS job openings", time: "10:00 AM", impact: "medium", why: "How many open jobs. Cooling openings ease wage pressure." },
  { re: /^New Residential Construction/i, name: "Housing starts", time: "8:30 AM", impact: "low", why: "Homebuilding activity." },
  { re: /^Industrial Production/i, name: "Industrial production", time: "9:15 AM", impact: "low", why: "Factory and utility output." },
  { re: /^Import\/Export Price Indexes/i, name: "Import prices", time: "8:30 AM", impact: "low", why: "Imported inflation." },
  { re: /^Consumer Sentiment|^University of Michigan/i, name: "Michigan consumer sentiment", time: "10:00 AM", impact: "medium", why: "How consumers feel, plus inflation expectations." },
];

const FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
export const etDate = (ms = Date.now()) => FMT.format(new Date(ms)); // YYYY-MM-DD
export function addDays(iso, n) { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const label = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const isWeekday = (iso) => { const g = new Date(iso + "T12:00:00Z").getUTCDay(); return g >= 1 && g <= 5; };

export function matchWatch(name) { return WATCH.find((w) => w.re.test(name)); }

async function fredReleases(from, to, key) {
  const u = `https://api.stlouisfed.org/fred/releases/dates?api_key=${key}&file_type=json&realtime_start=${from}&realtime_end=${to}&include_release_dates_with_no_data=true&limit=1000&order_by=release_date&sort_order=asc`;
  const j = await getJson(u, { label: "FRED calendar" });
  const out = [];
  (j.release_dates || []).forEach((r) => {
    if (r.date < from || r.date > to) return;
    const w = matchWatch(r.release_name || "");
    if (w) out.push({ date: r.date, name: w.name, time: w.time, impact: w.impact, why: w.why, source: "FRED" });
  });
  return out;
}

async function earningsRange(from, to, key) {
  const j = await getJson(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${key}`, { label: "Finnhub earnings" });
  return (j.earningsCalendar || []).filter((e) => e.symbol && e.date && e.revenueEstimate).map((e) => ({
    date: e.date, symbol: e.symbol, when: e.hour === "bmo" ? "Before open" : e.hour === "amc" ? "After close" : e.hour === "dmh" ? "During market" : "Time TBA",
    epsEst: typeof e.epsEstimate === "number" ? e.epsEstimate : null, revEst: e.revenueEstimate, size: e.revenueEstimate,
  }));
}

const FEEDS = [
  ["CNBC", "https://www.cnbc.com/id/100003114/device/rss/rss.html"],
  ["MarketWatch", "https://feeds.content.dowjones.io/public/rss/mw_topstories"],
  ["Yahoo Finance", "https://finance.yahoo.com/news/rssindex"],
];
export async function marketHeadlines() {
  const items = [];
  await Promise.all(FEEDS.map(async ([src, url]) => { try { items.push(...parseRss(await getText(url, { label: src + " news" }), src)); } catch (e) {} }));
  if (!items.length) throw new Error("no headlines");
  return dedupe(items, 20);
}

export function buildDays(startIso, nDays, econ, earn, fomc = FOMC_2026) {
  const days = [];
  for (let i = 0; i < nDays; i++) {
    const date = addDays(startIso, i);
    const e = econ.filter((x) => x.date === date).slice();
    if (fomc.includes(date)) e.push({ date, name: "Fed interest-rate decision (FOMC)", time: "2:00 PM", impact: "high", why: "Rate decision, then the press conference at 2:30 PM. The biggest scheduled market event.", source: "Federal Reserve" });
    if (!econ.some((x) => x.date === date && /claims/i.test(x.name)) && new Date(date + "T12:00:00Z").getUTCDay() === 4)
      e.push({ date, name: "Jobless claims", time: "8:30 AM", impact: "low", why: "Weekly layoffs check.", source: "Weekly schedule" });
    const order = { high: 0, medium: 1, low: 2 };
    e.sort((a, b) => order[a.impact] - order[b.impact] || a.time.localeCompare(b.time));
    const ear = earn.filter((x) => x.date === date).sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 12);
    days.push({ date, label: label(date), weekend: !isWeekday(date), economic: e, earnings: ear });
  }
  return days;
}

export async function calendar(env = process.env, nDays = 7) {
  return als.run({ health: [] }, async () => {
    const health = als.getStore().health;
    const start = etDate(), end = addDays(start, nDays - 1), notes = [];
    let econ = [], earn = [], headlines = [];
    if (env.MOCK === "1") {
      econ = [{ date: start, name: "CPI (inflation)", time: "8:30 AM", impact: "high", why: "Sample.", source: "sample" }];
      earn = [{ date: start, symbol: "SAMP", when: "After close", epsEst: 1.2, revEst: 5e9, size: 5e9 }];
      headlines = [{ title: "Sample market headline", url: "https://example.com", source: "sample", ms: Date.now() }];
    } else {
      const jobs = [];
      if (env.FRED_API_KEY) jobs.push(cached("fred:" + start, 6 * 3600e3, () => fredReleases(start, end, env.FRED_API_KEY)).then((r) => { econ = r.value; if (r.stale) notes.push("Economic calendar is saved data (FRED is down)."); }).catch(() => notes.push("Economic releases unavailable (FRED). Showing the Fed schedule only.")));
      else notes.push("Add FRED_API_KEY (free) for CPI, jobs, GDP and other release dates. Showing the Fed schedule only.");
      if (env.FINNHUB_KEY) jobs.push(cached("earn:" + start, 30 * 60e3, () => earningsRange(start, end, env.FINNHUB_KEY)).then((r) => (earn = r.value)).catch(() => notes.push("Earnings calendar unavailable.")));
      else notes.push("Add FINNHUB_KEY for the earnings calendar.");
      jobs.push(cached("heads", 3 * 60e3, marketHeadlines).then((r) => (headlines = r.value)).catch(() => notes.push("Headlines unavailable right now.")));
      await Promise.all(jobs);
    }
    return { generatedMs: Date.now(), today: start, days: buildDays(start, nDays, econ, earn), headlines, notes, health: health.slice(0, 20),
      caveat: "Release times are the usual schedule in US Eastern time. Confirm on bls.gov, bea.gov and federalreserve.gov before trading around an event." };
  });
}
