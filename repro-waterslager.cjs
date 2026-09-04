const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('/tmp/waterslager.html', 'utf8');
const src = fs.readFileSync('supabase/predefined/scrapers.js', 'utf8');

const root = {};
const sandbox = { self: root, root, console, URL, fetch };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

(async () => {
  try {
    const out = await root.ProductScraper.scrapeProduct({
      url: 'https://www.waterslager.jo/index.php?route=product/product&language=en-gb&product_id=419&path=48_51',
      mainHtml: html,
      productType: 'auto',
      fetchText: async (u) => (await fetch(u)).text(),
      fetchJson: async (u) => (await fetch(u)).json(),
    });
    console.log('OK site=', out.site, 'brand=', out.brand, 'title=', out.title, 'rows=', out.rows && out.rows.length);
    console.log(JSON.stringify(out.rows && out.rows.slice(0, 3), null, 2));
  } catch (e) {
    console.log('ERROR:', e && e.message ? e.message : e);
    console.log(e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : '');
  }
})();
