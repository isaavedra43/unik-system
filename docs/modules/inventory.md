# Inventario progresivo (`src/modules/inventory/`)

UNIK lleva su propio libro de existencias por artículo, bodega, ubicación, variante y contenedor, **sin depender de
que Zoho tenga el inventario correcto**. La confianza se gana contando: lo que nadie ha contado no se promete; lo
contado una vez se promete sólo con una decisión humana; lo contado bien dos veces se promete solo. Las existencias
de Zoho se muestran como referencia, nunca deciden.

Estado: implementado y validado localmente (FakePrisma con emulación de candados y escenarios contra PostgreSQL real).
Migración `20260916130000_add_inventory_logistics_core` **no aplicada** en producción. Flag `inventory` de la
configuración de operaciones (ver [operaciones](./operations.md)).

## Modelos

| Modelo                          | Para qué                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Warehouse`                     | Bodega; una por ubicación de Zoho vista en órdenes de venta o «Bodega principal». `zohoLocationId` único.                                           |
| `StorageLocation`               | Ubicación (`rack`, `bin`, `floor`, `yard`, `virtual`); cada bodega tiene `GENERAL` y, a demanda, `SCRAP`.                                           |
| `ProductInventoryProfile`       | Unidad base, conversiones, tolerancia (2 %), política de rastreo, ejes de variante, fuente por defecto y **confianza**.                             |
| `StockItem`                     | Contadores por artículo/bodega/ubicación/variante/contenedor.                                                                                       |
| `StockMovement`                 | Movimiento inmutable (`baseline`, `receipt`, `issue`, `transfer_in`, `transfer_out`, `adjust`, `consume`, `produce`, `return`, `block`, `unblock`). |
| `StockReservation`              | Reserva de un expediente (`active`, `released`, `consumed`, `expired`) con la confianza al reservar.                                                |
| `StockCount` / `StockCountLine` | Conteos `spot`, `cycle`, `full` (`draft`, `in_progress`, `closed`, `cancelled`); líneas `pending`, `accepted`, `adjusted`, `disputed`.              |
| `LegacyCommitmentClaim`         | Compromiso anterior al corte (`claimed`, `confirmed`, `released`, `expired`).                                                                       |

Las cantidades de líneas de conteo y reclamos se guardan en la unidad base; la cantidad y unidad capturadas viajan en
el evento. Las transferencias suman a `receipts`/`issued` (el tipo de movimiento conserva la distinción).

## Reglas puras (`stock-math.ts`, `variant-key.ts`)

- `known = baseline + receipts + returns + produced − issued − consumed + adjustments`
- `available = known − reserved − blocked − assignedToProduction − reclamos legados`
- Conversión de unidades con redondeo por unidad; `StockMathError('invalid_unit')` sin conversión.
- **Promesa** (`evaluateReservation`): `CONTROLLED` se promete automáticamente; `PROVISIONAL` sólo con decisión
  humana explícita (`allowProvisional`, actor `user`) y verificación de hace ≤ `provisionalVerificationMaxHours`
  (72 h); `UNCOUNTED` y `DISPUTED` nunca.
- **Conteo** (`evaluateCountClose`): `UNCOUNTED` → movimiento `baseline` y `PROVISIONAL`; diferencia dentro de
  tolerancia → ajuste (con `inventory.adjust`, o línea pendiente + trabajo de aprobación) y contador de conteos buenos;
  dos conteos buenos seguidos → `CONTROLLED`; fuera de tolerancia → `DISPUTED` con incidencia `count_dispute` y
  trabajo de seguimiento. Resolver la disputa regresa a `PROVISIONAL`.
- Llaves canónicas de variante (`color=gris|medida=60x60`) validadas contra los ejes del perfil.

## Candados (`inventory-locks.ts`)

`SELECT … FOR UPDATE` dentro de la transacción del comando, en orden de id: renglones de existencia (por artículo,
bodega y variante), conteo y perfil. Dos personas nunca reservan las mismas unidades: la segunda transacción espera
al commit de la primera y, en READ COMMITTED, ve los contadores ya comprometidos y se rechaza con
`insufficient_stock`. Validado contra PostgreSQL real con transacciones concurrentes (con los candados desactivados la
prueba falla: ambas reservas pasan). `CONTROLLED` nunca queda negativo.

## Servicios

- `warehouses-service.ts`: `ensureDefaultWarehouse` (seguro ante arranques simultáneos), `resolveWarehouseForZohoLocation`,
  ubicaciones `GENERAL`/`SCRAP`, altas y cambios.
- `profiles-service.ts`: perfil al primer uso (unidad de `Product.unit` o `pz`); la unidad base se congela en cuanto
  hay movimientos, reservas, reclamos o partidas de expedientes abiertos.
- `inventory-service.ts`: `verifyAvailability`, `recordInventoryMovement` (todas las clases; transferencia = salida +
  entrada), `reserveStock` (bajo el candado del grupo, cuenta reclamos), `releaseReservation`, `consumeReservation`
  (parcial deja el resto reservado), bloqueo/desbloqueo, contenedores, snapshot.
- `stock-count-service.ts`: iniciar, capturar líneas, cerrar, cancelar, decidir ajustes pendientes y resolver disputas.
- `legacy-claims-service.ts`: reclamar, confirmar (se vuelve reserva del expediente en la misma decisión serializada;
  se rechaza con `demand_over_reserved` si la necesidad ya tiene reservada su existencia), liberar, vencer.
- Toda reserva (`stock.reserve`, motor, reclamos) respeta `assertReservationCapacity`: nunca más de lo que la
  necesidad aún requiere ni de la cantidad de su asignación (`demand_over_reserved`). La merma no se traspasa y una
  salida sin reserva que deja reservas sin cobertura abre incidencia alta.
- `labels-service.ts`: folios `RL-`/`PL-`/`CT-` de `Sequence`, QR `unik:stock:{id}` y `unik:loc:{id}`, resolución de
  escaneo.
- `delivery-consumption.ts`: al registrar una entrega (gancho `onDeliveryRecorded` de logística, misma transacción)
  consume las reservas de cada asignación entregada con movimiento `issue` referido a la orden de entrega. Un rechazo
  de inventario no deshace lo entregado: abre `stock_conflict` para Inventario.
- `inventory-queries.ts`: listas paginadas para la UI (todas exigen `inventory.view` en servidor).

## Comandos (`inventory-commands.ts`)

| Tipo                                                                                                          | Permiso              |
| ------------------------------------------------------------------------------------------------------------- | -------------------- |
| `stock.count.start`, `stock.count.line`                                                                       | `inventory.count`    |
| `stock.count.close`, `stock.count.cancel` (versionados)                                                       | `inventory.count`    |
| `stock.count.decide_adjustment`, `stock.count.resolve_dispute`                                                | `inventory.adjust`   |
| `stock.reserve`, `stock.release`                                                                              | `inventory.reserve`  |
| `stock.consume`, `stock.move` (receipt, return, produce, issue, consume, transfer), `stock.container.create`  | `inventory.manage`   |
| `stock.adjust`, `stock.block`, `stock.unblock`                                                                | `inventory.adjust`   |
| `stock.claim_legacy`, `stock.confirm_legacy`, `stock.release_legacy`                                          | `inventory.reserve`  |
| `stock.expire_legacy`                                                                                         | sistema (supervisor) |
| `profile.ensure`, `profile.update` (versionado)                                                               | `inventory.manage`   |
| `location.create`, `location.update`, `warehouse.create`, `warehouse.update`, `warehouse.sync_zoho_locations` | `inventory.manage`   |

Todos exigen el flag `inventory` (`module_disabled` si está apagado). Envoltorios `fn(actor, input, {commandId,
expectedVersion, deviceId, occurredAt})`; `expireDueLegacyClaims({now})` para el supervisor. El consumo de reservas
que dispara una entrega no pasa por `stock.consume`: corre dentro del comando de logística.

## Eventos

Canónicos del núcleo (`stock.counted`, `stock.reserved`, `stock.reserved_provisional`, `stock.released`,
`stock.received`, `stock.issued`, `stock.adjusted`, `stock.transferred`) y propios: `stock.baseline`,
`stock.returned`, `stock.produced`, `stock.consumed`, `stock.blocked`, `stock.unblocked`,
`stock.reservation_consumed`, `stock.controlled`, `stock.count_started|closed|cancelled|disputed`,
`stock.adjustment_pending|decided`, `stock.dispute_line_resolved`, `stock.dispute_resolved`, `stock.negative`,
`stock.container_created`, `stock.legacy_claimed|confirmed|released|expired`, `inventory.profile_updated`,
`inventory.warehouse_created|updated`, `inventory.location_created|updated`. Se publican en `area:inventario` y en
`case:{id}` cuando hay expediente. `stock.reserved` y `stock.controlled` despiertan el avance de los expedientes.

## Permisos

`inventory.view` (consultar), `inventory.count` (contar), `inventory.adjust` (ajustar, decidir diferencias y
disputas), `inventory.reserve` (reservar y reclamos), `inventory.manage` (bodegas, ubicaciones, perfiles, movimientos).

## Errores

`insufficient_stock`, `stock_uncounted`, `stock_disputed`, `provisional_not_allowed`, `provisional_verification_stale`,
`duplicate`, `module_disabled`, `empty_count`, `legacy_claim_expired`, `negative_stock` (409);
`provisional_requires_human` (403); `invalid_quantity`, `invalid_unit`, `invalid_variant` (422). Están en
`OPERATIONS_ERROR_HTTP_STATUS` y en `inventoryHttpStatus(code)`.

## Integración con los demás módulos

- **Expediente:** `verifyAvailability` decide si la necesidad requiere conteo (`requiresCount`) y si se puede
  prometer; el motor reserva con `reserveStock` y guarda `DemandAllocation.stockReservationId`.
- **Compras (entrega 3):** recepción con `recordInventoryMovement({kind: 'receipt', …})` y luego `reserveStock`.
- **Manufactura (entrega 6):** consumo con `consumeReservation({kind: 'consume'})`; terminado, sobrante (contenedor
  `CT-` con dimensiones) y merma (`locationCode: 'SCRAP'`, siempre bloqueada) con `kind: 'produce'`.
- **Logística:** consumo automático al entregar (`delivery-consumption.ts`).
- **Supervisor:** reservas viejas sin preparar y reclamos vencidos (reglas 5).

## Pruebas

Unitarias en `src/modules/inventory/*.test.ts` con `createInventoryFake()` y `createLockEmulation(fake)`
(`testing/inventory-fixtures.ts`). Escenarios contra PostgreSQL real en
`tests/integration/operations-scenarios.int.test.ts` (conteo → provisional → promesa humana, división existencia +
compra, reclamo legado, dos órdenes compitiendo con FOR UPDATE, entrega parcial con consumo parcial).

## Cómo operar

1. Revisar la bodega creada automáticamente y sus ubicaciones; crear racks o bins si se van a usar.
2. Contar primero los artículos que más se venden: el primer conteo deja `PROVISIONAL`, el segundo conteo dentro de
   tolerancia los vuelve `CONTROLLED` y desde entonces se prometen solos.
3. Registrar como reclamo legado lo prometido antes del corte; confirmarlo cuando la venta tenga expediente.
4. Atender incidencias `count_dispute` y `stock_conflict` y las líneas de conteo pendientes de decisión.

## Limitaciones conocidas

- Una existencia `CONTROLLED` reservada no se puede transferir de ubicación (sólo lo disponible se mueve).
- Los ajustes de conteo se autorizan con `inventory.adjust`, no con `ApprovalRequest` por monto.
- `assignedToProduction` está en la fórmula pero nadie lo escribe todavía (manufactura usará reservas).
- `getStockSnapshot` devuelve hasta 1000 renglones; dos consultas de UI paginan en memoria (20 000 y 1000 filas).
- Las fotos HEIC de iPhone no se aceptan como evidencia (el validador de almacenamiento no las detecta).
- Falta la UI del área Inventario (dashboard, centro de trabajo, mapa de ubicaciones, captura de conteos móvil).
