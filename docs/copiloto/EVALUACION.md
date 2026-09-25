# Resultados de evaluación

Catálogo 2026-09-25.9 · modelo typesafe-ai/jev (ai-gateway) · 134 frases · 2026-09-25T00:10:01.418Z

## Por mensaje

| Resultado | Frases |
| --- | --- |
| Correcto | 123 (92 %) |
| Pregunta de más (seguro) | 11 (8 %) |
| Error sin escritura | 0 |
| **Error con borrador equivocado** | **0** |

## Por grupo de frases

| Grupo | Frases | Correcto | Pregunta de más | Error | Error con borrador |
| --- | --- | --- | --- | --- | --- |
| base | 64 | 95 % | 3 | 0 | 0 |
| dato | 12 | 92 % | 1 | 0 | 0 |
| natural | 33 | 91 % | 3 | 0 | 0 |
| jerga | 5 | 40 % | 3 | 0 | 0 |
| erratas | 4 | 100 % | 0 | 0 | 0 |
| excepcion | 8 | 88 % | 1 | 0 | 0 |
| fuera | 8 | 100 % | 0 | 0 | 0 |

## Por decisión (elección más probable de Jev)

| Decisión | Aciertos | Confianza media si acierta | Confianza media si falla | ECE |
| --- | --- | --- | --- | --- |
| intent | 134/134 (100 %) | 0.97 | - | 0.032 |
| herramienta | 53/53 (100 %) | 0.95 | - | 0.052 |
| tipo_accion | 57/57 (100 %) | 0.98 | - | 0.022 |
| local | 52/53 (98 %) | 0.95 | 0.72 | 0.048 |
| local_destino | 8/8 (100 %) | 1.00 | - | 0.002 |
| producto | 63/63 (100 %) | 0.87 | - | 0.129 |
| periodo | 7/7 (100 %) | 1.00 | - | 0.000 |
| destino | 5/5 (100 %) | 1.00 | - | 0.002 |
| dato | 25/25 (100 %) | 0.89 | - | 0.109 |
| inyeccion | 134/134 (100 %) | - | - | - |

ECE: diferencia media entre la confianza de Jev y su acierto real (0 = fiel; 0,1 = se desvía 10 puntos).

## Calibración: umbral de «actuar» por decisión y contexto

Recomendado = el umbral más bajo con el que no se habría actuado en ningún error de este conjunto, más 0,05 de margen. «revisar pregunta» = hay errores con confianza muy alta: el umbral no los evita, hay que mejorar la pregunta a Jev.

| Decisión | Contexto | Casos | Errores | Actual | Cobertura actual | Recomendado | Cobertura recomendada |
| --- | --- | --- | --- | --- | --- | --- | --- |
| intent | lectura (intent_lectura) | 72 | 0 | 0.60 | 97 % | 0.50 | 97 % |
| intent | escritura (intent_accion) | 62 | 0 | 0.75 | 100 % | 0.50 | 100 % |
| herramienta | lectura (herramienta) | 53 | 0 | 0.65 | 100 % | 0.50 | 100 % |
| tipo_accion | escritura (tipo_accion) | 57 | 0 | 0.85 | 96 % | 0.50 | 100 % |
| local | lectura (local_consulta) | 18 | 0 | 0.65 | 94 % | 0.50 | 94 % |
| local | escritura (local_borrador) | 35 | 1 | 0.85 | 86 % | 0.80 | 89 % |
| local_destino | escritura (local_borrador) | 8 | 0 | 0.85 | 100 % | 0.50 | 100 % |
| producto | lectura (producto_consulta) | 24 | 0 | 0.65 | 92 % | 0.50 | 96 % |
| producto | escritura (producto_borrador) | 39 | 0 | 0.85 | 79 % | 0.50 | 87 % |
| destino | lectura (destino) | 5 | 0 | 0.80 | 100 % | 0.50 | 100 % |
| dato | lectura (dato) | 25 | 0 | 0.60 | 88 % | 0.50 | 92 % |

## Fiabilidad por tramo de confianza (todas las decisiones)

| Confianza | Casos | Acierto real | Confianza media |
| --- | --- | --- | --- |
| 0.00–0.50 | 11 | 100 % | 0.39 |
| 0.50–0.70 | 9 | 100 % | 0.63 |
| 0.70–0.85 | 18 | 94 % | 0.77 |
| 0.85–0.95 | 60 | 100 % | 0.91 |
| 0.95–1.00 | 307 | 100 % | 0.99 |

## Detalle de lo que no fue «correcto»

| Frase | Grupo | Resultado | Plan | Detalle |
| --- | --- | --- | --- | --- |
| mermas de ayer en el Parador | base | pregunta | clarify | pregunta por intent |
| hazme la lista de la compra del Vivero | base | pregunta | clarify | pregunta por intent |
| invitación: 2 tónicas en Pickels | base | pregunta | clarify | pregunta por producto |
| ¿cuál es el mínimo de tónica en pickels? | dato | pregunta | clarify | pregunta por producto |
| mándale al vivero 2 cajas de agua desde el parador | natural | pregunta | clarify | pregunta por producto |
| nos han entregado 5 packs de agua en pickels | natural | pregunta | clarify | pregunta por producto |
| hemos terminado de contar el pickels, ciérralo | natural | pregunta | clarify | pregunta por local (local=no_indicado) |
| tírame 1 bolsa de hielo del parador | jerga | pregunta | clarify | pregunta por tipo_accion |
| pásame 4 tónicas del pickels al parador | jerga | pregunta | clarify | pregunta por producto |
| porfa baja 2 limones pochos del vivero | jerga | pregunta | clarify | pregunta por tipo_accion |
| no es una merma, es un traspaso: 2 cocas del parador al vivero | excepcion | pregunta | clarify | pregunta por producto |

Coste Jev de esta evaluación: 134 llamadas, 349615 tokens de entrada, ~0.014684 $.
