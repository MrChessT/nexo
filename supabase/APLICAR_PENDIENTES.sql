-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRACIONES PENDIENTES: 0008, 0009, 0011, 0012 y 0013 (la 0010 se retiró).
-- Pega TODO este archivo en Supabase → SQL Editor → Run.
-- · Va en una transacción: si algo falla, no se aplica nada a medias.
-- · Se puede repetir sin error (si ya aplicaste la 0008, no pasa nada).
-- ═══════════════════════════════════════════════════════════════════════════

begin;


-- ───────────────────────────── 0008_rendimiento

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

-- (analyze va al final, fuera de la transacción)
-- analyze memberships, stock_movements, receipt_lines, goods_receipts, transfers, inventory_counts, price_history;

-- ───────────────────────────── 0009_resumen_por_local

-- Resumen de inicio con datos reales y filtrables por local.
--
-- 1) stock_summary admite un local (null = todos los accesibles).
-- 2) usage_by_business_day: consumo por día de negocio con la MISMA definición que Informes
--    (analytics.ts · isUsage): consumo + mermas + ajustes negativos de inventario o manuales.
--    Así «Consumo» da la misma cifra en el resumen y en Informes.
-- Todas son security invoker: RLS decide qué locales ve el usuario.

drop function if exists stock_summary();

create or replace function stock_summary(p_location uuid default null)
returns table (total_value numeric, below_min_count bigint, critical_count bigint)
language sql stable security invoker set search_path = public as $$
  select
    coalesce(sum(stock_value), 0),
    count(*) filter (where below_min),
    count(*) filter (where below_min and qty <= 0)
  from v_stock_valuation
  where p_location is null or location_id = p_location
$$;

create or replace function usage_by_business_day(p_since date, p_location uuid default null)
returns table (business_day date, value numeric)
language sql stable security invoker set search_path = public as $$
  select g.business_day, g.value
  from (
    select
      ((m.occurred_at at time zone l.timezone) - l.day_cutoff::interval)::date as business_day,
      round(sum(m.qty * m.unit_cost), 2) as value
    from stock_movements m
    join locations l on l.id = m.location_id
    where (
        m.type in ('consumption', 'waste')
        or (m.type in ('count_adjustment', 'manual_adjustment') and m.qty < 0)
      )
      and (p_location is null or m.location_id = p_location)
      -- Margen de 2 días para zona horaria y hora de corte; el filtro exacto va después.
      and m.occurred_at >= (p_since - 2)::timestamptz
    group by m.org_id, m.location_id, m.product_id, m.type, 1
  ) g
  where g.business_day >= p_since
$$;

revoke execute on function stock_summary(uuid), usage_by_business_day(date, uuid) from public, anon;
grant execute on function stock_summary(uuid), usage_by_business_day(date, uuid) to authenticated;

-- Los movimientos sin coste reciben el coste medio en el trigger apply_stock_movement: mismo valor que Informes.
comment on function usage_by_business_day(date, uuid) is
  'Consumo por día de negocio: consumo, mermas y ajustes negativos. Misma definición que Informes.';

-- ───────────────────────────── 0011_consumo_por_inventario

-- Consumo real a partir de inventarios.
--
-- La mayoría de bares no registran cada copa: el consumo real es lo que falta al contar
-- (stock esperado − stock contado). Hasta ahora esa diferencia se guardaba como «ajuste de
-- inventario», mezclada con errores y roturas. close_count admite ahora p_as_consumption:
-- las diferencias NEGATIVAS se registran como consumo; las positivas (sobra stock) siguen
-- siendo ajuste, porque no son consumo.
--
-- count_preview enseña el resultado antes de cerrar (mismo cálculo que close_count).

drop function if exists close_count(uuid, boolean);

create or replace function close_count(p_count uuid, p_zero_uncounted boolean default false, p_as_consumption boolean default false)
returns void
language plpgsql security definer set search_path = public as $$
declare
  c inventory_counts;
