# Notes — Universal Scrapper

> Current, up-to-date project notes. Supersedes `MASTER_NOTES.md`, which is outdated.

## What this is

"Universal Scrapper" extracts product data (name, images, price, attributes, variants, swatches)
from cosmetic/e-commerce product pages, turns it into WooCommerce-compatible rows, and imports
it into a store.

**No login / no sign-up** — the whole product is anonymous.

## Repos & locations

| Item | Location |
|---|---|
| Main repo | `/Users/indiana/Cursor/product-scraper Extension/` → `github.com/jodukkan-max/Cosmetics-Scrapper` (branch `main`) |
| WordPress plugin | separate repo `github.com/jodukkan-max/universal-import` — "Universal Import" (formerly "Rey Swatches Import") |

## Components

| Folder | What it is |
|---|---|
| `extension/` | Chrome MV3 extension (side panel + background service worker) |
| `desktop/` | Electron desktop app (embedded browser + same scraper core) |
| `mobile/` | Flutter app — iOS + Android, in-app WebView browser |
| `supabase/` | Backend: DB migrations, Edge Function `deepseek`, `predefined/scrapers.js` module |

All four components are committed to the main repo.

## Backend (Supabase — anonymous)

- Tables: `scrapers` (custom + predefined metadata), `scrape_history`, `scraper_modules`
  (the single shared predefined scraper module, versioned).
- All scraper code is served from Supabase — NOT bundled into the apps.
- AI = DeepSeek (`deepseek-v4-flash`), called through the `deepseek` Edge Function
  (hides the API key).

## Canonical deliverables (do not rename or move)

- Android APK → `/Users/indiana/Desktop/Universal-Scrapper.apk`
- WordPress plugin zip → `/Users/indiana/Desktop/rey-swatches-import.zip`

## Recent work / current state

- **Extension v1.0.27** (2026-09-04).
- **Conversational chat to fix scraped data:** "Use deep thinking" now opens a natural-language
  chat with the AI agent (`chatFixScraper` → `CHAT_SYSTEM` + `parseChatReply` in `background.js`).
  The agent reasons about the page and the current table, replies in prose (may ask one clarifying
  question), and only writes a corrected `run()` in a code block when it changes the scraper. Runs
  with `thinking: true`, a 60s timeout, and a one-step "keep-warm" resume on timeout. UI in
  `sidepanel.html`/`.css`/`.js` (`openChat`, `addChatMessage`, `sendChat`, multi-turn `chatHistory`).
- **Removed `tags` and `Product URL` columns** from both `SIMPLE_COLUMNS` and `VARIABLE_COLUMNS`
  in `sidepanel.js` — gone from the table, CSV export, copy-to-clipboard, and the WooCommerce import.
- **Three-phase direct extraction (no retry loop):** scraper generation in `background.js`
  (`generateScraper`) is now 3 single-shot DeepSeek calls — core fields, variants (variable only),
  then code generation from verified rows — via `CORE_SYSTEM`, `VARIANTS_SYSTEM`, `CODE_SYSTEM`.
  No more "attempts" / retry loops, which removes timeout and infinite-loop failures.
- **Image sanitization** (`cleanImageList`, `sanitizeRows`) filters invalid/placeholder image URLs
  (e.g. `$img`, `${img}`) from every scraper run before import.
- **Rey Swatches / Color Code** extraction hardened in `VARIANTS_SYSTEM` + `buildReySwatches`
  (driven by hex/image presence, not attribute name).
- **All scraper code served from Supabase** (not bundled); `scraper_modules` table holds the shared
  predefined module, versioned.
- Fixed "No JSON-LD on Seventeen page!" on Android: robust HTML fetch chain in
  `mobile/lib/home_screen.dart` (`_currentHtml`: WebView `fetch()` → Dart `http.get` +
  `_unwrapHtml` → DOM read) and `mobile/lib/browser_controller.dart` (`getHtmlViaFetch`).
- Android release APK rebuilt and verified on the emulator.

