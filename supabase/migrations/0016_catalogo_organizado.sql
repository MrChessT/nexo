-- Catálogo organizado en dos niveles (Familia → Tipo) y bebidas por unidades.
--
-- 1. Categorías: las familias se unifican (Destilados, Cervezas, Refrescos y mixers…) y debajo va el
--    tipo de cada producto (Ginebra, Vodka, Tercio, Tónicas…). Los productos pasan a su tipo; las
--    categorías antiguas que quedan vacías se borran. Categorías desconocidas no se tocan.
-- 2. Unidades: cervezas (salvo barril), refrescos, energéticas y aguas se cuentan por unidades y se
--    compran en cajas. Si alguno estaba en ml, se convierte TODO (stock, historial, mínimos,
--    inventarios, traspasos): cantidades ÷ ml del envase y costes × ml, así el valor en € no cambia.
--    Si no tiene un formato de más de una unidad, se le añade «Caja 24» como formato de compra.
-- 3. catalog_search devuelve la familia de cada categoría y el formato de conteo y de compra.
--
-- Repetible: una segunda ejecución no cambia nada.

-- 1. Familia → Tipo ---------------------------------------------------------------------------

create or replace function catalog_family(p_category text, p_name text) returns text
language sql immutable parallel safe set search_path = public as $$
  select case
    when c ~ 'champ|cava|espumos' then 'Champán'
    when c ~ 'destilad|licor' then 'Destilados'
    when c ~ 'vino' then 'Vinos'
    when c ~ 'cervez' then 'Cervezas'
    when c ~ 'refresc|mixer|sin alcohol' then 'Refrescos y mixers'
    when c ~ 'energ' then 'Energéticas'
    when c ~ '\magua' then 'Aguas'
    when c ~ 'zumo|sirop' then 'Zumos y siropes'
    when c ~ 'hielo' then 'Hielo'
    when c ~ 'fruta|guarnic' then 'Fruta y guarnición'
    when c ~ 'snack|picoteo' then 'Snacks y picoteo'
    when c ~ 'consumib' then 'Consumibles'
    when c ~ 'comida' then case when n ~ 'limon|\mlima|naranj|pomelo|fruta' then 'Fruta y guarnición' else 'Snacks y picoteo' end
  end
  from (select norm_text(p_category) as c, norm_text(p_name) as n) x
$$;

-- p_text: nombre y notas del producto (en las notas va el tipo: «Beefeater · Ginebra · 70 cl…»).
create or replace function catalog_type(p_family text, p_text text) returns text
language sql immutable parallel safe set search_path = public as $$
  select case p_family
    when 'Destilados' then case
      when t ~ '\mginebra\M|\mgin\M' then 'Ginebra'
      when t ~ '\mvodka\M' then 'Vodka'
      when t ~ '\mron\M|\mrum\M' then 'Ron'
      when t ~ '\mwhisk' then 'Whisky'
      when t ~ '\mtequila\M|\mmezcal\M' then 'Tequila'
    end
    when 'Vinos' then case
      when t ~ '\mblanco' then 'Blanco'
      when t ~ '\mtinto' then 'Tinto'
      when t ~ '\mrosado' then 'Rosado'
    end
    when 'Cervezas' then case when t ~ '\mbarril' then 'Barril' else 'Botellín y tercio' end
    when 'Refrescos y mixers' then case
      when t ~ '\mtonica' then 'Tónicas'
      when t ~ 'te frio|nestea' then 'Té frío'
      when t ~ 'isoton|aquarius' then 'Isotónicas'
      else 'Refrescos'
    end
    when 'Aguas' then case when t ~ 'con gas' then 'Con gas' else 'Sin gas' end
    when 'Zumos y siropes' then case when t ~ 'sirop' then 'Siropes' else 'Zumos' end
    when 'Fruta y guarnición' then case
      when t ~ 'citric|limon|\mlima|naranj|pomelo' then 'Cítricos'
      when t ~ 'frutos rojos|fresa|frambues|arandan' then 'Frutos rojos'
      when t ~ 'bandeja' then 'Fruta para bandejas'
      when t ~ 'guarnic|hierbabuena|pepino|\msal\M' then 'Guarnición'
    end
    when 'Snacks y picoteo' then case
      when t ~ 'frutos secos|pistach|kikos' then 'Frutos secos'
      when t ~ 'salado|patata|chips' then 'Salados'
      when t ~ 'dulce|gominol|chocolat' then 'Dulces'
    end
  end
  from (select norm_text(p_text) as t) x
