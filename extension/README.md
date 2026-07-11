# Cosmetics Scraper — Chrome Extension

Scrapes cosmetics product pages into WooCommerce‑ready rows (variable + simple,
with color/image swatches), saves a **bulk queue** across pages, and exports via
**Copy / CSV** or imports to one or more saved **WooCommerce stores**.

This extension runs **entirely on your computer, inside Chrome**. It does **not**
depend on Claude/Anthropic or any external service — it only talks to the product
sites you scrape and your own WooCommerce store(s). It will keep working
indefinitely with no subscription of any kind.

## Install (load unpacked)
1. Open Chrome → go to `chrome://extensions`
2. Turn on **Developer mode** (top‑right)
3. Click **Load unpacked** and select this `extension` folder (the one with `manifest.json`)
4. Pin the extension and click its icon to open the **side panel**

> Keep this folder on disk. The unpacked extension loads from it every time Chrome
> starts, so don't delete or move it (or re‑load it if you do).

## Use
- **Scrape:** open a product page → **Scrape this page** (best for bot‑protected
  sites), or paste a URL and tap **Go**. Toggle **Variable / Simple** first.
- **Bulk:** after scraping, tap **+ Bulk** to queue it. Repeat across pages.
  The **Bulk** tab lets you **Copy all / CSV all / Import all**.
- **Stores:** add your WooCommerce store(s) (name, URL, consumer key/secret, and
  WP username + application password for CSV import). Saved in the browser.

## Files
- `manifest.json` — extension config (Manifest V3)
- `background.js` — runs scrapers (page or background) + WooCommerce calls
- `scrapers.js` — all per‑site scraping logic
- `sidepanel.html` / `sidepanel.css` / `sidepanel.js` — the UI

## Maintenance note
Websites occasionally change their HTML, which can break a scraper. Fixing that
means editing `scrapers.js`. If you can't do that yourself, keep this README and
the code so any developer can pick it up.
