// Seed predefined scraper metadata into Supabase from `supabase/predefined/scrapers.js`.
//
// Predefined scraper CODE is served from Supabase (the shared module in
// `scraper_modules`, uploaded by upload-module.mjs). This script seeds the
// CATALOG metadata (domain/type/brand/example) into the `scrapers` registry so
// predefined and user-added scrapers live in one database and the "already
// exists" check + Websites tab are driven by Supabase.
//
// Usage:
//   node migrate-predefined.mjs                 # build seed-predefined.json
//   SERVICE_ROLE_KEY=... node migrate-predefined.mjs --push   # seed Supabase
//
// `SERVICE_ROLE_KEY` is only needed for --push. Get it from Project Settings →
// API → service_role. Never commit it.

import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';

const SUPABASE_URL = 'https://hnscofvpziluahspyjqk.supabase.co';
const PUSH = process.argv.includes('--push');

const fileUrl = new URL('./supabase/predefined/scrapers.js', import.meta.url);
const source = await readFile(fileUrl, 'utf8');

const sandbox = { self: undefined, window: undefined };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const ProductScraper = sandbox.ProductScraper;
if (!ProductScraper || !ProductScraper.brands || !ProductScraper.SCRAPERS) {
  throw new Error('Failed to load ProductScraper from scrapers.js');
}

const { brands, SCRAPERS } = ProductScraper;

// One metadata row per (brand, type) present in SCRAPERS. `code` is intentionally
// NULL — predefined code is served by the bundled extension module.
const rows = [];
for (const b of brands) {
  const entry = SCRAPERS[b.key];
  if (!entry) continue;
  for (const type of ['variable', 'simple']) {
    if (typeof entry[type] === 'function') {
      rows.push({
        domain: b.domain,
        type,
        brand: b.name,
        example: b.example || '',
        is_predefined: true,
        code: null,
      });
    }
  }
}

console.log(`Built ${rows.length} predefined scraper metadata rows.`);

const outPath = new URL('./seed-predefined.json', import.meta.url);
await writeFile(outPath, JSON.stringify(rows, null, 2));
console.log(`Wrote ${outPath.pathname} (${rows.length} rows).`);

if (PUSH) {
  const key = process.env.SERVICE_ROLE_KEY;
  if (!key) { console.error('--push requires SERVICE_ROLE_KEY env var.'); process.exit(1); }
  let done = 0;
  for (const row of rows) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/scrapers?on_conflict=domain,type`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(row),
    });
    if (r.ok) done++;
    else console.error(`Push failed ${row.domain}/${row.type}: HTTP ${r.status} ${await r.text()}`);
  }
  console.log(`Pushed ${done}/${rows.length} rows.`);
}
