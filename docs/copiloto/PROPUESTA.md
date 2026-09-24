# Nexo Copiloto: propuesta de arquitectura (fase 1)

## Decisiones tomadas con tus respuestas

| Pregunta | Respuesta | Consecuencia |
| --- | --- | --- |
| Presupuesto Jev | Holgado | Jev cuesta ~0,0001 $/mensaje, así que no limita. Se usan preguntas especulativas, autoconsistencia en `intent` y evaluación de todos los candidatos en sugerencias. |
| Hardware LLM | Se pasará a una IA en línea; Ollama solo para probar | La redacción y los embeddings van detrás de un **proveedor intercambiable**: `ollama` (desarrollo) y `openai-compatible` (producción: OpenAI, Mistral, Groq, OpenRouter, vLLM…). Se elige por `.env`. |
| Dónde corre | Servidor desde el principio | Dockerfile, CORS y orígenes configurables, verificación del JWT, límite de peticiones, cabeceras de seguridad, logs estructurados sin datos sensibles y `/health` para el orquestador. |

**Privacidad con LLM en línea:** a la LLM de redacción solo le llega el informe de decisión cerrado (nombres de producto y local, cifras). Nunca recibe nombres de personas, emails, ids de usuario ni el JWT.

## Supabase: nube en lugar de local (fase 3)

En el PC de desarrollo no hay Docker, así que no hay Supabase local. El servicio se conecta al proyecto en la nube que ya usa la app, con el mismo método: clave anon + JWT del usuario, RLS activo y sin service role.

Hasta la fase 4 solo hace lecturas. La sintaxis de todas las consultas se ha comprobado contra el esquema real: llegan a Postgres y, sin sesión, devuelven 42501 (permiso denegado), no 400 (error de sintaxis). Falta la prueba de extremo a extremo con un usuario real.

## Hallazgos al leer la app que afectan al diseño

1. **Roles reales:** el enum de la BD es `owner | admin | manager | staff`, no `member | manager | admin`. El contrato usa los reales; «member» equivale a `staff`.
2. **Permisos por RPC:**
   - `register_movement` con `waste` lo puede hacer cualquier miembro con acceso al local; `manual_adjustment` y `opening` requieren manager.
   - `send_transfer` y `cancel_transfer` requieren manager (0003).
   - `close_count` requiere manager.
   - `post_receipt` lo puede hacer cualquier miembro con acceso al local.

   Cada borrador indica su `requiredRole` y la RPC lo vuelve a comprobar.
3. **Traspasos y recepciones no son una sola RPC:** hay que insertar la cabecera y las líneas (RLS permite `draft`/`open`) y luego llamar a `send_transfer` o `post_receipt`. El stock solo cambia en la RPC, así que se cumple la regla. Si la RPC falla, el servicio borra la cabecera en borrador (RLS lo permite) para no dejar restos.
4. **Las páginas no leen filtros de la URL:** ninguna usa `searchParams`. Para que funcione la navegación con filtros, la fase 6 tendrá que añadir la lectura de `?local=&producto=&estado=` en `/stock`, `/traspasos`, etc. Es un cambio pequeño, pero toca varias páginas.
5. **Aviso aparte:** `operations-page.tsx` convierte cantidades con `Number(...)` al guardar (líneas 397, 463, 505, 551), lo que choca con la regla de decimal.js. No lo toco (queda fuera del alcance), pero lo apunto.
6. **Área opcional:** `register_movement` acepta `p_area`. La merma por espacio («barra 1») actualiza `stock_area_balances`. El espacio se resuelve entre los `storage_areas` del local elegido.

## Bucle por mensaje

