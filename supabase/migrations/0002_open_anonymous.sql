-- Open governance WITHOUT auth: allow anonymous reads AND writes to scrapers.
-- Run after 0001_init.sql. The extension now works with no sign-in/sign-up.

grant insert, update, delete on public.scrapers to anon;

drop policy if exists "scrapers auth insert" on public.scrapers;
drop policy if exists "scrapers auth update" on public.scrapers;
drop policy if exists "scrapers auth delete" on public.scrapers;

create policy "scrapers anon insert" on public.scrapers for insert with check (true);
create policy "scrapers anon update" on public.scrapers for update using (true);
create policy "scrapers anon delete" on public.scrapers for delete using (true);
