-- Refuerza integridad multiempresa y permisos sin modificar la migracion core.

alter table organizations
  add constraint organizations_business_type_check
  check (business_type in ('nightclub', 'cocktail_bar', 'bar', 'restaurant', 'cafe', 'hotel'));

create or replace function validate_cross_org_links()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_org uuid;
  child_org uuid;
  expected_location uuid;
begin
  if tg_table_name = 'products' then
    if new.category_id is not null then
      select org_id into child_org from categories where id = new.category_id;
      if child_org is null or child_org <> new.org_id then
        raise exception 'cross_organization_link';
      end if;
    end if;
  elsif tg_table_name = 'categories' then
    if new.parent_id is not null then
      select org_id into parent_org from categories where id = new.parent_id;
      if parent_org is null or parent_org <> new.org_id then
        raise exception 'cross_organization_link';
      end if;
    end if;
  elsif tg_table_name = 'location_products' then
    select org_id into parent_org from locations where id = new.location_id;
    select org_id into child_org from products where id = new.product_id;
    if parent_org is null or child_org is null or parent_org <> child_org then
      raise exception 'cross_organization_link';
    end if;
    if new.default_area_id is not null then
      select location_id into expected_location from storage_areas where id = new.default_area_id;
      if expected_location is null or expected_location <> new.location_id then
        raise exception 'cross_location_link';
      end if;
    end if;
  elsif tg_table_name = 'transfer_lines' then
    select org_id into parent_org from transfers where id = new.transfer_id;
    select org_id into child_org from products where id = new.product_id;
    if parent_org is null or child_org is null or parent_org <> child_org then
      raise exception 'cross_organization_link';
    end if;
  elsif tg_table_name = 'count_lines' then
    select org_id, location_id into parent_org, expected_location from inventory_counts where id = new.count_id;
    select org_id into child_org from products where id = new.product_id;
    if parent_org is null or child_org is null or parent_org <> child_org then
      raise exception 'cross_organization_link';
    end if;
    if new.area_id is not null then
      select location_id into child_org from storage_areas where id = new.area_id;
      if child_org is null or child_org <> expected_location then
        raise exception 'cross_location_link';
      end if;
    end if;
  elsif tg_table_name = 'receipt_lines' then
    select org_id into parent_org from goods_receipts where id = new.receipt_id;
    select p.org_id into child_org
    from product_packs pp join products p on p.id = pp.product_id
    where pp.id = new.pack_id;
    if parent_org is null or child_org is null or parent_org <> child_org then
      raise exception 'cross_organization_link';
    end if;
  elsif tg_table_name in ('supplier_prices', 'price_history') then
    select s.org_id into parent_org from suppliers s where s.id = new.supplier_id;
    select p.org_id into child_org
    from product_packs pp join products p on p.id = pp.product_id
    where pp.id = new.pack_id;
    if parent_org is null or child_org is null or parent_org <> child_org then
      raise exception 'cross_organization_link';
    end if;
  end if;

  return new;
end $$;

create trigger products_cross_org_check
before insert or update on products
for each row execute function validate_cross_org_links();

create trigger categories_cross_org_check
before insert or update on categories
for each row execute function validate_cross_org_links();

create trigger location_products_cross_org_check
before insert or update on location_products
for each row execute function validate_cross_org_links();

create trigger transfer_lines_cross_org_check
before insert or update on transfer_lines
for each row execute function validate_cross_org_links();

create trigger count_lines_cross_org_check
before insert or update on count_lines
for each row execute function validate_cross_org_links();

create trigger receipt_lines_cross_org_check
before insert or update on receipt_lines
for each row execute function validate_cross_org_links();

create trigger supplier_prices_cross_org_check
before insert or update on supplier_prices
for each row execute function validate_cross_org_links();

create trigger price_history_cross_org_check
before insert or update on price_history
for each row execute function validate_cross_org_links();

drop policy if exists loc_select on locations;
create policy loc_select on locations for select using (can_access_location(id));

create or replace function send_transfer(p_transfer uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  t transfers;
  l transfer_lines;
  v_cost numeric;
begin
  select * into t from transfers where id = p_transfer for update;
  if not found then raise exception 'not_found'; end if;
  if not (can_access_location(t.from_location_id) and is_manager(t.org_id)) then raise exception 'forbidden'; end if;
  if t.status <> 'draft' then raise exception 'invalid_status'; end if;
  if not exists (select 1 from transfer_lines where transfer_id = p_transfer) then raise exception 'empty_transfer'; end if;

  for l in select * from transfer_lines where transfer_id = p_transfer loop
    insert into stock_movements (org_id, location_id, product_id, type, qty, ref_table, ref_id)
    values (t.org_id, t.from_location_id, l.product_id, 'transfer_out', -l.qty_sent, 'transfers', t.id)
    returning unit_cost into v_cost;
    update transfer_lines set unit_cost = v_cost where id = l.id;
  end loop;

  update transfers set status = 'in_transit', sent_by = auth.uid(), sent_at = now() where id = p_transfer;
end $$;

create or replace function receive_transfer(p_transfer uuid, p_lines jsonb default '[]'::jsonb)
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
    (select (e->>'qty_received')::numeric from jsonb_array_elements(p_lines) e where (e->>'line_id')::uuid = tl.id),
    tl.qty_sent
  )
  where tl.transfer_id = p_transfer;

  if exists (select 1 from transfer_lines where transfer_id = p_transfer and (qty_received < 0 or qty_received > qty_sent)) then
    raise exception 'invalid_quantity';
  end if;

  insert into stock_movements (org_id, location_id, product_id, type, qty, unit_cost, ref_table, ref_id)
  select t.org_id, t.to_location_id, product_id, 'transfer_in', qty_received, unit_cost, 'transfers', t.id
  from transfer_lines where transfer_id = p_transfer and qty_received > 0;

  update transfers set status = 'received', received_by = auth.uid(), received_at = now() where id = p_transfer;
end $$;

create or replace function cancel_transfer(p_transfer uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  t transfers;
begin
  select * into t from transfers where id = p_transfer for update;
  if not found then raise exception 'not_found'; end if;
  if not (can_access_location(t.from_location_id) and is_manager(t.org_id)) then raise exception 'forbidden'; end if;

  if t.status = 'in_transit' then
    insert into stock_movements (org_id, location_id, product_id, type, qty, unit_cost, reason, ref_table, ref_id)
    select t.org_id, t.from_location_id, product_id, 'transfer_in', qty_sent, unit_cost, 'cancelado', 'transfers', t.id
    from transfer_lines where transfer_id = p_transfer;
  elsif t.status <> 'draft' then
    raise exception 'invalid_status';
  end if;

  update transfers set status = 'cancelled' where id = p_transfer;
end $$;

revoke execute on function send_transfer(uuid), cancel_transfer(uuid) from public, anon;
grant execute on function send_transfer(uuid), cancel_transfer(uuid) to authenticated;
