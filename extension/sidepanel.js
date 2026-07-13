'use strict';

const VARIABLE_COLUMNS = ['ID','Parent','Type','SKU','Name','tags','Product URL','Images','Description','Short Description','Categories','Regular Price','Sale Price','Attribute 1 name','Attribute 1 value(s)','Attribute 1 visible','Attribute 1 global','Color Code','Rey Swatches'];
const SIMPLE_COLUMNS = ['SKU','Name','tags','Product URL','Description','Short Description','Regular Price','Categories','Images','Sale Price'];

let currentRows = [];
let currentType = 'variable';
let COLUMNS = VARIABLE_COLUMNS;
let editingStoreId = null;
let selectedIds = new Set();
let defaultMode = 'all';

let discoverCategories = [];

const $ = id => document.getElementById(id);
const escHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function detectSite(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    const map = { 'elfcosmetics.com':'e.l.f.','maybelline.com':'Maybelline','hudabeauty.com':'Huda Beauty','flormar.com':'Flormar','lorealparisusa.com':"L'Oréal Paris",'vichy-me.com':'Vichy','pastelarabia.com':'Pastel','laroche-posay.us':'La Roche-Posay','urbancare.ro':'Urban Care','bielenda.pl':'Bielenda','sephora.com':'Sephora','cerave.com':'CeraVe','narscosmetics.com':'NARS','glowrecipe.com':'Glow Recipe','seventeencosmetics.com':'Seventeen','inglotcosmetics.com':'Inglot','clamanti.co.uk':'Clamanti','lacabine.es':'laCabine','brunovassari.com':'Bruno Vassari','beesline.com':'Beesline','dermaliscio.net':'Dermaliscio','babaria.es':'Babaria','sarahk.com.br':'Sarah K','sheamiracles.com':'Shea Miracles','macadamiahair.com':'Macadamia Hair','cantubeauty.com':'Cantu Beauty','al-dawaa.com':'Creme 21' };
    for (const d in map) if (h === d || h.endsWith('.' + d)) return map[d];
  } catch (e) {}
  return '';
}

// I── Tabs (Products / Bulk / Stores / Categories) I───────────────────────────
document.querySelectorAll('.sp-tab').forEach(btn => btn.addEventListener('click', () => {
  const tab = btn.dataset.tab;
  document.querySelectorAll('.sp-tab').forEach(b => b.classList.toggle('active', b === btn));
  $('panel-products').classList.toggle('hidden', tab !== 'products');
  $('panel-bulk').classList.toggle('hidden', tab !== 'bulk');
  $('panel-stores').classList.toggle('hidden', tab !== 'stores');
  $('panel-categories').classList.toggle('hidden', tab !== 'categories');
  if (tab === 'stores') renderStores();
  if (tab === 'bulk') refreshBulkUI();
  if (tab === 'categories') renderCategories();
}));

// ═══ Category management ══════════════════════════════════════════════════════
// Persisted as { id, name, parentId } (parentId = '' for top-level)
let catList = [];

async function loadCategories() {
  const d = await chrome.storage.local.get('categories');
  catList = d.categories || [];
}
async function saveCategories() {
  await chrome.storage.local.set({ categories: catList });
}

function catNextId() {
  let max = 0;
  for (const c of catList) if (c.id > max) max = c.id;
  return max + 1;
}

// Flatten nested categories into "Parent > Child" display strings for multi-select
function flatCategoryOptions() {
  const flat = [];
  function walk(parentId, prefix) {
    const children = catList.filter(c => c.parentId === parentId);
    for (const c of children) {
      const label = prefix ? prefix + ' > ' + c.name : c.name;
      flat.push({ label, value: label });
      walk(c.id, label);
    }
  }
  walk('', '');
  return flat;
}