begin
  select * into c from inventory_counts where id = p_count for update;
  if not found then raise exception 'not_found'; end if;
  if not (can_access_location(c.location_id) and is_manager(c.org_id)) then
    raise exception 'forbidden';
  end if;
  if c.status <> 'open' then raise exception 'invalid_status'; end if;

  with counted as (
    select product_id, sum(qty) as q
    from count_lines where count_id = p_count
    group by product_id
  ), scope as (
    select product_id from counted
    union
    select lp.product_id from location_products lp
    where p_zero_uncounted and lp.location_id = c.location_id and lp.active
  )
  insert into count_results (count_id, product_id, expected_qty, counted_qty, unit_cost)
  select p_count, s.product_id, coalesce(b.qty, 0), coalesce(ct.q, 0), coalesce(b.avg_cost, 0)
  from scope s
  left join counted ct on ct.product_id = s.product_id
  left join stock_balances b on b.location_id = c.location_id and b.product_id = s.product_id;

  insert into stock_movements (org_id, location_id, product_id, type, qty, reason, ref_table, ref_id)
  select c.org_id, c.location_id, product_id,
         case when p_as_consumption and diff_qty < 0 then 'consumption'::movement_type else 'count_adjustment'::movement_type end,
         diff_qty,
         case when p_as_consumption and diff_qty < 0 then 'consumo calculado por inventario' end,
         'inventory_counts', p_count
  from count_results
  where count_id = p_count and diff_qty <> 0;

  update inventory_counts
  set status = 'closed', closed_by = auth.uid(), closed_at = now()
  where id = p_count;
end $$;

-- Vista previa del cierre: esperado, contado, diferencia y su valor, por producto.
-- security invoker: RLS decide qué ve el usuario (mismos datos que close_count).
create or replace function count_preview(p_count uuid, p_zero_uncounted boolean default false)
returns table (
  product_id uuid,
  product_name text,
  base_unit text,
  expected numeric,
  counted numeric,
  diff numeric,
  unit_cost numeric,
  diff_value numeric
)
language sql stable security invoker set search_path = public as $$
  with c as (
    select id, location_id from inventory_counts where id = p_count
  ), counted as (
    select cl.product_id, sum(cl.qty) as q from count_lines cl where cl.count_id = p_count group by cl.product_id
  ), scope as (
    select counted.product_id from counted
    union
    select lp.product_id from location_products lp join c on lp.location_id = c.location_id
    where p_zero_uncounted and lp.active
  )
  select s.product_id, p.name, p.base_unit,
         coalesce(b.qty, 0), coalesce(ct.q, 0), coalesce(ct.q, 0) - coalesce(b.qty, 0),
         coalesce(b.avg_cost, 0), round((coalesce(ct.q, 0) - coalesce(b.qty, 0)) * coalesce(b.avg_cost, 0), 2)
  from scope s
  cross join c
  join products p on p.id = s.product_id
  left join counted ct on ct.product_id = s.product_id
  left join stock_balances b on b.location_id = c.location_id and b.product_id = s.product_id
  order by abs(round((coalesce(ct.q, 0) - coalesce(b.qty, 0)) * coalesce(b.avg_cost, 0), 2)) desc, p.name
$$;

revoke execute on function close_count(uuid, boolean, boolean), count_preview(uuid, boolean) from public, anon;
grant execute on function close_count(uuid, boolean, boolean), count_preview(uuid, boolean) to authenticated;

-- ───────────────────────────── 0012_pedidos

-- Pedidos a proveedor: borrador → enviado → parcial / recibido (o cancelado).
--
-- · Cualquiera con acceso al local prepara borradores y recibe mercancía.
-- · Enviar y cancelar un pedido (compromete gasto) exige encargado o superior.
-- · Recibir crea una recepción normal enlazada al pedido y la contabiliza con post_receipt:
--   el stock y el coste medio se actualizan igual que en cualquier recepción.

do $$ begin
  create type order_status as enum ('draft', 'sent', 'partial', 'received', 'cancelled');
