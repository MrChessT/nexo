# Resultados de evaluación

Catálogo 2026-09-24.2 · modelo typesafe-ai/jev (ai-gateway) · 54 frases · 2026-09-24T14:20:05.759Z

## Por mensaje

| Resultado | Frases |
| --- | --- |
| Correcto | 51 (94 %) |
| Pregunta de más (seguro) | 3 (6 %) |
| Error sin escritura | 0 |
| **Error con borrador equivocado** | **0** |

## Por decisión (elección más probable de Jev)

| Decisión | Aciertos | Confianza media si acierta | Confianza media si falla |
| --- | --- | --- | --- |
| intent | 54/54 (100 %) | 0.96 | - |
| herramienta | 19/19 (100 %) | 0.95 | - |
| tipo_accion | 22/23 (96 %) | 0.99 | 0.59 |
| local | 22/22 (100 %) | 0.97 | - |
| local_destino | 3/3 (100 %) | 1.00 | - |
| producto | 24/24 (100 %) | 0.89 | - |
| periodo | 4/4 (100 %) | 1.00 | - |
| destino | 3/3 (100 %) | 1.00 | - |
| inyeccion | 54/54 (100 %) | - | - |

## Barrido de umbral para la intención

| Umbral act | Cobertura (actúa) | Precisión cuando actúa |
| --- | --- | --- |
| 0.5 | 100 % | 100 % |
| 0.6 | 98 % | 100 % |
| 0.7 | 96 % | 100 % |
| 0.8 | 93 % | 100 % |
| 0.9 | 87 % | 100 % |

## Detalle de lo que no fue «correcto»

| Frase | Resultado | Plan | Detalle |
| --- | --- | --- | --- |
| mermas de ayer en el Parador | pregunta | clarify | pregunta por intent |
| invitación: 2 tónicas en Pickels | pregunta | clarify | pregunta por intent |
| Makro ha subido la tanqueray a 17,20 | pregunta | clarify | pregunta por intent |

Coste Jev de esta evaluación: 54 llamadas, 129956 tokens de entrada, ~0.005458 $.
