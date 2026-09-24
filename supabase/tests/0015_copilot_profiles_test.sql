begin;

create extension if not exists pgtap with schema extensions;

select plan(5);

select has_table('public', 'copilot_profiles', 'assistant habits table exists');

insert into auth.users (id, email, email_confirmed_at) values
  ('b1000000-0000-4000-8000-000000000001', 'habitos-a@example.com', now()),
  ('b1000000-0000-4000-8000-000000000002', 'habitos-b@example.com', now());
insert into organizations (id, name) values
  ('b2000000-0000-4000-8000-000000000001', 'Org habitos'),
  ('b2000000-0000-4000-8000-000000000002', 'Otra org');
insert into memberships (org_id, user_id, role, all_locations) values
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'staff', true),
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002', 'staff', true);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select lives_ok(
  $$ insert into copilot_profiles (org_id, habits) values ('b2000000-0000-4000-8000-000000000001', '{"locations":{"x":3}}') $$,
  'a member stores their own habits'
);
select throws_ok(
  $$ insert into copilot_profiles (org_id, habits) values ('b2000000-0000-4000-8000-000000000002', '{}') $$,
  '42501', null,
  'habits cannot be stored in an organization the user does not belong to'
);

-- Otro usuario de la misma organización no ve ni modifica los hábitos del primero.
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is((select count(*)::int from copilot_profiles), 0, 'another user cannot read them');
update copilot_profiles set habits = '{}' where user_id = 'b1000000-0000-4000-8000-000000000001';
reset role;
select is(
  (select habits->'locations'->>'x' from copilot_profiles where user_id = 'b1000000-0000-4000-8000-000000000001'),
  '3',
  'another user cannot change them'
);

select * from finish();
rollback;
