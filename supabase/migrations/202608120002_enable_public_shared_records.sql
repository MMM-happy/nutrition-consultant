-- Public shared-wall mode: visitors may view and add records, but cannot edit or delete them.
alter table public.nutrition_meals add column if not exists legacy_key text;
create unique index if not exists nutrition_meals_legacy_key_unique on public.nutrition_meals (legacy_key) where legacy_key is not null;

grant select, insert on table public.nutrition_profiles to anon;
grant select, insert on table public.nutrition_meals to anon;

drop policy if exists "Public can view shared nutrition profiles" on public.nutrition_profiles;
drop policy if exists "Public can create shared nutrition profiles" on public.nutrition_profiles;
drop policy if exists "Public can view shared nutrition meals" on public.nutrition_meals;
drop policy if exists "Public can create shared nutrition meals" on public.nutrition_meals;

create policy "Public can view shared nutrition profiles"
on public.nutrition_profiles for select to anon using (true);

create policy "Public can create shared nutrition profiles"
on public.nutrition_profiles for insert to anon with check (true);

create policy "Public can view shared nutrition meals"
on public.nutrition_meals for select to anon using (true);

create policy "Public can create shared nutrition meals"
on public.nutrition_meals for insert to anon with check (true);
