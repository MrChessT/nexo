-- Rendimiento: mismos permisos y mismos resultados, menos trabajo por consulta.
--
-- 1) RLS: las políticas de lectura llamaban a is_member()/can_access_location() UNA VEZ POR FILA
--    (funciones security definer, que Postgres no puede integrar en el plan). Ahora comparan contra
--    el conjunto de organizaciones/locales del usuario, que se calcula UNA VEZ por consulta
--    (`x in (select ...)` → InitPlan/hashed SubPlan). La lógica de acceso es idéntica.
-- 2) Índices para las consultas reales de la app (listados por fecha, joins por FK, filtros).
-- 3) consumption_by_business_day: la vista v_movements_by_business_day agrupa TODOS los movimientos
--    antes de filtrar por día; esta función filtra primero por fecha (usa índice) y agrupa igual.

-- Conjuntos de acceso ---------------------------------------------------------

create or replace function my_org_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select org_id from memberships where user_id = auth.uid()
$$;

-- Mismo criterio que can_access_location(), pero devuelve todos los locales accesibles de una vez.
create or replace function my_location_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select l.id
  from locations l
  join memberships m on m.org_id = l.org_id and m.user_id = auth.uid()
  where m.role in ('owner', 'admin')
     or m.all_locations
     or exists (
       select 1 from membership_locations ml
       where ml.user_id = m.user_id and ml.location_id = l.id
     )
$$;

revoke execute on function my_org_ids(), my_location_ids() from public, anon;
grant execute on function my_org_ids(), my_location_ids() to authenticated;

-- Políticas de lectura (mismos nombres, misma semántica) ----------------------------

drop policy if exists org_select on organizations;
create policy org_select on organizations for select using (id in (select my_org_ids()));

drop policy if exists loc_select on locations;
create policy loc_select on locations for select using (id in (select my_location_ids()));

drop policy if exists area_select on storage_areas;
create policy area_select on storage_areas for select using (location_id in (select my_location_ids()));

drop policy if exists mem_select on memberships;
create policy mem_select on memberships for select using (org_id in (select my_org_ids()));

drop policy if exists memloc_select on membership_locations;
create policy memloc_select on membership_locations for select using (org_id in (select my_org_ids()));

drop policy if exists cat_select on categories;
create policy cat_select on categories for select using (org_id in (select my_org_ids()));

drop policy if exists sup_select on suppliers;
create policy sup_select on suppliers for select using (org_id in (select my_org_ids()));

drop policy if exists prod_select on products;
create policy prod_select on products for select using (org_id in (select my_org_ids()));

drop policy if exists pack_select on product_packs;
create policy pack_select on product_packs for select
  using (exists (select 1 from products p where p.id = product_id and p.org_id in (select my_org_ids())));

drop policy if exists sprice_select on supplier_prices;
create policy sprice_select on supplier_prices for select
  using (exists (select 1 from suppliers s where s.id = supplier_id and s.org_id in (select my_org_ids())));

drop policy if exists phist_select on price_history;
create policy phist_select on price_history for select
  using (exists (select 1 from suppliers s where s.id = supplier_id and s.org_id in (select my_org_ids())));

drop policy if exists locprod_select on location_products;
create policy locprod_select on location_products for select using (location_id in (select my_location_ids()));

drop policy if exists bal_select on stock_balances;
create policy bal_select on stock_balances for select using (location_id in (select my_location_ids()));

drop policy if exists stock_area_balance_select on stock_area_balances;
create policy stock_area_balance_select on stock_area_balances for select
  using (exists (select 1 from storage_areas a where a.id = area_id and a.location_id in (select my_location_ids())));

drop policy if exists mov_select on stock_movements;
create policy mov_select on stock_movements for select using (location_id in (select my_location_ids()));

drop policy if exists tr_select on transfers;
create policy tr_select on transfers for select
  using (from_location_id in (select my_location_ids()) or to_location_id in (select my_location_ids()));

