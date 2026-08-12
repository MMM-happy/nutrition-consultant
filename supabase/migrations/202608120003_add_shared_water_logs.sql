create table if not exists public.nutrition_water_logs (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.nutrition_profiles(id) on delete cascade,
  record_date date not null default current_date,
  volume_ml integer not null check (volume_ml > 0 and volume_ml <= 5000),
  created_at timestamptz not null default now()
);

create index if not exists nutrition_water_logs_profile_date_idx
  on public.nutrition_water_logs (profile_id, record_date desc, created_at desc);

alter table public.nutrition_water_logs enable row level security;
grant select, insert on table public.nutrition_water_logs to anon;

drop policy if exists "Public can view shared water logs" on public.nutrition_water_logs;
drop policy if exists "Public can create shared water logs" on public.nutrition_water_logs;

create policy "Public can view shared water logs"
on public.nutrition_water_logs for select to anon using (true);

create policy "Public can create shared water logs"
on public.nutrition_water_logs for insert to anon with check (true);
