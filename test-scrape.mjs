// Scraper test harness — downloads product pages and runs the built-in
// scrapers against them in a Node VM (jsdom supplies DOMParser).
// Usage: node test-scrape.mjs            (run the default product list)
//        node test-scrape.mjs <url> ...   (test specific URLs)
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, 'supabase', 'predefined', 'scrapers.js'), 'utf8');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Build VM sandbox ─────────────────────────────────────────────────────────
const win = new JSDOM('').window;
const sandbox = {
  URL, URLSearchParams, Headers, AbortController, AbortSignal,
  DOMParser: win.DOMParser,
  document: win.document,
  fetch: globalThis.fetch,
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  TextDecoder, TextEncoder,
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  Blob, File,
};
sandbox.self = sandbox;
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

createContext(sandbox);
runInContext(source, sandbox, { filename: 'scrapers.js' });

const { scrapeProduct, detectSite, brands } = sandbox.ProductScraper;

// ── Fetch helpers passed as ctx ─────────────────────────────────────────────
async function http(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) }, redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return res;
}
const fetchText = async (u, opts) => (await http(u, opts)).text();
const fetchJson = async (u, opts) => (await http(u, opts)).json();

// ── Run one product ─────────────────────────────────────────────────────────
async function runOne(url, opts = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) return { url, error: 'HTTP ' + res.status, blocked: true };
  const html = await res.text();
  const finalUrl = res.url || url;
  try {
    const out = await scrapeProduct({
      url: finalUrl,
      mainHtml: html,
      productType: opts.type || 'auto',
      fetchText: async (u, o) => fetchText(resolveUrl(u, finalUrl), o),
      fetchJson: async (u, o) => fetchJson(resolveUrl(u, finalUrl), o),
    });
    return summarize(out, finalUrl, html);
  } catch (e) {
    return { url, error: e && e.message ? e.message : String(e) };
  }
}

function resolveUrl(u, base) {
  try { return new URL(u, base).href; } catch { return u; }
}

function summarize(out, url, html) {
  const rows = out.rows || [];
  const site = out.site || detectSite(url) || '';
  const variations = rows.filter(r => r.Type === 'variation');
  const first = rows[0] || {};
  const keys = Object.keys(first);
  const title = out.title || first.Name || first.name || '';
  const price = first['Regular Price'] || first.regularPrice || '';
  const images = Array.isArray(first.Images) ? first.Images.length : (first.Images ? 1 : 0);
  const nameVal = first.Name || first.name || '';
  const ok = !!title && rows.length > 0;
  const warnings = [];
  if (!title) warnings.push('no title');
  if (!nameVal) warnings.push('no name');
  if (!price || price === '15' || price === '') warnings.push('no/fallback price');
  if (!images) warnings.push('no images');
  if (variations.length && !first['Attribute 1 value(s)']) warnings.push('variants but no attr values');
  return {
    url, site, type: variations.length ? 'variable' : 'simple',
    rows: rows.length, variations: variations.length,
    title: (title || '').slice(0, 60),
    price: price || '',
    images,
    ok,
    warnings,
  };
}

// ── Default product list (one or more per site family) ──────────────────────
const EXTRA_PRODUCTS = [
  // sites without an example URL in the catalogue
  'https://www.dumyah.com/en/lego-classic-creative-bricks-11002',
  'https://semsem.me/products/brush-set',
  'https://www.galaxus.ch/en/s1/product/example-123',
  'https://www.carrefouruae.com/mafuae/en/example',
  'https://enzoitaly.com/en/products/example',
  'https://celenesbysweden.com/products/example',
  'https://everymarket.com/products/example',
  'https://musejo.com/products/example',
].filter(u => !/example/.test(u)); // keep only real URLs; placeholders removed

const allExamples = (brands || [])
  .filter(b => b.example && b.example.startsWith('http'))
  .map(b => ({ url: b.example, name: b.name }));

function defaultProducts() {
  return allExamples.map(b => b.url);
}

const urls = process.argv.slice(2).length
  ? process.argv.slice(2)
  : defaultProducts();

// Show which brand each URL belongs to (for readability)
const brandFor = url => {
  const hit = (brands || []).find(b => b.example === url);
  return hit ? hit.name : '';
};

console.log('Testing ' + urls.length + ' product(s)...\n');
let pass = 0, fail = 0, blocked = 0;
for (const url of urls) {
  const r = await runOne(url);
  const brand = brandFor(url);
  const label = brand ? ` [${brand}]` : '';
  if (r.ok) {
    pass++;
    console.log('PASS  ' + url + label);
    console.log('      site=' + r.site + ' type=' + r.type + ' rows=' + r.rows + ' vars=' + r.variations + ' imgs=' + r.images + ' price=' + r.price);
    console.log('      title="' + r.title + '"');
  } else {
    fail++;
    if (r.blocked) blocked++;
    console.log('FAIL  ' + url + label);
    console.log('      ' + (r.error || '') + (r.blocked ? ' (fetch blocked)' : ''));
  }
  if (r.warnings && r.warnings.length) console.log('      WARN ' + r.warnings.join(', '));
  console.log('');
}
console.log('Summary: ' + pass + ' passed, ' + fail + ' failed (' + blocked + ' blocked by site).');
