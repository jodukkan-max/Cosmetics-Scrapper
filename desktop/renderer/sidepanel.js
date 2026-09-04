'use strict';

const VARIABLE_COLUMNS = ['ID','Parent','Type','SKU','Name','tags','Product URL','Images','Description','Short Description','Regular Price','Sale Price','Attribute 1 name','Attribute 1 value(s)','Attribute 2 name','Attribute 2 value(s)','Attribute 1 visible','Attribute 1 global','Color Code','Rey Swatches'];
const SIMPLE_COLUMNS = ['SKU','Name','tags','Product URL','Description','Short Description','Regular Price','Images','Sale Price'];

let currentRows = [];
let currentType = 'variable';
let COLUMNS = VARIABLE_COLUMNS;
let editingStoreId = null;
let selectedIds = new Set();

const $ = id => document.getElementById(id);
const escHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ═══ Embedded browser (webview) helpers ═══════════════════════════════════════
const browserEl = () => document.getElementById('browser');

function currentUrl() {
  const b = browserEl();
  if (!b) return '';
  try { return b.getURL() || ''; } catch (e) { return ''; }
}
function isLoaded() {
  const u = currentUrl();
  return !!u && u !== 'about:blank';
}
function webContentsId() {
  const b = browserEl();
  try { return b.getWebContentsId(); } catch (e) { return null; }
}

function navigate() {
  let url = $('url-input').value.trim();
  if (!url) return;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
  $('url-input').value = url;
  browserEl().src = url;
}

$('go-btn').addEventListener('click', navigate);
$('url-input').addEventListener('keydown', e => { if (e.key === 'Enter') navigate(); });

// Keep the URL bar in sync with the embedded browser.
(function () {
  const b = browserEl();
  if (!b) return;
  b.addEventListener('did-navigate', e => { $('url-input').value = e.url || ''; });
  b.addEventListener('did-navigate-in-page', e => { $('url-input').value = e.url || ''; });
})();

// ═══ Tabs (Products / Stores / Websites) ═══════════════════════════════════════
document.querySelectorAll('.sp-tab').forEach(btn => btn.addEventListener('click', () => {
  const tab = btn.dataset.tab;
  document.querySelectorAll('.sp-tab').forEach(b => b.classList.toggle('active', b === btn));
  $('panel-products').classList.toggle('hidden', tab !== 'products');
  $('panel-stores').classList.toggle('hidden', tab !== 'stores');
  $('panel-websites').classList.toggle('hidden', tab !== 'websites');
  if (tab === 'stores') renderStores();
  if (tab === 'websites') renderBrands();
}));

// ═══ Product type (auto-detected from the scrape result) ══════════════════════
function setType(t) {
  currentType = t;
  COLUMNS = t === 'simple' ? SIMPLE_COLUMNS : VARIABLE_COLUMNS;
}

// ═══ Scrape ═══════════════════════════════════════════════════════════════════
$('scrape-page-btn').addEventListener('click', async () => {
  if (!isLoaded()) return status('error', 'Open a product page in the browser first.');
  $('hero-title').classList.add('hidden');
  $('panel-products').classList.add('has-results');
  $('hero').classList.remove('hero-error');
  hideConfirm();
  runScrape({ mode: 'active', productType: 'auto', url: currentUrl() });
});

// ═══ Add new Scrapper (AI) ════════════════════════════════════════════════════
window.api.onAddScraperProgress((msg) => setScraperStep(msg.step, msg.state || 'done', msg.detail || ''));
window.api.onAgentThinking((text) => setAgentThought(text || ''));

function setAgentThought(text) {
  const el = $('agent-thought');
  if (!el) return;
  if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = text;
  el.classList.remove('hidden');
}

