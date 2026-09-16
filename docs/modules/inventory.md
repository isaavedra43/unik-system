# Inventario progresivo (`src/modules/inventory/`)

UNIK lleva su propio libro de existencias por artículo, bodega, ubicación, variante y contenedor, **sin depender de
que Zoho tenga el inventario correcto**. La confianza se gana contando: lo que nadie ha contado no se promete; lo
contado una vez se promete sólo con una decisión humana; lo contado bien dos veces se promete solo. Las existencias
de Zoho se muestran como referencia, nunca deciden.

Estado: núcleo **y pantallas del área** implementados y validados localmente (FakePrisma con emulación de candados,
escenarios contra PostgreSQL real y un recorrido visual de las rutas contra el build). Migración
`20260916130000_add_inventory_logistics_core` **no aplicada** en producción. Flag `inventory` de la configuración de
operaciones (ver [operaciones](./operations.md)). Las superficies del área están en
[«Área Inventario (pantallas)»](#área-inventario-pantallas); nada del módulo se ha probado contra Zoho real ni con
volumen de producción (ver [limitaciones](#limitaciones-conocidas)).

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
`stock.adjustment_pending|approval_requested|decided`, `stock.dispute_line_resolved`, `stock.dispute_resolved`,
`stock.negative`,
`stock.container_created`, `stock.legacy_claimed|confirmed|released|expired`, `inventory.profile_updated`,
`inventory.warehouse_created|updated`, `inventory.location_created|updated`. Se publican en `area:inventario` y en
`case:{id}` cuando hay expediente. `stock.reserved` y `stock.controlled` despiertan el avance de los expedientes.

## Permisos

`inventory.view` (consultar), `inventory.count` (contar), `inventory.adjust` (ajustar, decidir diferencias y
disputas), `inventory.reserve` (reservar y reclamos), `inventory.manage` (bodegas, ubicaciones, perfiles, movimientos).

## Errores

`insufficient_stock`, `stock_uncounted`, `stock_disputed`, `provisional_not_allowed`, `provisional_verification_stale`,
`duplicate`, `module_disabled`, `empty_count`, `legacy_claim_expired`, `negative_stock`, `demand_over_reserved` (409);
`provisional_requires_human` (403); `invalid_quantity`, `invalid_unit`, `invalid_variant` (422). Están en
`OPERATIONS_ERROR_HTTP_STATUS` y en `inventoryHttpStatus(code)` (`INVENTORY_ERROR_HTTP_STATUS` es la lista completa).

## Integración con los demás módulos

- **Expediente:** `verifyAvailability` decide si la necesidad requiere conteo (`requiresCount`) y si se puede
  prometer; el motor reserva con `reserveStock` y guarda `DemandAllocation.stockReservationId`.
- **[Compras](./purchases.md):** recepción con `recordInventoryMovement({kind: 'receipt', …})` y luego `reserveStock`.
- **[Manufactura](./manufacturing.md):** compromete el material en `StockItem.assignedToProduction`
  (`production-materials.ts`, que es quien escribe ese contador de la fórmula de disponible) y consume con
  `consumeReservation({kind: 'consume'})`; terminado, sobrante (contenedor `CT-` con dimensiones) y merma
  (`locationCode: 'SCRAP'`, siempre bloqueada) con `kind: 'produce'`.
- **Aprobaciones:** decidir la diferencia de una línea resuelve la política `inventory_adjustment` por monto
  (`resolveApprovalRequirement`): con una firma —la de quien tiene `inventory.adjust`— el ajuste se aplica en el acto;
  con dos o más se abre `ApprovalRequest`, la línea sigue pendiente (`stock.adjustment_approval_requested`) y el
  ajuste lo aplica la reacción a esa firma.
- **Logística:** consumo automático al entregar (`delivery-consumption.ts`).
- **Supervisor:** reservas viejas sin preparar y reclamos vencidos (reglas 5).

## Área Inventario (pantallas)

El área existe y está registrada: el servidor en `src/modules/areas/inventario/` (`register.ts` → renglones de
trabajo, panel y detalle; `dashboard.ts` con sus tiles «en vivo»; `inventory-area-queries.ts` con las lecturas de las
pantallas) y el cliente en `src/components/areas/inventario/` (`register-client.tsx`). Los barriles
`src/modules/areas/register-all.ts` y `src/components/areas/register-all-client.tsx` los cargan; ninguna pantalla
consulta Prisma desde el cliente y toda lectura exige `inventory.view` en servidor.

| Superficie                | Ruta                                             | Qué es                                                                                                                                                             |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Panel y centro de trabajo | `/app/areas/inventario` (`dashboard`, `trabajo`) | Pendientes del área (`verification`, `stock_count`, `reservation`, `movement`, `legacy_claim`) con las columnas propias SKU y Confianza.                           |
| Mapa de ubicaciones       | `/app/areas/inventario/mapa`                     | `LocationsMap`: bodegas y ubicaciones coloreadas por confianza, `LocationDrawer` para el detalle y `CountCapture` (con `ScanInput`) para contar desde el teléfono. |
| Existencias               | `/app/areas/inventario/existencias`              | `StockTable`: conocido, disponible, reservado y bloqueado por artículo, Zoho como columna informativa, «Por llegar» de Compras aparte y `StockActionsDialog`.      |
| Conteos y Movimientos     | `/app/areas/inventario/conteos`, `/movimientos`  | Vistas del centro de trabajo filtradas por tipo de renglón.                                                                                                        |
| Ubicaciones               | `/app/areas/inventario/ubicaciones`              | `LocationsAdmin`: bodegas, ubicaciones y `LabelSheet` (QR propio de `qr-code.ts`, folios `RL-`/`PL-`/`CT-`).                                                       |
| Perfil de artículo        | `/app/areas/inventario/perfiles/{zohoItemId}`    | `ProfileForm`: unidad base, conversiones, tolerancia, ejes de variante y política de rastreo.                                                                      |

Decisiones que no caben en el diálogo genérico de un renglón (`DetailExtras` del registro de cliente):
`CountDecisionsPanel` (decidir línea por línea las diferencias de un conteo) y `LegacyClaimPanel` (confirmar o liberar
un compromiso previo contra una necesidad del expediente).

Lecturas de la UI (todas bajo el área, con permiso en servidor):
`GET /app/areas/inventario/api/inventario/{map, counts/{countId}, stock/{zohoItemId}, locations/{locationId},
claims/{claimId}}`, y el escaneo comparte `GET /app/operations/api/scan`. Las escrituras no tienen endpoint propio:
son los comandos de este módulo por la cola offline (`useOfflineCommandQueue` → `/app/operations/api/commands/batch`),
así que contar sin señal es normal y el `commandId` evita duplicados.

Por IA: `recordCount` (`inventory.count`, `mywork-tools.ts`), `requestStockVerification` y `reserveStock`
(`inventory.reserve`, `agents-tools.ts`). Las de `src/modules/ai/tools/inventory-tools.ts` (`getProductCatalog`,
`getStockMovement`, `getLowStockAlerts`, `getProductDetails`) leen **Zoho**, no este libro de existencias.

## Pruebas

Unitarias en `src/modules/inventory/*.test.ts` con `createInventoryFake()` y `createLockEmulation(fake)`
(`testing/inventory-fixtures.ts`). Escenarios contra PostgreSQL real en
`tests/integration/operations-scenarios.int.test.ts` (conteo → provisional → promesa humana, división existencia +
compra, reclamo legado, dos órdenes compitiendo con FOR UPDATE, entrega parcial con consumo parcial). Del área:
`src/modules/areas/inventario/work-rows.test.ts`, `src/components/areas/inventario/inventario-model.test.ts` y
`qr-code.test.ts` (invariantes del símbolo impreso). `src/modules/areas/module-docs.test.ts` ata este documento al
código: si aparece un comando, un error, una tool o una pantalla que aquí no está, falla.

## Cómo operar

1. Revisar la bodega creada automáticamente y sus ubicaciones en `/app/areas/inventario/ubicaciones`; crear racks o
   bins si se van a usar e imprimir sus etiquetas.
2. Contar primero los artículos que más se venden: el primer conteo deja `PROVISIONAL`, el segundo conteo dentro de
   tolerancia los vuelve `CONTROLLED` y desde entonces se prometen solos.
3. Registrar como reclamo legado lo prometido antes del corte desde `/app/areas/inventario/existencias`
   (botón «Registrar» → «Compromiso previo al corte», permiso `inventory.reserve`); confirmarlo contra la necesidad
   del expediente —o liberarlo— desde el renglón «Compromiso previo» del centro de trabajo, que abre
   `LegacyClaimPanel`. Si nadie lo hace, el supervisor lo expira por TTL y la cantidad vuelve al disponible.
4. Atender incidencias `count_dispute` y `stock_conflict` y las líneas de conteo pendientes de decisión: se deciden
   una por una en el conteo (`/app/areas/inventario/conteos/{id}`, panel «Diferencias por decidir», permiso
   `inventory.adjust`), que es también a donde lleva el aviso de «Autorizar ajuste de conteo». Mientras quede una
   línea en disputa el artículo sigue `DISPUTED` y ninguna necesidad de ese SKU se puede prometer.
5. Registrar a mano lo que no viene de Compras ni de Manufactura —entradas, salidas, devoluciones, traspasos, ajustes
   y bloqueos— desde el mismo botón «Registrar» de Existencias (`inventory.manage`; ajuste y bloqueo,
   `inventory.adjust`).

## Limitaciones conocidas

- Una existencia `CONTROLLED` reservada no se puede transferir de ubicación (sólo lo disponible se mueve).
- El valor de un ajuste, que es lo que decide la política `inventory_adjustment`, se calcula con `Product.purchaseRate`
  —el único costo que UNIK guarda—: sin ese dato el monto es 0 y manda el rango `[0, …)` de la política.
- `getStockSnapshot` devuelve hasta 1000 renglones; dos consultas de UI paginan en memoria (20 000 y 1000 filas).
- Las fotos HEIC de iPhone no se aceptan como evidencia: `file-validation.ts` lee la firma `ftyp` y, sin marca para
  `heic`, la resuelve como `video/mp4`, así que la subida se rechaza con «Tipo declarado (image/heic) no coincide con
  el contenido (video/mp4)» (comprobado ejecutando `validateFileContent` con una cabecera HEIC real).
- El mapa dibuja hasta 500 ubicaciones y cada hoja imprime hasta 500 etiquetas (`MAX_LOCATIONS`, `MAX_LABELS`, con
  bandera `truncated`); esos topes se eligieron a ojo y no se han medido con volumen real.
- **El QR de las etiquetas nunca se ha escaneado.** Es un codificador propio (`qr-code.ts`) validado sólo por
  invariantes de la norma; leerlo con teléfono y con pistola es casilla explícita del runbook antes de imprimir un
  lote (el componente imprime el texto del folio como respaldo).
- Las pantallas del área se recorrieron contra el build con datos de demostración, nunca contra Zoho real ni con
  volumen de producción.
