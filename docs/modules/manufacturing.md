# Manufactura (`src/modules/manufacturing/`)

Manufactura convierte materia prima en producto terminado y responde una pregunta que nadie más puede responder:
**qué se consumió, qué salió, qué sobró y qué se tiró**, y de qué venta vino cada gramo.

El caso normal de UNIK no es un ensamble con receta: es una **transformación** (una lámina se corta en piezas, un
rollo se corta en tramos). Por eso la orden de transformación es el modo por omisión y la lista de materiales (BOM)
es opcional, para los productos que sí la tienen.

Regla que gobierna el módulo: **producido + consumido + sobrante + merma tienen que cuadrar**, y todo es trazable a la
materia prima y a la venta. Una orden no se libera con una diferencia sin explicar o con merma fuera de tolerancia sin
aprobar.

Estado: implementado y validado localmente (reglas puras, servicios con FakePrisma y escenarios contra PostgreSQL
real). Migración `20260916140100_add_manufacturing` **no aplicada** en producción. La verificación con una orden de
corte real está **PENDIENTE PRODUCCIÓN** (ver `docs/pilot-runbook.md` §11.11).

## Modelos

| Modelo                             | Para qué                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `WorkCenter`                       | Centro de trabajo con turnos, capacidad por turno (`m2`, `pieces`, `minutes`) y su bodega. |
| `Bom` (+`BomLine`, `BomOperation`) | Lista de materiales **opcional** con sus operaciones y sus controles de calidad.           |
| `ProductionOrder`                  | Orden `OP-` con producto, cantidad planeada, expediente, centro y programación.            |
| `ProductionOperation`              | Cada paso de la orden (por omisión una sola: «Corte/acabado»).                             |
| `MaterialConsumption`              | Lo comprometido y lo realmente consumido, por fila de existencia.                          |
| `ProductionOutput`                 | Salida: producto terminado, **sobrante vendible** con medidas, o merma.                    |
| `QualityCheck`                     | Inspección; si falla, ordena un retrabajo.                                                 |

## Estados

`draft` → `reserved` | `blocked` → `prepared` → `in_progress` → `inspection` → `completed` → `released`;
`cancelled` hasta antes de la liberación.

- `blocked` significa que **no se pudo comprometer material**; una reserva posterior la mueve a `reserved` (el job
  `manufacturing.retry_blocked` lo reintenta cuando llega existencia).
- Una inspección fallida agrega una operación de retrabajo y regresa a `in_progress`.
- Operación: `pending` → `running` ↔ `paused` → `done` | `skipped`.
- BOM: `draft` → `active` → `retired`.

## Flujo

1. **Entrada.** El motor manda una `AreaRequest` de transformación a Manufactura y el job
   `manufacturing.intake_request` la vuelve orden, o se crea a mano (`manufacturing.manage_orders`). La IA puede
   dejarla en **borrador** (`createTransformationOrderDraft`) sin comprometer material.
2. **Programar.** `capacity-rules.ts` acomoda la operación en la primera ventana de turno donde cabe; si no cabe en el
   horizonte, la ranura se marca `overloaded` y se levanta el aviso y el trabajo correspondiente.
3. **Reservar materiales.** Los insumos se comprometen con `StockItem.assignedToProduction`, **no** con
   `reserveStock`: una reserva está atada a una necesidad del expediente DEL MISMO artículo y se topa con su
   pendiente, así que no puede sostener la materia prima de una transformación sin corromper la contabilidad de la
   necesidad. Aplican las mismas reglas de confianza del inventario (`UNCOUNTED` y `DISPUTED` nunca comprometen;
   `PROVISIONAL` sólo por decisión de una persona con un conteo reciente) y los mismos candados por grupo de producto.
4. **Preparar y producir.** Las operaciones se inician, pausan y terminan (`manufacturing.operate`); el consumo real
   sale primero de lo asignado (baja el contador y se asienta un movimiento `consume` contra la misma fila).
5. **Sustituciones.** Consumir un material fuera de la lista abre la aprobación de negocio `production_incident` y
   queda pendiente hasta que alguien con `manufacturing.approve_incidents` la firme.
6. **Inspeccionar.** `manufacturing.inspect` registra la calidad; si falla, retrabajo.
7. **Registrar salidas.** Producto terminado (después de una inspección aprobada), **sobrante vendible** con sus
   medidas —entra al inventario como material vendible, con trazabilidad a la orden— y merma, que entra **bloqueada**
   a la ubicación de merma.