function showScraperProgress() {
  $('scraper-progress').classList.remove('hidden');
  setAgentThought('');
  document.querySelectorAll('#scraper-steps tr').forEach(tr => {
    tr.classList.remove('done', 'fail', 'running', 'skip', 'value');
    const mark = tr.querySelector('.step-mark');
    const detail = tr.querySelector('.step-detail');
    if (mark) mark.textContent = '';
    if (detail) detail.textContent = '';
  });
}
function setScraperStep(n, state, detail) {
  const tr = document.querySelector(`#scraper-steps tr[data-step="${n}"]`);
  if (!tr) return;
  tr.classList.remove('done', 'fail', 'running', 'skip', 'value');
  tr.classList.add(state);
  const mark = tr.querySelector('.step-mark');
  const detailEl = tr.querySelector('.step-detail');
  if (mark) mark.textContent = state === 'fail' ? '✕' : (state === 'done' ? '✓' : (state === 'skip' ? '–' : (state === 'value' ? '' : '…')));
  if (detailEl && detail) detailEl.textContent = detail;
  // Once generation finishes, stop showing the agent's thinking.
  if (n === 8 && state !== 'running') setAgentThought('');
}

function showScrapeBar() { $('scrape-bar').classList.remove('hidden'); }
function hideScrapeBar() { $('scrape-bar').classList.add('hidden'); }

$('add-scraper-btn').addEventListener('click', async () => {
  if (!isLoaded()) return status('error', 'Open a product page in the browser first.');
  status('loading', 'Checking with AI…');
  showScraperProgress();
  hideConfirm();
  try {
    const res = await window.api.addScraper({ url: currentUrl(), webContentsId: webContentsId() });
    if (!res) throw new Error('No response from the scraper engine.');
    if (res.productPage) {
      status('success', res.message || 'This is a product page.');
      brandsRendered = false; // refresh the Websites list next time it's opened
      // Start scraping using the detected product type, with a progress bar.
      const pType = res.productType === 'simple' || res.productType === 'variable' ? res.productType : 'auto';
      setScraperStep(9, 'running', 'Scraping…');
      showScrapeBar();
      $('hero-title').classList.add('hidden');
      $('panel-products').classList.add('has-results');
      $('hero').classList.remove('hero-error');
      const ok = await runScrape({ mode: 'active', productType: pType, url: currentUrl() });
      hideScrapeBar();
      setScraperStep(9, ok ? 'done' : 'fail', ok ? 'Done' : 'Failed');
      if (ok && !res.alreadyExists) showConfirm();
    } else if (res.notProduct) {
      setScraperStep(9, 'skip', '—');
      status('warn', res.message || 'This page is not a product page.');
    } else {
      status('error', res.error || 'Failed to check page.');
    }
  } catch (e) {
    console.error('addScraper error:', e);
    setScraperStep(9, 'fail', e.message);
    hideScrapeBar();
    status('error', e.message);
  }
});

function status(type, msg) { const el = $('status'); el.className = `status ${type}`; el.textContent = msg; el.classList.remove('hidden'); }

// ═══ Post-scrape confirmation: "is the scraped data correct?" ════════════════
const SKIP_FIX_FIELDS = new Set(['ID', 'Parent', 'Type', 'tags', 'Product URL', 'Attribute 1 visible', 'Attribute 1 global', 'Attribute 2 visible', 'Attribute 2 global', 'Rey Swatches', 'Rey Variations extra images']);

function showConfirm() {
  $('scraper-confirm').classList.remove('hidden');
  $('fix-panel').classList.add('hidden');
}
function hideConfirm() {
  $('scraper-confirm').classList.add('hidden');
  $('fix-panel').classList.add('hidden');
}
function fixStatus(type, msg) {
  const el = $('fix-status');
  if (type === 'hidden') { el.className = 'status hidden'; el.textContent = ''; return; }
  el.className = `status ${type}`;
  el.textContent = msg;
  el.classList.remove('hidden');
}

$('confirm-yes-btn').addEventListener('click', async () => {
  if (isLoaded()) await window.api.verifyScraper({ url: currentUrl(), type: currentType });
  hideConfirm();
  status('success', 'Scraper saved.');
});

$('confirm-no-btn').addEventListener('click', () => {
  showFixPanel();
});

