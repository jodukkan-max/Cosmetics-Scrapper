// Live test: scrape the Seventeen Cosmetics product using the predefined
// module (from Supabase), build the exact CSV the mobile app sends, and POST
// it to The Coach store — printing the full response for diagnosis.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

globalThis.self = globalThis;
require('./desktop/renderer/supabase.js');
const createCore = require('./desktop/core.js');
const Supabase = globalThis.Supabase;
const core = createCore({ Supabase, sendProgress: () => {}, sendThinking: () => {} });

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const VARIABLE_COLS = [
  'ID', 'Parent', 'Type', 'SKU', 'Name', 'tags', 'Product URL', 'Images',
  'Description', 'Short Description', 'Regular Price',
  'Attribute 1 name', 'Attribute 1 value(s)',
  'Attribute 2 name', 'Attribute 2 value(s)',
  'Color Code', 'Rey Swatches',
];

function cell(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

// Port of the mobile app's _reySwatches()
function reySwatches(parentRow, allRows) {
  if (parentRow.Type !== 'variable') return '';
  const attrName = (parentRow['Attribute 1 name'] || 'Color').toString().toLowerCase();
  const parentRef = 'id:' + parentRow.ID;
  const variations = allRows.filter(r => r.Type === 'variation' && r.Parent === parentRef);
  const isImageSwatch = variations.some(v => (v['Color Code'] || '').toString().trim().startsWith('http'));
  const terms = {};
  for (const v of variations) {
    const colorName = (v['Attribute 1 value(s)'] || '').toString();
    const cc = (v['Color Code'] || '').toString().trim();
    if (!colorName) continue;
    terms[colorName] = isImageSwatch
      ? { name: colorName, rey_attribute_image: cc }
      : { name: colorName, rey_attribute_color: cc ? cc : '#000000' };
  }
  if (isImageSwatch) return JSON.stringify({ Image: { name: 'Image', type: 'rey_image', terms } });
  if (attrName !== 'color') return '';
  return JSON.stringify({ [attrName]: { name: attrName, type: 'rey_color', terms } });
}

function buildCsv(rows, url, brand) {
  const esc = s => /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  const lines = [VARIABLE_COLS.map(esc).join(',')];
  for (const r of rows) {
    const line = VARIABLE_COLS.map(c => {
      if (c === 'Images' || c === 'Rey Variations extra images') {
        const list = Array.isArray(r[c]) ? r[c] : (r[c] == null ? [] : [r[c]]);
        return esc(list.join('|'));
      }
      return esc(cell(r[c]));
    }).join(',');
    lines.push(line);
  }
  return lines.join('\n');
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return { html: await res.text(), finalUrl: res.url || url };
}

async function postImport(store, authKey, csv) {
  const url = store.replace(/\/+$/, '') + '/wp-json/scraper/v1/import-csv';
  console.log('   POST ' + url);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Scraper-Key': authKey },
      body: JSON.stringify({ csv, skip_resize: true }),
    });
  } catch (e) {
    return { transport: e.toString() };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, raw: text.slice(0, 500) };
}

async function main() {
  const url = 'https://seventeencosmetics.com/en/catalogue/skin-perfect-ultra-coverage-waterproof-foundation_23/?vid=24#All';

  console.log('== 1. Scrape ==');
  let res;
  try {
    const { html, finalUrl } = await fetchPage(url);
    res = await core.handleScrape({ url: finalUrl, html, productType: 'auto' });
  } catch (e) {
    console.log('   FAIL (fetch):', e.message);
    process.exit(1);
  }
  if (!res.ok) {
    console.log('   FAIL (scrape):', res.error);
    process.exit(1);
  }
  const vars = res.rows.filter(r => r.Type === 'variation');
  console.log('   OK brand=' + (res.brand || '') + ' rows=' + res.rows.length + ' variations=' + vars.length);
  console.log('   title=' + (res.rows[0] && res.rows[0].Name));

  // Simulate the mobile app's post-processing: tags + Product URL.
  const brand = (res.brand || '').toString() || 'Seventeen Cosmetics';
  const rows = res.rows.map(r => ({ ...r, tags: brand, 'Product URL': url }));

  // Recompute parent Attribute value(s) like _exportRows (all variations selected by default).
  const parent = rows.find(r => r.Type === 'variable');
  if (parent) {
    const ref = 'id:' + parent.ID;
    const vars2 = rows.filter(x => x.Type === 'variation' && x.Parent === ref);
    parent['Attribute 1 value(s)'] = [...new Set(vars2.map(x => (x['Attribute 1 value(s)'] || '').toString()).filter(Boolean))].join(',');
    parent['Attribute 2 value(s)'] = [...new Set(vars2.map(x => (x['Attribute 2 value(s)'] || '').toString()).filter(Boolean))].join(',');
    parent['Rey Swatches'] = reySwatches(parent, rows);
  }

  const csv = buildCsv(rows, url, brand);
  const fs = await import('node:fs');
  fs.writeFileSync('/tmp/coach-test.csv', csv);
  console.log('   CSV bytes=' + csv.length + ' lines=' + csv.split('\n').length);
  console.log('   wrote /tmp/coach-test.csv');
  console.log('   --- CSV header ---');
  console.log(csv.split('\n')[0]);

  console.log('\n== 2. Import to The Coach (thecoach-jo.com, key 1191) ==');
  const coach = await postImport('https://thecoach-jo.com/', '1191', csv);
  console.log('   status=' + coach.status);
  console.log('   body=' + JSON.stringify(coach.json ?? coach.raw, null, 2));

  console.log('\n== 3. Import to Sense (sensemakeupjo.com, key 5194) for comparison ==');
  const sense = await postImport('https://sensemakeupjo.com/', '5194', csv);
  console.log('   status=' + sense.status);
  console.log('   body=' + JSON.stringify(sense.json ?? sense.raw, null, 2));
}

main().catch(e => { console.error('Unexpected:', e); process.exit(1); });
