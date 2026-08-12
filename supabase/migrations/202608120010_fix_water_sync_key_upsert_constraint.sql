-- PostgREST ON CONFLICT requires a full unique constraint, not a partial unique index.
drop index if exists public.nutrition_water_logs_sync_key_unique;

alter table public.nutrition_water_logs
  drop constraint if exists nutrition_water_logs_sync_key_key;

alter table public.nutrition_water_logs
  add constraint nutrition_water_logs_sync_key_key unique (sync_key);
