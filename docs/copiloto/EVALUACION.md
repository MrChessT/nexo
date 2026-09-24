# Resultados de evaluación

Catálogo 2026-09-24.3 · modelo typesafe-ai/jev (ai-gateway) · 59 frases · 2026-09-24T16:07:05.680Z

## Por mensaje

| Resultado | Frases |
| --- | --- |
| Correcto | 54 (92 %) |
| Pregunta de más (seguro) | 5 (8 %) |
| Error sin escritura | 0 |
| **Error con borrador equivocado** | **0** |

## Por decisión (elección más probable de Jev)

| Decisión | Aciertos | Confianza media si acierta | Confianza media si falla |
| --- | --- | --- | --- |
| intent | 58/59 (98 %) | 0.96 | 0.54 |
| herramienta | 20/20 (100 %) | 0.95 | - |
| tipo_accion | 26/27 (96 %) | 0.99 | 0.56 |
| local | 25/25 (100 %) | 0.95 | - |
| local_destino | 3/3 (100 %) | 1.00 | - |
| producto | 26/26 (100 %) | 0.90 | - |
| periodo | 4/4 (100 %) | 1.00 | - |
| destino | 3/3 (100 %) | 1.00 | - |
| inyeccion | 59/59 (100 %) | - | - |

## Barrido de umbral para la intención

| Umbral act | Cobertura (actúa) | Precisión cuando actúa |
| --- | --- | --- |
| 0.5 | 100 % | 98 % |
| 0.6 | 97 % | 100 % |
| 0.7 | 95 % | 100 % |
| 0.8 | 92 % | 100 % |
| 0.9 | 88 % | 100 % |

## Detalle de lo que no fue «correcto»

| Frase | Resultado | Plan | Detalle |
| --- | --- | --- | --- |
| mermas de ayer en el Parador | pregunta | clarify | pregunta por intent |
| ¿cuadró el inventario del Parador? | pregunta | clarify | pregunta por herramienta |
| hazme la lista de la compra del Vivero | pregunta | clarify | pregunta por intent |
| invitación: 2 tónicas en Pickels | pregunta | clarify | pregunta por intent |
| Makro ha subido la tanqueray a 17,20 | pregunta | clarify | pregunta por intent |

Coste Jev de esta evaluación: 59 llamadas, 147128 tokens de entrada, ~0.006179 $.
