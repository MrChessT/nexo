begin;

select plan(11);

select has_table('public', 'invitations', 'invitations table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.invitations'::regclass), 'invitations has row level security');

-- Organización con propietario, administrador y un invitado.
insert into auth.users (id, email, email_confirmed_at) values
  ('c0000000-0000-4000-8000-000000000001', 'owner@example.com', now()),
  ('c0000000-0000-4000-8000-000000000002', 'admin@example.com', now()),
  ('c0000000-0000-4000-8000-000000000003', 'nuevo@example.com', now()),
  ('c0000000-0000-4000-8000-000000000004', 'sin-verificar@example.com', null);
insert into organizations (id, name) values ('d0000000-0000-4000-8000-000000000001', 'Org test equipo');
insert into locations (id, org_id, name) values
  ('e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'Barra'),
  ('e0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'Terraza');
insert into memberships (org_id, user_id, role, all_locations) values
  ('d0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'owner', true),
  ('d0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'admin', true);

set local role authenticated;

-- El administrador invita a un camarero para la Barra, pero no puede invitar a un propietario.
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok(
  $$ insert into invitations (org_id, email, role, location_ids)
     values ('d0000000-0000-4000-8000-000000000001', 'nuevo@example.com', 'staff', array['e0000000-0000-4000-8000-000000000001']::uuid[]) $$,
  'an admin can invite a staff member'
);
select throws_ok(
  $$ insert into invitations (org_id, email, role) values ('d0000000-0000-4000-8000-000000000001', 'otro@example.com', 'owner') $$,
  '42501', null,
  'an admin cannot invite an owner'
);
select is((select count(*)::int from org_members('d0000000-0000-4000-8000-000000000001')), 2, 'an admin lists the members');

-- El invitado entra con su email verificado y queda unido solo a la Barra.
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select is(accept_invitations(), 1, 'the invitee accepts the invitation');
select is(
  (select array_agg(location_id)::text from membership_locations where user_id = 'c0000000-0000-4000-8000-000000000003'),
  '{e0000000-0000-4000-8000-000000000001}',
  'the new member only gets the invited locations'
);
select throws_ok($$ select * from org_members('d0000000-0000-4000-8000-000000000001') $$, 'forbidden', 'staff cannot list members with emails');

-- Un email sin verificar no acepta nada.
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select is(accept_invitations(), 0, 'an unverified email cannot accept invitations');

-- Propietarios: un administrador no puede degradarlo; el último propietario no se puede quitar.
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok(
  $$ update memberships set role = 'staff' where user_id = 'c0000000-0000-4000-8000-000000000001' $$,
  'forbidden',
  'an admin cannot change an owner'
);
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok(
  $$ update memberships set role = 'admin' where user_id = 'c0000000-0000-4000-8000-000000000001' $$,
  'last_owner',
  'the last owner cannot demote themselves'
);

select * from finish();
rollback;