function showFixPanel() {
  const row = currentRows[0] || {};
  const fields = Object.keys(row).filter(k => !SKIP_FIX_FIELDS.has(k));
  $('fix-fields').innerHTML = fields.map(f => {
    const val = row[f];
    const display = Array.isArray(val) ? val.join(', ') : String(val == null ? '' : val);
    return `<div class="fix-field" data-field="${escHtml(f)}">
      <label class="fix-check"><input type="checkbox" class="fix-wrong"> <span>${escHtml(f)}</span></label>
      <div class="fix-current" title="${escHtml(display)}">${escHtml(display.length > 70 ? display.slice(0, 70) + '…' : display)}</div>
      <input class="fix-correct" type="text" placeholder="Correct value (optional)" />
    </div>`;
  }).join('');
  fixStatus('hidden');
  $('fix-panel').classList.remove('hidden');
}

$('fix-submit-btn').addEventListener('click', async () => {
  if (!isLoaded()) return fixStatus('error', 'Open a product page in the browser first.');
  const corrections = [];
  $('fix-fields').querySelectorAll('.fix-field').forEach(el => {
    if (el.querySelector('.fix-wrong').checked) {
      const field = el.dataset.field;
      corrections.push({
        field,
        current: currentRows[0] ? String(currentRows[0][field] ?? '') : '',
        correct: el.querySelector('.fix-correct').value.trim(),
      });
    }
  });
  if (!corrections.length) return fixStatus('error', 'Select at least one wrong field.');
  fixStatus('loading', 'Fixing with AI…');
  try {
    const res = await window.api.fixScraper({ url: currentUrl(), webContentsId: webContentsId(), type: currentType, corrections });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Fix failed');
    currentRows = res.rows || [];
    if (currentRows.length > 0) setType(currentRows[0].hasOwnProperty('Type') ? 'variable' : 'simple');
    currentRows.forEach(r => { r.tags = brandFromUrl(currentUrl()); r['Product URL'] = currentUrl(); });
    $('type-badge').classList.add('hidden');
    renderResults(res.title || '');
    showConfirm(); // ask again with the corrected data
    status('success', 'Scraper updated. Check the data again.');
  } catch (e) {
    fixStatus('error', e.message);
  }
});

function brandFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const brands = (self.BrandCatalog && self.BrandCatalog.brands) || [];
    const hit = brands.find(b => host === b.domain || host.endsWith('.' + b.domain));
    if (hit) return hit.name;
  } catch (e) {}
  return '';
}

