create table if not exists public.nutrition_backup_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in ('profile_created', 'meal_created', 'water_created', 'profile_deleted')),
  profile_id text,
  payload jsonb not null,
  captured_at timestamptz not null default now()
);

alter table public.nutrition_backup_events enable row level security;
revoke all on table public.nutrition_backup_events from anon, authenticated;

create table if not exists public.nutrition_admin_controls (
  id boolean primary key default true check (id),
  password_hash text not null
);

alter table public.nutrition_admin_controls enable row level security;
revoke all on table public.nutrition_admin_controls from anon, authenticated;

insert into public.nutrition_admin_controls (id, password_hash)
values (true, '$2a$12$8bkPoHAFRS7MgPFNhM76GuHHMMloNTYEXyz5AERF4UOE50ZSuVeB6')
on conflict (id) do nothing;

create or replace function public.capture_nutrition_backup_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  snapshot jsonb;
begin
  if tg_op = 'DELETE' then
    snapshot := to_jsonb(old);
  else
    snapshot := to_jsonb(new);
  end if;
  insert into public.nutrition_backup_events (event_type, profile_id, payload)
  values (
    case tg_table_name
      when 'nutrition_profiles' then case when tg_op = 'DELETE' then 'profile_deleted' else 'profile_created' end
      when 'nutrition_meals' then 'meal_created'
      when 'nutrition_water_logs' then 'water_created'
    end,
    coalesce(snapshot->>'profile_id', snapshot->>'id'),
    snapshot
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.capture_nutrition_backup_event() from public;

drop trigger if exists nutrition_profiles_backup_insert on public.nutrition_profiles;
create trigger nutrition_profiles_backup_insert
after insert or delete on public.nutrition_profiles
for each row execute function public.capture_nutrition_backup_event();

drop trigger if exists nutrition_meals_backup_insert on public.nutrition_meals;
create trigger nutrition_meals_backup_insert
after insert on public.nutrition_meals
for each row execute function public.capture_nutrition_backup_event();

drop trigger if exists nutrition_water_logs_backup_insert on public.nutrition_water_logs;
create trigger nutrition_water_logs_backup_insert
after insert on public.nutrition_water_logs
for each row execute function public.capture_nutrition_backup_event();

create or replace function public.admin_delete_all_public_records(p_admin_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  expected_hash text;
  deleted_profiles integer;
begin
  select password_hash into expected_hash from public.nutrition_admin_controls where id = true;
  if expected_hash is null or crypt(p_admin_password, expected_hash) <> expected_hash then
    raise exception 'Unauthorized administrator request';
  end if;
  delete from public.nutrition_profiles;
  get diagnostics deleted_profiles = row_count;
  return jsonb_build_object('deletedProfiles', deleted_profiles);
end;
$$;

create or replace function public.admin_export_backup_events(p_admin_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  expected_hash text;
begin
  select password_hash into expected_hash from public.nutrition_admin_controls where id = true;
  if expected_hash is null or crypt(p_admin_password, expected_hash) <> expected_hash then
    raise exception 'Unauthorized administrator request';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(event) order by event.captured_at)
    from public.nutrition_backup_events event
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.admin_delete_all_public_records(text) from public;
revoke all on function public.admin_export_backup_events(text) from public;
grant execute on function public.admin_delete_all_public_records(text) to anon;
grant execute on function public.admin_export_backup_events(text) to anon;
