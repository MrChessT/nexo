begin;

create extension if not exists pgtap with schema extensions;

select plan(9);

insert into auth.users (id, email, email_confirmed_at) values ('b1000000-0000-4000-8000-000000000001', 'precios-test@example.com', now());
insert into organizations (id, name) values ('b2000000-0000-4000-8000-000000000001', 'Org test precios');
insert into locations (id, org_id, name) values
  ('b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'Bar'),
  ('b3000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'Terraza');
insert into memberships (org_id, user_id, role, all_locations) values ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'manager', true);
insert into suppliers (id, org_id, name) values ('b4000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'Proveedor precios');
insert into products (id, org_id, name, dimension) values ('b5000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'Ginebra precios', 'volume');
insert into product_packs (id, product_id, name, qty_base, is_purchase_default) values
  ('b6000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001', 'Caja 6 botellas', 4200, true);

-- Precio puesto a mano: queda en el historial; repetirlo no añade nada; cambiarlo, sí.
insert into supplier_prices (supplier_id, pack_id, last_price, last_price_at)
values ('b4000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-000000000001', 60, now() - interval '10 days');
select is((select count(*)::int from price_history where pack_id = 'b6000000-0000-4000-8000-000000000001'), 1, 'a new price is recorded in the history');
update supplier_prices set last_price = 60 where pack_id = 'b6000000-0000-4000-8000-000000000001';
select is((select count(*)::int from price_history where pack_id = 'b6000000-0000-4000-8000-000000000001'), 1, 'the same price is not recorded twice');
update supplier_prices set last_price = 66, last_price_at = now() - interval '5 days' where pack_id = 'b6000000-0000-4000-8000-000000000001';
select is((select count(*)::int from price_history where pack_id = 'b6000000-0000-4000-8000-000000000001'), 2, 'a price change is recorded');
select is(
  (select price::text from price_history where pack_id = 'b6000000-0000-4000-8000-000000000001' order by recorded_at desc limit 1),
  '66.0000',
  'the latest record holds the new price'
);

-- Un producto que llega por primera vez a la Terraza entra en su surtido.
select ok(
  not exists (select 1 from location_products where location_id = 'b3000000-0000-4000-8000-000000000002' and product_id = 'b5000000-0000-4000-8000-000000000001'),
  'the product is not in the terrace assortment yet'
);

-- Recepción de un pedido con precio nuevo: un solo registro, enlazado a su albarán.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
insert into purchase_orders (id, org_id, location_id, supplier_id)
values ('b7000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000002', 'b4000000-0000-4000-8000-000000000001');
insert into purchase_order_lines (order_id, pack_id, packs_qty, pack_price) values ('b7000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-000000000001', 1, 70);
select send_order('b7000000-0000-4000-8000-000000000001');
select receive_order('b7000000-0000-4000-8000-000000000001', '[{"pack_id":"b6000000-0000-4000-8000-000000000001","packs_qty":1,"pack_price":70}]'::jsonb, 'ALB-PRECIOS');
reset role;

select is(
  (select count(*)::int from price_history where pack_id = 'b6000000-0000-4000-8000-000000000001' and price = 70),
  1,
  'a received price is recorded once, not twice'
);
select ok(
  (select receipt_id is not null from price_history where pack_id = 'b6000000-0000-4000-8000-000000000001' and price = 70),
  'the received price is linked to its receipt'
);
select ok(
  exists (select 1 from location_products where location_id = 'b3000000-0000-4000-8000-000000000002' and product_id = 'b5000000-0000-4000-8000-000000000001' and active),
  'receiving a new product adds it to that location assortment'
);
select is(
  (select min_qty::text from location_products where location_id = 'b3000000-0000-4000-8000-000000000002' and product_id = 'b5000000-0000-4000-8000-000000000001'),
  '0.0000',
  'an automatically added product has no minimum'
);

select * from finish();
rollback;
