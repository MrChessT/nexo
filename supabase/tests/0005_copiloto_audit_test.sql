begin;

select plan(9);

select has_table('public', 'copilot_audit', 'copilot audit table exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.copilot_audit'::regclass),
  'copilot audit has row level security'
);
select ok(
  exists (select 1 from pg_policy where polrelid = 'public.copilot_audit'::regclass and polname = 'copilot_audit_insert' and polcmd = 'a'),
  'insert policy exists'
);
select ok(
  exists (select 1 from pg_policy where polrelid = 'public.copilot_audit'::regclass and polname = 'copilot_audit_select' and polcmd = 'r'),
  'select policy exists'
);
select ok(
  not exists (select 1 from pg_policy where polrelid = 'public.copilot_audit'::regclass and polcmd in ('w', 'd', '*')),
  'no update or delete policies'
);
select ok(
  exists (select 1 from pg_trigger where tgrelid = 'public.copilot_audit'::regclass and tgname = 'copilot_audit_immutable'),
  'immutability trigger exists'
);

-- Escenario: un miembro registra un mensaje y no puede modificarlo ni borrarlo.
insert into auth.users (id, email) values ('a0000000-0000-4000-8000-000000000001', 'copiloto-test@example.com');
insert into organizations (id, name) values ('b0000000-0000-4000-8000-000000000001', 'Org test copiloto');
insert into memberships (org_id, user_id, role, all_locations)
values ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'staff', true);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select lives_ok(
  $$ insert into copilot_audit (org_id, kind, intent, outcome, decisions)
     values ('b0000000-0000-4000-8000-000000000001', 'mensaje', 'consultar', 'consulta', '[{"id":"intent","probability":0.97}]') $$,
  'a member can record an audit entry'
);
select throws_ok(
  $$ insert into copilot_audit (org_id, user_id, kind)
     values ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000999', 'mensaje') $$,
  '42501',
  null,
  'a user cannot record entries in the name of someone else'
);

-- Sin política de update/delete, el usuario no ve filas que modificar; el trigger protege incluso al propietario.
reset role;
select throws_ok(
  $$ update copilot_audit set outcome = 'otro' $$,
  'copilot_audit es inmutable',
  'audit entries cannot be modified, not even by the table owner'
);

select * from finish();
rollback;
