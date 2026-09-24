begin;

select plan(7);

-- Local con dos productos: al contar falta ron (consumo) y sobra agua (ajuste).
insert into auth.users (id, email, email_confirmed_at) values ('f0000000-0000-4000-8000-000000000001', 'encargado@example.com', now());
insert into organizations (id, name) values ('f1000000-0000-4000-8000-000000000001', 'Org test consumo');
insert into locations (id, org_id, name) values ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'Bar');
insert into memberships (org_id, user_id, role, all_locations) values ('f1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 'manager', true);
insert into products (id, org_id, name, dimension) values
  ('f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'Ron test', 'volume'),
  ('f3000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000001', 'Agua test', 'count');
insert into stock_movements (org_id, location_id, product_id, type, qty, unit_cost) values
  ('f1000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 'opening', 2100, 0.02),
  ('f1000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000002', 'opening', 10, 0.5);
insert into inventory_counts (id, org_id, location_id) values ('f4000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001');
insert into count_lines (count_id, product_id, qty) values
  ('f4000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000001', 700),
  ('f4000000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000002', 12);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f0000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select is(
  (select diff::text from count_preview('f4000000-0000-4000-8000-000000000001') where product_name = 'Ron test'),
  '-1400.0000',
  'the preview shows the missing rum'
);
select is(
  (select diff_value::text from count_preview('f4000000-0000-4000-8000-000000000001') where product_name = 'Ron test'),
  '-28.00',
  'the preview values the difference at average cost'
);

select lives_ok($$ select close_count('f4000000-0000-4000-8000-000000000001', false, true) $$, 'a manager closes the count as consumption');

select is(
  (select type::text from stock_movements where ref_id = 'f4000000-0000-4000-8000-000000000001' and product_id = 'f3000000-0000-4000-8000-000000000001'),
  'consumption',
  'a negative difference is recorded as consumption'
);
select is(
  (select type::text from stock_movements where ref_id = 'f4000000-0000-4000-8000-000000000001' and product_id = 'f3000000-0000-4000-8000-000000000002'),
  'count_adjustment',
  'a positive difference stays an adjustment'
);
select is(
  (select qty::text from stock_balances where product_id = 'f3000000-0000-4000-8000-000000000001'),
  '700.0000',
  'the stock matches the count after closing'
);
select is(
  (select status::text from inventory_counts where id = 'f4000000-0000-4000-8000-000000000001'),
  'closed',
  'the count is closed'
);

select * from finish();
rollback;
