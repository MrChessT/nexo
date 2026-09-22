create extension if not exists pgcrypto;

create type member_role as enum ('owner', 'admin', 'manager', 'staff');
create type unit_dimension as enum ('mass', 'volume', 'count');
create type movement_type as enum (
  'opening', 'purchase', 'consumption', 'waste',
  'transfer_out', 'transfer_in', 'count_adjustment', 'manual_adjustment'
);
create type transfer_status as enum ('draft', 'in_transit', 'received', 'cancelled');
create type doc_status as enum ('open', 'closed', 'cancelled');

-- Tenencia ---------------------------------------------------------------

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  business_type text not null default 'bar',
  currency char(3) not null default 'EUR',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table locations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  kind text not null default 'venue',
  timezone text not null default 'Europe/Madrid',
  day_cutoff time not null default '06:00',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_id, name),
  unique (org_id, id)
);

create table storage_areas (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  name text not null,
  sort_order int not null default 0,
  unique (location_id, name)
);

create table memberships (
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role member_role not null default 'staff',
  all_locations boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table membership_locations (
  org_id uuid not null,
  user_id uuid not null,
  location_id uuid not null,
  primary key (user_id, location_id),
  foreign key (org_id, user_id) references memberships(org_id, user_id) on delete cascade,
  foreign key (org_id, location_id) references locations(org_id, id) on delete cascade
);

-- Catálogo ---------------------------------------------------------------

create table categories (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  parent_id uuid references categories(id) on delete set null,
  name text not null,
  sort_order int not null default 0,
  unique nulls not distinct (org_id, parent_id, name)
);

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  tax_id text,
  email text,
  phone text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_id, name),
  unique (org_id, id)
);

create table products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  category_id uuid references categories(id) on delete set null,
  name text not null,
  dimension unit_dimension not null,
  base_unit text generated always as (
    case dimension when 'mass' then 'g' when 'volume' then 'ml' else 'ud' end
  ) stored,
  sku text,
  track_stock boolean not null default true,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  unique (org_id, name),
  unique (org_id, sku),
  unique (org_id, id)
);

create table product_packs (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  name text not null,
  qty_base numeric(14,4) not null check (qty_base > 0),
  barcode text,
  full_weight_g numeric(10,2),
  empty_weight_g numeric(10,2),
  is_count_default boolean not null default false,
  is_purchase_default boolean not null default false,
  active boolean not null default true,
  unique (product_id, name),
  check (full_weight_g is null or empty_weight_g is null or full_weight_g > empty_weight_g)
);
create unique index product_packs_count_default on product_packs(product_id) where is_count_default;
create unique index product_packs_purchase_default on product_packs(product_id) where is_purchase_default;
create index product_packs_barcode on product_packs(barcode) where barcode is not null;

create table supplier_prices (
  supplier_id uuid not null references suppliers(id) on delete cascade,
  pack_id uuid not null references product_packs(id) on delete cascade,
  supplier_ref text,
  last_price numeric(12,4),
  last_price_at timestamptz,
  primary key (supplier_id, pack_id)
);

create table price_history (
  id bigint generated always as identity primary key,
  supplier_id uuid not null references suppliers(id) on delete cascade,
  pack_id uuid not null references product_packs(id) on delete cascade,
  price numeric(12,4) not null,
  receipt_id uuid,
  recorded_at timestamptz not null default now()
);
create index price_history_pack on price_history(pack_id, recorded_at desc);