$$;

-- Reorganiza el catálogo (familias y tipos) y pasa a unidades las bebidas que se cuentan por
-- unidades. Repetible. La llama esta migración y el último seed (una instalación nueva queda igual).
-- Solo para el administrador: toca el historial de movimientos.
create or replace function catalog_organize() returns void
language plpgsql set search_path = public as $$
declare
  families constant text[] := array['Destilados', 'Champán', 'Vinos', 'Cervezas', 'Refrescos y mixers', 'Energéticas', 'Aguas',
    'Zumos y siropes', 'Hielo', 'Fruta y guarnición', 'Snacks y picoteo', 'Consumibles'];
  r record;
  v_family uuid;
  v_type uuid;
  v_type_name text;
  v_touched uuid[] := '{}';
  f numeric;
begin
  for r in
    select p.id, p.org_id, p.category_id,
           catalog_family(coalesce(parent.name, c.name), p.name) as family,
           -- El nombre anterior solo orienta el tipo si ya era un tipo (subcategoría): «Zumos y
           -- siropes» como familia no dice si un producto es zumo o sirope.
           case when c.parent_id is not null then c.name end as old_name
    from products p
    join categories c on c.id = p.category_id
    left join categories parent on parent.id = c.parent_id
  loop
    continue when r.family is null;  -- categoría que no conocemos: se deja como está
    insert into categories (org_id, parent_id, name, sort_order)
    values (r.org_id, null, r.family, array_position(families, r.family))
    on conflict (org_id, parent_id, name) do update set sort_order = excluded.sort_order
    returning id into v_family;

    select catalog_type(r.family, p.name || ' ' || coalesce(p.notes, '') || ' ' || coalesce(r.old_name, ''))
      into v_type_name from products p where p.id = r.id;
    v_type := null;
    if v_type_name is not null then
      insert into categories (org_id, parent_id, name, sort_order)
      values (r.org_id, v_family, v_type_name, 0)
      on conflict (org_id, parent_id, name) do update set name = excluded.name
      returning id into v_type;
    end if;

    if r.category_id is distinct from coalesce(v_type, v_family) then
      v_touched := v_touched || r.category_id;
      update products set category_id = coalesce(v_type, v_family) where id = r.id;
    end if;
  end loop;

  -- Categorías antiguas vaciadas por la reorganización (sin productos ni subcategorías).
  delete from categories c
  where c.id = any(v_touched)
    and not exists (select 1 from products p where p.category_id = c.id)
    and not exists (select 1 from categories k where k.parent_id = c.id);
  -- Sus padres, si también han quedado vacíos y no son familias.
  delete from categories c
  where c.parent_id is null and not (c.name = any(families))
    and not exists (select 1 from products p where p.category_id = c.id)
    and not exists (select 1 from categories k where k.parent_id = c.id)
    and c.id in (select parent_id from categories where parent_id is not null union select unnest(v_touched));

  -- Cervezas (salvo barril), refrescos, energéticas y aguas: por unidades, en cajas.
  alter table stock_movements disable trigger stock_movements_immutable;

  for r in
    select p.id, p.name, p.org_id,
           (select k.qty_base from product_packs k where k.product_id = p.id and k.active
            order by k.is_count_default desc, k.qty_base limit 1) as unit_ml
    from products p
    join categories c on c.id = p.category_id
    left join categories fam on fam.id = c.parent_id
    where p.dimension = 'volume'
      and coalesce(fam.name, c.name) in ('Cervezas', 'Refrescos y mixers', 'Energéticas', 'Aguas')
      and not (c.name = 'Barril' or norm_text(p.name) ~ '\mbarril')
  loop
    f := r.unit_ml;
    if f is null or f <= 0 or f > 2000 then
      raise notice 'Sin envase claro, se deja en ml: %', r.name;
      continue;
    end if;

    update stock_movements set qty = round(qty / f, 4), unit_cost = unit_cost * f where product_id = r.id;
    update stock_balances set qty = round(qty / f, 4), avg_cost = avg_cost * f where product_id = r.id;
    update stock_area_balances set qty = round(qty / f, 4), avg_cost = avg_cost * f where product_id = r.id;
    update location_products set min_qty = round(min_qty / f, 4), par_qty = round(par_qty / f, 4) where product_id = r.id;
    update count_lines set qty = round(qty / f, 4) where product_id = r.id;
    update count_results set expected_qty = round(expected_qty / f, 4), counted_qty = round(counted_qty / f, 4), unit_cost = unit_cost * f where product_id = r.id;
    update transfer_lines set qty_sent = round(qty_sent / f, 4), qty_received = round(qty_received / f, 4), unit_cost = unit_cost * f where product_id = r.id;
    -- Formatos: el envase pasa a ser 1 unidad; las cajas, su número de unidades. Recepciones,
    -- pedidos y precios van por formato y no cambian.
    update product_packs set qty_base = round(qty_base / f, 4) where product_id = r.id;
    update products set dimension = 'count' where id = r.id;
    raise notice 'Convertido a unidades (÷ % ml): %', f, r.name;
  end loop;

  alter table stock_movements enable trigger stock_movements_immutable;

  -- Formato de compra en caja: «Caja 24» si el producto no tiene ninguno de más de una unidad.
  for r in
    select p.id, p.name from products p
    join categories c on c.id = p.category_id
    left join categories fam on fam.id = c.parent_id
    where p.dimension = 'count'
      and coalesce(fam.name, c.name) in ('Cervezas', 'Refrescos y mixers', 'Energéticas')
      and not exists (select 1 from product_packs k where k.product_id = p.id and k.active and k.qty_base > 1)
  loop
    update product_packs set is_purchase_default = false where product_id = r.id;
    insert into product_packs (product_id, name, qty_base, is_count_default, is_purchase_default)
    values (r.id, 'Caja 24', 24, false, true)
    on conflict (product_id, name) do nothing;
    raise notice 'Añadida «Caja 24» como formato de compra: %', r.name;
  end loop;
