// Run a scraper against a local HTML file (rendered DOM captured from the browser).
// Usage: node test-file.mjs <html-file> <url> [type]
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const [file, url, type] = process.argv.slice(2);
const source = readFileSync('./supabase/predefined/scrapers.js', 'utf8');
const win = new JSDOM('').window;
const sandbox = { URL, URLSearchParams, Headers, AbortController, DOMParser: win.DOMParser, document: win.document, fetch: globalThis.fetch, console, setTimeout, clearTimeout, TextDecoder, TextEncoder, atob: s=>Buffer.from(s,'base64').toString('binary'), btoa: s=>Buffer.from(s,'binary').toString('base64'), Blob, File };
sandbox.self = sandbox; sandbox.window = sandbox;
createContext(sandbox);
runInContext(source, sandbox, { filename: 'scrapers.js' });

const html = readFileSync(file, 'utf8');
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const out = await sandbox.ProductScraper.scrapeProduct({
  url, mainHtml: html, productType: type || 'auto',
  fetchText: async u => (await fetch(u, { headers: { "User-Agent": UA } })).text(),
  fetchJson: async u => (await fetch(u, { headers: { "User-Agent": UA } })).json(),
});
const rows = out.rows || [];
const vars = rows.filter(r => r.Type === 'variation');
const first = rows[0] || {};
console.log('site=' + out.site + ' type=' + (vars.length ? 'variable' : 'simple') + ' rows=' + rows.length + ' vars=' + vars.length);
console.log('title=' + JSON.stringify(out.title));
console.log('first row=' + JSON.stringify(first).slice(0, 500));
if (rows.length > 1) console.log('row[1]=' + JSON.stringify(rows[1]).slice(0, 300));
