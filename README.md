# Nexo Copiloto

Inventario multilocal para hostelería con un asistente que decide con **Jev** (TypeSafe AI).
Cliente de referencia: Parador Eventos (Parador, Pickels, Vivero y La Oliva).

**Principio:** Jev decide → el código calcula con `decimal.js` y escribe solo mediante RPC → el usuario confirma. Una LLM opcional solo redacta; sin ella responden plantillas.

## Qué hace

| Área | Pantalla | Asistente |
| --- | --- | --- |
| Resumen | `/`: valor del stock, consumo, rotación, alertas; filtro por local | «¿Qué debería revisar hoy?» |
| Stock | `/stock`: existencias, bajo mínimo, exportar CSV | «¿Cuánto ron queda en Parador?» |
| Catálogo | `/productos`: ficha con formatos, precios por proveedor y mínimos | Cambiar precio, dar de alta (con detección de duplicados), mínimos, archivar |
| Proveedores | `/proveedores` | — |
| Pedidos | `/pedidos`: sugerir, enviar (email/WhatsApp) y recibir contra el pedido | «Prepara el pedido de la semana para Parador» |
| Recepciones, traspasos, mermas | `/recepciones`, `/traspasos`, `/mermas` | Borradores que se confirman con un clic |
| Inventarios | `/inventarios`: conteo en formatos, revisión y cierre como consumo | «Cierra el inventario del Vivero» |
| Informes | `/informes`: consumo, mermas, stock, precios, reposición, desvíos | Gráficas en el chat |

## Estructura

```
src/
  app/                 Pantallas (App Router) y la ruta /api/copiloto
  components/          Asistente (panel), gráficas y operaciones compartidas
  copiloto/            El agente, solo servidor: Jev, herramientas, borradores, analítica
  lib/                 Supabase (clientes y tipos), formato es-ES, unidades, preferencias
  proxy.ts             Sesión en cada navegación (Next 16: sustituye a middleware)
supabase/
  migrations/          Esquema, RLS y RPC, numerados (fuente de verdad)
  tests/               Tests pgTAP de permisos y RPC (los ejecuta el CI)
  seed/                Datos de ejemplo de Parador Eventos, en orden 01 → 04
  scripts/             Herramientas puntuales (restablecer contraseña; aplicar.sql generado)
  config.toml          Supabase local (Postgres 17, igual que producción)
scripts/               Utilidades del repositorio (unir migraciones)
docs/
  copiloto/            Contrato de la API, arquitectura, catálogo de Jev y evaluación
  parador-eventos-cobertura.md   Alcance frente al negocio
```

## Desarrollo

```bash
npm install
npm run dev
```

Variables en `.env.local` (plantilla en `.env.example`): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` y, para Jev, `VERCEL_OIDC_TOKEN` (`npx vercel env pull .env.local`) o `TYPESAFE_API_KEY`.

## Calidad

```bash
npm run check        # lint + tipos + tests + build (lo mismo que el CI)
```

- `npm test`: tests de la app y del asistente, con Jev y LLM simulados.
- `npm run copiloto:eval`: set de frases contra Jev real (`--desde N`, `--lote N`).
- `npm run copiloto:probe -- "frase"`: probabilidades de Jev para una frase (afinar el catálogo).
- **CI** (GitHub Actions, cada push y PR): la app y la base de datos. La base de datos se levanta en local con todas las migraciones y pasa `supabase/tests`.

Reglas del código: el stock solo cambia mediante RPC y `stock_movements` es inmutable; las cantidades se guardan en unidad base (ml, g, ud) y nunca se calculan con `number`; todo va con el JWT del usuario y RLS, sin service role.

## Base de datos

Las migraciones se aplican en orden y se pueden repetir sin error.

| Migración | Qué añade |
| --- | --- |
| 0001–0004 | Núcleo: organizaciones, catálogo, stock, documentos, RLS, saldo por espacio |
| 0005–0006 | Asistente: auditoría, sesiones y borradores |
| 0007 | Catálogo con filtros en servidor (`catalog_search`) |
| 0008 | Rendimiento: RLS evaluada una vez por consulta, índices |
| 0009 | Resumen filtrable por local y consumo con una sola definición |
| 0010 | (retirada) |
| 0011 | Consumo real por inventario (`close_count` como consumo, `count_preview`) |
| 0012 | Pedidos a proveedor |
| 0013 | Limpieza de la 0010, por si se llegó a aplicar |
| 0014 | Permisos de tabla explícitos para usuarios autenticados (RLS sigue decidiendo las filas) |
| 0015 | Hábitos del asistente por usuario (locales y productos más usados) |

**Aplicar en el proyecto real:** `npm run db:bundle -- 0008` genera `supabase/scripts/aplicar.sql` con las migraciones desde la 0008, en una sola transacción. Se pega en Supabase → SQL Editor → Run.

**Local** (Docker): `npm run db:start`, `npm run db:reset`, `npm run db:test`.

**Datos de ejemplo:** `supabase/seed/01…04` en orden (organización y locales, productos, catálogo de Vivero, stock de apertura).

## Asistente

- `src/copiloto/jev/catalog.ts`: todas las preguntas a Jev (cambiar un texto sube `CATALOG_VERSION`). `gates/thresholds.ts`: umbrales de confianza.
- `agent/`: interpretación y bucle; `drafts/`: borradores, comprobaciones y confirmación; `tools/` y `analytics/`: cálculos.
- `src/app/api/copiloto/[...ruta]/route.ts`: `chat` (SSE), `actions/confirm`, `suggestions`, `analytics`, `reorder` y `health`.
- Documentación: [contrato](docs/copiloto/CONTRACT.md), [arquitectura](docs/copiloto/PROPUESTA.md), [catálogo de Jev y mediciones](docs/copiloto/CATALOGO_JEV.md).

## Despliegue

Vercel (`vercel.json`). En producción solo hacen falta las dos variables de Supabase: Jev se autentica con el token OIDC del propio despliegue (Vercel AI Gateway), sin guardar claves.
