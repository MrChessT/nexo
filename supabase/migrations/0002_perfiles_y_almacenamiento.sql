create table profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  created_at timestamptz not null default now()
);

create function handle_new_user_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, full_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'full_name', ''));
  return new;
end $$;

create trigger on_auth_user_created_profile
after insert on auth.users
for each row execute function handle_new_user_profile();

alter table profiles enable row level security;

create policy profile_select_shared_org on profiles for select using (
  user_id = auth.uid()
  or exists (
    select 1
    from memberships own_membership
    join memberships shared_membership on shared_membership.org_id = own_membership.org_id
    where own_membership.user_id = auth.uid()
      and shared_membership.user_id = profiles.user_id
  )
);

create policy profile_update_self on profiles for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'albaranes',
  'albaranes',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy receipts_read on storage.objects for select
using (
  bucket_id = 'albaranes'
  and array_length(storage.foldername(name), 1) >= 3
  and can_access_location((storage.foldername(name))[2]::uuid)
);

create policy receipts_upload on storage.objects for insert
with check (
  bucket_id = 'albaranes'
  and array_length(storage.foldername(name), 1) >= 3
  and can_access_location((storage.foldername(name))[2]::uuid)
);

create policy receipts_delete on storage.objects for delete
using (
  bucket_id = 'albaranes'
  and array_length(storage.foldername(name), 1) >= 3
  and can_access_location((storage.foldername(name))[2]::uuid)
);
