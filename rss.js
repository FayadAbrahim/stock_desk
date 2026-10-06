// Minimal RSS/Atom reader. No dependencies.
const decode = (s) => String(s || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
  .replace(/\s+/g, " ").trim();

export function parseRss(xml, source) {
  const items = [];
  const blocks = String(xml || "").match(/<item[\s>][\s\S]*?<\/item>/gi) || String(xml || "").match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  blocks.forEach((b) => {
    const pick = (tag) => { const m = b.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i")); return m ? decode(m[1]) : ""; };
    const title = pick("title");
    let link = pick("link");
    if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); link = m ? m[1] : ""; }
    const when = Date.parse(pick("pubDate") || pick("published") || pick("updated") || "");
    if (title && /^https?:\/\//i.test(link)) items.push({ title, url: link, source, ms: isNaN(when) ? null : when });
  });
  return items;
}

export function dedupe(items, max = 12) {
  const seen = new Set(), out = [];
  items.sort((a, b) => (b.ms || 0) - (a.ms || 0)).forEach((x) => {
    const k = x.title.toLowerCase().replace(/ & /g, " and ").replace(/[^a-z0-9]/g, "").slice(0, 60);
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  });
  return out.slice(0, max);
}
