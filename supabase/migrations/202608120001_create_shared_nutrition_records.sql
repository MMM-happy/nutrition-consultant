create extension if not exists pgcrypto;

create table if not exists public.nutrition_profiles (
  id text primary key,
  name text not null check (char_length(name) between 1 and 60),
  target_weight numeric(5,1) not null check (target_weight > 0 and target_weight < 500),
  current_weight numeric(5,1) not null check (current_weight > 0 and current_weight < 500),
  bmr integer not null check (bmr > 0 and bmr < 10000),
  target_calories integer not null check (target_calories > 0 and target_calories < 20000),
  target_protein integer not null check (target_protein >= 0 and target_protein < 2000),
  target_carbs integer not null check (target_carbs >= 0 and target_carbs < 2000),
  target_fat integer not null check (target_fat >= 0 and target_fat < 1000),
  goal text not null check (char_length(goal) between 1 and 80),
  created_at timestamptz not null default now()
);

create table if not exists public.nutrition_meals (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.nutrition_profiles(id) on delete cascade,
  record_date date not null default current_date,
  meal_type text not null check (char_length(meal_type) between 1 and 30),
  name text not null check (char_length(name) between 1 and 200),
  calories integer not null check (calories >= 0 and calories < 20000),
  protein numeric(7,1) not null default 0 check (protein >= 0 and protein < 2000),
  carbs numeric(7,1) not null default 0 check (carbs >= 0 and carbs < 2000),
  fat numeric(7,1) not null default 0 check (fat >= 0 and fat < 1000),
  tip text not null default '',
  analysis text not null default '',
  source text not null default 'text' check (source in ('text', 'photo', 'manual')),
  created_at timestamptz not null default now()
);

create index if not exists nutrition_meals_profile_date_idx on public.nutrition_meals (profile_id, record_date desc, created_at desc);
create index if not exists nutrition_meals_date_idx on public.nutrition_meals (record_date desc, created_at desc);

alter table public.nutrition_profiles enable row level security;
alter table public.nutrition_meals enable row level security;

revoke all on table public.nutrition_profiles from anon, authenticated;
revoke all on table public.nutrition_meals from anon, authenticated;
grant select, insert, update, delete on table public.nutrition_profiles to service_role;
grant select, insert, update, delete on table public.nutrition_meals to service_role;
