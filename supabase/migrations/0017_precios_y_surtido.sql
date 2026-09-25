-- Precios con historial completo y surtido de cada local al día. Idempotente.
--
-- 1) price_history solo se escribía al contabilizar una recepción. Los precios del catálogo importado y
--    los que se cambian a mano (ficha de producto, asistente) no quedaban en el historial, y las consultas
--    de precios («¿a cuánto nos sale el Beefeater?», «¿ha subido algo?») no los veían. Ahora cada cambio
--    de supplier_prices.last_price deja su registro, y se rellena lo que faltaba.
-- 2) El surtido de un local (location_products) solo se daba de alta a mano: un producto que llegaba por
--    primera vez a un local (recepción, traspaso, apertura) no salía en sus mínimos, en la reposición ni en
--    la hoja de inventario. Ahora cualquier movimiento de stock lo da de alta (sin mínimos), y se rellena.

-- 1 · Historial de precios -----------------------------------------------------------------------------

create or replace function record_price_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.last_price is null then return new; end if;
  if tg_op = 'UPDATE' and new.last_price is not distinct from old.last_price then return new; end if;
  insert into price_history (supplier_id, pack_id, price, recorded_at)
  values (new.supplier_id, new.pack_id, new.last_price, coalesce(new.last_price_at, now()));
  return new;
end $$;

drop trigger if exists supplier_prices_history on supplier_prices;
create trigger supplier_prices_history
after insert or update of last_price on supplier_prices
for each row execute function record_price_change();

-- post_receipt actualiza supplier_prices (el disparador ya deja el registro) y después inserta el suyo con
-- receipt_id. En vez de duplicarlo, se enlaza el registro recién creado en la misma transacción.
create or replace function merge_receipt_price() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
begin
  if new.receipt_id is null then return new; end if;
  select id into v_id
  from price_history
  where supplier_id = new.supplier_id and pack_id = new.pack_id and price = new.price
    and receipt_id is null and recorded_at = now()
  order by id desc
  limit 1;
  if v_id is null then return new; end if;
  update price_history set receipt_id = new.receipt_id where id = v_id;
  return null;
end $$;

drop trigger if exists price_history_merge_receipt on price_history;
create trigger price_history_merge_receipt
before insert on price_history
for each row execute function merge_receipt_price();

-- Precios que ya existían sin ningún registro en el historial (catálogo importado, cambios a mano).
insert into price_history (supplier_id, pack_id, price, recorded_at)
select sp.supplier_id, sp.pack_id, sp.last_price, coalesce(sp.last_price_at, now())
from supplier_prices sp
where sp.last_price is not null
  and not exists (select 1 from price_history h where h.supplier_id = sp.supplier_id and h.pack_id = sp.pack_id);

-- 2 · Surtido de cada local ----------------------------------------------------------------------------

create or replace function register_location_product() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into location_products (location_id, product_id)
  values (new.location_id, new.product_id)
  on conflict (location_id, product_id) do nothing;
  return null;
end $$;

drop trigger if exists stock_movements_assortment on stock_movements;
create trigger stock_movements_assortment
after insert on stock_movements
for each row execute function register_location_product();

-- Productos que ya se movieron en un local y no estaban en su surtido.
insert into location_products (location_id, product_id)
select distinct m.location_id, m.product_id
from stock_movements m
on conflict (location_id, product_id) do nothing;