async function runScrape(req) {
  $('results').classList.add('hidden');
  $('type-badge').classList.add('hidden');
  status('loading', 'Scraping…');
  try {
    const res = await window.api.scrape({ url: req.url, webContentsId: webContentsId(), productType: req.productType || 'auto' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Scrape failed');
    currentRows = res.rows || [];
    // Auto-detect product type: rows with a Type field are variable, otherwise simple
    if (currentRows.length > 0) {
      setType(currentRows[0].hasOwnProperty('Type') ? 'variable' : 'simple');
    }
    const brand = res.brand || brandFromUrl(req.url || '');
    currentRows.forEach(r => { r.tags = brand; r['Product URL'] = req.url || ''; });
    // Show the detected type only for known/listed sites.
    if (brand && currentRows.length > 0) {
      const badge = $('type-badge');
      badge.textContent = currentType === 'simple' ? 'Simple product' : 'Variable product';
      badge.classList.remove('hidden');
    }
    $('status').classList.add('hidden');
    renderResults(res.title || '');
    return true;
  } catch (e) {
    if (/cannot access/i.test(e.message || '')) {
      $('hero-title').classList.remove('hidden');
      $('panel-products').classList.remove('has-results');
      $('hero').classList.add('hero-error');
    }
    status('error', e.message);
    return false;
  }
}

// ═══ Rey Swatches ═════════════════════════════════════════════════════════════
function buildReySwatches(parentRow, rows) {
  rows = rows || currentRows;
  if (!parentRow) return '';
  const attrName = (parentRow['Attribute 1 name'] || 'Color').toLowerCase();
  const parentRef = `id:${parentRow.ID}`;
  const variations = rows.filter(r => r.Type === 'variation' && r.Parent === parentRef);
  const isImageSwatch = variations.some(v => (v['Color Code'] || '').trim().startsWith('http'));
  const terms = {};
  for (const v of variations) {
    const colorName = v['Attribute 1 value(s)'];
    const cc = (v['Color Code'] || '').trim();
    if (!colorName) continue;
    terms[colorName] = isImageSwatch
      ? { name: colorName, rey_attribute_image: cc }
      : { name: colorName, rey_attribute_color: cc || '#000000' };
  }
  if (isImageSwatch) return JSON.stringify({ Image: { name: 'Image', type: 'rey_image', terms } });
  // Only generate color swatches when the attribute is "Color"
  if (attrName.toLowerCase() !== 'color') return '';
  return JSON.stringify({ [attrName]: { name: attrName, type: 'rey_color', terms } });
}

// ═══ Render results table ═════════════════════════════════════════════════════
function cellValue(col, row, rows) {
  if (col === 'Images' || col === 'Rey Variations extra images') {
    const v = row[col]; const a = Array.isArray(v) ? v : (v ? [v] : []);
    return a.join(', ');
  }
  if (col === 'Rey Swatches') return row.Type === 'variable' ? buildReySwatches(row, rows || currentRows) : '';
  return String(row[col] == null ? '' : row[col]);
}

function tsvOf(columns, rows) {
  const clean = v => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ');
  return [columns.join('\t'), ...rows.map(r => columns.map(c => clean(cellValue(c, r, rows))).join('\t'))].join('\n');
}
function csvOf(columns, rows) {
  const esc = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns.map(esc).join(','), ...rows.map(r => columns.map(c => {
    if (c === 'Images' || c === 'Rey Variations extra images') {
      const v = r[c]; const a = Array.isArray(v) ? v : (v ? [v] : []);
      return esc(a.join('|'));
    }
    return esc(cellValue(c, r, rows));
  }).join(','))].join('\n');
}
function downloadCsvFile(csv, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name || `products-${Date.now()}.csv`;
  a.click();
}
function variationIdList() { return currentRows.filter(r => r.Type === 'variation').map(r => String(r.ID)); }
function exportRows() {
  if (currentType !== 'variable') return currentRows;
  const kept = currentRows.filter(r => r.Type !== 'variation' || selectedIds.has(String(r.ID)));
  return kept.map(r => {
    if (r.Type !== 'variable') return r;
    const ref = `id:${r.ID}`;
    const variations = kept.filter(x => x.Type === 'variation' && x.Parent === ref);
    const names = [...new Set(variations.map(x => x['Attribute 1 value(s)']).filter(Boolean))];
    const names2 = [...new Set(variations.map(x => x['Attribute 2 value(s)']).filter(Boolean))];
    return Object.assign({}, r, { 'Attribute 1 value(s)': names.join(','), 'Attribute 2 value(s)': names2.join(',') });
  });
}
function updateResultCount() {
  const total = variationIdList().length;
  $('result-count').textContent = (currentType === 'variable' && total)
    ? `${selectedIds.size} of ${total} variants`
    : `${currentRows.length} row${currentRows.length !== 1 ? 's' : ''}`;
}
function applySelectionUI() {
  $('tbody').querySelectorAll('tr.var-row').forEach(tr => tr.classList.toggle('row-unselected', !selectedIds.has(tr.dataset.rowid)));
  const ids = variationIdList();
  const master = $('master-check');
  if (master) master.checked = ids.length > 0 && ids.every(id => selectedIds.has(id));
  updateResultCount();
}
function setAllChecks(on) {
  selectedIds = new Set(on ? variationIdList() : []);
  $('tbody').querySelectorAll('.row-check').forEach(cb => { cb.checked = on; });
  applySelectionUI();
}
function flashCopied(btn) { btn.classList.add('copied'); const t = btn.textContent; btn.textContent = '✓ Copied'; setTimeout(() => { btn.classList.remove('copied'); btn.textContent = t; }, 1500); }

function renderResults(title) {
  const variationIds = variationIdList();
  selectedIds = new Set(variationIds);
  const showSel = currentType === 'variable' && variationIds.length > 0;
  updateResultCount();

  const headSel = showSel ? '<th class="sel-col"><input type="checkbox" id="master-check"></th>' : '';
  $('thead').innerHTML = `<tr>${headSel}${COLUMNS.map(c => `<th>${escHtml(c)}</th>`).join('')}</tr>`;

  $('tbody').innerHTML = currentRows.map(row => {
    const isVar = row.Type === 'variation';
    let selCell = '';
    if (showSel) selCell = isVar
      ? `<td class="sel-col"><input type="checkbox" class="row-check" data-id="${escHtml(String(row.ID))}" ${selectedIds.has(String(row.ID)) ? 'checked' : ''}></td>`
      : '<td class="sel-col"></td>';
    const cells = COLUMNS.map(col => {
      if (col === 'Images' || col === 'Rey Variations extra images') {
        const v = row[col]; const a = Array.isArray(v) ? v : (v ? [v] : []);
        return `<td>${a.map(u => `<img src="${escHtml(u)}" onerror="this.style.display='none'">`).join('')}</td>`;
      }
      if (col === 'Color Code' && row.Type === 'variation') {
        const cc = row['Color Code'] || '';
        const rowId = row.ID;
        if (cc.startsWith('#')) return `<td class="color-code-cell"><span class="swatch-dot" style="background:${escHtml(cc)}"></span> <input class="color-code-input" value="${escHtml(cc)}" data-rowid="${rowId}"></td>`;
        if (cc.startsWith('http')) return `<td class="color-code-cell"><img src="${escHtml(cc)}" onerror="this.style.display='none'"> <input class="color-code-input" value="${escHtml(cc)}" data-rowid="${rowId}"></td>`;
        return `<td class="color-code-cell"><input class="color-code-input" value="${escHtml(cc)}" data-rowid="${rowId}" placeholder="#RRGGBB"></td>`;
      }
      const val = cellValue(col, row);
      if (col === 'Rey Swatches' && row.Type === 'variable')
        return `<td data-col="Rey Swatches" data-rowid="${escHtml(String(row.ID))}" title="${escHtml(val)}">${escHtml(val.length > 80 ? val.slice(0, 80) + '…' : val)}</td>`;
      return `<td title="${escHtml(val)}">${escHtml(val.length > 80 ? val.slice(0, 80) + '…' : val)}</td>`;
    }).join('');
    return `<tr data-rowid="${escHtml(String(row.ID))}"${isVar ? ' class="var-row"' : ''}>${selCell}${cells}</tr>`;
  }).join('');

  // Color Code input change handlers
  $('tbody').querySelectorAll('.color-code-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const rowId = Number(inp.dataset.rowid);
      const row = currentRows.find(r => Number(r.ID) === rowId);
      if (row) row['Color Code'] = inp.value;
      // Update adjacent swatch dot if present
      const dot = inp.parentElement.querySelector('.swatch-dot');
      if (dot && /^#[0-9A-Fa-f]{6}$/.test(inp.value)) dot.style.background = inp.value;
      // Update Rey Swatches cell for the parent row
      if (row && row.Parent) {
        const parentId = row.Parent.replace(/^id:/, '');
        const parentRow = currentRows.find(r => String(r.ID) === parentId);
        if (parentRow) {
          const swatchesJson = buildReySwatches(parentRow, currentRows);
          const reyCell = document.querySelector(`td[data-col="Rey Swatches"][data-rowid="${escHtml(parentId)}"]`);
          if (reyCell) {
            const display = swatchesJson.length > 80 ? swatchesJson.slice(0, 80) + '…' : swatchesJson;
            reyCell.textContent = display;
            reyCell.title = swatchesJson;
          }
        }
      }
    });
  });

  if (showSel) {
    $('master-check').addEventListener('change', e => setAllChecks(e.target.checked));
    $('tbody').querySelectorAll('.row-check').forEach(cb => cb.addEventListener('change', () => {
      if (cb.checked) selectedIds.add(cb.dataset.id); else selectedIds.delete(cb.dataset.id);
      applySelectionUI();
    }));
    applySelectionUI();
  }
  $('import-box').classList.add('hidden');
  $('results').classList.remove('hidden');
}

