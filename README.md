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

## Migraciones

Se aplican en orden. En el proyecto real se pegan en Supabase → SQL Editor; el CI las aplica todas sobre una base limpia y pasa `supabase/tests`.

| Migración | Qué añade |
| --- | --- |
| 0001–0004 | Núcleo: organizaciones, catálogo, stock, documentos, RLS, saldo por espacio |
| 0005–0006 | Asistente: auditoría, sesiones y borradores |
| 0007 | Catálogo con filtros en servidor (`catalog_search`) |
| 0008 | Rendimiento: RLS evaluada una vez por consulta, índices, `stock_summary` |
| 0009 | Resumen filtrable por local y consumo con una sola definición |
| 0010 | (retirada: el apartado de Equipo se eliminó) |
| 0011 | Consumo real por inventario (`close_count` con `p_as_consumption`, `count_preview`) |
| 0012 | Pedidos a proveedor: borrador, envío, recepción parcial o total |
| 0013 | Limpieza de lo que creaba la 0010, por si se llegó a aplicar |

Las funciones de la app que dependen de una migración nueva degradan con un aviso si aún no está aplicada.

## Asistente (Nexo Copiloto)

El asistente de chat (Ctrl+K o botón «Asistente») y la página **Informes** forman parte de esta app: mismo repositorio y mismo despliegue.

**Principio:** Jev (TypeSafe AI) decide → el código calcula con decimal.js y ejecuta con las RPC → una LLM opcional solo redacta. Si no hay LLM, responden plantillas.

**Código**
- `src/copiloto/`: el agente, solo en servidor.
  - `jev/catalog.ts`: preguntas de Jev. `gates/thresholds.ts`: umbrales.
  - `tools/` y `analytics/`: cálculos. `drafts/`: borradores y confirmación.
  - `http.ts`: los endpoints.
- `src/app/api/copiloto/[...ruta]/route.ts`: endpoints `chat` (SSE), `actions/confirm`, `suggestions`, `analytics` y `health`. Usan la sesión del usuario (cookies); todo va con su JWT y RLS, sin service role.
- `src/components/copiloto/` (panel), `src/components/charts/` (gráficas SVG) y `src/app/informes/`.
- `docs/copiloto/`: contrato, arquitectura, catálogo de preguntas y evaluación.

**Base de datos**
- La primera vez, ejecuta `supabase/INSTALAR_ASISTENTE_Y_CATALOGO.sql` en el SQL Editor de Supabase. Instala las migraciones 0005 (auditoría) y 0006 (borradores y sesiones del asistente) y el catálogo de Vivero 55 en el modelo de la app.
- Se puede repetir sin error.

**Variables**
- En Vercel solo hacen falta `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Jev se autentica con el token OIDC del propio despliegue (Vercel AI Gateway), sin guardar claves.
- En local, `npx vercel env pull .env.local` trae ese token.

**Comprobaciones**
- `npm.cmd test`: incluye los tests del asistente, con Jev y LLM simulados.
- `npm.cmd run copiloto:eval`: 43 frases contra Jev real. Deja el resultado en la consola.
- `/informes?vista=&local=&dias=` y `/stock?local=` aplican los filtros que envía el asistente.