end $$;

revoke all on function catalog_organize() from public, anon, authenticated;

select catalog_organize();

-- 3. Búsqueda del catálogo con familias y formatos --------------------------------------------

create or replace function catalog_search(
  p_search text default null,
  p_category uuid default null,
  p_supplier uuid default null,
  p_location uuid default null,
  p_dimension text default null,
  p_status text default 'active',     -- active | archived | all
  p_stock text default null,          -- con | sin | bajo
  p_sort text default 'name',         -- name | name_desc | recent | category
  p_no_category boolean default false,
  p_limit int default 50,
  p_offset int default 0
) returns jsonb
language sql stable security invoker set search_path = public as $$
with words as (
  select array_remove(string_to_array(norm_text(trim(p_search)), ' '), '') as w
),
prod as (
  select
    p.id, p.name, p.sku, p.dimension::text as dimension, p.active, p.created_at, p.category_id,
    c.name as category, c.parent_id as category_parent, fam.name as family,
    coalesce(pk.packs, 0) as packs, pk.main_pack, coalesce(pk.barcodes, '') as barcodes,
    pk.count_pack, pk.purchase_pack,
    coalesce(sup.ids, '{}') as supplier_ids, coalesce(sup.names, '{}') as supplier_names,
    coalesce(loc.ids, '{}') as location_ids,
    coalesce(st.qty, 0) as stock_qty,
    coalesce(st.low, false) as low_stock
  from products p
  left join categories c on c.id = p.category_id
  left join categories fam on fam.id = c.parent_id
  left join lateral (
    select count(*) filter (where k.active) as packs,
           (array_agg(k.name order by k.is_purchase_default desc, k.qty_base desc) filter (where k.active))[1] as main_pack,
           (array_agg(jsonb_build_object('name', k.name, 'qty', k.qty_base::text) order by k.qty_base) filter (where k.active and k.is_count_default))[1] as count_pack,
           (array_agg(jsonb_build_object('name', k.name, 'qty', k.qty_base::text) order by k.is_purchase_default desc, k.qty_base desc) filter (where k.active and k.qty_base > 1))[1] as purchase_pack,
           string_agg(k.barcode, ' ') as barcodes
    from product_packs k where k.product_id = p.id
  ) pk on true
  left join lateral (
    select array_agg(distinct s.id) as ids, array_agg(distinct s.name) as names
    from product_packs k join supplier_prices sp on sp.pack_id = k.id join suppliers s on s.id = sp.supplier_id
    where k.product_id = p.id
  ) sup on true
  left join lateral (
    select array_agg(lp.location_id) as ids
    from location_products lp where lp.product_id = p.id and lp.active
  ) loc on true
  left join lateral (
    select sum(coalesce(b.qty, 0)) as qty,
           bool_or(lp.min_qty > 0 and coalesce(b.qty, 0) < lp.min_qty) as low
    from location_products lp
    left join stock_balances b on b.location_id = lp.location_id and b.product_id = lp.product_id
    where lp.product_id = p.id and lp.active and (p_location is null or lp.location_id = p_location)
  ) st on true
),
m as (
  select prod.*,
    (cardinality(words.w) = 0 or not exists (
       select 1 from unnest(words.w) x
       where norm_text(prod.name || ' ' || coalesce(prod.sku, '') || ' ' || coalesce(prod.category, '') || ' ' || coalesce(prod.family, '') || ' ' || prod.barcodes) not like '%' || x || '%'
    )) as f_q,
    (case when p_no_category then prod.category_id is null
          else p_category is null or prod.category_id = p_category or prod.category_parent = p_category end) as f_cat,
    (p_supplier is null or p_supplier = any(prod.supplier_ids)) as f_sup,
    (p_location is null or p_location = any(prod.location_ids)) as f_loc,
    (p_dimension is null or prod.dimension = p_dimension) as f_dim,
    (coalesce(p_status, 'active') = 'all' or (coalesce(p_status, 'active') = 'archived') = not prod.active) as f_st,
    (p_stock is null
      or (p_stock = 'con' and prod.stock_qty > 0)
      or (p_stock = 'sin' and prod.stock_qty <= 0)
      or (p_stock = 'bajo' and prod.low_stock)) as f_stk
  from prod, words
),
hit as (
  select * from m where f_q and f_cat and f_sup and f_loc and f_dim and f_st and f_stk
),
page as (
  select * from hit
  order by
    case when p_sort = 'category' then coalesce(family, category, 'zzz') end,
    case when p_sort = 'category' then category end,
    case when p_sort = 'recent' then created_at end desc,
    case when p_sort = 'name_desc' then name end desc,
    name
  limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)
),
-- Productos por categoría sin su propio filtro; una familia cuenta también los de sus tipos.
cat_counts as (
  select category_id, category_parent, count(*) as n from m
  where f_q and f_sup and f_loc and f_dim and f_st and f_stk group by category_id, category_parent
)
select jsonb_build_object(
  'total', (select count(*) from hit),
  'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'sku', sku, 'dimension', dimension, 'active', active,
      'category_id', category_id, 'category', category, 'family', family,
      'packs', packs, 'main_pack', main_pack, 'count_pack', count_pack, 'purchase_pack', purchase_pack,
      'suppliers', to_jsonb(supplier_names), 'locations', cardinality(location_ids),
      'stock_qty', stock_qty::text, 'low_stock', low_stock
    ) order by
      case when p_sort = 'category' then coalesce(family, category, 'zzz') end,
      case when p_sort = 'category' then category end,
      case when p_sort = 'recent' then created_at end desc,
      case when p_sort = 'name_desc' then name end desc,
      name) from page), '[]'::jsonb),
  -- Cada contador aplica todos los filtros menos el suyo: dice cuántos saldrían al elegir esa opción.
  'facets', jsonb_build_object(
    'status', (select jsonb_build_object(
        'all', count(*),
        'active', count(*) filter (where active),
        'archived', count(*) filter (where not active))
      from m where f_q and f_cat and f_sup and f_loc and f_dim and f_stk),
    'stock', (select jsonb_build_object(
        'con', count(*) filter (where stock_qty > 0),
        'sin', count(*) filter (where stock_qty <= 0),
        'bajo', count(*) filter (where low_stock))
      from m where f_q and f_cat and f_sup and f_loc and f_dim and f_st),
    'dimensions', coalesce((select jsonb_object_agg(dimension, n) from (
        select dimension, count(*) as n from m
        where f_q and f_cat and f_sup and f_loc and f_st and f_stk group by dimension) d), '{}'::jsonb),
    -- Familias primero (por su orden) y, debajo de cada una, sus tipos por nombre.
    'categories', coalesce((select jsonb_agg(jsonb_build_object(
          'id', c.id, 'name', c.name, 'parent_id', c.parent_id,
          'count', coalesce((select sum(n) from cat_counts cc where cc.category_id = c.id or cc.category_parent = c.id), 0))
        order by coalesce(par.sort_order, c.sort_order), coalesce(par.name, c.name), c.parent_id nulls first, c.name)
      from categories c left join categories par on par.id = c.parent_id), '[]'::jsonb),
    'uncategorized', (select count(*) from m where category_id is null and f_q and f_sup and f_loc and f_dim and f_st and f_stk),
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'count', coalesce(n.n, 0)) order by s.name)
      from suppliers s
      left join (select sid, count(*) as n from m, unnest(m.supplier_ids) sid
                 where f_q and f_cat and f_loc and f_dim and f_st and f_stk group by sid) n on n.sid = s.id
      where s.active), '[]'::jsonb),
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'count', coalesce(n.n, 0)) order by l.name)
      from locations l
      left join (select lid, count(*) as n from m, unnest(m.location_ids) lid
                 where f_q and f_cat and f_sup and f_dim and f_st and f_stk group by lid) n on n.lid = l.id
      where l.active), '[]'::jsonb)
  )
)
$$;