// ═══ Copy / CSV / Import ══════════════════════════════════════════════════════
$('copy-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(tsvOf(COLUMNS, exportRows())).then(() => flashCopied($('copy-btn')));
});
$('csv-btn').addEventListener('click', () => downloadCsvFile(csvOf(COLUMNS, exportRows())));

// ═══ Stores (persisted in localStorage) ════════════════════════════════════════
async function getStores() {
  try { return JSON.parse(localStorage.getItem('stores') || '[]'); } catch (e) { return []; }
}
async function setStores(s) { localStorage.setItem('stores', JSON.stringify(s)); }

$('store-save-btn').addEventListener('click', async () => {
  const name = $('store-name').value.trim();
  const url  = $('store-url').value.trim();
  if (!name || !url) return storeFormStatus('error', 'Name and URL are required.');
  const s = { name, url, authKey: $('store-authkey').value.trim() };
  const stores = await getStores();
  if (editingStoreId) { const e = stores.find(x => x.id === editingStoreId); if (e) Object.assign(e, s); editingStoreId = null; $('store-cancel-btn').classList.add('hidden'); }
  else { s.id = Date.now().toString(36); stores.push(s); }
  await setStores(stores);
  ['store-name','store-url','store-authkey'].forEach(id => $(id).value = '');
  storeFormStatus('success', 'Saved.');
  renderStores();
});
$('store-cancel-btn').addEventListener('click', () => {
  editingStoreId = null; $('store-cancel-btn').classList.add('hidden');
  ['store-name','store-url','store-authkey'].forEach(id => $(id).value = '');
});
function storeFormStatus(type, msg) { const el = $('store-form-status'); el.className = `status ${type}`; el.textContent = msg; el.classList.remove('hidden'); }