create table location_products (
  location_id uuid not null references locations(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  min_qty numeric(14,4) not null default 0,
  par_qty numeric(14,4) not null default 0,
  default_area_id uuid references storage_areas(id) on delete set null,
  active boolean not null default true,
  primary key (location_id, product_id)
);

-- Stock ------------------------------------------------------------------

create table stock_balances (
  location_id uuid not null references locations(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  qty numeric(16,4) not null default 0,
  avg_cost numeric(14,6) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (location_id, product_id)
);

create table stock_movements (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  location_id uuid not null,
  product_id uuid not null,
  area_id uuid references storage_areas(id) on delete set null,
  type movement_type not null,
  qty numeric(16,4) not null check (qty <> 0),
  unit_cost numeric(14,6),
  reason text,
  ref_table text,
  ref_id uuid,
  client_ref uuid unique,
  occurred_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (org_id, location_id) references locations(org_id, id),
  foreign key (org_id, product_id) references products(org_id, id),
  check (
    (type in ('opening', 'purchase', 'transfer_in') and qty > 0) or
    (type in ('consumption', 'waste', 'transfer_out') and qty < 0) or
    type in ('count_adjustment', 'manual_adjustment')
  )
);
create index stock_movements_location_time on stock_movements(location_id, occurred_at desc);
create index stock_movements_product_time on stock_movements(product_id, occurred_at desc);
create index stock_movements_ref on stock_movements(ref_table, ref_id);

-- Documentos -------------------------------------------------------------

create table transfers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  from_location_id uuid not null,
  to_location_id uuid not null,
  status transfer_status not null default 'draft',
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  sent_by uuid,
  sent_at timestamptz,
  received_by uuid,
  received_at timestamptz,
  foreign key (org_id, from_location_id) references locations(org_id, id),
  foreign key (org_id, to_location_id) references locations(org_id, id),
  check (from_location_id <> to_location_id)
);

create table transfer_lines (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references transfers(id) on delete cascade,
  product_id uuid not null references products(id),
  qty_sent numeric(16,4) not null check (qty_sent > 0),
  qty_received numeric(16,4) check (qty_received >= 0),
  unit_cost numeric(14,6),
  unique (transfer_id, product_id)
);

create table inventory_counts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  status doc_status not null default 'open',
  note text,
  started_by uuid default auth.uid(),
  started_at timestamptz not null default now(),
  closed_by uuid,
  closed_at timestamptz,
  foreign key (org_id, location_id) references locations(org_id, id)
);
create unique index inventory_counts_one_open on inventory_counts(location_id) where status = 'open';

create table count_lines (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references inventory_counts(id) on delete cascade,
  product_id uuid not null references products(id),
  area_id uuid references storage_areas(id) on delete set null,
  qty numeric(16,4) not null check (qty >= 0),
  input jsonb,
  counted_by uuid default auth.uid(),
  counted_at timestamptz not null default now(),
  client_ref uuid unique
);
create index count_lines_count on count_lines(count_id, product_id);

create table count_results (
  count_id uuid not null references inventory_counts(id) on delete cascade,
  product_id uuid not null references products(id),
  expected_qty numeric(16,4) not null,
  counted_qty numeric(16,4) not null,
  diff_qty numeric(16,4) generated always as (counted_qty - expected_qty) stored,
  unit_cost numeric(14,6) not null,
  primary key (count_id, product_id)
);

create table goods_receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  location_id uuid not null,
  supplier_id uuid,
  doc_number text,
  doc_date date not null default current_date,
  status doc_status not null default 'open',
  attachment_path text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  posted_by uuid,
  posted_at timestamptz,
  foreign key (org_id, location_id) references locations(org_id, id),
  foreign key (org_id, supplier_id) references suppliers(org_id, id)
);

create table receipt_lines (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references goods_receipts(id) on delete cascade,
  pack_id uuid not null references product_packs(id),
  packs_qty numeric(14,4) not null check (packs_qty > 0),
  pack_price numeric(12,4) not null check (pack_price >= 0)
);

-- Permisos ---------------------------------------------------------------

create function auth_role(p_org uuid) returns member_role
language sql stable security definer set search_path = public as $$
  select role from memberships where org_id = p_org and user_id = auth.uid()
$$;

create function is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth_role(p_org) is not null
$$;

create function is_manager(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth_role(p_org) in ('owner', 'admin', 'manager'), false)
$$;

create function is_admin(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth_role(p_org) in ('owner', 'admin'), false)
$$;