8. **Merma fuera de tolerancia.** `scrap-rules.ts` compara la merma contra su base (lo consumido de ese insumo, o
   producido + merma para el terminado). Si supera `scrapAllowancePct` se abre la incidencia `excess_scrap` y una
   aprobación que **bloquea la liberación** hasta que se firme. Merma registrada antes de cualquier consumo todavía no
   se puede juzgar (`pending`).
9. **Liberar.** El balance `consumido = producido × cantidad por unidad + sobrante + merma` se revisa por insumo
   dentro de la tolerancia de medición del artículo. Una línea sin razón de consumo se reporta pero no es comparable,
   así que nunca bloquea sola: la diferencia aceptada la firma un aprobador. Al liberar se sueltan los sobrantes de la
   asignación.

## Comandos (`manufacturing-commands.ts`)

| Familia       | Comandos                                                                                                                                  | Permiso                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Centros y BOM | `work_center.create/update`, `bom.create/update/activate/retire`                                                                          | `manufacturing.manage_boms`                 |
| Órdenes       | `order.create_transformation`, `order.create_from_bom`, `order.schedule`, `order.reserve_materials`, `order.prepare`, `release`, `cancel` | `manufacturing.manage_orders`               |
| Piso          | `operation.start/pause/finish`, `order.record_consumption`, `order.record_output`                                                         | `manufacturing.operate`                     |
| Calidad       | `order.inspect`                                                                                                                           | `manufacturing.inspect`                     |
| Incidencias   | `order.request_scrap_review`                                                                                                              | `manufacturing.approve_incidents` (aprueba) |
| Sistema       | `order.intake_request`, `capacity.alert`                                                                                                  | sólo jobs                                   |

Todos pasan por `executeCommand` del núcleo: ledger, idempotencia por `commandId`, guarda de versión y eventos y jobs
en la misma transacción.

## Jobs (`manufacturing-jobs.ts`)

| Job                             | Qué hace                                                                |
| ------------------------------- | ----------------------------------------------------------------------- |
| `manufacturing.intake_request`  | Solicitud de transformación → orden de producción.                      |
| `manufacturing.retry_blocked`   | Órdenes bloqueadas vuelven a intentar reservar cuando llega existencia. |
| `manufacturing.capacity_alerts` | Cada hora: vigila la sobrecarga de los centros de trabajo.              |

Los eventos de llegada de existencia que pueden desbloquear una orden están en `STOCK_ARRIVAL_EVENTS`
(`stock.received`, `stock.produced`, `stock.returned`, `stock.adjusted`, `stock.transferred`).

## Tiempo real

Canal `manufacturing:floor` (autorizado con `manufacturing.view`), con los tipos `manufacturing.orders`,
`manufacturing.work_centers`, `manufacturing.boms` y `manufacturing.capacity`, además de `case:{id}` y
`area:manufactura`.

## Notificaciones (`production_update`)

`notifyProductionUpdate()` (en `manufacturing-helpers.ts`) avisa a quien abrió la orden (`createdByUserId`) y al
dueño del expediente, si lo hay, de `production_released` (la orden quedó liberada, con lo producido y si va a
inventario o a entregar) y `production_scrap_exceeded` (la merma pasó la tolerancia y la liberación queda detenida).
Los aprobadores reciben aparte su `approval_requested`; el operador que ejecuta la acción nunca se avisa a sí mismo.

## Tools de IA (`src/modules/ai/tools/manufacturing-tools.ts`)

`listProductionOrders` y `getProductionBoard` (lectura, `manufacturing.view`), `createTransformationOrderDraft`
(borrador, `manufacturing.manage_orders`), `recordProductionOutput` y `reportScrap` (escritura de negocio,
`manufacturing.operate`, con tarjeta de aprobación para el responsable).

Las cinco están en la allowlist de `ia_manufactura`. Ninguna libera una orden, aprueba una incidencia ni firma una
inspección.

## Trazabilidad

`recordOutput` escribe `StockItem.originProductionOrderId` y el movimiento `produce`; esa cadena se **consulta** en dos
lugares, en las dos direcciones:

- `/app/manufacturing/orders/<id>` — panel «Trazabilidad» (`getProductionTrace` + `traceView`): material que entró (con
  las sustituciones), lo que salió separado en terminado, sobrante y merma, y la venta para la que se fabricó (o el
  aviso de que la orden era para inventario).