async function renderStores() {
  const stores = await getStores();
  const list = $('store-list');
  if (!stores.length) { list.innerHTML = '<li class="store-empty">No stores configured yet. Add one above.</li>'; return; }
  list.innerHTML = stores.map(s => `
    <li class="store-item" data-id="${s.id}">
      <div class="store-item-name">${escHtml(s.name)}</div>
      <div class="store-item-url">${escHtml(s.url)}</div>
      <div class="store-item-actions">
        <button data-act="test">Test</button>
        <button data-act="edit">Edit</button>
        <button data-act="del" class="del">Delete</button>
      </div>
      <div class="store-test hidden"></div>
    </li>`).join('');
  list.querySelectorAll('.store-item').forEach(li => {
    const id = li.dataset.id;
    li.querySelector('[data-act="test"]').addEventListener('click', () => testStore(id, li));
    li.querySelector('[data-act="edit"]').addEventListener('click', () => editStore(id));
    li.querySelector('[data-act="del"]').addEventListener('click', () => deleteStore(id));
  });
}
async function editStore(id) {
  const s = (await getStores()).find(x => x.id === id); if (!s) return;
  editingStoreId = id;
  $('store-name').value = s.name || '';
  $('store-url').value = s.url;
  $('store-authkey').value = s.authKey || '';
  $('store-cancel-btn').classList.remove('hidden');
}
async function deleteStore(id) { await setStores((await getStores()).filter(x => x.id !== id)); renderStores(); }

async function testStore(id, li) {
  const s = (await getStores()).find(x => x.id === id); if (!s) return;
  const badge = li.querySelector('.store-test'); badge.className = 'store-test'; badge.textContent = 'Testing...'; badge.classList.remove('hidden');
  if (!s.authKey) { badge.className = 'store-test error'; badge.textContent = '✗ Auth key is empty. Paste the key from the plugin dashboard.'; return; }
  const res = await window.api.wcTest({ store: s.url, authKey: s.authKey });
  badge.className = 'store-test ' + (res.ok ? 'success' : 'error');
  badge.textContent = res.ok ? '✓ ' + res.message : '✗ ' + res.error;
}

