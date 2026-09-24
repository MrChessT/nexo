-- Productos de ejemplo para ver el catalogo de Parador Eventos con datos reales.
-- Requiere haber ejecutado antes 01_parador_eventos.sql.
-- Ejecutar una sola vez en el SQL Editor de Supabase. Para seleccionar todo: Ctrl+A.

do $$
declare
  v_org_id uuid;
  v_cat_refrescos uuid;
  v_cat_cerveza uuid;
  v_cat_licores uuid;
  v_cat_comida uuid;
  v_supplier uuid;
  v_product uuid;
begin
  select id into v_org_id from organizations where name = 'Parador Eventos' limit 1;
  if v_org_id is null then
    raise exception 'Organizacion no encontrada. Ejecuta primero 01_parador_eventos.sql.';
  end if;

  insert into categories (org_id, name, sort_order) values (v_org_id, 'Bebidas sin alcohol', 1) returning id into v_cat_refrescos;
  insert into categories (org_id, name, sort_order) values (v_org_id, 'Cerveza', 2) returning id into v_cat_cerveza;
  insert into categories (org_id, name, sort_order) values (v_org_id, 'Licores', 3) returning id into v_cat_licores;
  insert into categories (org_id, name, sort_order) values (v_org_id, 'Comida', 4) returning id into v_cat_comida;

  insert into suppliers (org_id, name) values (v_org_id, 'Distribuidora Central') returning id into v_supplier;

  insert into products (org_id, category_id, name, dimension, sku)
  values (v_org_id, v_cat_refrescos, 'Coca-Cola', 'volume', 'REF-001') returning id into v_product;
  insert into product_packs (product_id, name, qty_base, is_count_default, is_purchase_default)
  values (v_product, 'Botella 330 ml', 330, true, true);

  insert into products (org_id, category_id, name, dimension, sku)
  values (v_org_id, v_cat_cerveza, 'Estrella Galicia', 'volume', 'CER-EG1') returning id into v_product;
  insert into product_packs (product_id, name, qty_base, is_count_default, is_purchase_default)
  values (v_product, 'Botellin 250 ml', 250, true, true);

  insert into products (org_id, category_id, name, dimension, sku)
  values (v_org_id, v_cat_licores, 'Ron Barcelo', 'volume', 'LIC-001') returning id into v_product;
  insert into product_packs (product_id, name, qty_base, is_count_default, is_purchase_default)
  values (v_product, 'Botella 700 ml', 700, true, true);

  insert into products (org_id, category_id, name, dimension, sku)
  values (v_org_id, v_cat_comida, 'Patatas fritas', 'mass', 'COM-001') returning id into v_product;
  insert into product_packs (product_id, name, qty_base, is_count_default, is_purchase_default)
  values (v_product, 'Bolsa 1 kg', 1000, true, true);

  insert into products (org_id, category_id, name, dimension, sku)
  values (v_org_id, v_cat_comida, 'Limones', 'count', 'COM-002') returning id into v_product;
  insert into product_packs (product_id, name, qty_base, is_count_default, is_purchase_default)
  values (v_product, 'Unidad', 1, true, true);
end $$;