exception when duplicate_object then null; end $$;

create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  location_id uuid not null,
  supplier_id uuid not null,
  status order_status not null default 'draft',
  note text check (char_length(note) <= 500),
  expected_date date,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  sent_by uuid,
  sent_at timestamptz,
  closed_at timestamptz,
  foreign key (org_id, location_id) references locations(org_id, id),
  foreign key (org_id, supplier_id) references suppliers(org_id, id)
);
create index if not exists purchase_orders_location on purchase_orders(location_id, created_at desc);
create index if not exists purchase_orders_supplier on purchase_orders(supplier_id);
create index if not exists purchase_orders_open on purchase_orders(location_id) where status in ('draft', 'sent', 'partial');

create table if not exists purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references purchase_orders(id) on delete cascade,
  pack_id uuid not null references product_packs(id),
  packs_qty numeric(14,4) not null check (packs_qty > 0),
  pack_price numeric(12,4) check (pack_price >= 0),
  received_packs numeric(14,4) not null default 0 check (received_packs >= 0),
  unique (order_id, pack_id)
);
create index if not exists purchase_order_lines_order on purchase_order_lines(order_id);
create index if not exists purchase_order_lines_pack on purchase_order_lines(pack_id);

alter table goods_receipts add column if not exists order_id uuid references purchase_orders(id) on delete set null;
create index if not exists goods_receipts_order on goods_receipts(order_id) where order_id is not null;

-- Un formato de otra organización no puede entrar en un pedido.
create or replace function validate_order_line() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from purchase_orders o
    join product_packs k on k.id = new.pack_id
    join products p on p.id = k.product_id
    where o.id = new.order_id and p.org_id = o.org_id
  ) then
    raise exception 'cross_organization_link';
  end if;
  return new;
end $$;

drop trigger if exists purchase_order_lines_validate on purchase_order_lines;
create trigger purchase_order_lines_validate
before insert or update of pack_id, order_id on purchase_order_lines
for each row execute function validate_order_line();

-- RLS ----------------------------------------------------------------------------

alter table purchase_orders enable row level security;
alter table purchase_order_lines enable row level security;

drop policy if exists po_select on purchase_orders;
create policy po_select on purchase_orders for select using (location_id in (select my_location_ids()));
drop policy if exists po_insert on purchase_orders;
create policy po_insert on purchase_orders for insert
  with check (status = 'draft' and can_access_location(location_id));
drop policy if exists po_update on purchase_orders;
create policy po_update on purchase_orders for update
  using (status = 'draft' and can_access_location(location_id))
  with check (status = 'draft' and can_access_location(location_id));
drop policy if exists po_delete on purchase_orders;
create policy po_delete on purchase_orders for delete
  using (status = 'draft' and can_access_location(location_id));

drop policy if exists pol_select on purchase_order_lines;
create policy pol_select on purchase_order_lines for select
  using (exists (select 1 from purchase_orders o where o.id = order_id and o.location_id in (select my_location_ids())));
drop policy if exists pol_write on purchase_order_lines;
create policy pol_write on purchase_order_lines for all
  using (exists (select 1 from purchase_orders o where o.id = order_id and o.status = 'draft' and can_access_location(o.location_id)))
  with check (exists (select 1 from purchase_orders o where o.id = order_id and o.status = 'draft' and can_access_location(o.location_id)));

-- Transiciones -------------------------------------------------------------------

