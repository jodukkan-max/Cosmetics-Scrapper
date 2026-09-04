// Extract the HTML string from a CDP Runtime.evaluate response JSON file.
// Usage: node extract-html.mjs <cdp-response.json> <output.html>
import { readFileSync, writeFileSync } from 'node:fs';

const [src, out] = process.argv.slice(2);
const json = JSON.parse(readFileSync(src, 'utf8'));
const value = json && json.result && json.result.value;
if (typeof value !== 'string') { console.error('No result.value string found in', src); process.exit(1); }
writeFileSync(out, value, 'utf8');
console.log('Wrote', out, value.length, 'bytes');
