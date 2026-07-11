# Cosmetics Scraper — Master Notes

> These notes capture the architecture, conventions, and state of this project so an AI agent can quickly regain context and contribute effectively.

---

## Project Overview

**What it is:** A Chrome Extension (Manifest V3) that scrapes cosmetic product pages and exports data in WooCommerce-compatible CSV/TSV format.

**Location:** `/Users/indiana/claude/product-scraper/extension/`

**Key files:**
- `manifest.json` — Extension manifest (MV3, sidePanel, storage, scripting, activeTab, tabs)
- `background.js` — Service worker; listens for messages from side panel, injects `scrapers.js` into tabs for scraping, also handles bulk discovery
- `scrapers.js` — All scraper implementations, data output helpers, and bulk discoverers; ~1850 LOC, loaded into page context
- `sidepanel.html` / `sidepanel.css` / `sidepanel.js` — UI: 2 tabs (Products / Stores); scrape, inline discover panel, collapsible bulk queue, CSV export

**NOTE:** The web app (server.js, public/, Dockerfile, etc.) was removed. Only the Chrome Extension remains.

---

## Architecture

### Scraping Flow
1. User opens side panel on a supported product page
2. Side panel sends `{ action: 'scrape', url, productType }` to service worker
3. Service worker injects `scrapers.js` into the active tab
4. `scrapers.js` runs `scrapeProduct(ctx)` where `ctx = { mainHtml, url, productType, fetchJson }`
5. Returns `{ rows, title }` — rows are flat WooCommerce-compatible objects
6. Side panel renders rows, allows variant selection, CSV/TSV export

### Two Product Types
- **Variable** (`variableRows` helper): Parent row + variation rows with attributes
- **Simple** (`simpleRow` helper): Single row, no attributes

### Bulk Discovery (inline "Discover" panel)

Each discoverable brand shows a **Discover** button in the brands list. Clicking it opens an inline panel below with progress feedback and a collapsible category→product tree.

**Flow:**
1. User clicks "Discover" next to a brand in the Products tab
2. Sidepanel sends `{ type: 'bulkDiscover', site: 'maybelline' }` to background worker
3. Background worker calls `discoverAll(ctx)` from the engine, passing `onProgress` callback
4. Progress messages flow back via `chrome.runtime.sendMessage({ type: 'bulkDiscoverProgress', ... })`
5. Results render as a collapsible tree: categories → products (name + Visit link + Add to Bulk button)
6. Each product has a **"+ Bulk"** button that scrapes it and adds to the queue
7. Export as CSV with columns: Category, Category URL, Product Name, Product URL

**Current discoverers:**
- **Seventeen** — fetches category pages from sitemap, extracts product cards from HTML
- **Maybelline** — sitemap-only (SPA blocks server-side rendering); derives product names from URL slugs, uses word-count heuristic to distinguish products from filter pages
- **e.l.f. Cosmetics** — fetches all product sitemaps (~1,173 products), then fetches each product page to extract JSON‑LD breadcrumbs (BreadcrumbList) for category grouping. Processes in batches of 5 with full progress reporting. ~3‑5 minutes for full scan.
- **NYX Professional Makeup** — **Server‑blocked.** NYX returns 403 for all non‑browser requests (sitemaps and category pages). The discoverer falls back to showing skeleton categories (Lips, Face, Eyes, Brows, Tools) with guidance to scrape individual pages via "Scrape This Page".

**Maybelline discoverer details:**
- Category roots: `eye-makeup`, `face-makeup`, `lip-makeup`, `nail-makeup`, `accessories`
- Product detection: URL slug has 3+ words OR >15 chars with 2+ words (filters out subcategory/filter pages like `/eyeliner/waterproof` or `/eyeshadow/matte`)
- Product names: derived from slug (`lash-sensational-sky-high-mascara` → `Lash Sensational Sky High Mascara`)
- ~243 products across 19 categories, zero product-page requests

**e.l.f. Cosmetics discoverer details:**
- Platform: Shopify storefront; no category info in product URLs (`/products/{handle}`)
- Approach: fetches all 5 product sitemaps (~1,173 product URLs), then fetches each product page individually
- Category extraction: parses `BreadcrumbList` JSON‑LD block (e.g., `Home > Eyes > Eyeliner` → category `Eyes > Eyeliner`)
- Product name: from `Product` JSON‑LD block; fallback to `<title>` tag
- Processing: batches of 5 concurrent fetches with full progress reporting
- Collection URLs: derived from first breadcrumb segment (`Eyes` → `/collections/eyes`)
- Products without breadcrumbs go to `All Products`; fetch failures go to `Uncategorized` with slug‑derived names