grant execute on function catalog_search(text, uuid, uuid, uuid, text, text, text, text, boolean, int, int) to authenticated;

-- 4. Stock valorado con familia y formatos (para mostrar «12 botellas» o «2 cajas + 5 ud») ---
-- Las columnas nuevas van al final: las funciones que ya usan la vista no cambian.
create or replace view v_stock_valuation with (security_invoker = true) as
select
  l.org_id,
  b.location_id,
  l.name as location_name,
  p.id as product_id,
  p.name as product_name,
  p.category_id,
  c.name as category_name,
  p.base_unit,
  b.qty,
  b.avg_cost,
  round(b.qty * b.avg_cost, 2) as stock_value,
  lp.min_qty,
  lp.par_qty,
  coalesce(b.qty < lp.min_qty, false) as below_min,
  greatest(coalesce(lp.par_qty, 0) - b.qty, 0) as suggested_order_qty,
  fam.name as family_name,
  p.dimension::text as dimension,
  cp.name as count_pack_name,
  cp.qty_base as count_pack_qty,
  pp.name as purchase_pack_name,
  pp.qty_base as purchase_pack_qty
from stock_balances b
join locations l on l.id = b.location_id
join products p on p.id = b.product_id
left join categories c on c.id = p.category_id
left join categories fam on fam.id = c.parent_id
left join location_products lp on lp.location_id = b.location_id and lp.product_id = b.product_id
left join lateral (
  select k.name, k.qty_base from product_packs k where k.product_id = p.id and k.active and k.is_count_default limit 1
) cp on true
left join lateral (
  select k.name, k.qty_base from product_packs k where k.product_id = p.id and k.active and k.qty_base > 1
  order by k.is_purchase_default desc, k.qty_base desc limit 1
) pp on true;

grant select on v_stock_valuation to authenticated;
grant execute on function catalog_family(text, text) to authenticated;
grant execute on function catalog_type(text, text) to authenticated;
