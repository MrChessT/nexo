-- Permisos de tabla explícitos para usuarios autenticados.
--
-- Las migraciones anteriores dependían de los privilegios por defecto que Supabase concedía sobre el
-- esquema public. Los proyectos y el CLI recientes ya no los conceden automáticamente, así que una
-- base creada desde cero (CI, entorno de pruebas) daba «permission denied» aunque RLS lo permitiera.
--
-- El permiso de tabla solo abre la puerta: QUÉ filas se leen o escriben lo sigue decidiendo RLS
-- (todas las tablas lo tienen activo y las que no deben escribirse no tienen política de escritura).
-- anon no recibe nada: la app exige iniciar sesión.
-- Idempotente: en el proyecto real, donde ya existían, no cambia nada.

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Lo que creen migraciones futuras hereda lo mismo.
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant usage, select on sequences to authenticated;