**NYX Professional Makeup discoverer details:**
- Platform: Salesforce Commerce Cloud (Demandware) — blocks all server‑side requests with 403
- Sitemap: `https://www.nyxcosmetics.com/sitemap.xml` → 403 (also 403 on `sitemap_index.xml`, `sitemap`, `sitemap.xml.gz`, `sitemap-en.xml`)
- Category pages: all return 403 from non‑browser fetch (even with Chrome UA header)
- The discoverer tries the sitemap as a best effort; on failure, returns a `blocked: true` response
- Fallback: shows 5 hardcoded category names (Lips, Face, Eyes, Brows, Brushes & Tools) with category URLs
- Guidance message instructs the user to use the active‑tab "Scrape This Page" feature for individual NYX products
- The sidepanel renders the blocked response with a warning‑style status message

**Per-brand discoverer function signature:**
```js
async function discoverBrand(ctx) {
  const { fetchText, onProgress } = ctx;
  // Must return: { categories: [{ name, url, products: [{ name, url }] }], totalProducts, totalCategories }
}
```

**Dispatch:** `DISCOVERERS = { seventeen: discoverSeventeen, maybelline: discoverMaybelline, elf: discoverElf, nyx: discoverNyx }` — separate from `SCRAPERS` for single-product scraping.

**Adding a new discoverable brand:**
1. Add `discover: true` to the brand's entry in `BRANDS[]`
2. Implement `discoverBrandName(ctx)` in `scrapers.js`
3. Register in `DISCOVERERS` table

### Key Helper Functions in scrapers.js
| Function | Purpose |
|---|---|
| `variableRows(title, parentImages, description, shortDesc, categories, optionName, variants)` | Builds parent + child WooCommerce rows |
| `simpleRow(o)` | Builds a single WooCommerce row |
| `ldBlocks(html)` | Extracts all JSON-LD blocks from HTML |
| `decodeEntities(str)` | Decodes HTML entities |
| `imgBaseName(url)` | Strips query params + UUIDs from image URLs for dedup |
| `fmtPrice(n)` | Formats numeric price to 2 decimal places |
| `toSlug(s)` | Converts string to URL slug |

### Variable row structure
```
Parent row: ID, Parent: '', Type: 'variable', SKU: '', Name, Images, Description, Short Description, Categories, Regular Price, Sale Price, Attribute 1 name, Attribute 1 value(s), Color Code
Child rows: ID, Parent: 'id:N', Type: 'variation', SKU, Name, Images (1st only), Regular Price, Sale Price, Attribute 1 name, Attribute 1 value(s), Color Code
```

---

## Currently Implemented Brands (25 scraper functions)

| Brand | Site Key | Platform | Approach | Discover |
|---|---|---|---|---|
| NYX Professional Makeup | `nyx` | SFCC/Demandware | JSON-LD ProductGroup + c-swatch elements | ✓ (server-blocked) |
| e.l.f. Cosmetics | `elf` | Shopify | Storefront GraphQL API + embedded media JSON | ✓ |
| Huda Beauty | `huda` | Shopify | Storefront GraphQL + custom swatch normalization | |
| Pastel | `pastel` | Custom/JS-driven | CSS var extraction from shade selectors | |
| Glow Recipe | `glowrecipe` | Shopify | Shopify API | |
| Inglot | `inglot` | Custom | DOM parsing | |
| Flormar | `flormar` | Custom | DOM parsing, rate-limited | |
| Maybelline | `maybelline` | L'Oréal/Sitecore | Input shade selectors + variant image API | ✓ |
| Seventeen | `seventeen` | Django/Oscar | JSON-LD + swiper galleries | ✓ |
| L'Oréal Paris | `lorealparis` | Sitecore | JSON-LD + oap media gallery | |
| Vichy | `vichy` | Sitecore | JSON-LD | |
| La Roche-Posay | `larocheposay` | Sitecore | JSON-LD | |
| Urban Care | `urbancare` | Custom | Simple DOM | |
| Bielenda | `bielenda` | Custom | Simple DOM | |
| CeraVe | `cerave` | Simple | Simple DOM | |
| NARS | `nars` | SFCC/Demandware | JSON-LD variant API | |
| Sephora | `sephora` | Custom SPA | #linkStore embedded JSON + variant API | |
| Radiant | `radiant` | Custom | DOM | |
| Misslyn | `misslyn` | Custom | DOM | |
| Essence | `essence` | Shopify | Shopify API | |
| Charlotte Tilbury | `charlottetilbury` | Next.js | `__NEXT_DATA__` + JSON-LD | |
| Dior | `dior` | Custom | JSON-LD + lazy-loaded gallery | |
| Summer Fridays | `summerfridays` | Shopify | Shopify API | |
| Character Cosmetics | `character` | Custom | DOM | |

