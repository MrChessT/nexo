begin;

create extension if not exists pgtap with schema extensions;

select plan(10);

insert into auth.users (id, email, email_confirmed_at) values
  ('a1000000-0000-4000-8000-000000000001', 'camarero-pedidos@example.com', now()),
  ('a1000000-0000-4000-8000-000000000002', 'encargado-pedidos@example.com', now());
insert into organizations (id, name) values ('a2000000-0000-4000-8000-000000000001', 'Org test pedidos');
insert into locations (id, org_id, name) values ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Bar');
insert into memberships (org_id, user_id, role, all_locations) values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'staff', true),
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', 'manager', true);
insert into suppliers (id, org_id, name) values ('a4000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Proveedor test');
insert into products (id, org_id, name, dimension) values ('a5000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Ron pedido', 'volume');
insert into product_packs (id, product_id, name, qty_base, is_purchase_default) values
  ('a6000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', 'Caja 6 botellas', 4200, true);

set local role authenticated;

-- El camarero prepara el pedido (2 cajas) pero no puede enviarlo.
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok(
  $$ insert into purchase_orders (id, org_id, location_id, supplier_id)
     values ('a7000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001') $$,
  'staff can prepare a draft order'
);
select lives_ok(
  $$ insert into purchase_order_lines (order_id, pack_id, packs_qty, pack_price)
     values ('a7000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001', 2, 90) $$,
  'staff can add lines to the draft'
);
select throws_ok($$ select send_order('a7000000-0000-4000-8000-000000000001') $$, 'forbidden', 'staff cannot send an order');

-- El encargado lo envía; ya no se puede editar.
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select lives_ok($$ select send_order('a7000000-0000-4000-8000-000000000001') $$, 'a manager sends the order');
update purchase_order_lines set packs_qty = 5 where order_id = 'a7000000-0000-4000-8000-000000000001';
select is(
  (select packs_qty::text from purchase_order_lines where order_id = 'a7000000-0000-4000-8000-000000000001'),
  '2.0000',
  'a sent order cannot be edited'
);

-- El camarero recibe 1 caja: pedido parcial y stock actualizado.
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok(
  $$ select receive_order('a7000000-0000-4000-8000-000000000001', '[{"pack_id":"a6000000-0000-4000-8000-000000000001","packs_qty":1,"pack_price":90}]'::jsonb, 'ALB-1') $$,
  'staff receives part of the order'
);
select is((select status::text from purchase_orders where id = 'a7000000-0000-4000-8000-000000000001'), 'partial', 'the order is partially received');
select is((select qty::text from stock_balances where product_id = 'a5000000-0000-4000-8000-000000000001'), '4200.0000', 'stock increases by one box');

-- Llega el resto: pedido recibido, con dos recepciones enlazadas.
select lives_ok(
  $$ select receive_order('a7000000-0000-4000-8000-000000000001', '[{"pack_id":"a6000000-0000-4000-8000-000000000001","packs_qty":1,"pack_price":92}]'::jsonb) $$,
  'the rest arrives'
);
select is(
  (select status::text || ':' || (select count(*) from goods_receipts where order_id = 'a7000000-0000-4000-8000-000000000001')::text from purchase_orders where id = 'a7000000-0000-4000-8000-000000000001'),
  'received:2',
  'the order is received with two linked receipts'
);

select * from finish();
rollback;