```
POST /chat
 │
 ├─ 0. Auth JWT → contexto de sesión (caché 5 min): rol, locales, espacios, catálogo, historial breve
 ├─ 0b. Atajo determinista (/stock agua, /mermas, botones)  ──► herramienta directa, sin Jev
 ├─ 1a. Parser de cantidades → segmentos; recuperación de candidatos (embeddings + léxica) por segmento
 ├─ 1b. JEV #1: intent, destino, local(es), espacio, herramienta, tipo_accion, periodo,
 │        motivo_merma, producto_i, cantidad_ok_i, ambiguo, seguimiento, inyeccion   (UNA petición)
 ├─ 2. Compuertas por decisión → si alguna queda por debajo de su umbral: evento clarify (top 2-3) y fin
 ├─ 3. Ejecución en código: herramienta de solo lectura con el JWT del usuario (RLS),
 │        métricas con decimal.js, navegación o borrador (zod) guardado en el servidor
 ├─ 4. JEV #2 (solo si hay candidatos o borrador): reponer/desvío/subida por ítem, urgencia, coherencia
 ├─ 5. Informe de decisión (JSON cerrado)  ──► evento decision (+ navigate | draft)
 └─ 6. Redactor: LLM (stream) → verificador de cifras → si falla: 1 reintento → plantilla
                                                                  ──► eventos text… done
```

Con **2 llamadas a Jev como máximo**, la resolución de producto va dentro de la nº 1 gracias a que la recuperación de candidatos se hace antes. Si la nº 1 deja la decisión por debajo del umbral, la respuesta es un `clarify` y la nº 2 no se hace.

## Estructura del servicio

```
nexo-copiloto/
├─ CONTRACT.md                 contrato con la app (fuente de verdad para la app)
├─ README.md                   (fase 7)
├─ .env.example
├─ Dockerfile                  node:24-alpine, usuario sin privilegios
├─ package.json / tsconfig.json (strict, noUncheckedIndexedAccess) / vitest.config.ts / eslint.config.mjs
├─ docs/
│  ├─ PROPUESTA.md
│  └─ CATALOGO_JEV.md
├─ src/
│  ├─ server.ts                arranque (@hono/node-server) y cierre ordenado
│  ├─ app.ts                   composición Hono: CORS, cabeceras, auth, rate limit, rutas
│  ├─ config.ts                .env validado con zod (falla al arrancar si falta algo)
│  ├─ contract/                tipos y esquemas zod de CONTRACT.md (exportables a la app)
│  ├─ jev/
│  │  ├─ client.ts             envoltorio del SDK: timeout, reintentos, caché, métricas, errores tipados
│  │  ├─ catalog.ts            TODAS las preguntas, versionadas (CATALOG_VERSION)
│  │  └─ state.ts              constructores de state mínimos
│  ├─ gates/
│  │  ├─ thresholds.ts         TODOS los umbrales (sobrescribibles por .env)
│  │  └─ gate.ts               bandas choice/score/noul, margen p1−p2, opciones para clarify
│  ├─ entities/
│  │  ├─ quantity-parser.ts    segmentos, números en letra («dos», «media»), decimales con coma
│  │  ├─ units.ts              unidades → unidad base con decimal.js y product_packs
│  │  ├─ retriever.ts          top-k: embeddings + coincidencia léxica difusa (sin acentos)
│  │  └─ embeddings.ts         proveedor (ollama | openai-compatible) + caché por hash del catálogo
│  ├─ tools/                   solo lectura, tipadas, cliente Supabase del usuario
│  │  ├─ query-stock.ts  query-movements.ts  query-prices.ts
│  │  ├─ query-pending-transfers.ts  query-count-variance.ts  query-reorder.ts
│  │  └─ supabase.ts           createClient(anon key + JWT del usuario); sin service role
│  ├─ agent/
│  │  ├─ loop.ts               bucle del mensaje (etapas cronometradas)
│  │  ├─ context.ts            contexto de sesión en caché
│  │  ├─ shortcuts.ts          atajos deterministas
│  │  └─ report.ts             informe de decisión (zod) — lo único que ve el redactor
│  ├─ drafts/
│  │  ├─ schemas.ts            zod por tipo de borrador
│  │  ├─ store.ts              borradores en el servidor con TTL
│  │  └─ confirm.ts            ejecución con las RPC, idempotencia y limpieza si falla
│  ├─ writer/
│  │  ├─ provider.ts           interfaz + ollama.ts + openai-compatible.ts (stream, num_ctx, temp, max_tokens, keep_alive)
│  │  ├─ prompt.ts             prompt del sistema cerrado; el informe va como datos
│  │  ├─ templates.ts          plantillas deterministas por intención y tipo de resultado
│  │  └─ verifier.ts           toda cifra del texto debe existir en el informe (con normalización es-ES)
│  ├─ suggestions/engine.ts    candidatos → Jev (noul + score) → orden → redacción
│  ├─ cache/lru.ts             LRU con TTL (interfaz para cambiar a Redis si hay varias réplicas)
│  ├─ security/                auth.ts (verificación del JWT), rate-limit.ts (token bucket por usuario), sanitize.ts
│  ├─ audit/                   AuditSink: JSONL en desarrollo → tabla Supabase por RPC (fase 6)
│  └─ metrics/                 histogramas por etapa, tokens, coste, aciertos de caché
├─ eval/
│  ├─ frases.jsonl             30-50 frases reales etiquetadas (intent, herramienta, acción, local, producto…)
│  └─ run-eval.ts              contra Jev real: precisión por decisión y curvas de umbral; A/B de idioma
└─ test/                       Vitest con Jev y LLM simulados
```

