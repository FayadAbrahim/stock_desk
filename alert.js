import { checkSecret, parseAlert, saveAlert } from "../lib/alerts.js";
import { rateLimit } from "../lib/cache.js";

// TradingView webhook target: POST https://YOUR-SITE/api/alert?key=YOUR_ALERT_SECRET
export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const ip = String((req.headers && (req.headers["x-forwarded-for"] || "")) || "").split(",")[0] || "local";
  if (!rateLimit("a:" + ip, 60)) { res.status(429).json({ error: "Too many requests." }); return; }
  const key = (req.query && req.query.key) || new URL(req.url, "http://x").searchParams.get("key");
  const auth = checkSecret(key);
  if (!auth.ok) { res.status(auth.code).json({ error: auth.error }); return; }
  try {
    const a = parseAlert(req.body);
    await saveAlert(a);
    res.status(200).json({ ok: true, alert: a });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
}
