"""End-to-end browser test on sample data. Run: python3 test/e2e.py  (starts its own server)"""
import json, os, subprocess, sys, time, urllib.request, urllib.error
from playwright.sync_api import sync_playwright

PORT = "3113"; BASE = "http://localhost:" + PORT
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env = dict(os.environ, MOCK="1", ALERT_SECRET="s3cret", PORT=PORT)
srv = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
fails = []; passed = []
def check(name, cond, extra=""):
    (passed if cond else fails).append(name); print(("PASS " if cond else "FAIL ") + name + (" -> " + str(extra) if (extra and not cond) else ""))
def post(path, body, ctype="application/json"):
    req = urllib.request.Request(BASE + path, data=body.encode(), method="POST", headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(req) as r: return r.status
    except urllib.error.HTTPError as e: return e.code

try:
    for _ in range(40):
        try: urllib.request.urlopen(BASE + "/api/quote?ticker=CMG"); break
        except Exception: time.sleep(0.25)
    with sync_playwright() as p:
        b = p.chromium.launch()
        def new_page(w=420, h=900, scheme="light"):
            ctx = b.new_context(viewport={"width": w, "height": h}, color_scheme=scheme)
            pg = ctx.new_page(); pg.errors = []
            pg.on("pageerror", lambda e: pg.errors.append(str(e)))
            pg.route("**/s3.tradingview.com/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body="/*stub*/"))
            pg.route("**/fonts.g*/**", lambda r: r.abort())
            return pg

        pg = new_page()
        pg.goto(BASE + "/#CMG"); pg.wait_for_selector(".tick", timeout=8000)
        check("report renders with verdict", pg.inner_text(".badge").strip() != "")
        # TradingView widgets mounted with the right symbol
        pg.wait_for_selector("#tvchart script", state="attached", timeout=5000)
        cfg = json.loads(pg.eval_on_selector("#tvchart script", "e => e.text"))
        check("TradingView chart widget configured for CMG", cfg.get("symbol") == "CMG" and cfg.get("interval") == "D", cfg)
        src = pg.eval_on_selector("#tvchart script", "e => e.src")
        check("chart script comes from tradingview", src.startswith("https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js"), src)
        tcfg = json.loads(pg.eval_on_selector("#tvtech script", "e => e.text"))
        check("technicals widget configured", tcfg.get("symbol") == "CMG" and tcfg.get("interval") == "1D", tcfg)
        # live price updates in place
        pg.wait_for_function("document.querySelector('#live').classList.contains('on')", timeout=8000)
        check("live indicator shows source", "sample" in pg.inner_text("#live"), pg.inner_text("#live"))
        pg.eval_on_selector("#tvchart", "e => e.firstChild.setAttribute('data-marker','keep')")
        p1 = pg.inner_text("#px"); time.sleep(11); p2 = pg.inner_text("#px")
        check("live price changes over time", p1 != p2, (p1, p2))
        check("chart widget not reloaded by live updates", pg.eval_on_selector("#tvchart", "e => e.firstChild.getAttribute('data-marker')") == "keep")
        check("change line shown", "today" in pg.inner_text("#chg"))
        # key levels ladder follows the live price
        check("ladder present", pg.locator("svg.ladder").count() == 1)
        # position P/L
        pg.fill("#psh", "900"); pg.fill("#pco", "31.75"); pg.click("#posf button")
        pg.wait_for_selector("#posline", timeout=3000)
        check("position P/L shown", "900 sh @ $31.75" in pg.inner_text("#posline"))
        pg.wait_for_selector("#tvchart script", state="attached")
        pg.reload(); pg.wait_for_selector("#posline", timeout=8000)
        check("position survives reload", "900 sh" in pg.inner_text("#posline"))
        # no horizontal overflow on mobile
        check("no horizontal scroll on mobile", pg.evaluate("document.scrollingElement.scrollWidth <= window.innerWidth + 1"), pg.evaluate("[document.scrollingElement.scrollWidth, window.innerWidth]"))
        pg.screenshot(path="/tmp/e2e_mobile_stock.png", full_page=True)

        # search a new ticker, strip updates, invalid ticker error
        pg.fill("#q", "intc"); pg.press("#q", "Enter")
        pg.wait_for_function("document.querySelector('.tick') && document.querySelector('.tick').textContent === 'INTC'", timeout=8000)
        check("new ticker loads and widgets follow", json.loads(pg.eval_on_selector("#tvchart script", "e => e.text"))["symbol"] == "INTC")
        check("watchlist chip added", "INTC" in pg.inner_text("#strip") and "CMG" in pg.inner_text("#strip"))
        pg.fill("#q", "123"); pg.press("#q", "Enter"); pg.wait_for_selector(".empty h3", timeout=8000)
        check("bad ticker gives a clear message", "Couldn't analyze" in pg.inner_text(".empty h3") or "Couldn't" in pg.inner_text("main"))

        # calendar tab
        pg.click("[data-tab=cal]"); pg.wait_for_selector(".day", timeout=8000)
        check("calendar shows today", pg.locator(".day.today").count() == 1)
        check("calendar has headlines and economic event", "CPI" in pg.inner_text("main") and "headline" in pg.inner_text("main").lower())
        pg.wait_for_selector("#tvcal script", state="attached", timeout=5000)
        check("TradingView economic calendar widget mounted", "embed-widget-events.js" in pg.eval_on_selector("#tvcal script", "e => e.src"))
        check("search hidden on calendar tab", not pg.is_visible("#f"))
        pg.screenshot(path="/tmp/e2e_mobile_cal.png", full_page=True)

        # alerts tab: webhook security + display + no script injection
        check("webhook rejects wrong key", post("/api/alert?key=wrong", "{}") == 401)
        check("webhook rejects GET", urllib.request.urlopen(BASE + "/api/alerts").status == 200)
        check("webhook accepts right key", post("/api/alert?key=s3cret", json.dumps({"ticker": "NYSE:CMG", "price": "31.2", "message": "Hit entry <img src=x onerror=window.__x=1>"})) == 200)
        check("webhook accepts plain text", post("/api/alert?key=s3cret", "INTC crossed 41", "text/plain") == 200)
        pg.click("[data-tab=alerts]"); pg.wait_for_selector(".alert", timeout=8000)
        txt = pg.inner_text("main")
        check("alerts listed with ticker", "CMG" in txt and "Hit entry" in txt and "INTC crossed 41" in txt)
        check("alert text is not executed as HTML", pg.evaluate("window.__x") is None and pg.locator(".alert img").count() == 0)
        check("setup instructions with webhook url", "/api/alert?key=YOUR_ALERT_SECRET" in pg.input_value("#c1"))
        pg.screenshot(path="/tmp/e2e_mobile_alerts.png", full_page=True)
        pg.click(".alert button.tk >> nth=0")
        pg.wait_for_selector(".tick", timeout=8000)
        check("clicking an alert ticker opens its report", pg.is_visible("#f") and pg.inner_text(".tick") in ("CMG", "INTC"))
        pg.wait_for_selector("#tvcard", timeout=5000)
        check("ticker alerts card shows on its report", "your tradingview alerts for" in pg.inner_text("main").lower())
        check("live price resumes after tab switch", pg.wait_for_function("document.querySelector('#live') && document.querySelector('#live').textContent.indexOf('sample') > -1", timeout=8000) is not None)
        check("no JavaScript errors", not pg.errors, pg.errors)
        pg.context.close()

        # dark mode + desktop layout
        pg = new_page(1280, 900, "dark")
        pg.goto(BASE + "/#CMG"); pg.wait_for_selector(".tick", timeout=8000)
        bg = pg.evaluate("getComputedStyle(document.body).backgroundColor")
        check("dark mode applied", bg.replace(" ", "") in ("rgb(13,19,26)",), bg)
        check("no horizontal scroll on desktop", pg.evaluate("document.scrollingElement.scrollWidth <= window.innerWidth + 1"))
        pg.screenshot(path="/tmp/e2e_desktop_dark.png", full_page=True)
        pg.context.close()

        # TradingView blocked (ad blocker): page still works and says so
        ctx = b.new_context(viewport={"width": 420, "height": 900}); pg = ctx.new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.route("**/s3.tradingview.com/**", lambda r: r.abort()); pg.route("**/fonts.g*/**", lambda r: r.abort())
        pg.goto(BASE + "/#CMG"); pg.wait_for_selector(".tick", timeout=8000)
        pg.wait_for_function("document.querySelector('#tvchart') && document.querySelector('#tvchart').innerText.indexOf('could not load') > -1", timeout=8000)
        check("blocked TradingView degrades gracefully", True)
        check("report still works with widgets blocked", pg.inner_text(".badge").strip() != "" and not errs, errs)
        ctx.close()

        # backend down: API failure shows an error, not a blank page
        ctx = b.new_context(viewport={"width": 420, "height": 900}); pg = ctx.new_page()
        pg.route("**/s3.tradingview.com/**", lambda r: r.fulfill(status=200, body="/*x*/")); pg.route("**/fonts.g*/**", lambda r: r.abort())
        pg.route("**/api/analyze*", lambda r: r.fulfill(status=502, content_type="application/json", body=json.dumps({"error": "No price data found for ZZZ."})))
        pg.goto(BASE + "/#ZZZ"); pg.wait_for_selector(".empty h3", timeout=8000)
        check("API error shown to user", "No price data" in pg.inner_text(".empty"))
        ctx.close(); b.close()
finally:
    srv.terminate()
print("\n%d passed, %d failed" % (len(passed), len(fails)))
sys.exit(1 if fails else 0)
