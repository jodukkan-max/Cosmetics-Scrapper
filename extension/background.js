/* MV3 service worker — orchestrates hybrid scraping + WooCommerce calls. */
importScripts('scrapers.js');

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'scrape') sendResponse(await handleScrape(msg));
      else if (msg.type === 'wcTest') sendResponse(await wcTest(msg));
      else if (msg.type === 'wcImport') sendResponse(await wcImport(msg));
      else if (msg.type === 'fetchSwatchDataUrl') sendResponse({ dataUrl: await fetchSwatchAsDataUrl(msg.swatchUrl) });
      else if (msg.type === 'bulkDiscover') handleBulkDiscover(msg, sendResponse);
      else sendResponse({ ok: false, error: 'Unknown message' });
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // keep the channel open for async response
});

// ── Scrape ─────────────────────────────────────────────────────────────────
async function handleScrape({ mode, productType, url, tabId }) {
  if (mode === 'active') {
    if (!tabId) return { ok: false, error: 'No active tab.' };
    // Inject the scraper engine, then run it in the page (same-origin fetch + rendered DOM).
    await chrome.scripting.executeScript({ target: { tabId }, files: ['scrapers.js'] });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: runInPage,
      args: [productType || 'variable'],
    });
    return result;
  }
  // URL mode: fetch cross-origin from the SW (host_permissions bypasses CORS).
  try {
    const fetchText = mkFetchText();
    const fetchJson = mkFetchJson();
    const mainHtml = await fetchText(url);
    const out = await self.ProductScraper.scrapeProduct({ productType, url, mainHtml, fetchText, fetchJson });
    return { ok: true, ...out };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Swatch image relay — downloads CORS-free in SW, returns base64 data URL ──
async function fetchSwatchAsDataUrl(swatchUrl) {
  try {
    const resp = await fetch(swatchUrl);
    if (!resp.ok) return '';
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const mime = resp.headers.get('content-type') || 'image/jpeg';
    return 'data:' + mime + ';base64,' + btoa(binary);
  } catch (e) { return ''; }
}

function mkFetchText() {
  return async (u, opts) => {
    const r = await fetch(u, opts);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`);
    return r.text();
  };
}
function mkFetchJson() {
  return async (u, opts) => {
    const r = await fetch(u, opts);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`);
    return r.json();
  };
}

// Runs inside the page (isolated world). self.ProductScraper was injected first.
async function runInPage(productType) {
  try {
    const fetchText = async (u, opts) => {
      const r = await fetch(u, Object.assign({ credentials: 'include' }, opts));
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`);
      return r.text();
    };
    const fetchJson = async (u, opts) => {
      const r = await fetch(u, Object.assign({ credentials: 'include' }, opts));
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`);
      return r.json();
    };
    const out = await self.ProductScraper.scrapeProduct({
      productType, url: location.href,
      mainHtml: document.documentElement.outerHTML,
      fetchText, fetchJson,
    });
    return { ok: true, rows: out.rows, title: out.title };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
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
    const d = await r.json().catch(() => ({}));
    if (r.status === 403) throw new Error('Invalid auth key. Check the key from the plugin dashboard.');
    if (r.status === 404) throw new Error('Rey Swatches Import plugin not found. Install and activate it first.');
    return { ok: true, message: 'Connected — import endpoint reachable.' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── CSV import via the plugin endpoint ──────────────────────────────────
async function wcImport({ store, authKey, csv }) {
  try {
    const url = store.replace(/\/+$/, '') + '/wp-json/scraper/v1/import-csv';
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Scraper-Key': authKey || '',
      },
      body: JSON.stringify({ csv }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 403) throw new Error('Invalid auth key. Check the key from the plugin dashboard.');
    if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Bulk discovery: scan sitemap + category pages for all products ───────────
async function handleBulkDiscover(msg, sendResponse) {
  const { site } = msg;
  const fetchText = mkFetchText();
  const onProgress = (p) => {
    chrome.runtime.sendMessage({ type: 'bulkDiscoverProgress', ...p }).catch(() => {});
  };
  try {
    const result = await self.ProductScraper.discoverAll({ site, fetchText, onProgress });
    sendResponse({ ok: true, ...result });
  } catch (e) {
    sendResponse({ ok: false, error: e.message || String(e) });
  }
}
