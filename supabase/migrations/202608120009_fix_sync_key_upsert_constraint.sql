-- PostgREST ON CONFLICT requires a full unique constraint; a partial index cannot be inferred.
drop index if exists public.nutrition_meals_sync_key_unique;

alter table public.nutrition_meals
  drop constraint if exists nutrition_meals_sync_key_key;

alter table public.nutrition_meals
  add constraint nutrition_meals_sync_key_key unique (sync_key);
