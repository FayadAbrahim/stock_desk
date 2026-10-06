# Stock Desk (standalone)

Type a ticker, get the full report. No Claude needed to run it. A small backend pulls live data and scores it with a fixed rubric.

## Put it online (about 10 minutes, free)
1. Get these free API keys:
   - Finnhub: https://finnhub.io (analyst ratings, valuation, insider trades, earnings dates)
   - Financial Modeling Prep: https://site.financialmodelingprep.com (House and Senate trades)
   - FRED: https://fred.stlouisfed.org/docs/api/api_key.html (economic calendar: CPI, jobs, GDP)
2. Create free accounts at https://vercel.com and https://github.com.
3. Put this folder in a new GitHub repo (New repository, then upload the files).
4. In Vercel: Add New > Project > import the repo. Before deploying, open Environment Variables and add `FINNHUB_KEY`, `FMP_KEY` and `FRED_API_KEY`. For alerts also add `ALERT_SECRET` (make up a long random string) and, to keep alerts across restarts, `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Deploy.
5. Vercel gives you a URL like `stock-desk-yourname.vercel.app`. Open it and type a ticker.

For a custom domain, add it in Vercel > Settings > Domains.

## Run locally
Copy `.env.example` to `.env`, fill in the keys, run `node server.js`, open http://localhost:3000.
`MOCK=1 node server.js` runs on sample data with no keys or internet.

## What comes from where
| Item | Source | Needs key |
|---|---|---|
| Live price, 50/200-day averages, RSI, key levels | Yahoo Finance | No |
| Options put/call volume, unusual activity | Yahoo Finance | No |
| Valuation, analyst ratings, insider buys and sells, earnings date | Finnhub | Yes (free) |
| House and Senate trades | Financial Modeling Prep | Yes (free tier may limit this) |
| President trades (OGE filings) | Kadoa page, best effort | No |
| Economic calendar (CPI, jobs, GDP, etc.) | FRED, plus the Fed's FOMC dates | Yes (free) |
| Earnings calendar | Finnhub | Yes |
| Headlines (market and per stock) | CNBC, MarketWatch, Yahoo RSS, Finnhub | No |
| Big funds (13F) | Link only | |

Anything that fails shows under "Not found" in the report and lowers the confidence label.

## How it stays reliable
- Every request has a timeout and retries on network errors, rate limits and server errors.
- Price: Yahoo first, Stooq daily close as backup. If a Finnhub key is set, it is used as a second opinion. A gap over 3% shows a warning.
- Results are cached briefly. If a source goes down, the last good data is shown with a note saying how old it is.
- Each report ends with a Data health panel showing which sources answered and how fast.
- Bad prices, short history and stale quotes are caught and flagged. Confidence drops when data is missing.
- Basic rate limiting (40 requests a minute per visitor).
- Run `npm test` for the 20 offline tests (indicators, scoring, fallbacks, parsers, calendar logic, quotes, alert security and storage).
- Run `python3 test/e2e.py` (needs `pip install playwright`) for the 35 browser checks on sample data: live price, TradingView widgets, calendar, alerts, dark mode, mobile and desktop, blocked widgets, backend errors.

## TradingView
- Under each report: a live TradingView chart and their technicals gauge. On the calendar tab: TradingView's live economic calendar. These are embedded widgets for viewing. TradingView does not offer a data feed, so the verdict is scored from the other sources.
- Live price: the page asks `/api/quote` every 5 seconds (Finnhub real-time trades, Yahoo as backup) and updates the price, today's change, your profit or loss and the key-levels picture in place. The key is never sent to the browser.
- Alerts tab: TradingView alerts land in your site. In TradingView set the alert's Webhook URL to `https://YOUR-SITE/api/alert?key=YOUR_ALERT_SECRET` and paste the message template shown on the Alerts tab. Webhooks need a paid TradingView plan and two-factor sign-in.
- The alert list is readable by anyone who has your site link, so keep alert messages free of anything private.

## Market calendar tab
Seven days of economic releases (with plain-English meaning and impact level), the Fed rate decision dates, the biggest earnings reports each day, and live market headlines. Refreshes every 5 minutes. The FOMC dates are built in for 2026. Update `FOMC_2026` in `lib/calendar.js` each year.

## Honest limits
- Free data is not tick-by-tick. For truly real-time quotes and full options data you would pay for a provider such as Polygon or Tradier. The code is split so a provider can be swapped in later.
- Yahoo and Kadoa are unofficial. They can change or block without notice. If options or president trades go blank, that is the cause.
- Congress and president trades are delayed disclosures (up to about 45 days), not live.
- Live price refreshes every 5 seconds, not tick by tick. The full analysis refreshes every 5 minutes.
- Free Vercel plans have no persistent storage, so without Redis the alert list resets when the server restarts.
- The site is public to anyone with the link. Your position (shares and cost) stays in your own browser only.
- Information, not investment advice.
