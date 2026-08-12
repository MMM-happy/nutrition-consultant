-- Public meal photos are saved only by the application server and displayed with public meal records.
alter table public.nutrition_meals
  add column if not exists photo_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'meal-photos',
  'meal-photos',
  true,
  6291456,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public site can upload meal photos" on storage.objects;
create policy "Public site can upload meal photos"
on storage.objects for insert to anon
with check (bucket_id = 'meal-photos');