async function fillStoreSelect(selEl) {
  const stores = await getStores();
  selEl.innerHTML = stores.length
    ? stores.map(s => `<label><input type="checkbox" value="${s.id}"> ${escHtml(s.name)}</label>`).join('')
    : '<span class="none">No stores. Add one in the Stores tab.</span>';
}
async function importToStores(csv, selEl, statusFn, skipResize = false) {
  const stores = await getStores();
  const ids = [...selEl.querySelectorAll('input:checked')].map(c => c.value);
  if (!ids.length) return statusFn('error', 'Select at least one store.');
  const selected = stores.filter(s => ids.includes(s.id));
  const report = [];
  for (const s of selected) {
    statusFn('loading', `Importing into ${s.name}...`);
    if (!s.authKey) { report.push(`${s.name}: missing auth key`); continue; }
    const res = await window.api.wcImport({ store: s.url, authKey: s.authKey, csv, skipResize });
    if (res.ok) {
      const d = res.data || {};
      const created = (d.created_variable || 0) + (d.created_simple || 0);
      const updated = (d.updated_variable || 0) + (d.updated_simple || 0);
      const skipped = d.skipped || 0;
      const parts = [];
      if (created) parts.push(created + ' created');
      if (updated) parts.push(updated + ' updated');
      if (skipped) parts.push(skipped + ' skipped');
      report.push(`✓ ${s.name}${parts.length ? ' (' + parts.join(', ') + ')' : ''}`);
    } else {
      report.push(`✗ ${s.name}: ${res.error}`);
    }
  }
  statusFn('success', report.join(' | '));
}

$('import-btn').addEventListener('click', async () => {
  const box = $('import-box'); box.classList.toggle('hidden');
  if (!box.classList.contains('hidden')) await fillStoreSelect($('store-select'));
});
$('do-import-btn').addEventListener('click', () =>
  importToStores(csvOf(COLUMNS, exportRows()), $('store-select'),
    (t, m) => { const el = $('import-status'); el.className = `status ${t}`; el.textContent = m; el.classList.remove('hidden'); },
    !$('resize-cb').checked));

// ═══ Brands list ════════════════════════════════════════
let brandsRendered = false;
function brandNameFromDomain(domain) {
  if (!domain) return '';
  return domain.split('.')[0].replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
async function renderBrands() {
  if (brandsRendered) return;
  const brands = (self.BrandCatalog && self.BrandCatalog.brands) || [];

  // Scrapers from Supabase (custom + predefined), grouped by domain.
  let scrapers = [];
  try { scrapers = self.Supabase ? await self.Supabase.listScrapers() : []; } catch (e) { scrapers = []; }
  const byDomain = {};
  for (const s of scrapers) {
    if (!s || !s.domain) continue;
    (byDomain[s.domain] = byDomain[s.domain] || []).push(s);
  }
  const custom = Object.entries(byDomain).map(([domain, rows]) => {
    const types = rows.map(r => r.type).filter(Boolean);
    const first = rows[0] || {};
    const predefined = rows.every(r => r.is_predefined);
    return {
      name: (first.brand && String(first.brand) !== '0' && String(first.brand) !== '')
        ? first.brand : brandNameFromDomain(domain),
      types,
      example: first.example || '',
      domain,
      custom: true,
      predefined,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  // Bundled catalog entries that aren't already in the Supabase registry.
  const customDomains = new Set(custom.map(c => c.domain));
  const ready = brands.filter(b => b.ready && !customDomains.has(b.domain));
  const soon = brands.filter(b => !b.ready);

  const li = b => {
    const exampleBtn = b.example
      ? `<a class="brand-example" href="${escHtml(b.example)}" target="_blank" rel="noopener">Example</a>`
      : '';
    const tags = (b.types || []).map(t => `<span class="type-tag type-${t}">${escHtml(t)}</span>`).join('');
    const delBtn = (b.custom && !b.predefined)
      ? `<button class="brand-del" data-domain="${escHtml(b.domain)}" title="Delete this scraper">✕</button>`
      : '';
    return `<li>
      <div class="brand-info">
        <span class="brand-name">${escHtml(b.name)}</span>
        ${tags}
      </div>
      <div class="brand-actions">${exampleBtn}${delBtn}</div>
    </li>`;
  };

  let html = custom.map(li).join('') + ready.map(li).join('');
  if (soon.length) html += `<li class="brands-soon">Coming soon: ${soon.map(b => escHtml(b.name)).join(', ')}</li>`;
  $('brands-list').innerHTML = html;

  // Delete handler for user-created (non-predefined) scrapers.
  $('brands-list').querySelectorAll('.brand-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const domain = btn.dataset.domain;
      try { if (self.Supabase) await self.Supabase.deleteScraperByDomain(domain); } catch (e) {}
      brandsRendered = false;
      renderBrands();
    });
  });

  brandsRendered = true;
}
