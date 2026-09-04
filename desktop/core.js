/* Scraper core — chrome-free, DOM-free, runs in the Electron main process (Node).
 * Faithful port of the logic from extension/background.js. All the heavy lifting
 * (AI generation loop, scraper execution, Supabase registry, WooCommerce import)
 * lives here; the Electron main.js only wires IPC and reads the page HTML.
 *
 * No Electron import, so it can be smoke-tested headlessly with plain Node.
 */

'use strict';

// Node has no `self`; the predefined module + generated scrapers reference it,
// so alias it to the global object (same trick the browser world relies on).
if (typeof self === 'undefined') global.self = globalThis;

const DS_FLASH = 'deepseek-v4-flash';

module.exports = function createCore({ Supabase, sendProgress, sendThinking }) {
  const noop = () => {};
  const progress = sendProgress || noop;
  const thinking = sendThinking || noop;

  async function callDeepSeek(messages, { json, onReasoning } = {}) {
    const res = await Supabase.deepseek(messages, { json });
    if (!res.ok) throw new Error(res.error || ('DeepSeek HTTP ' + res.status));
    const data = res.data || {};
    const content = data.content || '';
    if (!content) throw new Error('Empty AI response.');
    if (onReasoning && data.reasoning) onReasoning(data.reasoning);
    return content;
  }

  function stripFences(s) {
    return String(s || '')
      .replace(/^```(?:json|javascript|js)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
  }

  // Shrinks page HTML for the model: keep JSON-LD + visible text, drop scripts/styles.
  function condenseHtml(html) {
    const h = String(html || '');
    const lds = [...h.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');
    const text = h
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return 'URL JSON-LD:\n' + lds.slice(0, 8000) + '\n\nPAGE TEXT:\n' + text.slice(0, 20000);
  }

  function trimThinking(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return t.length > 240 ? t.slice(0, 240) + '…' : t;
  }

  function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ── Generic scraper generation ──────────────────────────────────────────────
  // Preamble of shared helpers available to every AI-generated scraper. The model
  // writes only `async function run(ctx) {...}`; we prepend this and append
  // `return run(ctx);` to build a self-contained, materializable function body.
  const GENERIC_HELPERS = `
function decodeEntities(s){ return String(s==null?'':s)
  .replace(/&#x([0-9a-fA-F]+);/g,(_,n)=>String.fromCodePoint(parseInt(n,16)))
  .replace(/&#(\\d+);/g,(_,n)=>String.fromCodePoint(parseInt(n,10)))
  .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&apos;/g,"'")
  .replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
  .replace(/&bull;/g,'\\u2022').replace(/&hellip;/g,'\\u2026')
  .replace(/&mdash;/g,'\\u2014').replace(/&ndash;/g,'\\u2013').replace(/&reg;/g,'\\u00ae').replace(/&trade;/g,'\\u2122'); }
function normalizeShopUrl(src){ if(!src) return ''; const s=String(src).trim(); if(s.indexOf('$')>=0||s.indexOf('{')>=0||s.indexOf('}')>=0) return ''; const abs=s.startsWith('//')?'https:'+s:s; return abs.split('?')[0]; }
function ldBlocks(html){ return [...String(html||'').matchAll(/<script[^>]*application\\/ld\\+json[^>]*>([\\s\\S]*?)<\\/script>/g)].map(m=>m[1]); }
const fmtPrice = p => { const n = parseFloat(p); return isFinite(n) ? n.toFixed(2) : ''; };
function simpleRow(o){ return [{ SKU: o.sku||'', Name: o.name||'', Description: o.description||'', 'Short Description': o.shortDesc||'', 'Regular Price': o.regularPrice||o.price||'', Categories: o.categories||'', Images: o.images||[], 'Sale Price': o.salePrice||'' }]; }
function variableRows(title, parentImages, description, shortDesc, categories, optionName, variants, optionName2){
  optionName2=optionName2||''; const rows=[]; let rowId=1;
  const a1=[...new Set((variants||[]).map(v=>v.name).filter(Boolean))].join(',');
  const a2=[...new Set((variants||[]).map(v=>v.name2).filter(Boolean))].join(',');
  rows.push({ ID:rowId++, Parent:'', Type:'variable', SKU:'', Name:title, Images:(parentImages||[]).slice(0,4), 'Rey Variations extra images':'', Description:description||'', 'Short Description':shortDesc||'', Categories:categories||'', 'Regular Price':'', 'Sale Price':'', 'Attribute 1 name':optionName, 'Attribute 1 value(s)':a1, 'Attribute 1 visible':'1', 'Attribute 1 global':'1', 'Attribute 2 name':optionName2, 'Attribute 2 value(s)':a2, 'Attribute 2 visible':optionName2?'1':'', 'Attribute 2 global':optionName2?'1':'', 'Color Code':'' });
  const parentId=rowId-1;
  for(const v of variants){ rows.push({ ID:rowId++, Parent:'id:'+parentId, Type:'variation', SKU:v.sku||'', Name:title, Images:(v.images&&v.images.length)?[v.images[0]]:[], 'Rey Variations extra images':(v.extras&&v.extras.length)?v.extras:[], Description:'', 'Short Description':'', Categories:'', 'Regular Price':v.regularPrice||'', 'Sale Price':v.salePrice||'', 'Attribute 1 name':optionName, 'Attribute 1 value(s)':v.name||'', 'Attribute 1 visible':'', 'Attribute 1 global':'1', 'Attribute 2 name':optionName2, 'Attribute 2 value(s)':v.name2||'', 'Attribute 2 visible':'', 'Attribute 2 global':optionName2?'1':'', 'Color Code':v.colorCode||'' }); }
  return rows;
}
`;

  function buildScraperBody(runBody) {
    return GENERIC_HELPERS + '\n' + runBody + '\nreturn run(ctx);';
  }

  function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  function brandFromDomain(domain) {
    if (!domain) return '';
    return domain.split('.')[0].replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  // Returns the materializable body for a scraper of this URL, if one exists in
  // the Supabase registry. `type` is 'simple' | 'variable' | 'auto'.
  async function scraperBodyFor(url, type) {
    const domain = domainOf(url);
    if (!domain) return '';
    const rows = await Supabase.listScrapersForDomain(domain);
    const simple = rows.find(r => r.type === 'simple' && r.code);
    const variable = rows.find(r => r.type === 'variable' && r.code);
    if (type === 'simple') return simple ? simple.code : '';
    if (type === 'variable') return variable ? variable.code : '';
    return variable ? variable.code : (simple ? simple.code : '');
  }

  async function getScraperEntry(domain, type) {
    const rows = await Supabase.listScrapersForDomain(domain);
    return rows.find(r => r.type === type) || null;
  }

  async function saveScraperEntry(domain, type, fields) {
    await Supabase.upsertScraper(Object.assign({ domain, type }, fields));
  }

  // ── Predefined module (shared scraper engine, served from Supabase) ──────────
  // Cached in-process (vs chrome.storage.local in the extension).
  let predefinedCachedBody = '';
  let predefinedCachedVersion = 0;

  async function predefinedBody() {
    if (predefinedCachedBody) {
      const serverVersion = await Supabase.getPredefinedVersion();
      if (serverVersion != null && serverVersion === predefinedCachedVersion) return predefinedCachedBody;
    }
    const mod = await Supabase.getPredefinedModule();
    if (!mod || !mod.code) return predefinedCachedBody || '';
    const body = mod.code + '\nreturn self.ProductScraper.scrapeProduct(ctx);';
    predefinedCachedBody = body;
    predefinedCachedVersion = mod.version;
    return body;
  }

  // Compact but structured page sample for the generator: title + og meta +
  // JSON-LD + tag-preserving HTML (scripts/styles stripped).
  function scraperHtmlSample(html) {
    const h = String(html || '');
    const lds = [...h.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n---\n');
    const title = (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const og = [...h.matchAll(/<meta[^>]*property="og:([^"]+)"[^>]*content="([^"]*)"[^>]*>/gi)].map(m => 'og:' + m[1] + '=' + m[2]).join('\n');
    const ogTitle = (h.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"[^>]*>/i) || [])[1] || '';
    const stripped = h
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    let anchor = -1;
    const h1 = stripped.search(/<h1\b/i);
    if (h1 >= 0) anchor = h1;
    else {
      const atc = stripped.search(/add[\s-]*to[\s-]*(cart|bag|basket)|addtocart|buy[\s-]*now/i);
      if (atc >= 0) anchor = atc;
      else {
        const needle = (ogTitle || title).replace(/[|–—].*$/, '').trim().slice(0, 60);
        if (needle) { const ti = stripped.indexOf(needle); if (ti >= 0) anchor = ti; }
      }
    }

    const windowed = anchor >= 0
      ? stripped.slice(Math.max(0, anchor - 1500), anchor + 22000)
      : stripped.slice(0, 16000);

    return 'TITLE: ' + title + '\n\nMETA:\n' + og + '\n\nJSON-LD BLOCKS:\n' + lds.slice(0, 8000) + '\n\nPRODUCT HTML (around the product area):\n' + windowed;
  }

  const GENERATE_SYSTEM = (type) => `You are an expert web-scraper engineer. Write a single JavaScript function for a Chrome extension that extracts product data from a product page's HTML.

Write ONLY the function definition (no markdown fences, no explanation):

async function run(ctx) { ... }

Inputs available on ctx:
- ctx.mainHtml (string) — the full page HTML (already downloaded for you).
- ctx.url (string) — the page URL.
- ctx.fetchText(url, opts) / ctx.fetchJson(url, opts) — optional fetch helpers (return string/object). Use only if the data is not already in mainHtml.

Helpers already defined in scope (DO NOT redefine them): decodeEntities(s), ldBlocks(html), normalizeShopUrl(src), fmtPrice(p), simpleRow(obj), variableRows(title, parentImages, description, shortDesc, categories, optionName, variants, optionName2).

ldBlocks(html) returns an array of RAW JSON **strings** (the text inside each <script type="application/ld+json"> tag). Each must be JSON.parse()'d (try/catch) before reading fields:
const blocks = ldBlocks(ctx.mainHtml).map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);

──────────────────────────────────────────────────────────────
OUTPUT CONTRACT (NON-NEGOTIABLE):

The ONLY correct return value is { rows, title }. You MUST build "rows" by calling the helper — do NOT hand-construct row objects and do NOT invent your own field names, because the downstream table columns are fixed and only these helpers produce them:

- simple product:   return { rows: simpleRow({ sku, name, description, shortDesc, regularPrice, salePrice, categories, images }), title };
- variable product: return { rows: variableRows(title, parentImages, description, shortDesc, categories, optionName, variants, optionName2), title };

"title" is the product name (string). Never return rows as a plain object or with your own key names — always exactly simpleRow([...]) / variableRows(...) output.

──────────────────────────────────────────────────────────────
HOW TO WORK — READ THIS CAREFULLY:

Every website has a UNIQUE HTML structure. You MUST NOT assume specific class names, meta tags, attribute names, or platforms (WooCommerce, Shopify, JSON-LD, etc.). Your job is to INSPECT ctx.mainHtml for THIS specific page and discover, from its actual content, where each output field lives. There is no standard selector list to follow — derive the mapping from the page itself.

Think in this order:
1. Read ctx.mainHtml. Identify the product's main content area (near the product name/title, price, and "add to cart" button).
2. Look for structured data embedded in the page — JSON-LD blocks, inline JSON in <script> tags (e.g. "var product = {...}", "__NEXT_DATA__", "ShopifyAnalytics", "data-*" attributes). If present, read the fields DIRECTLY from it. Structured data is self-describing: use whatever keys it actually contains.
3. For every field that is NOT available as structured data, locate it in the visible HTML by looking at what is actually near the product content:
   - name/title: the page title, an <h1>, or a product-name heading.
   - price: a number with a currency symbol/code near the title or add-to-cart button. If two numbers are shown together (one struck-through or smaller), the higher is the regular price and the lower is the sale price.
   - sku/id: an identifier label ("SKU", "barcode", "product code", "MPN", "UPC", "EAN", "Code") with a value near it, or the numeric id in the URL.
   - images: the large <img> src(s) in the product gallery area.
   - description: a longer block of prose text describing the product.
   - categories: breadcrumb links or "Category" labels.
4. Do NOT hardcode anything you saw on a previous page. Match THIS page's structure.

NEVER return an empty field just because there is "no JSON-LD" — that is a failure. If a field's data exists anywhere in mainHtml, find it.

──────────────────────────────────────────────────────────────

${type === 'variable'
  ? `This is a VARIABLE product: it has selectable options (size, colour, shade, etc.) and EACH option usually has its own price and its own photo.

Build rows with: variableRows(title, parentImages, description, shortDesc, categories, optionName, variants, optionName2)

The variants array is the core of a variable product. Discover each option's data from THIS page's structure:
- Find the source of the option list — it may be embedded JSON (JSON-LD hasVariant/offers arrays, a "data-product_variations" attribute, inline "product.variants", "__NEXT_DATA__", etc.), or HTML elements (swatches, <option>, radio inputs) with their own data attributes. Use whichever this page actually provides.
- For EVERY option, produce one variant object with its OWN data (this is the whole point):
  * name         — the option value (e.g. "Black", "Size M", "42").
  * name2        — the SECOND attribute's value for this option, ONLY when the product has more than one attribute (e.g. a product varying by colour AND size: name="Black", name2="M"; or material AND size: name="Cotton", name2="L"). If the product has a single attribute, set name2 to ''.
  * sku          — that option's own SKU/id, if the page provides one per option; else ''.
  * regularPrice — that option's OWN normal price (numeric string like "15.00", via fmtPrice).
  * salePrice    — that option's OWN sale price, ONLY if it is discounted; else ''.
  * images       — array of image URLs for THIS SPECIFIC option (its own photo). The FIRST image is the main photo. If a specific option has no distinct photo, set images to [] (never reuse another option's photo as if it were its own).
  * extras       — extra gallery images for this option (may be []).
  * colorCode    — hex colour or swatch image URL for this option, if the page provides it; else ''.
- "parentImages" = photos shown before any option is selected (the shared gallery). If the page only has per-option images, pass [].
- "optionName" = the attribute name (e.g. "Color", "Size", "Shade") — read it from the page; default to "Option" if absent.
- "optionName2" = the SECOND attribute name, ONLY when the product has more than one selectable attribute (e.g. "Size" when the first is "Color", or "Material" when the first is "Size"). This applies to ANY multi-attribute product, not just clothing. When there is only one attribute, pass '' (empty string) and leave every variant's name2 as ''.

CRITICAL: do NOT copy one price or one image across all options. If the page stores per-option data in a JSON structure whose keys differ from the examples above, read THOSE keys — the structure is whatever the page actually uses.`
  : `This is a SIMPLE product (single product, one price, no options). Build rows with: simpleRow({ sku, name, description, shortDesc, regularPrice, salePrice, categories, images }) and return { rows, title }. images is an array of image URL strings (normalizeShopUrl() each). regularPrice/salePrice are numeric strings like "20.76" (via fmtPrice). Use structured data if present; otherwise locate each field in the visible HTML as described above.`}

RULES:
- Never use document, window, location, self, or any DOM API. Only pure JS + regex + JSON + the provided helpers.
- ALWAYS build rows via simpleRow(...) (simple) or variableRows(...) (variable) and return { rows, title }. Do NOT hand-build row objects or invent your own key names.
- Inspect ctx.mainHtml and derive the mapping from THIS page. Do not assume any specific framework, class, or meta tag.
- Use fmtPrice() to normalise every price, and strip query strings from image URLs (normalizeShopUrl()).
- Images: match ONLY real <img> src values (or srcset/data URLs) that look like actual URLs. Inline script blocks often contain JS template placeholders (a dollar sign followed by braces, e.g. "$img") that look like image markup — NEVER emit those as an image URL, and never emit any value containing "$" or "{". Strip script blocks (except JSON-LD) before matching images, or filter matches to those starting with http/https.
- Robustness: optional chaining and fall back to '' for missing fields.`;

  // Drop obviously-broken image URLs (template placeholders like "$img" /
  // "${img}") so one bad URL can't make WooCommerce reject the whole product.
  function cleanImageList(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
      .map(u => String(u == null ? '' : u).trim())
      .filter(u => u !== '' && u.indexOf('$') < 0 && u.indexOf('{') < 0 && u.indexOf('}') < 0 &&
        (u.startsWith('http://') || u.startsWith('https://') || u.startsWith('//') || u.startsWith('data:')));
  }
  function sanitizeRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map(r => {
      if (!r || typeof r !== 'object') return r;
      const c = Object.assign({}, r);
      for (const k of ['Images', 'Rey Variations extra images']) {
        if (Array.isArray(c[k])) c[k] = cleanImageList(c[k]);
      }
      return c;
    });
  }

  // Runs a materializable scraper body (GENERIC_HELPERS + run(ctx)) against a
  // given HTML string. `new Function` is fine in Node (no MV3 CSP restriction),
  // and the page HTML is passed in as a string — the scraper never touches a DOM.
  // Errors are caught and returned as { ok:false, error } so the agentic loop can
  // feed the thrown message back to the model, mirroring evalScraperInMain.
  async function runScraperCode(code, ctx) {
    try {
      const fetchText = async (u, opts) => {
        const r = await fetch(u, Object.assign({}, opts));
        if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + u);
        return r.text();
      };
      const fetchJson = async (u, opts) => {
        const r = await fetch(u, Object.assign({}, opts));
        if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + u);
        return r.json();
      };
      const fn = new Function('ctx', code);
      const out = await fn(Object.assign({}, ctx, { fetchText, fetchJson }));
      return {
        ok: true,
        rows: sanitizeRows((out && out.rows) || []),
        title: (out && out.title) || '',
        site: (out && out.site) || '',
        brand: (out && out.brand) || '',
      };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  // Verdict for a scraper run. Returns { ok, problem }.
  function evaluateResult(res, type) {
    if (!res || !Array.isArray(res.rows) || !res.rows.length) {
      return { ok: false, problem: 'no rows were produced.' };
    }
    if (type === 'variable') {
      const hasParent = res.rows.some(r => r && r.Type === 'variable');
      if (!hasParent) {
        return { ok: false, problem: 'there is no "variable" parent row — you must call variableRows(...) and return its rows (a variable row followed by variation rows).' };
      }
      const vars = res.rows.filter(r => r && r.Type === 'variation');
      if (!vars.length) {
        return { ok: false, problem: 'no "variation" rows were produced — this product has options, so build a variants array and pass it to variableRows(...).' };
      }
      const withPrice = vars.filter(r => r['Regular Price'] && r['Regular Price'] !== '').length;
      const withImg = vars.filter(r => Array.isArray(r.Images) && r.Images.length).length;
      if (withPrice === 0 || withImg === 0) {
        const missing = [];
        if (withPrice === 0) missing.push('no variant has its own price');
        if (withImg === 0) missing.push('no variant has its own photo');
        return { ok: false, problem: missing.join(' and ') + ' — locate each variant\'s own price and photo in the HTML and map them.' };
      }
      return { ok: true, problem: '' };
    }
    // simple
    const row = res.rows[0] || {};
    if (typeof row.Name !== 'string') {
      return { ok: false, problem: 'the row is not in the required schema (missing "Name") — call simpleRow({...}) and return { rows, title }.' };
    }
    const hasPrice = !!(row['Regular Price'] || row['Sale Price']);
    const hasImg = Array.isArray(row.Images) && row.Images.length > 0;
    if (!hasPrice || !hasImg) {
      const missing = [];
      if (!hasPrice) missing.push('price');
      if (!hasImg) missing.push('image');
      return { ok: false, problem: 'no ' + missing.join(' or ') + ' was extracted — locate it in the page HTML.' };
    }
    return { ok: true, problem: '' };
  }

  // Compact dump of the rows a scraper produced, so the agent can SEE its output.
  function describeRows(rows) {
    if (!Array.isArray(rows) || !rows.length) return 'NO ROWS (empty).';
    const out = rows.slice(0, 30).map((r, i) => {
      if (!r) return '[' + i + '] null';
      const t = r.Type || 'row';
      if (t === 'variation') {
        return '[' + i + '] variation | name=' + JSON.stringify(r['Attribute 1 value(s)'])
          + ' | sku=' + JSON.stringify(r.SKU)
          + ' | regular=' + JSON.stringify(r['Regular Price'])
          + ' | sale=' + JSON.stringify(r['Sale Price'])
          + ' | images=' + (Array.isArray(r.Images) ? r.Images.length : 0);
      }
      return '[' + i + '] ' + t
        + ' | name=' + JSON.stringify(r.Name)
        + ' | sku=' + JSON.stringify(r.SKU)
        + ' | regular=' + JSON.stringify(r['Regular Price'])
        + ' | sale=' + JSON.stringify(r['Sale Price'])
        + ' | categories=' + JSON.stringify(r.Categories)
        + ' | images=' + (Array.isArray(r.Images) ? r.Images.length : 0)
        + ' | desc=' + JSON.stringify((r.Description || '').slice(0, 80));
    }).join('\n');
    return out + (rows.length > 30 ? '\n... and ' + (rows.length - 30) + ' more rows' : '');
  }

  async function generateScraper(html, url, type, hint) {
    const effectiveType = type === 'variable' ? 'variable' : 'simple';
    const sample = scraperHtmlSample(html);
    const MAX_TURNS = 6;

    const messages = [
      { role: 'system', content: GENERATE_SYSTEM(effectiveType) },
      { role: 'user', content: 'Product page URL: ' + url + (hint ? '\n\n' + hint : '') + '\n\n' + sample },
    ];

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      progress(8, 'running', turn === 1 ? 'Thinking…' : 'Agent turn ' + turn + '/' + MAX_TURNS);
      thinking(turn === 1
        ? 'Reading the page and designing a scraper for this site…'
        : 'Reviewing the previous attempt and correcting it…');

      const raw = await callDeepSeek(messages, {
        onReasoning: (r) => thinking(trimThinking(r)),
      });
      const runBody = stripFences(raw);

      if (!/async\s+function\s+run\s*\(/.test(runBody)) {
        thinking('The agent replied without a run() function — asking it to retry…');
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: 'You did not return an "async function run(ctx) { ... }". Reply with ONLY the function definition.' });
        continue;
      }

      thinking('Running the generated scraper against the page…');
      const body = buildScraperBody(runBody);
      const res = await runScraperCode(body, { url, mainHtml: html, productType: effectiveType });

      if (!res.ok) {
        thinking('The scraper threw an error — the agent is fixing the code…');
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: 'Your code threw an error:\n' + (res.error || 'unknown error') + '\n\nFix the code and return a corrected run() function.' });
        continue;
      }

      const verdict = evaluateResult(res, effectiveType);
      if (verdict.ok) {
        thinking('Scraper works — extracted ' + res.rows.length + ' row' + (res.rows.length === 1 ? '' : 's') + '.');
        return { body, rows: res.rows.length, title: res.title };
      }

      thinking('Scraper ran but the mapping is off: ' + verdict.problem);
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content: 'Your scraper ran and returned these rows:\n' + describeRows(res.rows)
          + '\n\nProblem: ' + verdict.problem + '\n\nFix the mapping and return a corrected run() function.',
      });
    }

    throw new Error('Could not generate a working scraper after ' + MAX_TURNS + ' agent turns.');
  }

  const PRODUCT_CHECK_PROMPT = [
    {
      role: 'system',
      content: 'You classify a web page. Respond with JSON only, no other text. Determine: (1) isProductPage — true if this is a product detail page (a single purchasable product with a name, price, and add-to-cart), false for a category/listing/home page. (2) productType — "simple" if it is a single product with one price and no options (size/color/etc.), or "variable" if it has selectable options/variants (size, color, etc.) that change the price; null if not a product page. (3) attributeCount — for variable products only: the number of distinct selectable attributes (1 or 2; e.g. just Color = 1, Color + Size = 2); null for simple or non-product. (4) attributes — for variable products only: an array, one object per attribute, each {"name": "...", "swatched": true|false, "swatchType": "color_code"|"image_url"|null}. name is the attribute label in lowercase (e.g. "color", "size", "weight", "flavor"). swatched is true only if selecting that attribute shows a visual swatch or thumbnail. swatchType is how the swatch is shown: "color_code" for a solid colour/hex swatch, "image_url" for a small image/thumbnail, or null if not swatched or unknown. Use [] for simple or non-product. Example: {"isProductPage": true, "productType": "variable", "attributeCount": 2, "attributes": [{"name": "color", "swatched": true, "swatchType": "image_url"}, {"name": "size", "swatched": false, "swatchType": null}]}.',
    },
  ];

  // Human-readable hint for the scraper-generation agent, built from the
  // classification: the attribute count/names + swatch info help the agent map
  // optionName/optionName2 and each variant's colorCode on the first try.
  function buildAttributeHint(pType, attrs) {
    if (pType !== 'variable') return '';
    const list = (attrs || []).filter(a => a && a.name);
    if (!list.length) return '';
    const parts = list.map(a => {
      const name = String(a.name);
      let swatch = '';
      if (a.swatched) {
        swatch = a.swatchType === 'image_url' ? ' (swatched: image thumbnails)'
          : (a.swatchType === 'color_code' ? ' (swatched: colour codes)' : ' (swatched)');
      }
      return name + swatch;
    });
    return 'Detected attributes: ' + parts.join(', ') + '. '
      + 'Use the first attribute as optionName and, if there is a second, the second as optionName2 '
      + '(set each variant\'s name2 accordingly). If an attribute is swatched with a colour code or image thumbnail, '
      + 'store that value in the variant\'s colorCode field.';
  }

  async function handleAddScraper({ url, html }) {
    let step = 0;
    try {
      if (!url) return { ok: false, error: 'No page loaded.' };
      if (!html) return { ok: false, error: 'Could not read the page HTML. Make sure a page is loaded.' };

      // Step 1: read the open page's HTML (already passed in).
      step = 1; progress(1, 'running');
      progress(1, 'done', formatBytes(html.length));

      // Step 2: ask AI to classify the page (product page + simple/variable).
      step = 2; progress(2, 'running');
      const checkRaw = await callDeepSeek(
        PRODUCT_CHECK_PROMPT.concat([{ role: 'user', content: condenseHtml(html) }]),
        { json: true }
      );
      progress(2, 'done', 'Ai Agent');

      // Step 3 + 4: report whether it's a product page, and if so, simple or variable.
      let check;
      try { check = JSON.parse(stripFences(checkRaw)); } catch (e) { check = null; }
      const isProduct = !!(check && check.isProductPage);
      const pType = (check && check.productType) ? String(check.productType).toLowerCase() : '';
      const attrs = (check && Array.isArray(check.attributes)) ? check.attributes : [];
      let attrCount = (check && check.attributeCount) ? parseInt(check.attributeCount, 10) : 0;
      if (attrCount !== 1 && attrCount !== 2) attrCount = attrs.length >= 2 ? 2 : (attrs.length === 1 ? 1 : 0);

      if (!isProduct) {
        progress(3, 'fail', 'Not a product page');
        progress(4, 'skip', '—');
        progress(5, 'skip', '—');
        progress(6, 'skip', '—');
        progress(7, 'skip', '—');
        progress(8, 'skip', '—');
        return { notProduct: true, message: 'This page is not a product page.' };
      }

      progress(3, 'done', 'Product page');
      if (pType === 'simple' || pType === 'variable') progress(4, 'value', pType);
      else progress(4, 'value', 'unknown');

      // Steps 5-7: attribute detail (variable only) — this guides the agent.
      if (pType === 'variable') {
        const n = attrCount === 2 ? 2 : 1;
        progress(5, 'value', 'Variable · ' + n + ' attribute' + (n === 1 ? '' : 's'));
        const names = attrs.map(a => (a && a.name) ? String(a.name) : '').filter(Boolean);
        progress(6, 'value', names.length ? names.join(', ') : 'Unknown');
        const colorAttr = attrs.find(a => a && /color|colour/.test(String(a.name || '')));
        if (colorAttr) {
          if (colorAttr.swatched) {
            progress(7, 'value', colorAttr.swatchType === 'image_url' ? 'Color — image swatch' : (colorAttr.swatchType === 'color_code' ? 'Color — colour code' : 'Color — swatched'));
          } else {
            progress(7, 'value', 'Color — not swatched');
          }
        } else {
          progress(7, 'value', 'No color attribute');
        }
      } else {
        progress(5, 'skip', '—');
        progress(6, 'skip', '—');
        progress(7, 'skip', '—');
      }

      // Step 8: generate (or reuse) a scraper for this site + product type.
      step = 8; progress(8, 'running');
      const domain = domainOf(url);
      const type = pType === 'variable' ? 'variable' : 'simple';
      const existingEntry = await getScraperEntry(domain, type);
      const alreadyExists = !!existingEntry && (existingEntry.is_predefined || (!!existingEntry.code && !!existingEntry.verified));
      let generated = false;
      if (alreadyExists) {
        progress(8, 'done', 'Already exists');
      } else {
        const { body, rows } = await generateScraper(html, url, type, buildAttributeHint(pType, attrs));
        await saveScraperEntry(domain, type, {
          brand: (existingEntry && existingEntry.brand) || brandFromDomain(domain),
          example: url,
          code: body,
          is_predefined: false,
        });
        generated = true;
        progress(8, 'done', rows + ' rows');
      }
      return {
        productPage: true, productType: pType, generated, alreadyExists,
        message: alreadyExists
          ? 'A ' + type + ' scraper already exists for this site.'
          : (pType ? 'This is a ' + pType + ' product page.' : 'This is a product page.'),
      };
    } catch (e) {
      if (step) progress(step, 'fail', (e && e.message) || String(e));
      return { ok: false, error: (e && e.message) || String(e) || 'Unknown error' };
    }
  }

  async function handleScrape({ url, html, productType }) {
    if (!url) return { ok: false, error: 'No page loaded.' };
    const customBody = await scraperBodyFor(url, productType || 'auto');
    if (customBody) {
      const r = await runScraperCode(customBody, { url, mainHtml: html, productType: productType || 'auto' });
      if (r.ok) return { ok: true, rows: r.rows, title: r.title, site: 'custom', brand: '' };
      return r;
    }
    const body = await predefinedBody();
    if (!body) return { ok: false, error: 'Could not load the scraper engine. Check your connection and try again.' };
    const r = await runScraperCode(body, { url, mainHtml: html, productType: productType || 'auto' });
    if (r.ok) return { ok: true, rows: r.rows, title: r.title, site: r.site || '', brand: r.brand || '' };
    return r;
  }

  // ── Fix an existing scraper based on user corrections ────────────────────────
  async function fixScraper({ url, html, type, corrections }) {
    try {
      if (!url) return { ok: false, error: 'No page loaded.' };
      const domain = domainOf(url);
      const effType = type === 'variable' ? 'variable' : 'simple';
      const entry = await getScraperEntry(domain, effType);
      if (!entry || !entry.code) return { ok: false, error: 'No scraper found for this site.' };

      const sample = scraperHtmlSample(html);

      const fixLines = (corrections || []).map(c => {
        const cur = (c.current == null || c.current === '') ? '(empty)' : String(c.current);
        const corr = (c.correct && String(c.correct).trim())
          ? ' -> should be "' + String(c.correct).trim() + '"'
          : ' (current value is wrong)';
        return '- ' + c.field + ': currently "' + cur + '"' + corr;
      }).join('\n');

      let lastError = '';
      for (let attempt = 1; attempt <= 2; attempt++) {
        const messages = [
          { role: 'system', content: GENERATE_SYSTEM(effType) },
          { role: 'user', content: 'Product page URL: ' + url + '\n\n' + sample
            + '\n\nThe scraper you generated extracted some fields incorrectly. Fix the scraper code so it extracts these fields correctly:\n' + fixLines
            + (lastError ? '\n\nYour previous attempt failed with: ' + lastError + ' — fix it.' : '') },
        ];
        const raw = await callDeepSeek(messages, {});
        const runBody = stripFences(raw);
        if (!/async\s+function\s+run\s*\(/.test(runBody)) { lastError = 'run() function not found'; continue; }
        const body = buildScraperBody(runBody);
        const res = await runScraperCode(body, { url, mainHtml: html, productType: effType });
        if (res.ok) {
          await saveScraperEntry(domain, effType, { code: body });
          return { ok: true, rows: res.rows, title: res.title, site: 'custom' };
        }
        lastError = res.error;
      }
      return { ok: false, error: 'Could not fix scraper: ' + lastError };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  async function verifyScraper({ url, type }) {
    try {
      const domain = domainOf(url);
      const effType = type === 'variable' ? 'variable' : 'simple';
      await Supabase.setVerified(domain, effType, true);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  // ── Swatch image relay — downloads CORS-free, returns base64 data URL ──
  async function fetchSwatchAsDataUrl(swatchUrl) {
    try {
      const resp = await fetch(swatchUrl);
      if (!resp.ok) return '';
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const mime = resp.headers.get('content-type') || 'image/jpeg';
      return 'data:' + mime + ';base64,' + Buffer.from(binary, 'binary').toString('base64');
    } catch (e) { return ''; }
  }

  // ── Connection test (Rey Swatches Import plugin endpoint) ──────────────
  async function wcTest({ store, authKey }) {
    try {
      const base = store.replace(/\/+$/, '') + '/wp-json/scraper/v1/import-csv';
      const r = await fetch(base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Scraper-Key': authKey || '',
        },
        body: JSON.stringify({ csv: 'SKU,Name,Regular Price\nTEST,Test Product,0' }),
      });
      await r.json().catch(() => ({}));
      if (r.status === 403) throw new Error('Invalid auth key. Check the key from the plugin dashboard.');
      if (r.status === 404) throw new Error('Rey Swatches Import plugin not found. Install and activate it first.');
      return { ok: true, message: 'Connected — import endpoint reachable.' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ── CSV import via the plugin endpoint ──────────────────────────────────
  async function wcImport({ store, authKey, csv, skipResize }) {
    try {
      const url = store.replace(/\/+$/, '') + '/wp-json/scraper/v1/import-csv';
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Scraper-Key': authKey || '',
        },
        body: JSON.stringify({ csv, skip_resize: !!skipResize }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status === 403) throw new Error('Invalid auth key. Check the key from the plugin dashboard.');
      if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`);
      const created = (data.created_variable || 0) + (data.created_simple || 0);
      const updated = (data.updated_variable || 0) + (data.updated_simple || 0);
      const skipped = data.skipped || 0;
      if (created + updated === 0 && skipped > 0) {
        const msgs = Array.isArray(data.messages) ? data.messages.filter(Boolean) : [];
        throw new Error(msgs.length ? msgs.join(' | ') : 'No products were imported.');
      }
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return {
    domainOf,
    handleScrape,
    handleAddScraper,
    fixScraper,
    verifyScraper,
    wcTest,
    wcImport,
    fetchSwatchAsDataUrl,
    runScraperCode,
  };
};
