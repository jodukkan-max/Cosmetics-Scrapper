// Verify the improved AI prompt produces a scraper that maps each variant to
// its own price + photo. Usage: node test-ai-gen.mjs <html-file> <url>
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { JSDOM } from 'jsdom';
import { createContext, runInContext } from 'node:vm';

const [file, url, typeArg] = process.argv.slice(2);
const type = typeArg || 'variable';
const html = readFileSync(file, 'utf8');

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const KEY = process.env.DEEPSEEK_API_KEY || '';

// Copied from background.js (must stay in sync).
const GENERIC_HELPERS = `
function decodeEntities(s){ return String(s==null?'':s)
  .replace(/&#x([0-9a-fA-F]+);/g,(_,n)=>String.fromCodePoint(parseInt(n,16)))
  .replace(/&#(\\d+);/g,(_,n)=>String.fromCodePoint(parseInt(n,10)))
  .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&apos;/g,"'")
  .replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
  .replace(/&bull;/g,'\\u2022').replace(/&hellip;/g,'\\u2026')
  .replace(/&mdash;/g,'\\u2014').replace(/&ndash;/g,'\\u2013').replace(/&reg;/g,'\\u00ae').replace(/&trade;/g,'\\u2122'); }
function normalizeShopUrl(src){ if(!src) return ''; const abs=src.startsWith('//')?'https:'+src:src; return abs.split('?')[0]; }
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
- Always return { rows, title } where title is the product name.
- Inspect ctx.mainHtml and derive the mapping from THIS page. Do not assume any specific framework, class, or meta tag.
- Use fmtPrice() to normalise every price, and strip query strings from image URLs (normalizeShopUrl()).
- Robustness: optional chaining and fall back to '' for missing fields.`;