drop policy if exists trl_select on transfer_lines;
create policy trl_select on transfer_lines for select
  using (exists (
    select 1 from transfers t where t.id = transfer_id
      and (t.from_location_id in (select my_location_ids()) or t.to_location_id in (select my_location_ids()))
  ));

drop policy if exists cnt_select on inventory_counts;
create policy cnt_select on inventory_counts for select using (location_id in (select my_location_ids()));

drop policy if exists cntl_select on count_lines;
create policy cntl_select on count_lines for select
  using (exists (select 1 from inventory_counts c where c.id = count_id and c.location_id in (select my_location_ids())));

drop policy if exists cntr_select on count_results;
create policy cntr_select on count_results for select
  using (exists (select 1 from inventory_counts c where c.id = count_id and c.location_id in (select my_location_ids())));

drop policy if exists rcp_select on goods_receipts;
create policy rcp_select on goods_receipts for select using (location_id in (select my_location_ids()));

drop policy if exists rcpl_select on receipt_lines;
create policy rcpl_select on receipt_lines for select
  using (exists (select 1 from goods_receipts r where r.id = receipt_id and r.location_id in (select my_location_ids())));

-- Índices ---------------------------------------------------------------------

-- Búsqueda de la organización del usuario (memberships solo tenía PK (org_id, user_id)).
create index if not exists memberships_user on memberships(user_id);
-- Actividad reciente (dashboard) y listado de mermas / consumo por tipo y fecha.
create index if not exists stock_movements_time on stock_movements(occurred_at desc);
create index if not exists stock_movements_type_time on stock_movements(type, occurred_at desc);
-- FKs sin índice que se usan en joins, RLS y post_receipt.
create index if not exists receipt_lines_receipt on receipt_lines(receipt_id);
create index if not exists goods_receipts_location_date on goods_receipts(location_id, doc_date desc);
create index if not exists transfers_from_location on transfers(from_location_id, created_at desc);
create index if not exists transfers_to_location on transfers(to_location_id);
create index if not exists inventory_counts_location_started on inventory_counts(location_id, started_at desc);
create index if not exists price_history_recorded on price_history(recorded_at);
create index if not exists price_history_supplier on price_history(supplier_id);
create index if not exists transfer_lines_product on transfer_lines(product_id);

-- Consumo por día de negocio, filtrando antes de agrupar ------------------------------
-- Devuelve las mismas filas que v_movements_by_business_day (mismo agrupado y redondeo)
-- para los tipos pedidos y desde p_since. security invoker: RLS decide qué ve el usuario.

create or replace function consumption_by_business_day(p_since date, p_types movement_type[])
returns table (business_day date, value numeric)
language sql stable security invoker set search_path = public as $$
  select g.business_day, g.value
  from (
    select
      ((m.occurred_at at time zone l.timezone) - l.day_cutoff::interval)::date as business_day,
      round(sum(m.qty * m.unit_cost), 2) as value
    from stock_movements m
    join locations l on l.id = m.location_id
    where m.type = any(p_types)
      -- Margen de 2 días para zona horaria y hora de corte; el filtro exacto va después.
      and m.occurred_at >= (p_since - 2)::timestamptz
    group by m.org_id, m.location_id, m.product_id, m.type, 1
  ) g
  where g.business_day >= p_since
$$;

revoke execute on function consumption_by_business_day(date, movement_type[]) from public, anon;
grant execute on function consumption_by_business_day(date, movement_type[]) to authenticated;

-- Resumen del stock para el dashboard: totales sobre TODO el stock visible, calculados en Postgres
-- (una fila de respuesta en lugar de descargar todas las filas). security invoker: respeta RLS.
create or replace function stock_summary()
returns table (total_value numeric, below_min_count bigint, critical_count bigint)
language sql stable security invoker set search_path = public as $$
  select
    coalesce(sum(stock_value), 0),
    count(*) filter (where below_min),
    count(*) filter (where below_min and qty <= 0)
  from v_stock_valuation
$$;

revoke execute on function stock_summary() from public, anon;
grant execute on function stock_summary() to authenticated;

analyze memberships, stock_movements, receipt_lines, goods_receipts, transfers, inventory_counts, price_history;
