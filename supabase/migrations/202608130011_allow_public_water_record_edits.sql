-- This site intentionally exposes shared records. Permit the new edit and delete controls.
grant update, delete on table public.nutrition_water_logs to anon;

drop policy if exists "Public can edit shared water logs" on public.nutrition_water_logs;
create policy "Public can edit shared water logs"
on public.nutrition_water_logs for update to anon
using (true)
with check (true);

drop policy if exists "Public can delete shared water logs" on public.nutrition_water_logs;
create policy "Public can delete shared water logs"
on public.nutrition_water_logs for delete to anon
using (true);

alter table public.nutrition_backup_events
  drop constraint if exists nutrition_backup_events_event_type_check;
alter table public.nutrition_backup_events
  add constraint nutrition_backup_events_event_type_check check (event_type in ('profile_created', 'meal_created', 'water_created', 'water_updated', 'water_deleted', 'profile_deleted'));

create or replace function public.capture_nutrition_backup_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare snapshot jsonb;
begin
  snapshot := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  insert into public.nutrition_backup_events (event_type, profile_id, payload)
  values (
    case
      when tg_table_name = 'nutrition_profiles' and tg_op = 'DELETE' then 'profile_deleted'
      when tg_table_name = 'nutrition_profiles' then 'profile_created'
      when tg_table_name = 'nutrition_meals' then 'meal_created'
      when tg_table_name = 'nutrition_water_logs' and tg_op = 'UPDATE' then 'water_updated'
      when tg_table_name = 'nutrition_water_logs' and tg_op = 'DELETE' then 'water_deleted'
      else 'water_created'
    end,
    coalesce(snapshot->>'profile_id', snapshot->>'id'), snapshot
  );
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists nutrition_water_logs_backup_insert on public.nutrition_water_logs;
create trigger nutrition_water_logs_backup_insert
after insert or update or delete on public.nutrition_water_logs
for each row execute function public.capture_nutrition_backup_event();

revoke execute on function public.capture_nutrition_backup_event() from public, anon, authenticated;
