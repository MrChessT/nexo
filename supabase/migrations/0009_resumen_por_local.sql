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
