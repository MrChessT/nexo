# Resultados de evaluación

Catálogo 2026-09-26.4 · modelo typesafe-ai/jev (ai-gateway) · 215 frases · 2026-09-25T08:54:00.828Z

Latencia de la llamada nº 1: mediana 340 ms · p90 30375 ms · máxima 64603 ms.

## Por mensaje

| Resultado | Frases |
| --- | --- |
| Correcto | 204 (95 %) |
| Pregunta de más (seguro) | 9 (4 %) |
| Error sin escritura | 2 |
| **Error con borrador equivocado** | **0** |

## Por grupo de frases

| Grupo | Frases | Correcto | Pregunta de más | Error | Error con borrador |
| --- | --- | --- | --- | --- | --- |
| base | 64 | 92 % | 5 | 0 | 0 |
| dato | 12 | 92 % | 0 | 1 | 0 |
| natural | 33 | 85 % | 4 | 1 | 0 |
| jerga | 5 | 100 % | 0 | 0 | 0 |
| erratas | 4 | 100 % | 0 | 0 | 0 |
| excepcion | 8 | 100 % | 0 | 0 | 0 |
| fuera | 8 | 100 % | 0 | 0 | 0 |
| operaciones | 21 | 100 % | 0 | 0 | 0 |
| consumo | 2 | 100 % | 0 | 0 | 0 |
| encargado | 58 | 100 % | 0 | 0 | 0 |

## Por decisión (elección más probable de Jev)

| Decisión | Aciertos | Confianza media si acierta | Confianza media si falla | ECE |
| --- | --- | --- | --- | --- |
| intent | 215/215 (100 %) | 0.96 | - | 0.035 |
| herramienta | 80/80 (100 %) | 0.97 | - | 0.035 |
| tipo_accion | 102/103 (99 %) | 0.96 | 0.63 | 0.036 |
| local | 93/93 (100 %) | 0.97 | - | 0.028 |
| local_destino | 15/15 (100 %) | 1.00 | - | 0.003 |
| producto | 103/103 (100 %) | 0.87 | - | 0.127 |
| periodo | 13/13 (100 %) | 1.00 | - | 0.000 |
| destino | 6/6 (100 %) | 1.00 | - | 0.005 |
| dato | 33/35 (94 %) | 0.95 | 0.45 | 0.040 |
| inyeccion | 215/215 (100 %) | - | - | - |

ECE: diferencia media entre la confianza de Jev y su acierto real (0 = fiel; 0,1 = se desvía 10 puntos).

## Calibración: umbral de «actuar» por decisión y contexto

Recomendado = el umbral más bajo con el que no se habría actuado en ningún error de este conjunto, más 0,05 de margen. «revisar pregunta» = hay errores con confianza muy alta: el umbral no los evita, hay que mejorar la pregunta a Jev.

| Decisión | Contexto | Casos | Errores | Actual | Cobertura actual | Recomendado | Cobertura recomendada |
| --- | --- | --- | --- | --- | --- | --- | --- |
| intent | lectura (intent_lectura) | 104 | 0 | 0.60 | 97 % | 0.50 | 98 % |
| intent | escritura (intent_accion) | 111 | 0 | 0.75 | 98 % | 0.50 | 99 % |
| herramienta | lectura (herramienta) | 80 | 0 | 0.65 | 100 % | 0.50 | 100 % |
| tipo_accion | escritura (tipo_accion) | 103 | 1 | 0.85 | 87 % | 0.70 | 97 % |
| local | lectura (local_consulta) | 32 | 0 | 0.65 | 100 % | 0.50 | 100 % |
| local | escritura (local_borrador) | 61 | 0 | 0.85 | 92 % | 0.50 | 100 % |
| local_destino | escritura (local_borrador) | 15 | 0 | 0.85 | 100 % | 0.50 | 100 % |
| producto | lectura (producto_consulta) | 40 | 0 | 0.65 | 90 % | 0.50 | 95 % |
| producto | escritura (producto_borrador) | 63 | 0 | 0.85 | 78 % | 0.50 | 92 % |
| destino | lectura (destino) | 6 | 0 | 0.80 | 100 % | 0.50 | 100 % |
| dato | lectura (dato) | 35 | 2 | 0.60 | 89 % | 0.55 | 89 % |

## Fiabilidad por tramo de confianza (todas las decisiones)

| Confianza | Casos | Acierto real | Confianza media |
| --- | --- | --- | --- |
| 0.00–0.50 | 13 | 85 % | 0.37 |
| 0.50–0.70 | 16 | 94 % | 0.60 |
| 0.70–0.85 | 36 | 100 % | 0.79 |
| 0.85–0.95 | 77 | 100 % | 0.90 |
| 0.95–1.00 | 521 | 100 % | 0.99 |

## Detalle de lo que no fue «correcto»

| Frase | Grupo | Resultado | Plan | Detalle |
| --- | --- | --- | --- | --- |
| han llegado 3 cajas de coca a 13,50 € en Parador | base | pregunta | clarify | pregunta por tipo_accion |
| recibido el pedido de Distribuciones Canarias en Parador: 2 cajas de barceló | base | pregunta | clarify | pregunta por tipo_accion |
| entran 4 sacos de limones en el Vivero | base | pregunta | clarify | pregunta por tipo_accion |
| prepara el pedido de la semana para Parador | base | pregunta | clarify | pregunta por tipo_accion |
| haz el pedido del finde para el Vivero | base | pregunta | clarify | pregunta por tipo_accion |
| ¿cuánta pasta tenemos metida en ron? | dato | error | consultar | dato=cantidad |
| tenemos limones? | natural | error | consultar | dato=general |
| acaban de traer 2 cajas de brugal al parador | natural | pregunta | clarify | pregunta por tipo_accion |
| nos han entregado 5 packs de agua en pickels | natural | pregunta | clarify | pregunta por tipo_accion |
| prepárame el pedido para la oliva | natural | pregunta | clarify | pregunta por tipo_accion |
| ha llegado lo de distribuciones canarias | natural | pregunta | clarify | pregunta por intent |

Coste Jev de esta evaluación: 215 llamadas, 619181 tokens de entrada, ~0.026006 $.
