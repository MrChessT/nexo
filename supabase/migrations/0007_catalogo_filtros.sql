-- Catálogo con filtros en el servidor: la página de productos pide solo la página visible y los
-- contadores de cada filtro, en una llamada. security invoker: RLS decide qué productos ve el usuario.

-- Texto comparable: minúsculas y sin tildes (búsqueda "limon" encuentra "Limón").
create or replace function norm_text(t text) returns text
language sql immutable parallel safe as $$
  select lower(translate(coalesce(t, ''),
    'ÁÀÂÄÉÈÊËÍÌÎÏÓÒÔÖÚÙÛÜÑÇáàâäéèêëíìîïóòôöúùûüñç',
    'AAAAEEEEIIIIOOOOUUUUNCaaaaeeeeiiiioooouuuunc'))
$$;

create index if not exists products_org_category on products(org_id, category_id);
create index if not exists products_org_active_name on products(org_id, active, name);
create index if not exists location_products_product on location_products(product_id);
create index if not exists supplier_prices_pack on supplier_prices(pack_id);

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
    c.name as category, c.parent_id as category_parent,
    coalesce(pk.packs, 0) as packs, pk.main_pack, coalesce(pk.barcodes, '') as barcodes,
    coalesce(sup.ids, '{}') as supplier_ids, coalesce(sup.names, '{}') as supplier_names,
    coalesce(loc.ids, '{}') as location_ids,
    coalesce(st.qty, 0) as stock_qty,
    coalesce(st.low, false) as low_stock
  from products p
  left join categories c on c.id = p.category_id
  left join lateral (
    select count(*) filter (where k.active) as packs,
           (array_agg(k.name order by k.is_purchase_default desc, k.qty_base desc) filter (where k.active))[1] as main_pack,
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
       where norm_text(prod.name || ' ' || coalesce(prod.sku, '') || ' ' || coalesce(prod.category, '') || ' ' || prod.barcodes) not like '%' || x || '%'
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
    case when p_sort = 'category' then coalesce(category, 'zzz') end,
    case when p_sort = 'recent' then created_at end desc,
    case when p_sort = 'name_desc' then name end desc,
    name
  limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)
)
select jsonb_build_object(
  'total', (select count(*) from hit),
  'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'sku', sku, 'dimension', dimension, 'active', active,
      'category_id', category_id, 'category', category,
      'packs', packs, 'main_pack', main_pack,
      'suppliers', to_jsonb(supplier_names), 'locations', cardinality(location_ids),
      'stock_qty', stock_qty::text, 'low_stock', low_stock
    ) order by
      case when p_sort = 'category' then coalesce(category, 'zzz') end,
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
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'count', coalesce(n.n, 0)) order by c.sort_order, c.name)
      from categories c
      left join (select category_id, count(*) as n from m
                 where f_q and f_sup and f_loc and f_dim and f_st and f_stk group by category_id) n on n.category_id = c.id), '[]'::jsonb),
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
grant execute on function norm_text(text) to authenticated;