---

## NYX Cosmetics Scraper (Added 2025-07-02)

**Platform:** Salesforce Commerce Cloud (Demandware)

**Product page structure:**
- JSON-LD `ProductGroup` block with `hasVariant[]` containing all variant data (sku, image, color, price)
- `c-swatch` (`<a>` elements with `data-js-pid`, `data-js-title`, `data-js-productimgsrc`, `style="background-color:#hex"`)
- Carousel gallery images extracted from `c-carousel__item` img src attributes
- BreadcrumbList JSON-LD for categories
- Subtitle from `c-product-main__subtitle` span

**Variable scraper (`scrapeNyx`):**
1. Parse ProductGroup JSON-LD for title, description, hasVariant
2. Parse `c-swatch` elements for hex colors and variant-specific images
3. Merge swatch data with JSON-LD variants by SKU
4. Extract carousel images for parent gallery
5. Build `variableRows()` with attribute name "Color"

**Simple scraper (`scrapeNyxSimple`):**
1. Parse Product JSON-LD for single product data
2. Extract carousel images
3. Build `simpleRow()`

**Example product URL:** `https://www.nyxcosmetics.com/lip/lip-gloss-pouch/USNYX_44.html`

---

## Adding a New Brand Scraper

1. Create `scrapeNewBrand(ctx)` and `scrapeNewBrandSimple(ctx)` functions in `scrapers.js`
2. Add entry to `SCRAPERS` table: `newbrand: { variable: scrapeNewBrand, simple: scrapeNewBrandSimple }`
3. Add entry to `BRANDS` catalogue: `{ name: '...', domain: '...', key: 'newbrand', example: '...' }`
4. Add to `detectSite()` hostname map: `'newbrand.com': 'newbrand'`
5. **No sidepanel.js changes needed** — it reads dynamically from `ProductScraper.brands`

### Scraper function signature
```js
async function scrapeNewBrand(ctx) {
  const html = ctx.mainHtml;   // Full page HTML as string
  const url = ctx.url;         // Page URL
  // ctx.fetchJson(url, opts) — cross-origin fetch returning JSON
  // Must return: { rows: [...], title: 'Product Title' }
}
```

### Conventions
- All scrapers must be browser-compatible (no Node.js APIs)
- Image URLs: strip query params (`split('?')[0]`), use `imgBaseName()` for dedup
- Swatch colors: hex strings like `#bd5eba`, or image URLs if image swatches
- Price formatting: use `fmtPrice()`
- Always call `decodeEntities()` on HTML text
- Category format: `Parent > Child > Subchild` (joined with `>`)

---

## Common Scraping Patterns

### JSON-LD extraction
```js
const ldBlocks = (html) => [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
```

### Shopify Storefront API
```js
const token = extractStorefrontToken(html);
const gql = await ctx.fetchJson(`${domain}/api/2024-07/graphql.json`, {
  method: 'POST',
  headers: { 'X-Shopify-Storefront-Access-Token': token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: ELF_QUERY, variables: { handle } }),
});
```

### Image dedup
```js
const seen = new Set();
for (const u of urls) {
  const base = imgBaseName(u);
  if (!seen.has(base)) { seen.add(base); result.push(u); }
}
```

---

## File Manifest

```
extension/
├── manifest.json          # MV3 extension manifest
├── background.js          # Service worker (~130 lines)
├── scrapers.js            # All scraper logic + helpers + discoverers (~1850 lines)
├── sidepanel.html         # Extension UI (2 tabs: Products / Stores; inline discover panel)
├── sidepanel.css          # Extension styles
└── sidepanel.js           # Extension UI logic (~650 lines)
```

---

## Last Updated

**Date:** 2026-07-06
**Change:** Added bulk discovery for e.l.f. Cosmetics (sitemap + per‑page JSON‑LD breadcrumbs, 1,173 products across all categories) and NYX Professional Makeup (server‑blocked with fallback skeleton categories + guidance message). Updated sidepanel to show warn‑style status for blocked sites.