### Por qué Hono y no Fastify

- API de `Request`/`Response` estándar y helper `streamSSE` nativo, justo lo que necesita `/chat`.
- Los tests llaman a `app.request()` sin abrir un puerto.
- Es muy ligero y arranca en frío rápido en un contenedor.
- El proxy de Next.js (fase 6) también trabaja con `Request`/`Response` estándar, así que el modelo mental es el mismo en los dos lados.

Fastify aportaría más ecosistema de plugins, pero aquí no hace falta.

### Dependencias previstas

`hono`, `@hono/node-server`, `@typesafe-ai/sdk@0.6.0` (fijada; la 0.6.0 cambió de forma incompatible el `criteria` de score), `@supabase/supabase-js`, `decimal.js`, `zod`, `jose` (verificación del JWT con JWKS de Supabase) y `pino` (logs). Desarrollo: `typescript`, `vitest`, `eslint`, `tsx`.

## Seguridad (servidor)

- **JWT:** verificación local con el JWKS de Supabase (`jose`). Si el proyecto usa secreto simétrico, se usa `auth.getUser()` con caché de 60 s por hash del token. Todas las lecturas y escrituras usan el JWT del usuario, así que el RLS está siempre activo.
- **Anti prompt injection:**
  - el mensaje y los datos de la BD solo entran como `state` o como datos del informe, nunca como instrucciones;
  - el redactor no tiene herramientas;
  - el noul `inyeccion` corta el flujo;
  - el verificador impide que el texto introduzca cifras nuevas.
- **CORS:** solo `APP_ORIGIN`. Además, cabeceras `X-Content-Type-Options`, `Referrer-Policy` y límite de tamaño del cuerpo.
- **Límite de peticiones:** token bucket por usuario (`sub` del JWT) y por IP: `/chat` 20/min, `/actions/confirm` 10/min, `/suggestions` 6/min.
- **Auditoría:** mensaje (con límite de longitud), decisiones con probabilidad y confianza, gate aplicado, borradores y confirmaciones con su resultado.
- **Borradores inmutables desde el cliente:** se guardan en el servidor y solo se aceptan ediciones de la lista blanca, validadas de nuevo con zod.
- **`/metrics`:** protegido con `METRICS_TOKEN`.

## Rendimiento

| Etapa | Objetivo p50 |
| --- | --- |
| Contexto (caché) | < 5 ms |
| Parser + recuperación | < 40 ms |
| Jev nº 1 | ~300-600 ms |
| Herramientas | < 150 ms |
| Jev nº 2 | ~300 ms |
| Primer token del redactor | < 700 ms |

- **Caché de Jev:** clave `sha256(model + CATALOG_VERSION + state + preguntas)`, TTL de 10 min.
- **Embeddings del catálogo:** caché por organización. Se invalida cuando cambia la huella `count + max(created_at) + hash de nombres` de `products`.

## Riesgos y cómo se mitigan

- **Español en Jev:** A/B de idioma en la evaluación y umbrales calibrados con frases reales.
- **Borradores en memoria y varias réplicas:** con una sola réplica no hay problema. Si se escala, `store.ts` y `lru.ts` tienen interfaz para pasar a Redis.
- **Embeddings en línea:** si el proveedor cae, la búsqueda léxica difusa mantiene la resolución de productos, con menos recall.
