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
