# Nexo Inventario

Aplicacion multilocal de inventario para hosteleria.

## Desarrollo

```bash
npm.cmd install
npm.cmd run dev
```

La aplicacion usa Next.js App Router, TypeScript estricto y Supabase. La migracion `0001_inventario_core.sql` es el contrato base y no se modifica; los cambios de esquema se añaden numerados en `supabase/migrations`. La migracion `0004_saldo_por_espacio.sql` añade el saldo por barra, almacen o camara sin romper el saldo agregado por local.

La cobertura específica de Parador Eventos y las capacidades pendientes están documentadas en [docs/parador-eventos-cobertura.md](docs/parador-eventos-cobertura.md).

## Puerta de calidad

Antes de integrar una funcionalidad:

```bash
npm.cmd run lint
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

Para validar la base de datos necesitas Docker Desktop iniciado:

```bash
supabase.cmd start
npm.cmd run db:reset
npm.cmd run db:test
npm.cmd run db:lint
```

Los tests de `src/lib` cubren formulas sin conversiones de cantidades a `number`. Los tests de `supabase/tests` comprueban el contrato de RLS, triggers y RPC; los escenarios de permisos y movimientos deben ampliarse junto a cada migracion.

## Reglas de datos

- Los productos, proveedores, formatos y locales pertenecen a una organizacion.
- El stock solo cambia mediante RPC y `stock_movements` es inmutable.
- Las cantidades se guardan en unidad base y los decimales se calculan con `decimal.js`.
- Los datos de prueba se importan al modelo canonico, nunca mediante tablas paralelas.
