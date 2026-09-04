-- Universal Scrapper — initial schema.
-- Run this in the Supabase SQL Editor (Project → SQL Editor → New query → Run).

create extension if not exists "pgcrypto";

-- ── Scraper registry ─────────────────────────────────────────────────────────
create table if not exists public.scrapers (
  id uuid primary key default gen_random_uuid(),
  domain text not null,
  type text not null check (type in ('simple', 'variable')),
  brand text,
  example text,
  code text,
  is_predefined boolean not null default false,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (domain, type)
);

-- ── Scrape history (audit trail) ─────────────────────────────────────────────
create table if not exists public.scrape_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade default auth.uid(),
  domain text,
  url text,
  product_type text,
  row_count integer,
  ok boolean,
  error text,
  created_at timestamptz not null default now()
);

-- ── updated_at trigger ───────────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists scrapers_touch on public.scrapers;
create trigger scrapers_touch before update on public.scrapers
  for each row execute function public.touch_updated_at();

-- ── Row level security ───────────────────────────────────────────────────────
alter table public.scrapers enable row level security;
alter table public.scrape_history enable row level security;

-- scrapers: public read, any authenticated user may write (open governance).
drop policy if exists "scrapers public read" on public.scrapers;
create policy "scrapers public read" on public.scrapers for select using (true);

drop policy if exists "scrapers auth insert" on public.scrapers;
create policy "scrapers auth insert" on public.scrapers for insert
  with check (auth.role() = 'authenticated');

drop policy if exists "scrapers auth update" on public.scrapers;
create policy "scrapers auth update" on public.scrapers for update
  using (auth.role() = 'authenticated');

drop policy if exists "scrapers auth delete" on public.scrapers;
create policy "scrapers auth delete" on public.scrapers for delete
  using (auth.role() = 'authenticated');

-- scrape_history: owner only.
drop policy if exists "history owner" on public.scrape_history;
create policy "history owner" on public.scrape_history for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── Grants for PostgREST ─────────────────────────────────────────────────────
grant usage on schema public to anon, authenticated;
grant select on public.scrapers to anon, authenticated;
grant insert, update, delete on public.scrapers to authenticated;
grant select, insert, update, delete on public.scrape_history to authenticated;
