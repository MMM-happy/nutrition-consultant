alter table public.nutrition_meals
  add column if not exists sync_key text;

alter table public.nutrition_water_logs
  add column if not exists sync_key text;

create unique index if not exists nutrition_meals_sync_key_unique
  on public.nutrition_meals (sync_key)
  where sync_key is not null;

create unique index if not exists nutrition_water_logs_sync_key_unique
  on public.nutrition_water_logs (sync_key)
  where sync_key is not null;

insert into public.nutrition_backup_events (event_type, profile_id, payload)
select 'profile_created', profile.id, to_jsonb(profile)
from public.nutrition_profiles profile
where not exists (
  select 1 from public.nutrition_backup_events event
  where event.event_type = 'profile_created' and event.profile_id = profile.id
);
