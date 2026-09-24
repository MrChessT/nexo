-- Se retira el apartado de Equipo (invitaciones y gestión de miembros desde la app).
-- La migración 0010 se eliminó del repositorio; si llegó a aplicarse, esto borra lo que creó.
-- Idempotente: si nunca se aplicó, no hace nada.

drop trigger if exists memberships_protect_owners on memberships;
drop function if exists protect_owners();
drop function if exists org_members(uuid);
drop function if exists accept_invitations();
drop table if exists invitations;
