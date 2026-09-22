-- Saldo oficial por espacio fisico, manteniendo stock_balances como agregado por local.

create table stock_area_balances (
  area_id uuid not null references storage_areas(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  qty numeric(16,4) not null default 0,
  avg_cost numeric(14,6) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (area_id, product_id)
);

create index stock_area_balances_product on stock_area_balances(product_id);

create or replace function apply_stock_movement()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  local_balance stock_balances;
  area_balance stock_area_balances;
  area_location uuid;
begin
  if new.area_id is not null then
    select location_id into area_location
    from storage_areas
    where id = new.area_id;

    if area_location is null or area_location <> new.location_id then
      raise exception 'cross_location_link';
    end if;
  end if;

  insert into stock_balances (location_id, product_id)
  values (new.location_id, new.product_id)
  on conflict do nothing;

  select * into local_balance
  from stock_balances
  where location_id = new.location_id and product_id = new.product_id
  for update;

  if new.qty > 0 and new.unit_cost is not null then
    if local_balance.qty > 0 then
      local_balance.avg_cost := (local_balance.qty * local_balance.avg_cost + new.qty * new.unit_cost)
        / (local_balance.qty + new.qty);
    else
      local_balance.avg_cost := new.unit_cost;
    end if;
  elsif new.unit_cost is null then
    new.unit_cost := local_balance.avg_cost;
  end if;

  update stock_balances
  set qty = local_balance.qty + new.qty,
      avg_cost = local_balance.avg_cost,
      updated_at = now()
  where location_id = new.location_id and product_id = new.product_id;

  if new.area_id is not null then
    insert into stock_area_balances (area_id, product_id)
    values (new.area_id, new.product_id)
    on conflict do nothing;

    select * into area_balance
    from stock_area_balances
    where area_id = new.area_id and product_id = new.product_id
    for update;

    if new.qty > 0 and new.unit_cost is not null then
      if area_balance.qty > 0 then
        area_balance.avg_cost := (area_balance.qty * area_balance.avg_cost + new.qty * new.unit_cost)
          / (area_balance.qty + new.qty);
      else
        area_balance.avg_cost := new.unit_cost;
      end if;
    end if;

    update stock_area_balances
    set qty = area_balance.qty + new.qty,
        avg_cost = area_balance.avg_cost,
        updated_at = now()
    where area_id = new.area_id and product_id = new.product_id;
  end if;

  return new;
end $$;

alter table stock_area_balances enable row level security;

create policy stock_area_balance_select on stock_area_balances
for select using (
  exists (
    select 1
    from storage_areas a
    where a.id = area_id and can_access_location(a.location_id)
  )
);

create view v_stock_area_valuation with (security_invoker = true) as
select
  l.org_id,
  a.location_id,
  a.id as area_id,
  l.name as location_name,
  a.name as area_name,
  b.product_id,
  p.name as product_name,
  p.category_id,
  c.name as category_name,
  p.base_unit,
  b.qty,
  b.avg_cost,
  round(b.qty * b.avg_cost, 2) as stock_value,
  b.updated_at
from stock_area_balances b
join storage_areas a on a.id = b.area_id
join locations l on l.id = a.location_id
join products p on p.id = b.product_id
left join categories c on c.id = p.category_id;
