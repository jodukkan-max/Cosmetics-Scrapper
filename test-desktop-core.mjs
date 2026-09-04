// Headless end-to-end test for the desktop scraper core (no Electron needed).
// Exercises the exact code path main.js uses: anonymous Supabase client →
// predefined module (served from Supabase) → new Function execution in Node →
// rows. Also verifies a scraper write/read/delete round-trip to Supabase.
//
// Usage: node test-desktop-core.mjs [productUrl]
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// supabase.js is an IIFE that attaches to `self` (the browser/SW global); alias
// it to globalThis so it lands on the Node global, exactly like main.js does.
globalThis.self = globalThis;
require('./desktop/renderer/supabase.js');
const createCore = require('./desktop/core.js');

const Supabase = globalThis.Supabase;

const progress = [];
const thinking = [];
const core = createCore({
  Supabase,
  sendProgress: (step, state, detail) => progress.push([step, state, detail]),
  sendThinking: (text) => thinking.push(text),
});

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return { html: await res.text(), finalUrl: res.url || url };
}

function summarize(rows) {
  const vars = rows.filter(r => r.Type === 'variation');
  const first = rows[0] || {};
  return {
    rows: rows.length,
    variations: vars.length,
    title: (first.Name || '').slice(0, 60),
    price: first['Regular Price'] || '',
    images: Array.isArray(first.Images) ? first.Images.length : 0,
  };
}

const TEST_DOMAIN = 'desktop-e2e.invalid';

async function main() {
  console.log('== 1. Supabase connectivity + predefined module ==');
  try {
    const version = await Supabase.getPredefinedVersion();
    const mod = await Supabase.getPredefinedModule();
    console.log('   predefined version:', version, '| module bytes:', mod && mod.code ? mod.code.length : 'N/A');
    if (!mod || !mod.code) throw new Error('Could not fetch predefined module');
  } catch (e) {
    console.log('   FAIL:', e.message);
    process.exit(1);
  }

  console.log('\n== 2. Scrape a real product URL (predefined module path) ==');
  const url = process.argv[2]
    || 'https://www.glowrecipe.com/products/watermelon-glow-niacinamide-dew-drops';
  try {
    const { html, finalUrl } = await fetchPage(url);
    const res = await core.handleScrape({ url: finalUrl, html, productType: 'auto' });
    if (!res.ok) {
      console.log('   FAIL:', res.error);
      process.exit(1);
    }
    const s = summarize(res.rows);
    console.log('   OK  site=' + (res.site || '(predefined)') + ' brand=' + (res.brand || '')
      + ' rows=' + s.rows + ' vars=' + s.variations + ' imgs=' + s.images + ' price=' + s.price);
    console.log('   title="' + s.title + '"');
    if (s.rows === 0) throw new Error('no rows produced');
  } catch (e) {
    console.log('   FAIL:', e.message);
    process.exit(1);
  }

  console.log('\n== 3. Scraper save + reuse round-trip (write/read/delete) ==');
  try {
    // Save a scraper under a throwaway domain, read it back, then clean up.
    // `code` is the full materializable body (the same shape buildScraperBody
    // produces): helpers + run(ctx) + `return run(ctx);`.
    const testBody = [
      'async function run(ctx) {',
      '  return { rows: [{ SKU: "X", Name: "Test Product", "Regular Price": "12.00", Images: ["https://example.com/a.jpg"] }], title: "Test Product" };',
      '}',
      'return run(ctx);',
    ].join('\n');
    await Supabase.upsertScraper({
      domain: TEST_DOMAIN,
      type: 'simple',
      brand: 'E2E Test',
      example: 'https://desktop-e2e.invalid/p/1',
      code: testBody,
      is_predefined: false,
    });
    const read = await Supabase.listScrapersForDomain(TEST_DOMAIN);
    const saved = read.find(r => r.type === 'simple');
    if (!saved || !saved.code) throw new Error('scraper not persisted (write/read failed)');
    console.log('   OK  persisted scraper for ' + TEST_DOMAIN + ' (type=' + saved.type + ', code bytes=' + saved.code.length + ')');

    // Reuse it through the same path the app uses for a custom scraper.
    const reuse = await core.handleScrape({
      url: 'https://desktop-e2e.invalid/p/1',
      html: '<html><head><title>Test</title></head><body></body></html>',
      productType: 'simple',
    });
    if (!reuse.ok || !reuse.rows.length) throw new Error('saved scraper not reusable: ' + (reuse.error || 'no rows'));
    console.log('   OK  saved scraper reused → ' + reuse.rows.length + ' row(s)');

    await Supabase.deleteScraperByDomain(TEST_DOMAIN);
    console.log('   OK  cleaned up test scraper');
  } catch (e) {
    console.log('   FAIL:', e.message);
    process.exit(1);
  }

  console.log('\nAll checks passed.');
}

main().catch(e => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
