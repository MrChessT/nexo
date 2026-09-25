# Resultados de evaluación

Catálogo 2026-09-25.8 · modelo typesafe-ai/jev (ai-gateway) · 134 frases · 2026-09-24T23:56:02.807Z

## Por mensaje

| Resultado | Frases |
| --- | --- |
| Correcto | 113 (84 %) |
| Pregunta de más (seguro) | 18 (13 %) |
| Error sin escritura | 3 |
| **Error con borrador equivocado** | **0** |

## Por grupo de frases

| Grupo | Frases | Correcto | Pregunta de más | Error | Error con borrador |
| --- | --- | --- | --- | --- | --- |
| base | 64 | 95 % | 3 | 0 | 0 |
| dato | 12 | 67 % | 2 | 2 | 0 |
| natural | 33 | 76 % | 8 | 0 | 0 |
| jerga | 5 | 40 % | 3 | 0 | 0 |
| erratas | 4 | 100 % | 0 | 0 | 0 |
| excepcion | 8 | 88 % | 0 | 1 | 0 |
| fuera | 8 | 75 % | 2 | 0 | 0 |

## Por decisión (elección más probable de Jev)

| Decisión | Aciertos | Confianza media si acierta | Confianza media si falla | ECE |
| --- | --- | --- | --- | --- |
| intent | 130/134 (97 %) | 0.94 | 0.33 | 0.049 |
| herramienta | 50/53 (94 %) | 0.93 | 0.37 | 0.086 |
| tipo_accion | 53/57 (93 %) | 0.98 | 0.51 | 0.033 |
| local | 52/53 (98 %) | 0.95 | 0.69 | 0.035 |
| local_destino | 8/8 (100 %) | 1.00 | - | 0.001 |
| producto | 63/63 (100 %) | 0.87 | - | 0.130 |
| periodo | 7/7 (100 %) | 1.00 | - | 0.000 |
| destino | 5/5 (100 %) | 1.00 | - | 0.002 |
| dato | 23/25 (92 %) | 0.91 | 0.86 | 0.147 |
| inyeccion | 134/134 (100 %) | - | - | - |

ECE: diferencia media entre la confianza de Jev y su acierto real (0 = fiel; 0,1 = se desvía 10 puntos).

## Calibración: umbral de «actuar» por decisión y contexto

Recomendado = el umbral más bajo con el que no se habría actuado en ningún error de este conjunto, más 0,05 de margen. «revisar pregunta» = hay errores con confianza muy alta: el umbral no los evita, hay que mejorar la pregunta a Jev.

| Decisión | Contexto | Casos | Errores | Actual | Cobertura actual | Recomendado | Cobertura recomendada |
| --- | --- | --- | --- | --- | --- | --- | --- |
| intent | lectura (intent_lectura) | 72 | 4 | 0.60 | 89 % | 0.55 | 90 % |
| intent | escritura (intent_accion) | 62 | 0 | 0.85 | 89 % | 0.50 | 98 % |
| herramienta | lectura (herramienta) | 53 | 3 | 0.65 | 94 % | 0.60 | 94 % |
| tipo_accion | escritura (tipo_accion) | 57 | 4 | 0.90 | 86 % | 0.80 | 89 % |
| local | lectura (local_consulta) | 18 | 0 | 0.75 | 94 % | 0.50 | 100 % |
| local | escritura (local_borrador) | 35 | 1 | 0.90 | 83 % | 0.75 | 91 % |
| local_destino | escritura (local_borrador) | 8 | 0 | 0.90 | 100 % | 0.50 | 100 % |
| producto | lectura (producto_consulta) | 24 | 0 | 0.75 | 83 % | 0.50 | 96 % |
| producto | escritura (producto_borrador) | 39 | 0 | 0.92 | 67 % | 0.50 | 90 % |
| destino | lectura (destino) | 5 | 0 | 0.80 | 100 % | 0.50 | 100 % |
| dato | lectura (dato) | 25 | 2 | 0.60 | 88 % (2 err.) | revisar pregunta | - |

## Fiabilidad por tramo de confianza (todas las decisiones)

| Confianza | Casos | Acierto real | Confianza media |
| --- | --- | --- | --- |
| 0.00–0.50 | 20 | 60 % | 0.35 |
| 0.50–0.70 | 13 | 77 % | 0.62 |
| 0.70–0.85 | 28 | 93 % | 0.78 |
| 0.85–0.95 | 54 | 100 % | 0.90 |
| 0.95–1.00 | 290 | 100 % | 0.99 |

## Detalle de lo que no fue «correcto»

| Frase | Grupo | Resultado | Plan | Detalle |
| --- | --- | --- | --- | --- |
| mermas de ayer en el Parador | base | pregunta | clarify | pregunta por intent |
| hazme la lista de la compra del Vivero | base | pregunta | clarify | pregunta por intent |
| invitación: 2 tónicas en Pickels | base | pregunta | clarify | pregunta por intent (tipo_accion=ninguna) |
| ¿cuánta pasta tenemos metida en ron? | dato | error | consultar | dato=cantidad |
| ¿quién nos trae la tanqueray? | dato | error | conversar | intent=fuera_de_ambito, herramienta=query_orders |
| ¿cuál es el mínimo de tónica en pickels? | dato | pregunta | clarify | pregunta por intent (intent=proponer_accion) |
| ¿ha subido algo la coca? | dato | pregunta | clarify | pregunta por herramienta (herramienta=query_movements) |
| ¿se ha roto algo hoy? | natural | pregunta | clarify | pregunta por intent (intent=proponer_accion) |
| ¿nos ha llegado ya lo que mandó el parador? | natural | pregunta | clarify | pregunta por herramienta (herramienta=query_orders) |
| hemos invitado a 3 cocas en la oliva | natural | pregunta | clarify | pregunta por intent (tipo_accion=preparar_pedido) |
| mándale al vivero 2 cajas de agua desde el parador | natural | pregunta | clarify | pregunta por producto |
| nos han entregado 5 packs de agua en pickels | natural | pregunta | clarify | pregunta por producto |
| envía el pedido de bebidas del sur | natural | pregunta | clarify | pregunta por tipo_accion |
| ha llegado lo de distribuciones canarias | natural | pregunta | clarify | pregunta por intent (tipo_accion=recibir_traspaso) |
| hemos terminado de contar el pickels, ciérralo | natural | pregunta | clarify | pregunta por local (local=no_indicado) |
| tírame 1 bolsa de hielo del parador | jerga | pregunta | clarify | pregunta por tipo_accion |
| pásame 4 tónicas del pickels al parador | jerga | pregunta | clarify | pregunta por tipo_accion |
| porfa baja 2 limones pochos del vivero | jerga | pregunta | clarify | pregunta por tipo_accion (tipo_accion=traspaso) |
| no quiero pedir nada, solo saber qué hay de coca en el parador | excepcion | error | consultar | dato=general |
| enséñame los informes | fuera | pregunta | clarify | pregunta por intent (intent=consultar) |
| vamos a pedidos | fuera | pregunta | clarify | pregunta por intent |

Coste Jev de esta evaluación: 134 llamadas, 323110 tokens de entrada, ~0.013571 $.
