-- Auditoría de Nexo Copiloto: mensajes, decisiones de Jev con su probabilidad, borradores y confirmaciones.
-- Solo inserción: nadie puede modificar ni borrar un registro. El servicio escribe con el JWT del usuario.

create table copilot_audit (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('mensaje', 'borrador', 'confirmacion', 'bloqueo')),
  message_id uuid,
  draft_id uuid,
  intent text,
  outcome text,
  decisions jsonb not null default '[]'::jsonb,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(decisions) = 'array'),
  check (jsonb_typeof(detail) = 'object')
);

create index copilot_audit_org_time on copilot_audit(org_id, created_at desc);
create index copilot_audit_draft on copilot_audit(draft_id) where draft_id is not null;

create function forbid_copilot_audit_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'copilot_audit es inmutable';
end $$;

create trigger copilot_audit_immutable
before update or delete on copilot_audit
for each row execute function forbid_copilot_audit_mutation();

alter table copilot_audit enable row level security;

-- Cada usuario solo registra en su nombre y en organizaciones a las que pertenece.
create policy copilot_audit_insert on copilot_audit for insert
  with check (user_id = auth.uid() and is_member(org_id));

-- Lectura: los administradores ven la auditoría de su organización; cada usuario, la suya.
create policy copilot_audit_select on copilot_audit for select
  using (is_admin(org_id) or user_id = auth.uid());
