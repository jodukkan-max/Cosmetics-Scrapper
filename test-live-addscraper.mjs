// Live test of the REAL production background.js "Add new scrapper" flow
// (including the AI agent loop) against a live product page. Only the Chrome
// extension APIs are stubbed; the prompt, DeepSeek calls, agent self-correction,
// validation, and storage logic run exactly as they do in the extension.
//
// Usage: node test-live-addscraper.mjs [url]
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createContext, runInContext } from 'node:vm';

const url = process.argv[2] || 'https://realcosmetics.jo/en/Product/37996';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// 1. Fetch the live HTML.
console.log('Fetching ' + url + ' ...');
const liveResp = await fetch(url, {
  headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
  redirect: 'follow',
});
const liveHtml = await liveResp.text();
console.log('Got ' + liveHtml.length + ' bytes of HTML.\n');

// gzip-aware fetch wrapper (Node's fetch does not auto-decompress gzip, but the
// DeepSeek API and some sites return gzip; Chrome handles this transparently).
async function nodeFetch(input, init) {
  const r = await fetch(input, init);
  const buf = Buffer.from(await r.arrayBuffer());
  const body = (buf[0] === 0x1f && buf[1] === 0x8b) ? gunzipSync(buf) : buf;
  const text = body.toString('utf8');
  return {
    ok: r.ok,
    status: r.status,
    headers: { get: (k) => r.headers.get(k) },
    text: async () => text,
    json: async () => JSON.parse(text),
    arrayBuffer: async () => body,
  };
}

// 2. Stub the Chrome APIs that background.js touches.
const storage = { customScrapers: {} };
const progressLog = [];

const chromeStub = {
  sidePanel: { setPanelBehavior: async () => ({}) },
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') return { [key]: storage[key] };
        if (Array.isArray(key)) { const o = {}; for (const k of key) o[k] = storage[k]; return o; }
        if (key && typeof key === 'object') { const o = {}; for (const k of Object.keys(key)) o[k] = storage[k] !== undefined ? storage[k] : key[k]; return o; }
        return { ...storage };
      },
      async set(obj) { Object.assign(storage, obj); },
    },
  },
  runtime: {
    onMessage: { addListener() {} },
    async sendMessage(msg) {
      if (msg && msg.type === 'addScraperProgress') {
        progressLog.push(msg);
        console.log('  [progress] step ' + msg.step + ' ' + (msg.state || '') + ' ' + (msg.detail || ''));
      }
      return {};
    },
  },
  scripting: {
    async executeScript(params) {
      // getTabHtml path: no args, returns document.documentElement.outerHTML.
      if (!params.args) return [{ result: liveHtml }];
      // runScraperInPage path: func = evalScraperInMain, args = [code, type, html].
      const result = await params.func(...params.args);
      return [{ result }];
    },
  },
};

// 3. Sandbox + load the real background.js.
const sandbox = {
  chrome: chromeStub,
  fetch: nodeFetch,
  URL, URLSearchParams,
  location: { href: url },
  console,
  setTimeout, clearTimeout,
  TextEncoder, TextDecoder,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  Blob, File,
  document: { documentElement: { outerHTML: liveHtml } },
};
sandbox.self = sandbox;
sandbox.window = sandbox;
createContext(sandbox);

const source = readFileSync('./extension/background.js', 'utf8')
  + '\n;globalThis.__bg = { handleAddScraper, generateScraper, evalScraperInMain, evaluateResult, describeRows, callDeepSeek, getCustomScrapers };';
runInContext(source, sandbox, { filename: 'background.js' });

// 4. Run the real flow.
console.log('Running handleAddScraper (real AI agent loop)...\n');
const t0 = Date.now();
const result = await sandbox.__bg.handleAddScraper({ tabId: 1, url });
const dt = ((Date.now() - t0) / 1000).toFixed(1);

console.log('\n=== FINAL RESULT (' + dt + 's) ===');
console.log(JSON.stringify(result, null, 2));

const domain = 'realcosmetics.jo';
const entry = storage.customScrapers[domain];
console.log('\n=== SAVED SCRAPER [' + domain + '] ===');
if (entry) {
  console.log('brand=' + entry.brand + ' type=' + entry.type + ' example=' + entry.example + ' codeLen=' + (entry.code ? entry.code.length : 0));
  console.log('code head:');
  console.log((entry.code || '').slice(0, 400));
} else {
  console.log('(no scraper saved)');
}
console.log('\nprogress events: ' + progressLog.length);

// 5. Verify the generated scraper actually extracts the right fields.
if (entry && entry.code) {
  const runRes = await sandbox.__bg.evalScraperInMain(entry.code, 'simple', liveHtml);
  if (runRes.ok) {
    const row = (runRes.rows || [])[0] || {};
    console.log('\n=== SCRAPED DATA (real extraction) ===');
    console.log('title=' + JSON.stringify(runRes.title));
    console.log('Name=' + JSON.stringify(row.Name));
    console.log('SKU=' + JSON.stringify(row.SKU));
    console.log('Regular Price=' + JSON.stringify(row['Regular Price']));
    console.log('Sale Price=' + JSON.stringify(row['Sale Price']));
    console.log('Categories=' + JSON.stringify(row.Categories));
    console.log('Images=' + JSON.stringify((row.Images || []).slice(0, 3)));
    console.log('Description=' + JSON.stringify((row.Description || '').slice(0, 160)));
  } else {
    console.log('\nSCRAPE ERROR: ' + runRes.error);
  }
}
