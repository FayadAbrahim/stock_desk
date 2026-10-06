// TradingView alert inbox. TradingView POSTs to /api/alert?key=SECRET; the page reads /api/alerts.
// Storage: Upstash Redis if UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set (survives restarts).
// Otherwise an in-memory list (fine for local testing, but it resets on serverless cold starts).
import { getJson } from "./http.js";
import { timingSafeEqual } from "node:crypto";

const mem = [];
export const clearAlerts = () => (mem.length = 0);

export function checkSecret(given, env = process.env) {
  const want = env.ALERT_SECRET;
  if (!want) return { ok: false, code: 503, error: "Set ALERT_SECRET on the server to accept alerts." };
  const a = Buffer.from(String(given || "")), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, code: 401, error: "Wrong key." };
  return { ok: true };
}

const strip = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

// TradingView sends either JSON (if your alert message is JSON) or plain text.
export function parseAlert(body) {
  let o = body;
  if (typeof body === "string") {
    const txt = body.trim();
    try { o = JSON.parse(txt); } catch (e) { o = { message: txt }; }
  }
  if (!o || typeof o !== "object") o = { message: String(o || "") };
  const message = strip(o.message || o.text || o.alert || o.action || "", 300);
  let ticker = strip(o.ticker || o.symbol || "", 20).toUpperCase().replace(/^.*:/, "").replace(/[^A-Z0-9.\-]/g, "");
  if (!ticker) { const m = message.match(/\b([A-Z]{1,5})\b/); ticker = m ? m[1] : ""; }
  const price = parseFloat(o.price || o.close);
  if (!message && !ticker) throw new Error("Empty alert");
  return { ticker, price: isFinite(price) ? price : null, message: message || "Alert", ms: Date.now() };
}

async function redis(cmds, env) {
  const r = await getJson(`${env.UPSTASH_REDIS_REST_URL}/pipeline`, { label: "Redis", retries: cmds[0][0] === "LPUSH" ? 0 : 1, timeout: 4000, method: "POST", headers: { Authorization: "Bearer " + env.UPSTASH_REDIS_REST_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(cmds) });
  return r;
}
const hasRedis = (env) => env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN;

export async function saveAlert(a, env = process.env) {
  if (hasRedis(env)) { await redis([["LPUSH", "alerts", JSON.stringify(a)], ["LTRIM", "alerts", 0, 199]], env); return; }
  mem.unshift(a); mem.length = Math.min(mem.length, 200);
}
export async function listAlerts(env = process.env, limit = 100) {
  if (hasRedis(env)) {
    const r = await redis([["LRANGE", "alerts", 0, limit - 1]], env);
    return ((r[0] && r[0].result) || []).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
  }
  return mem.slice(0, limit);
}
