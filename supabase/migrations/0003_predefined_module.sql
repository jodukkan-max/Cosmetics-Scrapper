-- Serve predefined scraper code from Supabase.
-- Stores the shared predefined scraper module (scrapers.js) ONCE, instead of
-- duplicating it across the 138 metadata rows. The extension fetches this single
-- row, caches it, and runs ProductScraper.scrapeProduct(ctx) for predefined or
-- unknown sites.
--
-- Run after 0001_init.sql and 0002_open_anonymous.sql.

create table if not exists public.scraper_modules (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  code text,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.scraper_modules enable row level security;

-- Public read (the extension fetches it anonymously); no anonymous write — the
-- module is uploaded with the service_role key.
drop policy if exists "scraper_modules public read" on public.scraper_modules;
create policy "scraper_modules public read" on public.scraper_modules for select using (true);

grant usage on schema public to anon, authenticated;
grant select on public.scraper_modules to anon, authenticated;
