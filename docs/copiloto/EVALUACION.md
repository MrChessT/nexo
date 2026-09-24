# Resultados de evaluación

Catálogo 2026-09-25.7 · modelo typesafe-ai/jev (ai-gateway) · 64 frases · 2026-09-24T22:53:03.280Z

## Por mensaje

| Resultado | Frases |
| --- | --- |
| Correcto | 62 (97 %) |
| Pregunta de más (seguro) | 2 (3 %) |
| Error sin escritura | 0 |
| **Error con borrador equivocado** | **0** |

## Por decisión (elección más probable de Jev)

| Decisión | Aciertos | Confianza media si acierta | Confianza media si falla |
| --- | --- | --- | --- |
| intent | 64/64 (100 %) | 0.95 | - |
| herramienta | 25/25 (100 %) | 0.94 | - |
| tipo_accion | 26/27 (96 %) | 0.98 | 0.52 |
| local | 25/25 (100 %) | 0.96 | - |
| local_destino | 3/3 (100 %) | 1.00 | - |
| producto | 26/26 (100 %) | 0.90 | - |
| periodo | 4/4 (100 %) | 1.00 | - |
| destino | 3/3 (100 %) | 1.00 | - |
| inyeccion | 64/64 (100 %) | - | - |

## Barrido de umbral para la intención

| Umbral act | Cobertura (actúa) | Precisión cuando actúa |
| --- | --- | --- |
| 0.5 | 98 % | 100 % |
| 0.6 | 98 % | 100 % |
| 0.7 | 95 % | 100 % |
| 0.8 | 92 % | 100 % |
| 0.9 | 84 % | 100 % |

## Detalle de lo que no fue «correcto»

| Frase | Resultado | Plan | Detalle |
| --- | --- | --- | --- |
| hazme la lista de la compra del Vivero | pregunta | clarify | pregunta por intent |
| invitación: 2 tónicas en Pickels | pregunta | clarify | pregunta por intent |

Coste Jev de esta evaluación: 64 llamadas, 144189 tokens de entrada, ~0.006056 $.
