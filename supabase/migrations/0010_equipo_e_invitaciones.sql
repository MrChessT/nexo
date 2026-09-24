-- Equipo: invitaciones por email, listado de miembros para administradores y protección de propietarios.
--
-- Flujo: un administrador invita un email con rol y locales → la persona entra en la app con ese email
-- (enlace mágico: el email queda verificado) → accept_invitations() la une a la organización.
-- Sin service role: todo con el JWT del usuario y comprobaciones en funciones security definer.

create table if not exists invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  email text not null check (email = lower(trim(email)) and email like '%_@_%'),
  role member_role not null default 'staff',
  all_locations boolean not null default false,
  location_ids uuid[] not null default '{}',
  invited_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);
create unique index if not exists invitations_pending on invitations(org_id, email) where accepted_at is null;
create index if not exists invitations_email on invitations(email) where accepted_at is null;

alter table invitations enable row level security;

-- Solo administradores; y solo un propietario puede invitar a otro propietario.
drop policy if exists invitations_admin on invitations;
create policy invitations_admin on invitations for all
  using (is_admin(org_id))
  with check (is_admin(org_id) and (role <> 'owner' or auth_role(org_id) = 'owner'));

-- Une al usuario actual a las organizaciones que lo han invitado (por su email verificado).
create or replace function accept_invitations() returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_count integer := 0;
  inv invitations;
begin
  if auth.uid() is null then raise exception 'unauthenticated'; end if;
  select lower(email) into v_email from auth.users where id = auth.uid() and email_confirmed_at is not null;
  if v_email is null then return 0; end if;
  perform set_config('nexo.accepting_invitation', 'on', true);

  for inv in select * from invitations where email = v_email and accepted_at is null for update loop
    insert into memberships (org_id, user_id, role, all_locations)
    values (inv.org_id, auth.uid(), inv.role, inv.all_locations)
    on conflict (org_id, user_id) do nothing;

    insert into membership_locations (org_id, user_id, location_id)
    select inv.org_id, auth.uid(), l.id
    from locations l
    where l.org_id = inv.org_id and l.id = any(inv.location_ids)
    on conflict do nothing;

    update invitations set accepted_at = now() where id = inv.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- Miembros con su email (auth.users no es legible desde el cliente). Solo administradores.
create or replace function org_members(p_org uuid)
returns table (user_id uuid, email text, full_name text, role member_role, all_locations boolean, location_ids uuid[], joined_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin(p_org) then raise exception 'forbidden'; end if;
  return query
  select m.user_id, u.email::text, p.full_name, m.role, m.all_locations,
         coalesce(array_agg(ml.location_id) filter (where ml.location_id is not null), '{}'),
         m.created_at
  from memberships m
  join auth.users u on u.id = m.user_id
  left join profiles p on p.user_id = m.user_id
  left join membership_locations ml on ml.org_id = m.org_id and ml.user_id = m.user_id
  where m.org_id = p_org
  group by m.user_id, u.email, p.full_name, m.role, m.all_locations, m.created_at
  order by m.created_at;
end $$;

-- Propietarios: solo otro propietario los cambia o los quita, y siempre queda al menos uno.
-- (Sin usuario, como en borrados en cascada de toda la organización, no se aplica.)
create or replace function protect_owners() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    return coalesce(new, old);
  end if;
  -- Altas legítimas de propietario: la organización recién creada (aún sin miembros) o una
  -- invitación que ya validó un propietario (accept_invitations marca la transacción).
  if tg_op = 'INSERT' and new.role = 'owner'
     and (current_setting('nexo.accepting_invitation', true) = 'on'
          or not exists (select 1 from memberships where org_id = new.org_id)) then
    return new;
  end if;
  if (tg_op <> 'INSERT' and old.role = 'owner') or (tg_op <> 'DELETE' and new.role = 'owner') then
    if auth_role(coalesce(new.org_id, old.org_id)) is distinct from 'owner' then
      raise exception 'forbidden';
    end if;
  end if;
  if tg_op <> 'INSERT' and old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner') then
    if not exists (select 1 from memberships where org_id = old.org_id and role = 'owner' and user_id <> old.user_id) then
      raise exception 'last_owner';
    end if;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists memberships_protect_owners on memberships;
create trigger memberships_protect_owners
before insert or update or delete on memberships
for each row execute function protect_owners();

revoke execute on function accept_invitations(), org_members(uuid) from public, anon;
grant execute on function accept_invitations(), org_members(uuid) to authenticated;
