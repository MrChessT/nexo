-- Estado del asistente (Nexo Copiloto) en la base de datos: en Vercel cada petición puede ir a una
-- instancia distinta, así que borradores y sesiones no pueden vivir en memoria.
-- Todo con el JWT del usuario: cada uno solo ve y toca lo suyo.

create table copilot_sessions (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  -- Turnos recientes y aclaraciones pendientes (incluida la llamada nº 1 de Jev que se reutiliza).
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(state) = 'object')
);

create index copilot_sessions_user on copilot_sessions(user_id, updated_at desc);

create table copilot_drafts (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  message_id uuid,
  request text,
  draft jsonb not null,
  status text not null default 'pendiente' check (status in ('pendiente', 'ejecutando', 'confirmado')),
  idempotency_key uuid,
  result jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(draft) = 'object')
);

create index copilot_drafts_user on copilot_drafts(user_id, created_at desc);

-- El contenido de un borrador no cambia nunca: solo su estado y su resultado.
create function copilot_drafts_guard() returns trigger
language plpgsql as $$
begin
  if new.draft is distinct from old.draft
     or new.user_id is distinct from old.user_id
     or new.org_id is distinct from old.org_id
     or new.expires_at is distinct from old.expires_at then
    raise exception 'copilot_drafts: el borrador es inmutable';
  end if;
  return new;
end $$;

create trigger copilot_drafts_immutable
before update on copilot_drafts
for each row execute function copilot_drafts_guard();

alter table copilot_sessions enable row level security;
alter table copilot_drafts enable row level security;

create policy copilot_sessions_own on copilot_sessions for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and is_member(org_id));

create policy copilot_drafts_select on copilot_drafts for select using (user_id = auth.uid());
create policy copilot_drafts_insert on copilot_drafts for insert with check (user_id = auth.uid() and is_member(org_id));
create policy copilot_drafts_update on copilot_drafts for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy copilot_drafts_delete on copilot_drafts for delete using (user_id = auth.uid());
