// Offline sample data so the pipeline and UI can be tested without network or keys.
export function chart(t) {
  const rows = []; let p = 30, seed = [...t].reduce((a, c) => a + c.charCodeAt(0), 7);
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const start = Math.floor(Date.now() / 1000) - 260 * 86400;
  for (let i = 0; i < 252; i++) { p *= 1 + (rnd() - 0.49) * 0.03; const h = p * (1 + rnd() * 0.012), l = p * (1 - rnd() * 0.012); rows.push({ t: start + i * 86400, c: p, h, l, v: 1e6 + rnd() * 5e5 }); }
  return { meta: { regularMarketPrice: rows[rows.length - 1].c, regularMarketTime: Math.floor(Date.now() / 1000), longName: t + " (sample data)" }, rows };
}
export const fund = async () => ({ errors: [], profile: { name: "Sample Co" }, metric: { metric: { peTTM: 31, pegTTM: 1.8, psTTM: 4.2, netProfitMarginTTM: 12.4, revenueGrowthTTMYoy: 7.1, beta: 1.2 } },
  rec: [{ strongBuy: 6, buy: 18, hold: 14, sell: 1, strongSell: 0 }], target: { targetMean: 38, targetHigh: 50, targetLow: 28 },
  insiders: { data: [{ transactionCode: "P", change: 5000, transactionPrice: 30 }, { transactionCode: "S", change: -2000, transactionPrice: 33 }] },
  earnings: { earningsCalendar: [{ date: "2026-10-29" }] } });
export const opt = async () => ({ cv: 42000, pv: 26000, coi: 300000, poi: 250000, pcVol: 0.62, pcOi: 0.83, expiries: 3, unusual: [{ side: "call", strike: 35, exp: "2026-11-20", vol: 3200, oi: 600, iv: 0.5 }] });
export const congress = async () => ([{ who: "Sample Member", party: "D", chamber: "House", side: "Buy", date: new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10), amount: "$15,001 - $50,000" }, { who: "Donald J Trump", chamber: "President (OGE)", side: "Sell", date: new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10), amount: "$15K-50K" }]);
