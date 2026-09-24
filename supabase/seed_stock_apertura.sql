-- Apertura de stock real para ver Stock/Resumen con datos, usando movimientos inmutables
-- (no se edita stock_balances directamente: el trigger apply_stock_movement lo calcula).
-- Requiere haber ejecutado antes seed_parador_eventos.sql y seed_productos_demo.sql.
-- Ejecutar en el SQL Editor de Supabase (Ctrl+A para seleccionar todo).

do $$
declare
  v_org_id uuid;
  v_parador uuid;
  v_pickels uuid;
  v_coca uuid;
  v_estrella uuid;
  v_ron uuid;
  v_patatas uuid;
  v_limones uuid;
begin
  select id into v_org_id from organizations where name = 'Parador Eventos' limit 1;
  if v_org_id is null then
    raise exception 'Organizacion no encontrada. Ejecuta primero seed_parador_eventos.sql.';
  end if;

  select id into v_parador from locations where org_id = v_org_id and name = 'Parador' limit 1;
  select id into v_pickels from locations where org_id = v_org_id and name = 'Pickels' limit 1;

  select id into v_coca from products where org_id = v_org_id and name = 'Coca-Cola' limit 1;
  select id into v_estrella from products where org_id = v_org_id and name = 'Estrella Galicia' limit 1;
  select id into v_ron from products where org_id = v_org_id and name = 'Ron Barcelo' limit 1;
  select id into v_patatas from products where org_id = v_org_id and name = 'Patatas fritas' limit 1;
  select id into v_limones from products where org_id = v_org_id and name = 'Limones' limit 1;

  if v_coca is null then
    raise exception 'Productos no encontrados. Ejecuta primero seed_productos_demo.sql.';
  end if;

  -- Umbrales minimos por local (para la señal "Bajo minimo" en Stock).
  insert into location_products (location_id, product_id, min_qty, par_qty) values
    (v_parador, v_coca, 6000, 20000),
    (v_parador, v_estrella, 5000, 15000),
    (v_parador, v_ron, 2000, 7000),
    (v_parador, v_patatas, 5000, 20000),
    (v_parador, v_limones, 50, 200),
    (v_pickels, v_coca, 3000, 10000),
    (v_pickels, v_estrella, 3000, 10000)
  on conflict (location_id, product_id) do nothing;

  -- Movimientos de apertura (qty en unidad base: ml, g o ud).
  insert into stock_movements (org_id, location_id, product_id, type, qty, unit_cost, reason) values
    (v_org_id, v_parador, v_coca, 'opening', 16500, 0.001515, 'Apertura inicial de inventario'),
    (v_org_id, v_parador, v_estrella, 'opening', 25000, 0.0016, 'Apertura inicial de inventario'),
    (v_org_id, v_parador, v_ron, 'opening', 7000, 0.017143, 'Apertura inicial de inventario'),
    (v_org_id, v_parador, v_patatas, 'opening', 20000, 0.0025, 'Apertura inicial de inventario'),
    (v_org_id, v_parador, v_limones, 'opening', 200, 0.20, 'Apertura inicial de inventario'),
    (v_org_id, v_pickels, v_coca, 'opening', 3300, 0.001515, 'Apertura inicial de inventario'),
    (v_org_id, v_pickels, v_estrella, 'opening', 2500, 0.0016, 'Apertura inicial de inventario');
end $$;