function scraperHtmlSample(h) {
  h = String(h || '');
  const lds = [...h.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n---\n');
  const title = (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const og = [...h.matchAll(/<meta[^>]*property="og:([^"]+)"[^>]*content="([^"]*)"[^>]*>/gi)].map(m => 'og:' + m[1] + '=' + m[2]).join('\n');
  const ogTitle = (h.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"[^>]*>/i) || [])[1] || '';
  const stripped = h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/\s+/g, ' ').trim();

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
    ? stripped.slice(Math.max(0, anchor - 3000), anchor + 40000)
    : stripped.slice(0, 30000);

  return 'TITLE: ' + title + '\n\nMETA:\n' + og + '\n\nJSON-LD BLOCKS:\n' + lds.slice(0, 20000) + '\n\nPRODUCT HTML (around the product area):\n' + windowed;
}

function stripFences(s) { return String(s || '').replace(/^```(?:json|javascript|js)?\s*/i, '').replace(/\s*```$/, '').trim(); }

async function callDeepSeek(messages) {
  const r = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY, 'Accept-Encoding': 'gzip' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', messages, stream: false }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('DeepSeek HTTP ' + r.status + ': ' + t.slice(0, 300)); }
  let buf = Buffer.from(await r.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  const d = JSON.parse(buf.toString('utf8'));
  return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
}

// ── run generated scraper in a VM ────────────────────────────────────────────
const win = new JSDOM('').window;
const sandbox = { URL, URLSearchParams, Headers, AbortController, DOMParser: win.DOMParser, document: win.document, fetch: globalThis.fetch, console, setTimeout, clearTimeout, TextDecoder, TextEncoder, atob: s => Buffer.from(s, 'base64').toString('binary'), btoa: s => Buffer.from(s, 'binary').toString('base64'), Blob, File };
sandbox.self = sandbox; sandbox.window = sandbox;
createContext(sandbox);

async function runBodyInVm(runBody) {
  const body = GENERIC_HELPERS + '\n' + runBody + '\nreturn run(ctx);';
  try {
    const out = await new Function('ctx', body)({ productType: type, url, mainHtml: html, fetchText: async u => (await fetch(u)).text(), fetchJson: async u => (await fetch(u)).json() });
    return { ok: true, rows: out.rows || [], title: out.title || '' };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function evaluateResult(res, type) {
  if (!res || !Array.isArray(res.rows) || !res.rows.length) return { ok: false, problem: 'no rows were produced.' };
  if (type === 'variable') {
    if (!res.rows.some(r => r && r.Type === 'variable')) return { ok: false, problem: 'no "variable" parent row — call variableRows(...).' };
    const vars = res.rows.filter(r => r && r.Type === 'variation');
    if (!vars.length) return { ok: false, problem: 'no "variation" rows produced.' };
    const withPrice = vars.filter(r => r['Regular Price'] && r['Regular Price'] !== '').length;
    const withImg = vars.filter(r => Array.isArray(r.Images) && r.Images.length).length;
    if (withPrice === 0 || withImg === 0) {
      const missing = [];
      if (withPrice === 0) missing.push('no variant has its own price');
      if (withImg === 0) missing.push('no variant has its own photo');
      return { ok: false, problem: missing.join(' and ') + '.' };
    }
    return { ok: true, problem: '' };
  }
  const row = res.rows[0] || {};
  if (typeof row.Name !== 'string') return { ok: false, problem: 'row missing "Name" — call simpleRow({...}).' };
  const hasPrice = !!(row['Regular Price'] || row['Sale Price']);
  const hasImg = Array.isArray(row.Images) && row.Images.length > 0;
  if (!hasPrice || !hasImg) {
    const missing = [];
    if (!hasPrice) missing.push('price');
    if (!hasImg) missing.push('image');
    return { ok: false, problem: 'no ' + missing.join(' or ') + '.' };
  }
  return { ok: true, problem: '' };
}

function describeRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return 'NO ROWS (empty).';
  return rows.slice(0, 30).map((r, i) => {
    if (!r) return '[' + i + '] null';
    const t = r.Type || 'row';
    if (t === 'variation') return '[' + i + '] variation | name=' + JSON.stringify(r['Attribute 1 value(s)']) + ' | sku=' + JSON.stringify(r.SKU) + ' | regular=' + JSON.stringify(r['Regular Price']) + ' | sale=' + JSON.stringify(r['Sale Price']) + ' | images=' + (Array.isArray(r.Images) ? r.Images.length : 0);
    return '[' + i + '] ' + t + ' | name=' + JSON.stringify(r.Name) + ' | sku=' + JSON.stringify(r.SKU) + ' | regular=' + JSON.stringify(r['Regular Price']) + ' | sale=' + JSON.stringify(r['Sale Price']) + ' | categories=' + JSON.stringify(r.Categories) + ' | images=' + (Array.isArray(r.Images) ? r.Images.length : 0);
  }).join('\n') + (rows.length > 30 ? '\n...and ' + (rows.length - 30) + ' more' : '');
}

// ── agentic loop ─────────────────────────────────────────────────────────────
const sample = scraperHtmlSample(html);
const MAX_TURNS = 6;
const messages = [
  { role: 'system', content: GENERATE_SYSTEM(type) },
  { role: 'user', content: 'Product page URL: ' + url + '\n\n' + sample },
];

let final = null;
for (let turn = 1; turn <= MAX_TURNS; turn++) {
  const raw = await callDeepSeek(messages);
  const runBody = stripFences(raw);
  if (turn === 1) {
    console.log('=== Generated run() (first 600 chars) ===');
    console.log(runBody.slice(0, 600));
  }
  if (!/async\s+function\s+run\s*\(/.test(runBody)) {
    messages.push({ role: 'assistant', content: raw });
    messages.push({ role: 'user', content: 'You did not return an "async function run(ctx) { ... }". Reply with ONLY the function definition.' });
    console.log('turn ' + turn + ': no run() found');
    continue;
  }
  const res = await runBodyInVm(runBody);
  if (!res.ok) {
    messages.push({ role: 'assistant', content: raw });
    messages.push({ role: 'user', content: 'Your code threw an error:\n' + res.error + '\n\nFix the code and return a corrected run() function.' });
    console.log('turn ' + turn + ': ERROR ' + res.error);
    continue;
  }
  const verdict = evaluateResult(res, type);
  console.log('turn ' + turn + ': ' + (verdict.ok ? 'OK' : 'FAIL — ' + verdict.problem) + ' | rows=' + res.rows.length);
  if (verdict.ok) { final = res; break; }
  messages.push({ role: 'assistant', content: raw });
  messages.push({ role: 'user', content: 'Your scraper ran and returned these rows:\n' + describeRows(res.rows) + '\n\nProblem: ' + verdict.problem + '\n\nFix the mapping and return a corrected run() function.' });
}

if (!final) { console.log('\nDID NOT CONVERGE after ' + MAX_TURNS + ' turns.'); process.exit(2); }

const rows = final.rows || [];
const vars = rows.filter(r => r.Type === 'variation');
console.log('\n=== RESULT (converged) ===');
console.log('title=' + JSON.stringify(final.title));
console.log('rows=' + rows.length + ' variants=' + vars.length);
if (vars.length) {
  const withPrice = vars.filter(r => r['Regular Price'] && r['Regular Price'] !== '').length;
  const withImg = vars.filter(r => Array.isArray(r.Images) && r.Images.length).length;
  console.log('variants with own price: ' + withPrice + '/' + vars.length);
  console.log('variants with own image: ' + withImg + '/' + vars.length);
  console.log('\nSample variants:');
  for (const v of vars.slice(0, 5)) {
    console.log('  ' + v['Attribute 1 value(s)'] + ' | SKU=' + v.SKU + ' | price=' + v['Regular Price'] + ' | img=' + (v.Images[0] || '(none)').slice(0, 70));
  }
} else {
  const r = rows[0];
  console.log('\nSimple row fields:');
  console.log('  Name=' + JSON.stringify(r.Name));
  console.log('  SKU=' + JSON.stringify(r.SKU));
  console.log('  Regular Price=' + JSON.stringify(r['Regular Price']));
  console.log('  Sale Price=' + JSON.stringify(r['Sale Price']));
  console.log('  Categories=' + JSON.stringify(r.Categories));
  console.log('  Images=' + JSON.stringify((r.Images || []).slice(0, 3)));
  console.log('  Description=' + JSON.stringify((r.Description || '').slice(0, 120)));
}
