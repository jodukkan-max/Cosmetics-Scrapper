const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhuc2NvZnZwemlsdWFoc3B5anFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0Njc5MjEsImV4cCI6MjEwMzA0MzkyMX0.tqVD8zrRo-vRF3SPLVKflWMsmfkznDra6NLU0UzQXgg';

(async () => {
  const r = await fetch('https://hnscofvpziluahspyjqk.supabase.co/rest/v1/scrapers?domain=eq.waterslager.jo&select=*', {
    headers: { apikey: ANON, Authorization: 'Bearer ' + ANON },
  });
  const rows = await r.json();
  console.log('count=', rows.length);
  for (const s of rows) {
    console.log('---', s.domain, '|', s.type, '| brand=', s.brand, '| predefined=', s.is_predefined, '| verified=', s.verified);
    if (s.code) console.log(s.code.slice(0, 2000));
    console.log('...code length=', (s.code || '').length);
  }
})();