function renderCategories() {
  loadCategories().then(() => {
    const ul = $('cat-list');
    const empty = $('cat-empty');
    const sel = $('cat-parent-select');

    // Build parent select options
    const topCats = catList.filter(c => !c.parentId);
    sel.innerHTML = '<option value="">— Top-level —</option>' +
      topCats.map(c => `<option value="${c.id}">${escHtml(c.name)}</option>`).join('');

    if (!catList.length) {
      ul.innerHTML = '';
      ul.classList.add('hidden');
      empty.classList.remove('hidden');
      return;
    }
    ul.classList.remove('hidden');
    empty.classList.add('hidden');

    // Render tree: top-level with children indented
    function renderSub(cats, depth) {
      return cats.map(c => {
        const children = catList.filter(ch => ch.parentId === c.id);
        return `<li class="cat-item" style="padding-left:${8 + depth * 20}px">
          <span class="cat-name">${escHtml(c.name)}</span>
          <button class="cat-del-btn" data-id="${c.id}">Delete</button>
          ${children.length ? renderSub(children, depth + 1) : ''}
        </li>`;
      }).join('\n');
    }
    ul.innerHTML = `<ul class="cat-tree">${renderSub(topCats, 0)}</ul>`;

    // Delete handlers
    ul.querySelectorAll('.cat-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.id);
        // Also remove children
        catList = catList.filter(c => c.id !== id && c.parentId !== id);
        await saveCategories();
        renderCategories();
      });
    });
  });
}

$('cat-add-btn').addEventListener('click', async () => {
  const name = $('cat-name-input').value.trim();
  if (!name) return;
  const parentId = $('cat-parent-select').value ? Number($('cat-parent-select').value) : '';
  catList.push({ id: catNextId(), name, parentId });
  await saveCategories();
  $('cat-name-input').value = '';
  $('cat-parent-select').value = '';
  renderCategories();
});

// Load categories on startup
loadCategories();

// ═══ Product type ═══════════════════════════════════════════════════════════
$('type-variable').addEventListener('click', () => setType('variable'));
$('type-simple').addEventListener('click', () => setType('simple'));
function setType(t) {
  currentType = t;
  COLUMNS = t === 'simple' ? SIMPLE_COLUMNS : VARIABLE_COLUMNS;
  $('type-variable').classList.toggle('active', t === 'variable');
  $('type-simple').classList.toggle('active', t === 'simple');
}

// ═══ Active-tab detection ═════════════════════════════════════════════════════
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}
async function refreshHint() {
  const tab = await activeTab();
  const site = tab && tab.url ? detectSite(tab.url) : '';
  $('site-hint').textContent = site ? `Current page: ${site}` : 'Open a product page, or paste a URL below.';
}
refreshHint();
chrome.tabs.onActivated.addListener(refreshHint);
chrome.tabs.onUpdated.addListener(refreshHint);

// ═══ Scrape ═══════════════════════════════════════════════════════════════════
$('scrape-page-btn').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) return status('error', 'No active tab.');
  runScrape({ mode: 'active', productType: currentType, tabId: tab.id, url: tab.url });
});
$('scrape-url-btn').addEventListener('click', () => {
  const url = $('product-url').value.trim();
  if (!url) return;
  runScrape({ mode: 'url', productType: currentType, url });
});
$('product-url').addEventListener('keydown', e => { if (e.key === 'Enter') $('scrape-url-btn').click(); });

function status(type, msg) { const el = $('status'); el.className = `status ${type}`; el.textContent = msg; el.classList.remove('hidden'); }

function brandFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const brands = (self.ProductScraper && self.ProductScraper.brands) || [];
    const hit = brands.find(b => host === b.domain || host.endsWith('.' + b.domain));
    if (hit) return hit.name;
  } catch (e) {}
  return '';
}

