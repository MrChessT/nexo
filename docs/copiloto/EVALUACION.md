# Resultados de evaluación

Catálogo 2026-09-26.2 · modelo typesafe-ai/jev (ai-gateway) · 215 frases · 2026-09-25T08:33:11.692Z

Latencia de la llamada nº 1: mediana 336 ms · p90 24414 ms · máxima 65072 ms.

## Por mensaje

| Resultado | Frases |
| --- | --- |
| Correcto | 196 (91 %) |
| Pregunta de más (seguro) | 16 (7 %) |
| Error sin escritura | 2 |
| **Error con borrador equivocado** | **1** |

## Por grupo de frases

| Grupo | Frases | Correcto | Pregunta de más | Error | Error con borrador |
| --- | --- | --- | --- | --- | --- |
| base | 64 | 97 % | 2 | 0 | 0 |
| dato | 12 | 83 % | 2 | 0 | 0 |
| natural | 33 | 91 % | 3 | 0 | 0 |
| jerga | 5 | 40 % | 3 | 0 | 0 |
| erratas | 4 | 75 % | 0 | 1 | 0 |
| excepcion | 8 | 88 % | 1 | 0 | 0 |
| fuera | 8 | 100 % | 0 | 0 | 0 |
| operaciones | 21 | 86 % | 2 | 1 | 0 |
| consumo | 2 | 100 % | 0 | 0 | 0 |
| encargado | 58 | 93 % | 3 | 0 | 1 |

## Por decisión (elección más probable de Jev)

| Decisión | Aciertos | Confianza media si acierta | Confianza media si falla | ECE |
| --- | --- | --- | --- | --- |
| intent | 215/215 (100 %) | 0.97 | - | 0.035 |
| herramienta | 80/80 (100 %) | 0.96 | - | 0.044 |
| tipo_accion | 101/103 (98 %) | 0.98 | 0.51 | 0.021 |
| local | 91/93 (98 %) | 0.95 | 0.65 | 0.034 |
| local_destino | 15/15 (100 %) | 1.00 | - | 0.004 |
| producto | 101/103 (98 %) | 0.88 | 0.23 | 0.118 |
| periodo | 13/13 (100 %) | 1.00 | - | 0.000 |
| destino | 6/6 (100 %) | 1.00 | - | 0.005 |
| dato | 34/35 (97 %) | 0.93 | 0.43 | 0.052 |
| inyeccion | 215/215 (100 %) | - | - | - |

ECE: diferencia media entre la confianza de Jev y su acierto real (0 = fiel; 0,1 = se desvía 10 puntos).

## Calibración: umbral de «actuar» por decisión y contexto

Recomendado = el umbral más bajo con el que no se habría actuado en ningún error de este conjunto, más 0,05 de margen. «revisar pregunta» = hay errores con confianza muy alta: el umbral no los evita, hay que mejorar la pregunta a Jev.

| Decisión | Contexto | Casos | Errores | Actual | Cobertura actual | Recomendado | Cobertura recomendada |
| --- | --- | --- | --- | --- | --- | --- | --- |
| intent | lectura (intent_lectura) | 104 | 0 | 0.60 | 97 % | 0.50 | 98 % |
| intent | escritura (intent_accion) | 111 | 0 | 0.75 | 98 % | 0.50 | 99 % |
| herramienta | lectura (herramienta) | 80 | 0 | 0.65 | 99 % | 0.50 | 100 % |
| tipo_accion | escritura (tipo_accion) | 103 | 2 | 0.85 | 95 % | 0.70 | 97 % |
| local | lectura (local_consulta) | 32 | 0 | 0.65 | 97 % | 0.50 | 100 % |
| local | escritura (local_borrador) | 61 | 2 | 0.85 | 84 % | 0.75 | 89 % |
| local_destino | escritura (local_borrador) | 15 | 0 | 0.85 | 100 % | 0.50 | 100 % |
| producto | lectura (producto_consulta) | 40 | 2 | 0.65 | 88 % | 0.50 | 93 % |
| producto | escritura (producto_borrador) | 63 | 0 | 0.85 | 76 % | 0.50 | 90 % |
| destino | lectura (destino) | 6 | 0 | 0.80 | 100 % | 0.50 | 100 % |
| dato | lectura (dato) | 35 | 1 | 0.60 | 91 % | 0.55 | 91 % |

## Fiabilidad por tramo de confianza (todas las decisiones)

| Confianza | Casos | Acierto real | Confianza media |
| --- | --- | --- | --- |
| 0.00–0.50 | 15 | 73 % | 0.38 |
| 0.50–0.70 | 20 | 85 % | 0.60 |
| 0.70–0.85 | 33 | 100 % | 0.78 |
| 0.85–0.95 | 85 | 100 % | 0.91 |
| 0.95–1.00 | 510 | 100 % | 0.99 |

## Detalle de lo que no fue «correcto»

| Frase | Grupo | Resultado | Plan | Detalle |
| --- | --- | --- | --- | --- |
| mermas de ayer en el Parador | base | pregunta | clarify | pregunta por intent |
| invitación: 2 tónicas en Pickels | base | pregunta | clarify | pregunta por producto |
| ¿cuál es el mínimo de tónica en pickels? | dato | pregunta | clarify | pregunta por producto (producto=ninguno) |
| ¿ha subido algo la coca? | dato | pregunta | clarify | pregunta por herramienta |
| mándale al vivero 2 cajas de agua desde el parador | natural | pregunta | clarify | pregunta por producto |
| nos han entregado 5 packs de agua en pickels | natural | pregunta | clarify | pregunta por producto |
| hemos terminado de contar el pickels, ciérralo | natural | pregunta | clarify | pregunta por local (local=no_indicado) |
| tírame 1 bolsa de hielo del parador | jerga | pregunta | clarify | pregunta por tipo_accion |
| pásame 4 tónicas del pickels al parador | jerga | pregunta | clarify | pregunta por producto |
| porfa baja 2 limones pochos del vivero | jerga | pregunta | clarify | pregunta por tipo_accion |
| cuanto varcelo queda en paradro | erratas | error | consultar | dato=valor |
| no es una merma, es un traspaso: 2 cocas del parador al vivero | excepcion | pregunta | clarify | pregunta por producto |
| ya tenemos aquí lo que mandó Pickels, dale entrada | operaciones | pregunta | clarify | pregunta por tipo_accion (tipo_accion=recibir_pedido) |
| ficha del Barceló | operaciones | pregunta | clarify | pregunta por intent |
| oye y de agua como vamos en la oliva | operaciones | error | consultar | producto=ninguno |
| caducaron 3 packs de agua en la oliva | encargado | pregunta | clarify | pregunta por tipo_accion |
| invita la casa a 2 tónicas en el parador | encargado | pregunta | clarify | pregunta por producto |
| ya ha llegado lo que mandó el vivero | encargado | error_peligroso | documento | local=no_indicado |
| ¿cómo hago un traspaso? | encargado | pregunta | clarify | pregunta por intent |

Coste Jev de esta evaluación: 215 llamadas, 600534 tokens de entrada, ~0.025222 $.
