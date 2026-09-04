// Upload the shared predefined scraper module (scrapers.js) to Supabase.
// Stores the whole module ONCE in `scraper_modules` (name='predefined'), bumping
// `version` on every upload so the extension's cache can detect changes.
//
// Usage:
//   SERVICE_ROLE_KEY=... node upload-module.mjs
//
// `SERVICE_ROLE_KEY` is required. Get it from Project Settings → API →
// service_role. Never commit it.

import { readFile } from 'node:fs/promises';

const SUPABASE_URL = 'https://hnscofvpziluahspyjqk.supabase.co';
const NAME = 'predefined';

const key = process.env.SERVICE_ROLE_KEY;
if (!key) { console.error('SERVICE_ROLE_KEY env var is required.'); process.exit(1); }

const fileUrl = new URL('./supabase/predefined/scrapers.js', import.meta.url);
const source = await readFile(fileUrl, 'utf8');

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
};

// Read the current version, then bump it.
let currentVersion = 0;
{
  const r = await fetch(`${SUPABASE_URL}/rest/v1/scraper_modules?name=eq.${NAME}&select=version`, { headers });
  const data = await r.json().catch(() => []);
  currentVersion = (data && data[0] && data[0].version) || 0;
}

const nextVersion = currentVersion + 1;

const r = await fetch(`${SUPABASE_URL}/rest/v1/scraper_modules?on_conflict=name`, {
  method: 'POST',
  headers: {
    ...headers,
    Prefer: 'resolution=merge-duplicates',
  },
  body: JSON.stringify({ name: NAME, code: source, version: nextVersion }),
});

if (r.ok) {
  console.log(`Uploaded "${NAME}" module (${source.length} bytes) → version ${nextVersion}.`);
} else {
  console.error(`Upload failed: HTTP ${r.status} ${await r.text()}`);
  process.exit(1);
}
