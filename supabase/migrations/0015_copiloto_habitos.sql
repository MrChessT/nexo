-- Memoria del asistente por usuario: qué locales y productos usa más (entre sesiones y dispositivos).
-- Sirve para preguntar menos (proponer el local habitual, marcado para revisar) y ordenar mejor las
-- opciones. Solo contadores, sin texto de las conversaciones. Cada usuario ve y toca solo lo suyo.

create table if not exists copilot_profiles (
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- {"locations": {"<id>": n}, "products": {"<id>": n}}
  habits jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id),
  check (jsonb_typeof(habits) = 'object')
);

alter table copilot_profiles enable row level security;

drop policy if exists copilot_profiles_own on copilot_profiles;
create policy copilot_profiles_own on copilot_profiles for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and org_id in (select my_org_ids()));

grant select, insert, update, delete on copilot_profiles to authenticated;
