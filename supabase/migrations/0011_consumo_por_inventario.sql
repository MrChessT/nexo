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

create function close_count(p_count uuid, p_zero_uncounted boolean default false, p_as_consumption boolean default false)
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
