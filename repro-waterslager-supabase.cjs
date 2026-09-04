const fs = require('fs');
const vm = require('vm');

const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhuc2NvZnZwemlsdWFoc3B5anFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0Njc5MjEsImV4cCI6MjEwMzA0MzkyMX0.tqVD8zrRo-vRF3SPLVKflWMsmfkznDra6NLU0UzQXgg';

const html = fs.readFileSync('/tmp/waterslager.html', 'utf8');

(async () => {
  const r = await fetch('https://hnscofvpziluahspyjqk.supabase.co/rest/v1/scraper_modules?name=eq.predefined&select=code,version', {
    headers: { apikey: ANON, Authorization: 'Bearer ' + ANON },
  });
  const rows = await r.json();
  const mod = rows[0];
  console.log('module version=', mod.version, 'codeLen=', mod.code.length);

  const root = {};
  const sandbox = { self: root, root, console, URL, fetch };
  vm.createContext(sandbox);
  vm.runInContext(mod.code + '\nreturn;', sandbox); // define self.ProductScraper
  const src = mod.code + '\nreturn self.ProductScraper.scrapeProduct(ctx);';

  try {
    const out = await vm.runInContext(src, sandbox, {
      ctx: {
        url: 'https://www.waterslager.jo/index.php?route=product/product&language=en-gb&product_id=419&path=48_51',
        mainHtml: html,
        productType: 'auto',
        fetchText: async (u) => (await fetch(u)).text(),
        fetchJson: async (u) => (await fetch(u)).json(),
      },
    });
    console.log('OK site=', out.site, 'brand=', out.brand, 'title=', out.title, 'rows=', out.rows && out.rows.length);
  } catch (e) {
    console.log('ERROR:', e && e.message ? e.message : e);
    console.log(e && e.stack ? e.stack.split('\n').slice(0, 8).join('\n') : '');
  }
})();
