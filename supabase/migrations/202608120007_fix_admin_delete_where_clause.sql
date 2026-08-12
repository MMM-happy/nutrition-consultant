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
  delete from public.nutrition_profiles where true;
  get diagnostics deleted_profiles = row_count;
  return jsonb_build_object('deletedProfiles', deleted_profiles);
end;
$$;

revoke all on function public.admin_delete_all_public_records(text) from public, authenticated;
grant execute on function public.admin_delete_all_public_records(text) to anon;
