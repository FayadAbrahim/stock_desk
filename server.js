// Local dev server: node server.js  ->  http://localhost:3000
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import analyze from "./api/analyze.js";
import calendar from "./api/calendar.js";
import quote from "./api/quote.js";
import alert from "./api/alert.js";
import alerts from "./api/alerts.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
try { fs.readFileSync(path.join(dir, ".env"), "utf8").split("\n").forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2]; }); } catch (e) {}

const routes = { "/api/analyze": analyze, "/api/calendar": calendar, "/api/quote": quote, "/api/alert": alert, "/api/alerts": alerts };
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

export const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const h = routes[u.pathname];
  if (h) {
    req.query = Object.fromEntries(u.searchParams);
    let raw = "";
    for await (const c of req) { raw += c; if (raw.length > 100000) break; }
    req.body = raw;
    if (/json/.test(req.headers["content-type"] || "")) { try { req.body = JSON.parse(raw); } catch (e) {} }
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
    return h(req, res);
  }
  const f = path.join(dir, "public", u.pathname === "/" ? "index.html" : u.pathname);
  if (!f.startsWith(path.join(dir, "public")) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end("Not found"); }
  res.setHeader("Content-Type", types[path.extname(f)] || "text/plain"); res.end(fs.readFileSync(f));
});
if (process.argv[1] === fileURLToPath(import.meta.url)) server.listen(process.env.PORT || 3000, () => console.log("Stock Desk on http://localhost:" + (process.env.PORT || 3000)));