async function runScrape(req) {
  $('results').classList.add('hidden');
  status('loading', 'Scraping…');
  try {
    const res = await chrome.runtime.sendMessage(Object.assign({ type: 'scrape' }, req));
    if (!res || !res.ok) throw new Error((res && res.error) || 'Scrape failed');
    currentRows = res.rows || [];
    const brand = brandFromUrl(req.url || '');
    currentRows.forEach(r => { r.tags = brand; r['Product URL'] = req.url || ''; r.Categories = r.Categories || ''; });
    $('status').classList.add('hidden');
    renderResults(res.title || '');
  } catch (e) {
    status('error', e.message);
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
  return [columns.map(esc).join(','), ...rows.map(r => columns.map(c => esc(cellValue(c, r, rows))).join(','))].join('\n');
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
    const names = kept.filter(x => x.Type === 'variation' && x.Parent === ref).map(x => x['Attribute 1 value(s)']);
    return Object.assign({}, r, { 'Attribute 1 value(s)': names.join(',') });
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
  $('result-title').textContent = title || 'Product';
  const variationIds = variationIdList();
  const preselect = defaultMode === 'all' ? variationIds : (defaultMode === 'first2' ? variationIds.slice(0, 2) : []);
  selectedIds = new Set(preselect);
  const showSel = currentType === 'variable' && variationIds.length > 0;
  $('select-bar').classList.toggle('hidden', !showSel);
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
        if (cc.startsWith('#')) return `<td><span class="swatch-dot" style="background:${escHtml(cc)}"></span> ${escHtml(cc)}</td>`;
        if (cc.startsWith('http')) return `<td><img src="${escHtml(cc)}" onerror="this.style.display='none'"></td>`;
      }
      // Categories: multi-select dropdown for parent/simple rows, empty for variations
      if (col === 'Categories') {
        if (isVar) return '<td></td>';
        const selected = String(row['Categories'] || '').split(',').map(s => s.trim()).filter(Boolean);
        const opts = flatCategoryOptions();
        const optionsHtml = opts.map(o => {
          const sel = selected.includes(o.value) ? ' selected' : '';
          return `<option value="${escHtml(o.value)}"${sel}>${escHtml(o.label)}</option>`;
        }).join('');
        return `<td class="cat-select-cell"><select multiple class="cat-multisel" data-rowid="${escHtml(String(row.ID))}">${optionsHtml}</select></td>`;
      }
      const val = cellValue(col, row);
      return `<td title="${escHtml(val)}">${escHtml(val.length > 80 ? val.slice(0, 80) + '…' : val)}</td>`;
    }).join('');
    return `<tr data-rowid="${escHtml(String(row.ID))}"${isVar ? ' class="var-row"' : ''}>${selCell}${cells}</tr>`;
  }).join('');

  // Categories multi-select change handlers
  $('tbody').querySelectorAll('.cat-multisel').forEach(sel => {
    sel.addEventListener('change', () => {
      const rowId = Number(sel.dataset.rowid);
      const row = currentRows.find(r => Number(r.ID) === rowId);
      if (!row) return;
      const vals = [...sel.selectedOptions].map(o => o.value);
      row['Categories'] = vals.join(', ');
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

// ═══ Variant selection ════════════════════════════════════════════════════════
$('sel-all').addEventListener('click', () => setAllChecks(true));
$('sel-none').addEventListener('click', () => setAllChecks(false));
function setDefaultMode(mode) {
  defaultMode = mode;
  $('default-all').checked = mode === 'all';
  $('default-first2').checked = mode === 'first2';
  chrome.storage.local.set({ defaultMode });
}
chrome.storage.local.get(['defaultMode', 'defaultSelectAll']).then(r => {
  const mode = r.defaultMode || (r.defaultSelectAll === false ? 'none' : 'all');
  defaultMode = mode;
  $('default-all').checked = mode === 'all';
  $('default-first2').checked = mode === 'first2';
});
$('default-all').addEventListener('change', e => setDefaultMode(e.target.checked ? 'all' : 'none'));
$('default-first2').addEventListener('change', e => setDefaultMode(e.target.checked ? 'first2' : 'none'));

// ═══ Stores ══════════════════════════════════════════════════════════════════
async function getStores() { return (await chrome.storage.local.get('stores')).stores || []; }
async function setStores(s) { await chrome.storage.local.set({ stores: s }); }

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

// Global WP username -- shared across all stores.
async function testStore(id, li) {
  const s = (await getStores()).find(x => x.id === id); if (!s) return;
  const badge = li.querySelector('.store-test'); badge.className = 'store-test'; badge.textContent = 'Testing...'; badge.classList.remove('hidden');
  if (!s.authKey) { badge.className = 'store-test error'; badge.textContent = '✗ Auth key is empty. Paste the key from the plugin dashboard.'; return; }
  const res = await chrome.runtime.sendMessage({ type: 'wcTest', store: s.url, authKey: s.authKey });
  badge.className = 'store-test ' + (res.ok ? 'success' : 'error');
  badge.textContent = res.ok ? '✓ ' + res.message : '✗ ' + res.error;
}

async function fillStoreSelect(selEl) {
  const stores = await getStores();
  selEl.innerHTML = stores.length
    ? stores.map(s => `<label><input type="checkbox" value="${s.id}"> ${escHtml(s.name)}</label>`).join('')
    : '<span class="none">No stores. Add one in the Stores tab.</span>';
}
async function importToStores(csv, selEl, statusFn) {
  // If selEl is null, import to all stores (used by bulk single-click import).
  const stores = await getStores();
  let selected;
  if (selEl) {
    const ids = [...selEl.querySelectorAll('input:checked')].map(c => c.value);
    if (!ids.length) return statusFn('error', 'Select at least one store.');
    selected = stores.filter(s => ids.includes(s.id));
  } else {
    selected = stores.filter(s => s.authKey);
    if (!selected.length) return statusFn('error', 'No stores with auth keys configured.');
  }
  const report = [];
  for (const s of selected) {
    statusFn('loading', `Importing into ${s.name}...`);
    if (!s.authKey) { report.push(`${s.name}: missing auth key`); continue; }
    const res = await chrome.runtime.sendMessage({ type: 'wcImport', store: s.url, authKey: s.authKey, csv });
    report.push(res.ok ? `✓ ${s.name}` : `✗ ${s.name}: ${res.error}`);
  }
  statusFn('success', report.join(' | '));
}

$('import-btn').addEventListener('click', async () => {
  const box = $('import-box'); box.classList.toggle('hidden');
  if (!box.classList.contains('hidden')) await fillStoreSelect($('store-select'));
});
$('do-import-btn').addEventListener('click', () =>
  importToStores(csvOf(COLUMNS, exportRows()), $('store-select'),
    (t, m) => { const el = $('import-status'); el.className = `status ${t}`; el.textContent = m; el.classList.remove('hidden'); }));

// I── Bulk queue (dedicated panel) I───────────────────────────────────────────
async function getSaved() { return (await chrome.storage.local.get('savedProducts')).savedProducts || []; }
async function setSaved(s) { await chrome.storage.local.set({ savedProducts: s }); refreshBulkUI(); }
async function refreshBulkUI() {
  const saved = await getSaved();
  const has = saved.length > 0;
  $('bulk-tab-count').textContent = has ? `(${saved.length})` : '(0)';
  if (!$('panel-bulk').classList.contains('hidden')) {
    $('bulk-empty').classList.toggle('hidden', has);
    $('bulk-content').classList.toggle('hidden', !has);
    if (has) renderBulkList(saved);
  }
}
refreshBulkUI();

$('save-btn').addEventListener('click', async () => {
  if (!currentRows.length) return;
  const saved = await getSaved();
  saved.push({ id: Date.now().toString(36), title: $('result-title').textContent || 'Product', productType: currentType, rows: exportRows() });
  await setSaved(saved);
  flashCopied($('save-btn'));
});

function renumberRows(rows, startId) {
  const idMap = {}; let cur = startId;
  for (const r of rows) if (r.ID !== undefined && r.ID !== '') { idMap[r.ID] = cur; r.ID = cur++; }
  for (const r of rows) if (r.Parent && String(r.Parent).startsWith('id:')) {
    const old = parseInt(String(r.Parent).slice(3), 10);
    if (idMap[old] !== undefined) r.Parent = `id:${idMap[old]}`;
  }
  return cur;
}
function combineSaved(saved) {
  const anyVariable = saved.some(i => i.productType !== 'simple');
  const columns = anyVariable ? VARIABLE_COLUMNS : SIMPLE_COLUMNS;
  let out = []; let nextId = 1;
  for (const item of saved) {
    let rows = JSON.parse(JSON.stringify(item.rows));
    if (anyVariable && item.productType === 'simple') {
      rows = rows.map(r => ({
        ID: nextId++, Parent: '', Type: 'simple', SKU: r.SKU || '', Name: r.Name || '', tags: r.tags || '', 'Product URL': r['Product URL'] || '',
        Images: r.Images || [], 'Rey Variations extra images': '',
        Description: r.Description || '', 'Short Description': r['Short Description'] || '',
        Categories: r.Categories || '', 'Regular Price': r['Regular Price'] || '', 'Sale Price': r['Sale Price'] || '',
        'Attribute 1 name': '', 'Attribute 1 value(s)': '', 'Attribute 1 visible': '', 'Attribute 1 global': '', 'Color Code': '',
      }));
    } else if (anyVariable) {
      nextId = renumberRows(rows, nextId);
    }
    out = out.concat(rows);
  }
  return { columns, rows: out };
}

function renderBulkList(saved) {
  const list = $('bulk-list');
  list.innerHTML = saved.map(s => {
    const products = s.productType === 'simple' ? s.rows.length : s.rows.filter(r => r.Type === 'variable').length;
    const vars = s.rows.filter(r => r.Type === 'variation').length;
    const meta = s.productType === 'simple' ? 'simple' : `${vars} variation${vars !== 1 ? 's' : ''}`;
    return `<li class="store-item" data-id="${s.id}">
      <div class="store-item-name">${escHtml(s.title)}</div>
      <div class="store-item-url">${escHtml(s.productType)} · ${meta}</div>
      <div class="store-item-actions"><button data-act="del" class="del">Remove</button></div>
    </li>`;
  }).join('');
  list.querySelectorAll('[data-act="del"]').forEach(b =>
    b.addEventListener('click', async (e) => {
      const id = e.target.closest('.store-item').dataset.id;
      await setSaved((await getSaved()).filter(x => x.id !== id));
    }));
}

$('bulk-clear').addEventListener('click', async () => { await setSaved([]); });
$('bulk-copy').addEventListener('click', async () => {
  const saved = await getSaved();
  if (!saved.length) return;
  const { columns, rows } = combineSaved(saved);
  navigator.clipboard.writeText(tsvOf(columns, rows)).then(() => flashCopied($('bulk-copy')));
});
$('bulk-csv').addEventListener('click', async () => {
  const saved = await getSaved();
  if (!saved.length) return;
  const { columns, rows } = combineSaved(saved);
  downloadCsvFile(csvOf(columns, rows));
});

// Import to website — show store picker if multiple stores, else import directly.
$('bulk-import-btn').addEventListener('click', async () => {
  const saved = await getSaved();
  if (!saved.length) return;
  const stores = await getStores();
  const credentialed = stores.filter(s => s.authKey);
  // If exactly one store with credentials, import directly.
  if (credentialed.length === 1) {
    const { columns, rows } = combineSaved(saved);
    importToStores(csvOf(columns, rows), null,
      (t, m) => { const el = $('bulk-import-status'); el.className = `status ${t}`; el.textContent = m; el.classList.remove('hidden'); });
    $('bulk-import-status').classList.remove('hidden');
    return;
  }
  // Show store picker.
  const box = $('bulk-import-box'); box.classList.toggle('hidden');
  if (!box.classList.contains('hidden')) await fillStoreSelect($('bulk-store-select'));
});
$('bulk-do-import').addEventListener('click', async () => {
  const saved = await getSaved();
  if (!saved.length) return;
  const { columns, rows } = combineSaved(saved);
  importToStores(csvOf(columns, rows), $('bulk-store-select'),
    (t, m) => { const el = $('bulk-import-status'); el.className = `status ${t}`; el.textContent = m; el.classList.remove('hidden'); });
});

// ═══ Brands list (with discover buttons) ═══════════════════════════════════════
function renderBrands() {
  const brands = (self.ProductScraper && self.ProductScraper.brands) || [];
  const ready = brands.filter(b => b.ready);
  const soon = brands.filter(b => !b.ready);
  const li = b => {
    const discoverBtn = b.discover
      ? `<button class="brand-discover-btn" data-brand-key="${escHtml(b.key)}" data-brand-name="${escHtml(b.name)}">Discover</button>`
      : '';
    const exampleBtn = b.example
      ? `<a class="brand-example" href="${escHtml(b.example)}" target="_blank" rel="noopener">Example</a>`
      : '';
    const actions = [discoverBtn, exampleBtn].filter(Boolean).join('');
    return `<li>
      <span class="brand-name">${escHtml(b.name)}</span>
      <div class="brand-actions">${actions}</div>
    </li>`;
  };
  let html = ready.map(li).join('');
  if (soon.length) html += `<li class="brands-soon">Coming soon: ${soon.map(b => escHtml(b.name)).join(', ')}</li>`;
  $('brands-list').innerHTML = html;
  // Wire discover buttons
  document.querySelectorAll('.brand-discover-btn').forEach(btn =>
    btn.addEventListener('click', () => startDiscover(btn.dataset.brandKey, btn.dataset.brandName)));
}
renderBrands();

// ═══ Discover (inline panel) ═══════════════════════════════════════════════════

$('discover-close-btn').addEventListener('click', () => {
  $('discover-panel').classList.add('hidden');
});

async function startDiscover(site, brandName) {
  // Reset panel
  $('discover-brand-name').textContent = brandName;
  $('discover-results').classList.add('hidden');
  $('discover-status').classList.add('hidden');
  $('discover-progress').classList.remove('hidden');
  $('discover-progress-fill').style.width = '0%';
  $('discover-progress-text').textContent = 'Fetching sitemap…';
  $('discover-panel').classList.remove('hidden');
  $('discover-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  document.querySelectorAll('.brand-discover-btn').forEach(b => b.disabled = true);
  discoverCategories = [];
  try {
    const res = await chrome.runtime.sendMessage({ type: 'bulkDiscover', site });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Discovery failed');
    discoverCategories = res.categories || [];
    renderDiscoverResults(res);
    discoverPanelStatus('success', `Found ${res.totalProducts} products across ${res.totalCategories} categories.`);
  } catch (e) {
    discoverPanelStatus('error', e.message);
  } finally {
    $('discover-progress').classList.add('hidden');
    document.querySelectorAll('.brand-discover-btn').forEach(b => b.disabled = false);
  }
}

function discoverPanelStatus(type, msg) {
  const el = $('discover-status');
  el.className = `status ${type}`; el.textContent = msg; el.classList.remove('hidden');
}

function renderDiscoverResults(res) {
  const totalProds = res.totalProducts || discoverCategories.reduce((s, c) => s + (c.products || []).length, 0);
  $('discover-result-title').textContent = res.totalCategories + ' categories';
  $('discover-result-count').textContent = totalProds + ' products';
  $('discover-results').classList.remove('hidden');
  $('discover-status').classList.add('hidden');

  $('discover-tree').innerHTML = discoverCategories.map((cat, i) => {
    const prods = cat.products || [];
    const errorNote = cat.error ? `<span class="discover-error">⚠ ${escHtml(cat.error)}</span>` : '';
    let productRows = '';
    if (prods.length) {
      productRows = prods.map((p, j) => `
        <tr>
          <td class="discover-col-id">${j + 1}</td>
          <td>${p.name ? escHtml(p.name) : '<span class="muted">(unknown)</span>'}</td>
          <td><a href="${escHtml(p.url)}" target="_blank" rel="noopener" class="discover-url">${escHtml(p.url.split('/en/catalogue/')[1] || p.url)}</a></td>
          <td class="discover-col-add"><button class="discover-add-btn" data-url="${escHtml(p.url)}">+ Bulk</button></td>
        </tr>`).join('');
    }
    return `<details class="discover-cat-details"${i === 0 ? ' open' : ''}>
      <summary class="discover-cat-summary">
        <span class="discover-cat-name">${escHtml(cat.name)}</span>
        <span class="discover-cat-url"><a href="${escHtml(cat.url)}" target="_blank" rel="noopener">${escHtml(cat.url.replace(/https?:\/\/seventeencosmetics\.com/, ''))}</a></span>
        <span class="discover-cat-count">${prods.length}</span>
        ${errorNote}
      </summary>
      ${prods.length ? `<table class="discover-prod-table"><thead><tr><th class="discover-col-id">#</th><th>Product</th><th>URL</th><th class="discover-col-add"></th></tr></thead><tbody>${productRows}</tbody></table>` : '<p class="muted" style="padding:0 12px 8px">No products found on this category page.</p>'}
    </details>`;
  }).join('');

  // Wire "Add to bulk" buttons
  $('discover-tree').querySelectorAll('.discover-add-btn').forEach(btn =>
    btn.addEventListener('click', async (e) => {
      const url = e.target.dataset.url;
      // Run a quick variable scrape for this product URL
      try {
        e.target.textContent = '…';
        e.target.disabled = true;
        const res = await chrome.runtime.sendMessage({ type: 'scrape', mode: 'url', productType: 'variable', url });
        if (!res || !res.ok) throw new Error((res && res.error) || 'Scrape failed');
        const brand = (self.ProductScraper && self.ProductScraper.brands || [])
          .find(b => url.includes(b.domain));
        const rows = res.rows || [];
        rows.forEach(r => { r.tags = brand ? brand.name : ''; r['Product URL'] = url; });
        const saved = await getSaved();
        saved.push({ id: Date.now().toString(36), title: res.title || url, productType: 'variable', rows });
        await setSaved(saved);
        e.target.textContent = '✓';
        e.target.classList.add('copied');
        setTimeout(() => { e.target.textContent = '+ Bulk'; e.target.classList.remove('copied'); e.target.disabled = false; }, 2000);
      } catch (err) {
        e.target.textContent = '✗';
        e.target.style.color = 'var(--err)';
        setTimeout(() => { e.target.textContent = '+ Bulk'; e.target.style.color = ''; e.target.disabled = false; }, 2000);
      }
    }));

  $('discover-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('discover-expand-btn').addEventListener('click', () => {
  $('discover-tree').querySelectorAll('details').forEach(d => d.open = true);
});
$('discover-collapse-btn').addEventListener('click', () => {
  $('discover-tree').querySelectorAll('details').forEach(d => d.open = false);
});
$('discover-csv-btn').addEventListener('click', () => {
  const rows = [];
  for (const cat of discoverCategories) {
    for (const p of (cat.products || [])) {
      rows.push({ category: cat.name, categoryUrl: cat.url, product: p.name, productUrl: p.url });
    }
  }
  if (!rows.length) return;
  const esc = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = ['Category,Category URL,Product Name,Product URL', ...rows.map(r =>
    [esc(r.category), esc(r.categoryUrl), esc(r.product), esc(r.productUrl)].join(','))].join('\n');
  downloadCsvFile(csv, 'discover-products.csv');
});

// Progress messages from background worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'bulkDiscoverProgress') {
    if (msg.phase === 'scanning') {
      const pct = Math.round((msg.current / msg.total) * 100);
      $('discover-progress-fill').style.width = pct + '%';
      const catName = (msg.catUrl || '').replace(/.*\/category\//, '').replace(/\/+$/, '').replace(/_\d+/, '');
      $('discover-progress-text').textContent = `Scanning ${msg.current}/${msg.total}: ${catName} (${msg.foundSoFar} products so far)`;
    } else if (msg.phase === 'done') {
      $('discover-progress-fill').style.width = '100%';
      $('discover-progress-text').textContent = `Done — ${msg.totalProducts} products across ${msg.totalCats} categories.`;
    }
  }
});
