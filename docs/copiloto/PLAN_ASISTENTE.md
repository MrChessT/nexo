# Plan: asistente para hacerlo (casi) todo desde el chat

Objetivo: que cualquier tarea diaria del inventario se pueda hacer hablando con el asistente, que
entienda bien a la primera, que pregunte solo lo que de verdad falta y que responda claro, sin ser
más lento que ahora (una llamada a Jev para decidir y, como mucho, otra para comprobar).

## Diagnóstico (septiembre 2026)

| Área | Estado | Problema |
| --- | --- | --- |
| Confianza | Un umbral fijo por decisión (`local_borrador`, `producto_consulta`…) | No depende de la operación: el espacio o el periodo pesan igual aunque no importen; un local escrito tal cual en el mensaje exige la misma seguridad que uno supuesto. |
| Preguntas a Jev | Todas en una llamada, siempre | Se preguntan periodo y motivo aunque el mensaje no hable de fechas ni de roturas: más tokens y más latencia, y respuestas que luego «meten ruido». |
| Salida | Texto con viñetas + chips con porcentajes | Los chips técnicos (Intención 100 %, Espacio 54 %) confunden; los resultados largos son un bloque de texto; el borrador edita cantidades en ml. |
| Cobertura | 8 consultas, 9 operaciones | No se puede: recibir o cancelar traspasos, enviar/recibir/cancelar pedidos, abrir un inventario ni apuntar recuentos, preguntar por un producto concreto (formatos, precio, proveedor), consumo por producto. |
| Medición | Batería sin Jev (78 frases) y conversaciones simuladas (24 turnos) | Sin clave de Jev no se miden sus decisiones reales. |

## Etapas

### Etapa 1 · Confianza según el contexto (política por operación)
- Una **política** por contexto (`consulta:query_stock`, `accion:traspaso`, `accion:cambiar_precio`…)
  dice qué datos son **requeridos**, **opcionales** o **irrelevantes**, y el **riesgo** (lectura,
  escritura, crítica).
- El umbral de cada dato sale del riesgo del contexto, no del dato: el mismo «local» exige 0,75 en
  una consulta, 0,9 en una merma y 0,95 al cerrar un inventario.
- **Evidencia literal**: si el mensaje nombra el local o el producto tal cual («del Parador al
  Vivero», «beefeater»), basta menos seguridad de Jev (la palabra está ahí). Nunca en operaciones
  críticas.
- Lo **irrelevante** ni se evalúa, ni se enseña, ni provoca preguntas (espacio en un traspaso,
  periodo en el stock, local en un cambio de precio, motivo fuera de las mermas).
- Preguntas a Jev **según las pistas del mensaje**: periodo solo si habla de fechas, motivo solo si
  habla de roturas/caducidad/invitación, local solo si hay más de un local. Menos tokens, menos
  latencia.

### Etapa 2 · Salida limpia
- En lugar de chips con porcentajes, una línea «Entendido: Traspaso · Parador → Vivero · Larios 12».
  El detalle con porcentajes, plegado («¿Por qué?»). Lo dudoso se marca en naranja.
- Resultados de consulta como lista estructurada (producto, cantidad, local), con totales arriba y
  «ver más», en lugar de un bloque de texto.
- Borradores: cantidades en botellas/cajas, también al editarlas.

### Etapa 3 · Cobertura: hacerlo todo desde el chat
- Traspasos: **recibir** («ha llegado el traspaso del Parador») y **cancelar**.
- Pedidos: **enviar** («manda el pedido de Makro»), **recibir** («ha llegado el pedido de Makro»),
  **cancelar**.
- Inventarios: **abrir** («empieza el inventario del Vivero») y **apuntar recuentos** («en la barra
  hay 5 botellas de Beefeater»).
- Consultas nuevas: **ficha de producto** (formatos, proveedor, último precio, stock por local) y
  **consumo por producto** («¿qué es lo que más se gasta?»).

### Etapa 4 · Rendimiento
- Menos candidatos de producto cuando uno destaca (hoy 20 por fragmento): menos tokens por llamada.
- Sin segunda llamada a Jev cuando no aporta (pocas filas, nada que valorar).
- Medir latencia por etapa (ya existe `StageTimer`) en las conversaciones de prueba.

### Etapa 5 · Validar con Jev real (necesita `TYPESAFE_API_KEY` o `AI_GATEWAY_API_KEY`)
- `npm run copiloto:conversaciones -- --real` y `npm run copiloto:eval` con los casos nuevos.
- Ajustar los umbrales de cada contexto con esos datos.

## Estado (25/09/2026, etapa 5 revisada con Jev real)

| Etapa | Estado | Qué quedó hecho |
| --- | --- | --- |
| 1 · Confianza por contexto | Hecha | `gates/policy.ts` (18 contextos), evidencia literal, lo irrelevante fuera, preguntas a Jev según pistas del mensaje. |
| 2 · Salida limpia | Hecha | Línea «Entendido» + «¿Por qué?», evento `table`, borradores en botellas/cajas, sin gráficas repetidas. |
| 3 · Cobertura | Hecha | Recibir/cancelar traspasos; enviar/recibir/cancelar pedidos; abrir inventario y apuntar recuentos; ficha de producto. Pendiente: consumo por producto («¿qué es lo que más se gasta?»). |
| 4 · Rendimiento | Hecha | Llamada a Jev un 17 % más pequeña de media (8.537 → 7.069 caracteres): candidatos 5,9 → 2,4 por mensaje y sin ruido de búsqueda; pantalla y seguimiento solo cuando hacen falta. |
| 5 · Jev real | Hecha | Jev real por Vercel AI Gateway (`typesafe-ai/jev`). Conversaciones 19/27 → 27/27 y evaluación 94 % → 97 % (0 errores, 0 borradores equivocados). Arreglos: coherencia con la cantidad tal como se pidió («100 ud (= 4 cajas + 4 ud)»: 0,14 → 0,93); fragmentos sin nombre de local («6 cocas», no «6 cocas de Parador»); intención corroborada por una operación clarísima («ha llegado el traspaso del Parador»: 0,66 + recibir_traspaso 0,99 → borrador); «tira» es merma (recepción 0,34 → merma 1,00); recibir pedido/traspaso = el documento entero, sin productos (recepción con precio 0,68 → 1,00); una pregunta nueva no se pega a la orden abierta. Pendiente: «quita unas cocas» queda en el borde del umbral (merma 0,90-0,93) y varía entre ejecuciones. |
| 6 · Respuestas legibles y rápidas | Hecha | Botones para seguir tras cada consulta («Precios», «Consumo del mes», «Ficha», «Qué reponer», «Preparar pedido») que responden sin Jev; vía rápida sin Jev para «¿cuánto X queda?»; tabla antes que la gráfica y gráfica + valoración en paralelo; «Entendido» solo al preguntar; sin texto repetido junto al borrador; ficha en varias líneas; movimientos resumidos en € por tipo; último precio conocido de un producto aunque sea anterior al periodo. |

## Cómo se mide cada etapa
- `npm test` (incluye la batería con el catálogo real y las conversaciones simuladas).
- Cada etapa añade casos a `src/copiloto/eval/conversaciones.json` y a `bateria.jsonl`.
- Con Jev real: `docs/copiloto/CONVERSACIONES.md` y `docs/copiloto/EVALUACION.md`.
