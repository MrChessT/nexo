# Parador Eventos: cobertura y alcance

## Contexto de negocio

Parador Eventos gestiona cuatro locales: Parador, Pickels, Vivero y La Oliva. El objetivo no es solo saber cuánto stock queda: es relacionar compras, gasto, consumo, mermas, horas, traspasos e ingresos para decidir dónde invertir y qué locales son rentables.

## Ya cubierto por el producto

- Organización multiempresa y usuarios con roles.
- Varios locales por organización.
- Catálogo común de productos, categorías, proveedores y formatos.
- Stock en unidad base y coste medio ponderado.
- Recepciones de mercancía y actualización de precios.
- Traspasos con estados, cantidades enviadas/recibidas y pérdida en tránsito.
- Mermas y ajustes mediante movimientos inmutables.
- Inventarios por zonas como orden de conteo.
- Informes de valoración, movimientos por día de negocio y pérdidas en traspasos.
- RLS, aislamiento de organizaciones e idempotencia como contratos de base de datos.

## Cubierto parcialmente

### Zonas físicas

La migración `0004_saldo_por_espacio.sql` añade `stock_area_balances` y la vista `v_stock_area_valuation`. El saldo agregado `local + producto` se conserva para compatibilidad, mientras que los movimientos con `area_id` actualizan también el saldo de `barra`, `almacén`, `cámara` u otras zonas. La base valida que el área pertenezca al local del movimiento.

Queda pendiente decidir la asignación de movimientos antiguos o sin área: seguirán contabilizando en el saldo agregado y no se repartirán automáticamente entre espacios.

### Pedidos

Hay recepción de mercancía, pero falta un ciclo completo de pedido: sugerencia, borrador, enviado a proveedor, confirmado, parcialmente recibido y cerrado.

### Informes económicos

Existe valoración de stock y consumo basado en movimientos. Faltan gastos no inventariables, inversión por local, presupuesto y margen/facturación.

## Pendiente de diseñar antes de implementar

### Personas y horas

Entidad de trabajador, turnos y tramos de trabajo imputables a uno o varios locales. Debe evitar solapes y permitir coste horario, centro de coste y aprobación.

### Gastos e inversión

Gasto con proveedor, categoría, local, fecha de negocio, importe neto/IVA/total, documento adjunto y estado de aprobación. La inversión debe distinguirse del gasto operativo y admitir amortización o proyecto cuando proceda.

### Elaboraciones y consumo

Recetas versionadas con ingredientes en unidad base, rendimiento, coste teórico y merma de elaboración. No se debe mezclar consumo teórico con consumo real hasta definir la futura integración TPV.

### Ventas y TPV

El núcleo actual no tiene ventas. La primera versión debe dejar un contrato de importación de ventas por local, periodo y producto vendible, sin crear una integración TPV prematura.

## Decisiones de producto

1. Las pantallas usarán el vocabulario del cliente: locales, barras, almacenes, proveedores, pedidos, mermas y traspasos.
2. Los datos de prueba de Parador Eventos alimentarán el modelo canónico, nunca tablas paralelas.
3. Cada bloque nuevo tendrá migración, permisos, validación de importes/cantidades y tests antes de exponerse en la interfaz.
4. No se presentará como "control de rentabilidad" hasta incorporar ingresos o una fuente de ventas; antes se denominará control de gasto, consumo y stock.
5. El siguiente diseño de esquema debe resolver primero saldo por espacio y después gastos/personal, antes de conectar datos de producción.
