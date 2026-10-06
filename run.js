import { analyze } from "../lib/analyze.js";
const r = await analyze("CMG");
console.log(r.ticker, r.price, r.verdict, r.score, r.confidence);
console.log(r.scores.map((s) => s.label + ":" + s.score).join(" | "));
console.log("levels", r.levels.length, "congress", r.congress.trades.length, "missing", r.missing);
if (!r.verdict || !r.levels.length || typeof r.score !== "number") { console.error("FAIL"); process.exit(1); }
console.log("OK");