- `/app/manufacturing/trazabilidad/<stockItemId>` — de una existencia hacia atrás (`traceStockItem`): las órdenes que
  produjeron en ella y el detalle de la última. Pide `manufacturing.view` **o** `inventory.view`, y el cajón de una
  ubicación del mapa de Inventario enlaza aquí cuando la existencia salió de planta.

La forma en pantalla la decide `src/modules/areas/manufactura/trace-model.ts` (puro, con prueba); las consultas no se
duplican.

## Área Manufactura (`/app/areas/manufactura/...`)

- `dashboard` — tablero del área.
- `trabajo` — centro de trabajo con filas `production_order` y `production_operation` más las comunes; columnas extra
  Centro y Termina.
- `ordenes` — órdenes de producción con material, avance y calidad.
- `tablero` — Tablero de producción a ancho completo: carga por centro y turno con las órdenes en curso. Su barra
  enlaza **Listas de materiales** y **Nueva orden**.
- `comunicaciones` — canal `area:manufactura` y bandeja del equipo `equipo_manufactura`.

### Páginas de gestión fuera de `/app/areas`

Dos superficies del módulo no son espacios del registro, así que no heredan las pestañas del área. Las enlaza la tira de
secciones (`MANUFACTURA_SECTIONS` en `src/modules/areas/manufactura/manufactura-sections.ts`, pintada con el `TabNav`
compartido) que llevan las tres páginas: Tablero · Órdenes · Listas de materiales · Centros de trabajo.

- `/app/manufacturing/bom` — listas de materiales versionadas: crear, editar el borrador, activar (retira la revisión
  activa anterior del mismo producto en la misma transacción) y retirar. Ver pide `manufacturing.view`; gestionar,
  `manufacturing.manage_boms`. Se entra desde el Tablero de producción.
- `/app/manufacturing/centros` — capacidad por turno y, debajo, la **carga comprometida** de los próximos 7 días con las
  operaciones que la llenan (`getWorkCenterLoad`, la misma lectura del planificador y del job de avisos).
- `/app/manufacturing/orders/nueva` — orden de transformación (pide `manufacturing.manage_orders`).

`visibleManufacturaSections` sólo ofrece lo que la persona puede abrir de verdad: las dos páginas de gestión llaman
`requirePermission('manufacturing.view')`, y `operations.admin` **no** satisface esa clave, así que a quien sólo
administre operaciones no se le enlaza un 403.

## Permisos

`manufacturing.view`, `manufacturing.manage_boms`, `manufacturing.manage_orders`, `manufacturing.operate`,
`manufacturing.inspect`, `manufacturing.approve_incidents`.

Nota: **no existe** una clave `manufacturing.approve`; el aprobador del área es `manufacturing.approve_incidents`.

## Pruebas

Reglas puras: `production-state`, `scrap-rules`, `capacity-rules`. Con FakePrisma: `production-flow`,
`production-hardening`, `manufacturing-orders`. Tools de IA:
`src/modules/ai/tools/manufacturing-tools.test.ts`.

Contra PostgreSQL real (`npm run test:integration`): `tests/integration/domains-scenarios.int.test.ts` recorre la
transformación con merma **dentro** de la tolerancia (libera sin aprobación ni incidencia) y **fuera** de ella
(incidencia `excess_scrap`, aprobación `production_incident`, liberación bloqueada y liberada sólo tras la firma),
con el balance de materiales cuadrado; `tests/integration/manufactura-work-rows.int.test.ts` cubre las ramas SQL del
centro de trabajo.

> Esas dos suites comparten **una** base desechable con todas las demás y sólo valen si corren **solas**. Una
> corrida simultánea las pone en rojo con errores que parecen del producto (deadlock, FK de `Notification`,
> unicidad de `Responsible.area`); desde el 2026-09-16 el `globalSetup` del proyecto hace esperar a la segunda
> corrida en vez de dejarla corromper la base. Ver `docs/pilot-runbook.md` §11.14.

## Limitaciones conocidas

- No se ha corrido **ninguna orden de corte real**: falta ver que el sobrante aparezca vendible en la operación y que
  la ruta de autorización de merma sea usable en planta.
- El balance de materiales no es comparable cuando la línea no tiene razón de consumo por unidad de salida: se
  reporta, pero no bloquea.
- Los turnos se definen en hora local de la planta; un turno que cruza la medianoche está contemplado, pero no hay
  soporte de turnos traslapados en un mismo centro.
