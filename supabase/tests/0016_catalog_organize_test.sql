begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

-- Catálogo como el de los datos de ejemplo: categorías planas, un refresco en ml con historial y una
-- ginebra cuyo tipo solo está en las notas.
insert into organizations (id, name) values ('e1000000-0000-4000-8000-000000000001', 'Org test catálogo');
insert into locations (id, org_id, name) values ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'Bar');
insert into categories (id, org_id, name) values
  ('e5000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'Bebidas sin alcohol'),
  ('e5000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001', 'Destilados para gamas'),
  ('e5000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000001', 'Mi categoría');
insert into products (id, org_id, category_id, name, dimension, notes) values
  ('e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001', 'Cola test', 'volume', null),
  ('e3000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000002', 'Beefeater test', 'volume', 'Beefeater · Ginebra · 70 cl'),
  ('e3000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000003', 'Otro test', 'count', null);
insert into product_packs (product_id, name, qty_base, is_count_default, is_purchase_default) values
  ('e3000000-0000-4000-8000-000000000001', 'Botella 330 ml', 330, true, true),
  ('e3000000-0000-4000-8000-000000000002', 'Botella 70 cl', 700, true, false);
insert into location_products (location_id, product_id, min_qty, par_qty) values
  ('e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 1650, 3300);
-- 10 botellas de 330 ml a 0,50 € la botella; luego se tiran 2.
insert into stock_movements (org_id, location_id, product_id, type, qty, unit_cost) values
  ('e1000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'opening', 3300, 0.5 / 330.0);
insert into stock_movements (org_id, location_id, product_id, type, qty) values
  ('e1000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'waste', -660);

select lives_ok($$ select catalog_organize() $$, 'the catalog is organized');

select is(
  (select fam.name || ' › ' || c.name from products p join categories c on c.id = p.category_id join categories fam on fam.id = c.parent_id where p.id = 'e3000000-0000-4000-8000-000000000001'),
  'Refrescos y mixers › Refrescos',
  'a soft drink goes to its family and type'
);
select is(
  (select fam.name || ' › ' || c.name from products p join categories c on c.id = p.category_id join categories fam on fam.id = c.parent_id where p.id = 'e3000000-0000-4000-8000-000000000002'),
  'Destilados › Ginebra',
  'the type comes from the notes when the name does not say it'
);
select is(
  (select c.name from products p join categories c on c.id = p.category_id where p.id = 'e3000000-0000-4000-8000-000000000003'),
  'Mi categoría',
  'unknown categories are left alone'
);
select ok(
  not exists (select 1 from categories where id in ('e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000002')),
  'old categories emptied by the reorganization are removed'
);

select is((select dimension::text from products where id = 'e3000000-0000-4000-8000-000000000001'), 'count', 'the soft drink is counted in units');
select is((select qty::text from stock_balances where product_id = 'e3000000-0000-4000-8000-000000000001'), '8.0000', 'the balance is converted exactly (2640 ml → 8 ud)');
select is(
  (select round(qty * avg_cost, 2)::text from stock_balances where product_id = 'e3000000-0000-4000-8000-000000000001'),
  '4.00',
  'the stock value does not change'
);
select is(
  (select string_agg(qty::text, ',' order by occurred_at, id) from stock_movements where product_id = 'e3000000-0000-4000-8000-000000000001'),
  '10.0000,-2.0000',
  'the movement history is converted too'
);
select is((select min_qty::text || '/' || par_qty::text from location_products where product_id = 'e3000000-0000-4000-8000-000000000001'), '5.0000/10.0000', 'minimum and target are converted');
select is(
  (select string_agg(name || '=' || qty_base::text || case when is_purchase_default then '*' else '' end, ', ' order by qty_base) from product_packs where product_id = 'e3000000-0000-4000-8000-000000000001'),
  'Botella 330 ml=1.0000, Caja 24=24.0000*',
  'the bottle becomes one unit and a box of 24 is the purchase format'
);

select catalog_organize();
select is((select qty::text from stock_balances where product_id = 'e3000000-0000-4000-8000-000000000001'), '8.0000', 'running it again changes nothing');

select * from finish();
rollback;