create function location_org(p_location uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from locations where id = p_location
$$;

create function can_access_location(p_location uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from locations l
    join memberships m on m.org_id = l.org_id and m.user_id = auth.uid()
    where l.id = p_location
      and (
        m.role in ('owner', 'admin')
        or m.all_locations
        or exists (
          select 1 from membership_locations ml
          where ml.user_id = m.user_id and ml.location_id = l.id
        )
      )
  )
$$;

-- Motor de stock ---------------------------------------------------------

create function apply_stock_movement() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  b stock_balances;
begin
  insert into stock_balances (location_id, product_id)
  values (new.location_id, new.product_id)
  on conflict do nothing;

  select * into b from stock_balances
  where location_id = new.location_id and product_id = new.product_id
  for update;

  if new.qty > 0 and new.unit_cost is not null then
    if b.qty > 0 then
      b.avg_cost := (b.qty * b.avg_cost + new.qty * new.unit_cost) / (b.qty + new.qty);
    else
      b.avg_cost := new.unit_cost;
    end if;
  elsif new.unit_cost is null then
    new.unit_cost := b.avg_cost;
  end if;

  update stock_balances
  set qty = b.qty + new.qty, avg_cost = b.avg_cost, updated_at = now()
  where location_id = new.location_id and product_id = new.product_id;

  return new;
end $$;

create trigger stock_movements_apply
before insert on stock_movements
for each row execute function apply_stock_movement();

create function forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'stock_movements es inmutable: registra un movimiento inverso';
end $$;

create trigger stock_movements_immutable
before update or delete on stock_movements
for each row execute function forbid_mutation();

-- RPC --------------------------------------------------------------------

create function create_organization(p_name text, p_business_type text default 'bar')
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then raise exception 'unauthenticated'; end if;
  insert into organizations (name, business_type) values (p_name, p_business_type)
  returning id into v_org;
  insert into memberships (org_id, user_id, role, all_locations)
  values (v_org, auth.uid(), 'owner', true);
  return v_org;
end $$;

create function register_movement(
  p_location uuid,
  p_product uuid,
  p_type movement_type,
  p_qty numeric,
  p_reason text default null,
  p_area uuid default null,
  p_unit_cost numeric default null,
  p_client_ref uuid default null
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := location_org(p_location);
  v_qty numeric;
  v_id bigint;
begin
  if not can_access_location(p_location) then raise exception 'forbidden'; end if;
  if p_type not in ('waste', 'consumption', 'manual_adjustment', 'opening') then
    raise exception 'type_not_allowed';
  end if;
  if p_type in ('manual_adjustment', 'opening') and not is_manager(v_org) then
    raise exception 'forbidden';
  end if;

  if p_client_ref is not null then
    select id into v_id from stock_movements where client_ref = p_client_ref;
    if found then return v_id; end if;
  end if;

  v_qty := case
    when p_type in ('waste', 'consumption') then -abs(p_qty)
    when p_type = 'opening' then abs(p_qty)
    else p_qty
  end;

  insert into stock_movements
    (org_id, location_id, product_id, area_id, type, qty, unit_cost, reason, client_ref)
  values
    (v_org, p_location, p_product, p_area, p_type, v_qty, p_unit_cost, p_reason, p_client_ref)
  returning id into v_id;

  return v_id;
end $$;

create function send_transfer(p_transfer uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  t transfers;
  l transfer_lines;
  v_cost numeric;
begin
  select * into t from transfers where id = p_transfer for update;
  if not found then raise exception 'not_found'; end if;
  if not can_access_location(t.from_location_id) then raise exception 'forbidden'; end if;
  if t.status <> 'draft' then raise exception 'invalid_status'; end if;
  if not exists (select 1 from transfer_lines where transfer_id = p_transfer) then
    raise exception 'empty_transfer';
  end if;

  for l in select * from transfer_lines where transfer_id = p_transfer loop
    insert into stock_movements (org_id, location_id, product_id, type, qty, ref_table, ref_id)
    values (t.org_id, t.from_location_id, l.product_id, 'transfer_out', -l.qty_sent, 'transfers', t.id)
    returning unit_cost into v_cost;
    update transfer_lines set unit_cost = v_cost where id = l.id;
  end loop;

  update transfers
  set status = 'in_transit', sent_by = auth.uid(), sent_at = now()
  where id = p_transfer;
end $$;

create function receive_transfer(p_transfer uuid, p_lines jsonb default '[]'::jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  t transfers;
begin
  select * into t from transfers where id = p_transfer for update;
  if not found then raise exception 'not_found'; end if;
  if not can_access_location(t.to_location_id) then raise exception 'forbidden'; end if;
  if t.status <> 'in_transit' then raise exception 'invalid_status'; end if;

  update transfer_lines tl
  set qty_received = coalesce(
    (select (e->>'qty_received')::numeric
     from jsonb_array_elements(p_lines) e
     where (e->>'line_id')::uuid = tl.id),
    tl.qty_sent
  )
  where tl.transfer_id = p_transfer;

  insert into stock_movements (org_id, location_id, product_id, type, qty, unit_cost, ref_table, ref_id)
  select t.org_id, t.to_location_id, product_id, 'transfer_in', qty_received, unit_cost, 'transfers', t.id
  from transfer_lines
  where transfer_id = p_transfer and qty_received > 0;

  update transfers
  set status = 'received', received_by = auth.uid(), received_at = now()
  where id = p_transfer;
end $$;

create function cancel_transfer(p_transfer uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  t transfers;
begin
  select * into t from transfers where id = p_transfer for update;
  if not found then raise exception 'not_found'; end if;
  if not can_access_location(t.from_location_id) then raise exception 'forbidden'; end if;

  if t.status = 'in_transit' then
    insert into stock_movements (org_id, location_id, product_id, type, qty, unit_cost, reason, ref_table, ref_id)
    select t.org_id, t.from_location_id, product_id, 'transfer_in', qty_sent, unit_cost, 'cancelado', 'transfers', t.id
    from transfer_lines where transfer_id = p_transfer;
  elsif t.status <> 'draft' then
    raise exception 'invalid_status';
  end if;

  update transfers set status = 'cancelled' where id = p_transfer;
end $$;

create function close_count(p_count uuid, p_zero_uncounted boolean default false)
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

  insert into stock_movements (org_id, location_id, product_id, type, qty, ref_table, ref_id)
  select c.org_id, c.location_id, product_id, 'count_adjustment', diff_qty, 'inventory_counts', p_count
  from count_results
  where count_id = p_count and diff_qty <> 0;

  update inventory_counts
  set status = 'closed', closed_by = auth.uid(), closed_at = now()
  where id = p_count;
end $$;

create function post_receipt(p_receipt uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  r goods_receipts;
begin
  select * into r from goods_receipts where id = p_receipt for update;
  if not found then raise exception 'not_found'; end if;
  if not can_access_location(r.location_id) then raise exception 'forbidden'; end if;
  if r.status <> 'open' then raise exception 'invalid_status'; end if;
  if not exists (select 1 from receipt_lines where receipt_id = p_receipt) then
    raise exception 'empty_receipt';
  end if;

  insert into stock_movements (org_id, location_id, product_id, type, qty, unit_cost, ref_table, ref_id)
  select r.org_id, r.location_id, pp.product_id, 'purchase',
         rl.packs_qty * pp.qty_base, rl.pack_price / pp.qty_base,
         'goods_receipts', r.id
  from receipt_lines rl
  join product_packs pp on pp.id = rl.pack_id
  where rl.receipt_id = p_receipt;

  if r.supplier_id is not null then
    insert into supplier_prices (supplier_id, pack_id, last_price, last_price_at)
    select distinct on (pack_id) r.supplier_id, pack_id, pack_price, now()
    from receipt_lines where receipt_id = p_receipt
    order by pack_id
    on conflict (supplier_id, pack_id)
    do update set last_price = excluded.last_price, last_price_at = excluded.last_price_at;

    insert into price_history (supplier_id, pack_id, price, receipt_id)
    select r.supplier_id, pack_id, pack_price, r.id
    from receipt_lines where receipt_id = p_receipt;
  end if;

  update goods_receipts
  set status = 'closed', posted_by = auth.uid(), posted_at = now()
  where id = p_receipt;
end $$;

-- RLS --------------------------------------------------------------------

alter table organizations enable row level security;
alter table locations enable row level security;
alter table storage_areas enable row level security;
alter table memberships enable row level security;
alter table membership_locations enable row level security;
alter table categories enable row level security;
alter table suppliers enable row level security;
alter table products enable row level security;
alter table product_packs enable row level security;
alter table supplier_prices enable row level security;
alter table price_history enable row level security;
alter table location_products enable row level security;
alter table stock_balances enable row level security;
alter table stock_movements enable row level security;
alter table transfers enable row level security;
alter table transfer_lines enable row level security;
alter table inventory_counts enable row level security;
alter table count_lines enable row level security;
alter table count_results enable row level security;
alter table goods_receipts enable row level security;
alter table receipt_lines enable row level security;

create policy org_select on organizations for select using (is_member(id));
create policy org_update on organizations for update using (is_admin(id)) with check (is_admin(id));

create policy loc_select on locations for select using (is_member(org_id));
create policy loc_write on locations for all using (is_admin(org_id)) with check (is_admin(org_id));

create policy area_select on storage_areas for select using (can_access_location(location_id));
create policy area_write on storage_areas for all
  using (can_access_location(location_id) and is_manager(location_org(location_id)))
  with check (can_access_location(location_id) and is_manager(location_org(location_id)));

create policy mem_select on memberships for select using (is_member(org_id));
create policy mem_write on memberships for all using (is_admin(org_id)) with check (is_admin(org_id));

create policy memloc_select on membership_locations for select using (is_member(org_id));
create policy memloc_write on membership_locations for all using (is_admin(org_id)) with check (is_admin(org_id));

create policy cat_select on categories for select using (is_member(org_id));
create policy cat_write on categories for all using (is_manager(org_id)) with check (is_manager(org_id));

create policy sup_select on suppliers for select using (is_member(org_id));
create policy sup_write on suppliers for all using (is_manager(org_id)) with check (is_manager(org_id));

create policy prod_select on products for select using (is_member(org_id));
create policy prod_write on products for all using (is_manager(org_id)) with check (is_manager(org_id));

create policy pack_select on product_packs for select
  using (exists (select 1 from products p where p.id = product_id and is_member(p.org_id)));
create policy pack_write on product_packs for all
  using (exists (select 1 from products p where p.id = product_id and is_manager(p.org_id)))
  with check (exists (select 1 from products p where p.id = product_id and is_manager(p.org_id)));

create policy sprice_select on supplier_prices for select
  using (exists (select 1 from suppliers s where s.id = supplier_id and is_member(s.org_id)));
create policy sprice_write on supplier_prices for all
  using (exists (select 1 from suppliers s where s.id = supplier_id and is_manager(s.org_id)))
  with check (exists (select 1 from suppliers s where s.id = supplier_id and is_manager(s.org_id)));

create policy phist_select on price_history for select
  using (exists (select 1 from suppliers s where s.id = supplier_id and is_member(s.org_id)));

create policy locprod_select on location_products for select using (can_access_location(location_id));
create policy locprod_write on location_products for all
  using (can_access_location(location_id) and is_manager(location_org(location_id)))
  with check (can_access_location(location_id) and is_manager(location_org(location_id)));

create policy bal_select on stock_balances for select using (can_access_location(location_id));
create policy mov_select on stock_movements for select using (can_access_location(location_id));

create policy tr_select on transfers for select
  using (can_access_location(from_location_id) or can_access_location(to_location_id));
create policy tr_insert on transfers for insert
  with check (status = 'draft' and can_access_location(from_location_id));
create policy tr_update on transfers for update
  using (status = 'draft' and can_access_location(from_location_id))
  with check (status = 'draft' and can_access_location(from_location_id));
create policy tr_delete on transfers for delete
  using (status = 'draft' and can_access_location(from_location_id));

create policy trl_select on transfer_lines for select
  using (exists (
    select 1 from transfers t where t.id = transfer_id
      and (can_access_location(t.from_location_id) or can_access_location(t.to_location_id))
  ));
create policy trl_write on transfer_lines for all
  using (exists (
    select 1 from transfers t where t.id = transfer_id
      and t.status = 'draft' and can_access_location(t.from_location_id)
  ))
  with check (exists (
    select 1 from transfers t where t.id = transfer_id
      and t.status = 'draft' and can_access_location(t.from_location_id)
  ));

create policy cnt_select on inventory_counts for select using (can_access_location(location_id));
create policy cnt_insert on inventory_counts for insert
  with check (status = 'open' and can_access_location(location_id));

create policy cntl_select on count_lines for select
  using (exists (select 1 from inventory_counts c where c.id = count_id and can_access_location(c.location_id)));
create policy cntl_write on count_lines for all
  using (exists (
    select 1 from inventory_counts c where c.id = count_id
      and c.status = 'open' and can_access_location(c.location_id)
  ))
  with check (exists (
    select 1 from inventory_counts c where c.id = count_id
      and c.status = 'open' and can_access_location(c.location_id)
  ));

create policy cntr_select on count_results for select
  using (exists (select 1 from inventory_counts c where c.id = count_id and can_access_location(c.location_id)));

create policy rcp_select on goods_receipts for select using (can_access_location(location_id));
create policy rcp_insert on goods_receipts for insert
  with check (status = 'open' and can_access_location(location_id));
create policy rcp_update on goods_receipts for update
  using (status = 'open' and can_access_location(location_id))
  with check (status = 'open' and can_access_location(location_id));
create policy rcp_delete on goods_receipts for delete
  using (status = 'open' and can_access_location(location_id));

create policy rcpl_select on receipt_lines for select
  using (exists (select 1 from goods_receipts r where r.id = receipt_id and can_access_location(r.location_id)));
create policy rcpl_write on receipt_lines for all
  using (exists (
    select 1 from goods_receipts r where r.id = receipt_id
      and r.status = 'open' and can_access_location(r.location_id)
  ))
  with check (exists (
    select 1 from goods_receipts r where r.id = receipt_id
      and r.status = 'open' and can_access_location(r.location_id)
  ));

-- Vistas de reporting ----------------------------------------------------

create view v_stock_valuation with (security_invoker = true) as
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
  greatest(coalesce(lp.par_qty, 0) - b.qty, 0) as suggested_order_qty
from stock_balances b
join locations l on l.id = b.location_id
join products p on p.id = b.product_id
left join categories c on c.id = p.category_id
left join location_products lp on lp.location_id = b.location_id and lp.product_id = b.product_id;

create view v_movements_by_business_day with (security_invoker = true) as
select
  m.org_id,
  m.location_id,
  m.product_id,
  m.type,
  ((m.occurred_at at time zone l.timezone) - l.day_cutoff::interval)::date as business_day,
  sum(m.qty) as qty,
  round(sum(m.qty * m.unit_cost), 2) as value
from stock_movements m
join locations l on l.id = m.location_id
group by 1, 2, 3, 4, 5;

create view v_transfer_losses with (security_invoker = true) as
select
  t.org_id,
  t.id as transfer_id,
  t.from_location_id,
  t.to_location_id,
  t.received_at,
  tl.product_id,
  tl.qty_sent,
  tl.qty_received,
  tl.qty_sent - tl.qty_received as qty_lost,
  round((tl.qty_sent - tl.qty_received) * tl.unit_cost, 2) as value_lost
from transfers t
join transfer_lines tl on tl.transfer_id = t.id
where t.status = 'received' and tl.qty_received <> tl.qty_sent;

-- Ejecución --------------------------------------------------------------

revoke execute on all functions in schema public from public, anon;
grant execute on function
  create_organization(text, text),
  register_movement(uuid, uuid, movement_type, numeric, text, uuid, numeric, uuid),
  send_transfer(uuid),
  receive_transfer(uuid, jsonb),
  cancel_transfer(uuid),
  close_count(uuid, boolean),
  post_receipt(uuid),
  is_member(uuid),
  is_manager(uuid),
  is_admin(uuid),
  can_access_location(uuid),
  location_org(uuid),
  auth_role(uuid)
to authenticated;
