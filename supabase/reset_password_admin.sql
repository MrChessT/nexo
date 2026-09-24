-- Fija una contrasena conocida para el usuario admin sin pasar por email.
-- Uso puntual mientras Supabase no envia correos (limite del plan gratuito).
-- Sustituye la contrasena por una tuya y bórrala del archivo después de usarla.
-- Ejecutar en el SQL Editor de Supabase (Ctrl+A para seleccionar todo).

update auth.users
set encrypted_password = crypt('CAMBIA_ESTA_CONTRASEÑA', gen_salt('bf')),
    updated_at = now()
where email = 'oskarperssonb@gmail.com';
