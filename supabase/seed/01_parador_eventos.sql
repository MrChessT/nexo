-- Alta inicial de Parador Eventos: organizacion, locales, areas y el primer usuario owner.
-- Sustituye el email si corresponde a otro usuario.
-- Ejecutar una sola vez en el SQL Editor de Supabase.

do $$
declare
  v_org_id uuid;
  v_user_id uuid;
  v_parador uuid;
  v_pickels uuid;
  v_vivero uuid;
  v_oliva uuid;
begin
  select id into v_user_id from auth.users where email = 'oskarperssonb@gmail.com' limit 1;
  if v_user_id is null then
    raise exception 'Usuario no encontrado. Crea el usuario primero en Authentication > Users.';
  end if;

  insert into organizations (name, business_type, currency)
  values ('Parador Eventos', 'restaurant', 'EUR')
  returning id into v_org_id;

  insert into locations (org_id, name, kind) values (v_org_id, 'Parador', 'venue') returning id into v_parador;
  insert into locations (org_id, name, kind) values (v_org_id, 'Pickels', 'venue') returning id into v_pickels;
  insert into locations (org_id, name, kind) values (v_org_id, 'Vivero', 'venue') returning id into v_vivero;
  insert into locations (org_id, name, kind) values (v_org_id, 'La Oliva', 'venue') returning id into v_oliva;

  insert into storage_areas (location_id, name, sort_order) values
    (v_parador, 'Almacen general', 1),
    (v_parador, 'Barra', 2),
    (v_pickels, 'Almacen general', 1),
    (v_pickels, 'Barra', 2),
    (v_vivero, 'Almacen general', 1),
    (v_vivero, 'Barra', 2),
    (v_oliva, 'Almacen general', 1),
    (v_oliva, 'Barra', 2);

  insert into memberships (org_id, user_id, role, all_locations)
  values (v_org_id, v_user_id, 'owner', true);
end $$;