create or replace function send_order(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  o purchase_orders;
begin
  select * into o from purchase_orders where id = p_order for update;
  if not found then raise exception 'not_found'; end if;
  if not (can_access_location(o.location_id) and is_manager(o.org_id)) then raise exception 'forbidden'; end if;
  if o.status <> 'draft' then raise exception 'invalid_status'; end if;
  if not exists (select 1 from purchase_order_lines where order_id = p_order) then raise exception 'empty_order'; end if;
  update purchase_orders set status = 'sent', sent_by = auth.uid(), sent_at = now() where id = p_order;
end $$;

create or replace function cancel_order(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  o purchase_orders;
begin
  select * into o from purchase_orders where id = p_order for update;
  if not found then raise exception 'not_found'; end if;
  if not (can_access_location(o.location_id) and is_manager(o.org_id)) then raise exception 'forbidden'; end if;
  if o.status not in ('draft', 'sent', 'partial') then raise exception 'invalid_status'; end if;
  update purchase_orders set status = 'cancelled', closed_at = now() where id = p_order;
end $$;

-- Recibe mercancía de un pedido enviado. p_lines: [{"pack_id": uuid, "packs_qty": n, "pack_price": n}].
-- Se admiten formatos que no estaban en el pedido (el proveedor manda otra cosa): entran en la
-- recepción y no cuentan para completar el pedido. p_close cierra el pedido aunque falte algo.
create or replace function receive_order(
  p_order uuid,
  p_lines jsonb,
  p_doc_number text default null,
  p_doc_date date default current_date,
  p_close boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  o purchase_orders;
  v_receipt uuid;
  v_complete boolean;
begin
  select * into o from purchase_orders where id = p_order for update;
  if not found then raise exception 'not_found'; end if;
  if not can_access_location(o.location_id) then raise exception 'forbidden'; end if;
  if o.status not in ('sent', 'partial') then raise exception 'invalid_status'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'empty_receipt'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) l
    where coalesce((l->>'packs_qty')::numeric, 0) <= 0 or coalesce((l->>'pack_price')::numeric, -1) < 0
  ) then
    raise exception 'invalid_quantity';
  end if;

  insert into goods_receipts (org_id, location_id, supplier_id, doc_number, doc_date, order_id)
  values (o.org_id, o.location_id, o.supplier_id, nullif(trim(p_doc_number), ''), coalesce(p_doc_date, current_date), p_order)
  returning id into v_receipt;

  insert into receipt_lines (receipt_id, pack_id, packs_qty, pack_price)
  select v_receipt, (l->>'pack_id')::uuid, (l->>'packs_qty')::numeric, (l->>'pack_price')::numeric
  from jsonb_array_elements(p_lines) l;

  -- Misma contabilización que cualquier recepción: movimientos, coste medio y precios.
  perform post_receipt(v_receipt);

  update purchase_order_lines pol
  set received_packs = pol.received_packs + r.qty
  from (
    select (l->>'pack_id')::uuid as pack_id, sum((l->>'packs_qty')::numeric) as qty
    from jsonb_array_elements(p_lines) l group by 1
  ) r
  where pol.order_id = p_order and pol.pack_id = r.pack_id;

  select not exists (select 1 from purchase_order_lines where order_id = p_order and received_packs < packs_qty) into v_complete;
  update purchase_orders
  set status = case when v_complete or p_close then 'received'::order_status else 'partial'::order_status end,
      closed_at = case when v_complete or p_close then now() end
  where id = p_order;
  return v_receipt;
end $$;

revoke execute on function send_order(uuid), cancel_order(uuid), receive_order(uuid, jsonb, text, date, boolean), validate_order_line() from public, anon;
grant execute on function send_order(uuid), cancel_order(uuid), receive_order(uuid, jsonb, text, date, boolean) to authenticated;

-- ───────────────────────────── 0013_quitar_equipo

-- Se retira el apartado de Equipo (invitaciones y gestión de miembros desde la app).
-- La migración 0010 se eliminó del repositorio; si llegó a aplicarse, esto borra lo que creó.
-- Idempotente: si nunca se aplicó, no hace nada.

drop trigger if exists memberships_protect_owners on memberships;
drop function if exists protect_owners();
drop function if exists org_members(uuid);
drop function if exists accept_invitations();
drop table if exists invitations;

commit;

-- Estadísticas para que Postgres use los índices nuevos desde ya.
analyze memberships, stock_movements, receipt_lines, goods_receipts, transfers, inventory_counts, price_history, purchase_orders, purchase_order_lines;
