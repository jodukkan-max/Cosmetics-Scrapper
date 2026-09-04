// Full live test: uses the ACTUAL extension client (supabase.js) + the real
// DeepSeek Edge Function to generate a scraper for a real product page, runs it,
// then saves/reads/deletes it in Supabase — all anonymously, like the extension.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Load the real supabase.js client exactly as the extension does (self global).
const supabaseSrc = await readFile(new URL('./extension/supabase.js', import.meta.url), 'utf8');
const selfObj = { chrome: { storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } } }, fetch, JSON, URL, encodeURIComponent };
vm.createContext(selfObj);
vm.runInContext(supabaseSrc, selfObj);
const SB = selfObj.Supabase;

const log = (name, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
const results = [];
const check = (name, ok, detail) => { results.push(ok); log(name, ok, detail); };

// 1. List scrapers via the real client (proves read path + 138 rows).
let rows = await SB.listScrapers();
check('listScrapers (real client)', Array.isArray(rows) && rows.length >= 138, `${rows.length} rows`);

// 2. Fetch a real product page (scrape-friendly test target, not a brand site).
const url = 'https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html';
let r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }, redirect: 'follow' });
let html = await r.text();
check('fetch real product page', r.ok && html.length > 5000, `HTTP ${r.status}, ${html.length} bytes`);

// 3. Classify via the DeepSeek Edge Function (anonymous) — same as step 2 in background.js.
const classifyPrompt = {
  messages: [
    { role: 'system', content: 'You classify a web page. Respond with JSON only. Determine: (1) isProductPage — true if this is a product detail page. (2) productType — "simple" if single product/price/no options, "variable" if it has options. Use null for productType when not a product page. Example: {"isProductPage": true, "productType": "simple"}.' },
    { role: 'user', content: html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 8000) },
  ],
  json: true,
};
r = await SB.deepseek(classifyPrompt.messages, { json: true });
const clsRaw = r.data && r.data.content;
let cls = null;
try { cls = JSON.parse(clsRaw); } catch {}
check('classify via edge fn', r.ok && cls && cls.isProductPage === true, JSON.stringify(cls).slice(0, 120));

// 4. Generate a simple scraper via the edge function.
const genPrompt = {
  messages: [
    { role: 'system', content: 'Write ONLY an async function run(ctx){...} that extracts product data from ctx.mainHtml. Return { rows: [{ SKU, Name, Description, "Short Description", "Regular Price", Categories, Images, "Sale Price" }], title }. Use JSON-LD in ctx.mainHtml if present, else visible HTML. Prices via parseFloat + toFixed(2). Images is an array of URLs. No DOM APIs, no markdown fences.' },
    { role: 'user', content: 'URL: ' + url + '\n\nHTML:\n' + html.slice(0, 60000) },
  ],
};
r = await SB.deepseek(genPrompt.messages);
const code = (r.data && r.data.content) || '';
check('generate scraper via edge fn', r.ok && /async\s+function\s+run\s*\(/.test(code), `code length ${code.length}`);

// 5. Run the generated scraper against the real HTML (same new Function approach).
let scraped = null;
if (code) {
  const body = code + '\nreturn run(ctx);';
  const fn = new Function('ctx', body);
  scraped = await fn({ productType: 'simple', url, mainHtml: html, fetchText: async u => (await fetch(u)).text(), fetchJson: async u => (await fetch(u)).json() });
  const row = scraped && scraped.rows && scraped.rows[0];
  const hasPrice = row && (row['Regular Price'] || row['Sale Price']);
  const hasImg = row && Array.isArray(row.Images) && row.Images.length > 0;
  check('run generated scraper', !!row && hasPrice && hasImg, `name=${JSON.stringify(row && row.Name)} price=${JSON.stringify(row && (row['Regular Price'] || row['Sale Price']))} images=${row && row.Images ? row.Images.length : 0}`);
}

// 6. Save the generated scraper to Supabase (real client, anonymous upsert), read back, delete.
if (code) {
  const domain = 'livetest-' + Date.now() + '.example.com';
  r = await SB.upsertScraper({ domain, type: 'simple', brand: 'LiveTest', example: url, code, is_predefined: false });
  check('upsert scraper (real client)', r.ok || r.status === 201, `status=${r.status} domain=${domain}`);

  const forDomain = await SB.listScrapersForDomain(domain);
  check('read scraper back', forDomain.some(s => s.code && s.code.includes('async function run')), `rows for ${domain}: ${forDomain.length}`);

  r = await SB.deleteScraperByDomain(domain);
  const after = await SB.listScrapersForDomain(domain);
  check('delete test scraper', r.ok && after.length === 0, `remaining rows for ${domain}: ${after.length}`);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} live checks passed.`);
process.exit(passed === results.length ? 0 : 1);
