# Logística con Zoho (`src/modules/logistics/`)

Logística toma lo que el expediente dejó listo, lo convierte en **órdenes de entrega**, asigna transporte escribiendo
la orden de envío en Zoho **por el outbox con relectura**, organiza viajes y paradas, y registra la entrega con
evidencia física. Una entrega incompleta reabre el remanente en lugar de perderlo, y una escritura a Zoho que falla o
regresa distinto nunca se oculta: queda como estado explícito con incidencia y trabajo.

Estado: núcleo **y pantallas del área** implementados y validados localmente (reglas puras, FakePrisma con
`shipPackage` simulado, escenarios contra PostgreSQL real y un recorrido visual de las rutas contra el build).
Migración `20260916130000_add_inventory_logistics_core` **no aplicada** en producción. Flag `logistics` de la
configuración de operaciones. El despacho, el mapa Leaflet, la PWA del chofer y las tools de IA existen y están
descritos en [«Área Logística (pantallas)»](#área-logística-pantallas); lo que sigue sin probarse es **Zoho real**:
toda la sincronización se ha visto sólo con `ZOHO_BOOKS_MOCK`.

## Modelos

| Modelo               | Para qué                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `DeliveryOrder`      | Entrega de un expediente: asignaciones, paquete de Zoho, modo, destino, transporte, estado y `zohoSyncState`.    |
| `Vehicle` / `Driver` | Flotilla con capacidad (kg, m², piezas) y mantenimiento; chofer ligado a un usuario.                             |
| `Trip` / `TripStop`  | Viaje del día (`planned`, `en_route`, `done`, `cancelled`) con paradas (`pending`, `arrived`, `done`, `failed`). |
| `DeliveryEvidence`   | Foto, firma, nota o confirmación de cantidades de una entrega.                                                   |

Modos de entrega: `own_fleet`, `carrier`, `customer_pickup`, `direct_supplier`. Sólo `own_fleet` y `carrier` llevan
orden de envío en Zoho; con flotilla propia se indica vehículo y chofer, y con `carrier` (paquetería o transportista
externo) viaja el número de guía y ninguno de los dos. Quién decide el modo: el motor al planear la entrega (el método
de entrega de la orden de venta de Zoho — `RECOGE EN BODEGA…` → `customer_pickup`, `PAQUETERÍA` / `MENSAJERÍA` /
`TRANSPORTISTA` → `carrier`, lo demás → `own_fleet`), compras al pedir entrega directa (`direct_supplier`) y Logística
al asignar transporte, que puede cambiar `own_fleet` ↔ `carrier` mientras la entrega no esté cargada en un viaje.
Sólo las entregas `own_fleet` van en un viaje de la flotilla.

Estados de `DeliveryOrder`: `pending` (sin paquete), `planned`, `assigned`, `pending_external`, `conflict`,
`dispatched`, `delivered`, `partially_delivered`, `failed`, `cancelled`.

Estados de sincronización (`zoho-sync-state.ts`): `not_required` → `pending_write` → `written` → `readback_ok` |
`readback_mismatch`; al entregar `delivered_pending_write` → `delivered_written`; `failed`.

## Flujo

1. **Planear** (`delivery.create`, lo hace el motor del expediente en `planear_entrega`): enlaza el paquete libre de la
   orden de venta cuyas líneas son los artículos de la entrega (con varios candidatos o sin líneas sincronizadas no
   adivina: Logística lo liga con `delivery.link_package`). Sin paquete, la orden queda `pending` y se crea la solicitud
   `create_package_in_zoho` a Ventas (bloquea la entrega); cuando el paquete aparece, el barrido lo enlaza.
2. **Asignar transporte** (`delivery.assign_transport`, `logistics.zoho_write`): guarda `shipmentInput` con
   `requestKey = zoho:ship:{id}:{version}`, estado `pending_external` y encola `ops.zoho.ship_package` (dedupe por
   `requestKey`, grupo `case:{caseId}`, 5 intentos). Repetir el mismo contenido no encola otra escritura.
3. **Escribir y releer** (job): `shipPackage` en Zoho y relectura del paquete:
   - igual → `assigned` + `readback_ok` + evento `zoho.shipment_confirmed` + evidencia `zoho_readback`; el paso
     `asignar_transporte` del expediente se cierra;
   - distinto → `conflict` + `readback_mismatch` adoptando los valores de Zoho, incidencia `zoho_conflict` y trabajo
     `external_sync` a Logística para decidir si re-escribe;
   - parche local sin relectura (presupuesto de API) → `written`; el barrido `logistics.zoho_reconcile` relee después;
   - error 5xx, 401, 408 o 429 → reintento; errores de validación o cualquier otro 4xx de Zoho → falla permanente;
     una escritura del mismo expediente que sigue en curso va primero; al agotar intentos → `failed`,
     incidencia `zoho_failure` (alta) y trabajo `external_sync`.
4. **Entregar** (`delivery.record` o `trip.complete_stop`, chofer asignado o despacho): exige una foto o firma ya
   subida (`validating` o `ready`); sin ella se rechaza con `evidence_required` y la orden sigue abierta.
   - completa → `delivered`, asignaciones y necesidades entregadas, `ops.zoho.mark_delivered` por el outbox;
   - cantidad menor → `partially_delivered`, asignación `reopened`, orden hija por el remanente, incidencia
     `partial_delivery` y trabajo a Ventas «Decidir remanente»;
   - en la misma transacción inventario consume las reservas de lo entregado (`delivery-consumption.ts`).
5. **Cancelar** (`delivery.cancel` o cancelación del expediente): encola `ops.zoho.cancel_shipment` sólo si UNIK
   escribió el embarque y cierra paradas, solicitudes y trabajo colgados.

Viajes: `trip.build` (folio `VJ-`, capacidad y orden de paradas por vecino más cercano respetando ventanas),
`trip.add_stop`, `trip.reorder` (las visitadas no se mueven), `trip.start`, `trip.arrive_stop` (GPS),
`trip.complete_stop`, `trip.fail_stop` (trabajo de reprogramación + aviso a Ventas), `trip.close` (rechaza con
paradas abiertas) y `trip.cancel` (el viaje que no va a salir: pide motivo, deja el viaje en `cancelled`, libera cada
entrega —`tripId` a null y el estado que describe su espejo de Zoho— y NO marca ninguna parada como fallida, así que
no abre incidencias de entrega falsas; un viaje que ya entregó algo se rechaza con `trip_has_deliveries`).

## Comandos (`logistics-commands.ts`)

| Tipo                                                                                                                       | Permiso                                                     |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `delivery.create`, `delivery.link_package`, `delivery.cancel`                                                              | `logistics.dispatch`                                        |
| `delivery.assign_transport`                                                                                                | `logistics.dispatch` + `logistics.zoho_write`               |
| `delivery.record`                                                                                                          | chofer asignado (`logistics.drive`) o `logistics.dispatch`  |
| `delivery.reconcile_shipment`, `delivery.zoho_write_failed`, `delivery.zoho_delivered`, `delivery.zoho_shipment_cancelled` | sólo sistema (jobs)                                         |
| `trip.build`, `trip.add_stop`, `trip.reorder`                                                                              | `logistics.dispatch`                                        |
| `trip.start`, `trip.arrive_stop`, `trip.complete_stop`, `trip.fail_stop`, `trip.close`                                     | chofer del viaje (`logistics.drive`) o `logistics.dispatch` |
| `trip.cancel`                                                                                                              | `logistics.dispatch` (decisión de despacho, no del chofer)  |
| `fleet.vehicle.create`, `fleet.vehicle.update`, `fleet.driver.create`, `fleet.driver.update`                               | `logistics.manage_fleet`                                    |

## Jobs (`logistics-jobs.ts`)

| Job                        | Qué hace                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `ops.zoho.ship_package`    | escribe la orden de envío y reconcilia con la relectura                                                              |
| `ops.zoho.mark_delivered`  | marca entregado en Zoho                                                                                              |
| `ops.zoho.cancel_shipment` | cancela el embarque que UNIK escribió                                                                                |
| `logistics.zoho_reconcile` | cada 30 min: re-encola escrituras sin job vivo, relee `written`/`readback_mismatch`/`failed`, enlaza paquetes nuevos |

Los jobs usan `shipPackage`, `markPackageDelivered` y `cancelPackageShipment` de `packages-shipping-service.ts`
(con `ZOHO_BOOKS_MOCK` sólo parchan la fila del paquete). El supervisor re-encola una escritura estancada y abre
`zoho_failure` tras 60 minutos sin avance (regla 3).

## Eventos y tiempo real

Del núcleo: `delivery.planned|dispatched|confirmed|partial|failed|address_updated`,
`zoho.shipment_queued|confirmed|conflict|failed|cancelled`, `zoho.delivered_marked`, `allocation.delivered|reopened`,
`demand.fulfilled`. Propios:
`delivery.package_requested|package_linked|transport_assigned|mode_changed|released_from_trip|cancelled|evidence_added`,
`trip.built|stop_added|stops_reordered|started|stop_arrived|stop_completed|stop_failed|closed|cancelled`,
`fleet.vehicle_created|updated`, `fleet.driver_created|updated` (la lista viva es `LOGISTICS_EVENTS` en `types.ts`).

Canales SSE: `logistics:dispatch` (`logistics.dispatch`) y `trip:{id}` (`logistics.view`, `logistics.dispatch` o el
chofer del viaje), además de `case:{id}` y `area:logistica`.

## Notificaciones (`delivery_update`)

`notifyDeliveryUpdate()` (en `logistics-helpers.ts`) avisa al **dueño del expediente** —no al área— de los cuatro
movimientos que le importan al cliente: `delivery_dispatched` (el viaje salió), `delivery_confirmed` /
`delivery_partial` (parada entregada, completa o no), `delivery_failed` (hay que reprogramar) y
`delivery_zoho_conflict` (Zoho guardó otro embarque). Una sola lectura del expediente da el destinatario y la
referencia «EXP-000123 · SO-00045» del título; el chofer que registra la acción nunca se avisa a sí mismo (lo
resuelve `notifyUser` con el `actorUserId` que pasa el motor). La categoría sale del catálogo, así que una persona
puede apagarla sin apagar el resto del motor.

## Evidencias

Destino de subida `delivery_evidence` (propósito `evidence`, imagen o PDF, 15 MB, retención protegida, descarga
restringida): `POST /app/files/api/uploads` con `target {type: 'delivery_evidence', id: '{deliveryOrderId}'}` o
`'{deliveryOrderId}:signature'`. Cada subida crea `DeliveryEvidence` + `EvidenceLink`. Lectura para la PWA:
`getDriverToday(user)` (`driver-service.ts`).

## Permisos

`logistics.view`, `logistics.dispatch`, `logistics.drive`, `logistics.manage_fleet`, `logistics.zoho_write`.

## Errores

`package_missing`, `allocation_in_delivery`, `fleet_unavailable`, `duplicate_code`, `driver_user_taken`, `in_use`,
`stops_pending`, `trip_has_deliveries`, `module_disabled` (409); `evidence_required`, `evidence_invalid`,
`invalid_quantity`, `nothing_delivered`, `capacity_exceeded` (422). Mapeados en `OPERATIONS_ERROR_HTTP_STATUS` y en
`logisticsHttpStatus(code)` (`LOGISTICS_ERROR_HTTP_STATUS` es la lista completa).

## Área Logística (pantallas)

El área existe y está registrada: el servidor en `src/modules/areas/logistica/` (renglones de trabajo, panel,
`logistics-view-model.ts` con las rutas y los canales) y el cliente en `src/components/areas/logistica/`
(`register-client.tsx`). Toda escritura es un comando de este módulo por la cola offline
(`useOfflineCommandQueue` → `/app/operations/api/commands/batch`), nunca una llamada directa a Zoho desde el navegador.

| Superficie        | Ruta                                          | Qué es                                                                                                                                                                                                                                                            |
| ----------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Despacho          | `/app/areas/logistica/despacho`               | `DispatchBoard`: entregas sin cargar (`DeliveryCard`), mapa del día y viajes por unidad (`VehicleTimeline`, arrastrar o botón «Cargar en viaje»); `AssignTransportDialog` y `BuildTripDialog` son sus dos decisiones. En teléfono las tres columnas son pestañas. |
| Mapa              | dentro de Despacho                            | `DispatchMap`: Leaflet (`leaflet` + `react-leaflet`, `dynamic({ssr:false})`), un marcador por parada, la polilínea de cada viaje en orden y pines grises para lo no cargado.                                                                                      |
| Centro de trabajo | `/app/areas/logistica` (`trabajo`)            | Pendientes del área (`delivery_order`, `trip`) con la columna Transportista + `ZohoSyncPill`, que es lo que dice si el embarque de verdad quedó escrito en Zoho.                                                                                                  |
| Viajes            | `/app/areas/logistica/viajes`, `/viajes/{id}` | Lista del centro de trabajo y `TripDetailView`: unidad, chofer, paradas en orden (`TripStopsEditor`, con «Subir»/«Bajar» además del arrastre), evidencias y cancelación.                                                                                          |
| Flotilla          | `/app/areas/logistica/flota`                  | `FleetManager`: unidades y choferes con su disponibilidad del día y sus formularios (`fleet.*`, `logistics.manage_fleet`).                                                                                                                                        |
| PWA del chofer    | `/app/areas/logistica/chofer`                 | `DriverApp`: el día del chofer, arrancar viaje, llegar (GPS), entregar con foto o firma, reportar parada fallida y cerrar. Entra con `logistics.drive` (permiso `entry` del área) sin ver ningún otro espacio.                                                    |

Lecturas: `GET /app/areas/logistica/api/logistica/{despacho?fecha=…, viajes/{tripId}, flota?fecha=…}` y, para la PWA,
`GET /app/areas/logistica/chofer/api/today`. Tiempo real por `logistics:dispatch` y `trip:{id}`.

Escrituras del chofer: `POST /app/areas/logistica/chofer/api/commands`, una puerta a la medida del día de un chofer
(`trip.start`, `trip.arrive_stop`, `trip.complete_stop`, `trip.fail_stop`, `trip.close`, `delivery.record`); el actor
es siempre la sesión y el motor vuelve a comprobar que esa persona es el chofer del viaje. Sin señal el comando queda
en la cola compartida y el service worker la vacía con Background Sync (etiqueta `logistics-commands`); en iOS, que no
lo tiene, la página la vacía al reconectar. Reenviar es seguro: el ledger responde el resultado guardado del mismo
`commandId`.

Por IA (`src/modules/ai/tools/logistics-tools.ts`, todas en `OPERATIONS_TOOL_NAMES`): `getDispatchBoard`,
`getTripPlan`, `buildTrip`, `addTripStop`, `reorderTripStops`, `startTrip`, `recordDeliveryResult` y
`reportFailedStop`. Ejecutan los mismos comandos con los mismos permisos.

## Pruebas

Reglas puras (`zoho-sync-state`, `route-rules`, `delivery-rules`, `fleet-rules`) y flujos con FakePrisma
(`logistics-flow.test.ts`, `trips-service.test.ts`, `logistics-storage.test.ts`). Contra PostgreSQL real
(`npm run test:integration`): flujo completo con flotilla propia y relectura igual, entrega con cantidad distinta,
Zoho falla al asignar transportista (cinco intentos → `failed`), Zoho devuelve otro valor (`conflict`). Del área:
`src/modules/areas/logistica/*.test.ts` (renglones y modelo de vista) y
`src/modules/ai/tools/logistics-tools.test.ts`. `src/modules/areas/module-docs.test.ts` ata este documento al código:
si aparece un comando, un error, una tool o una pantalla que aquí no está, falla.

## Cómo operar

1. Dar de alta vehículos y choferes (con su usuario) en `/app/areas/logistica/flota`, y el permiso
   `logistics.zoho_write` sólo a quien escribe en Zoho; el chofer necesita `logistics.drive` para su PWA.
2. Armar el día desde `/app/areas/logistica/despacho` y vigilar las entregas `pending` sin paquete: Ventas debe crear
   el paquete en Zoho.
3. Atender `zoho_conflict` (decidir si se re-escribe asignando transporte de nuevo) y `zoho_failure` (reintentar
   asignando transporte; `mark_delivered` y `cancel_shipment` fallidos se confirman con el barrido cuando Zoho ya
   refleja el cambio).
4. Revisar el trabajo «Decidir remanente» de las entregas parciales.

## Limitaciones conocidas

- No existe un comando de reintento manual para `mark_delivered` o `cancel_shipment` fallidos.
- En una entrega parcial no se ajusta la cantidad del paquete en Zoho; la orden hija nace sin paquete.
- `zohoLastAttemptAt` y `zohoError` los escriben los jobs fuera de comando (metadato técnico, sin versión).
- Un rechazo offline por `evidence_required` queda en el ledger: tras subir la evidencia se envía otro `commandId`.
  Sólo cuenta la evidencia listada en el comando o subida después de la última parada fallida.
- El paso `asignar_transporte` sólo se cierra con la relectura de Zoho (`readback_ok` o entrega ya marcada). Iniciar un
  viaje exige paquete de Zoho y, si la entrega no tenía transporte asignado o su escritura falló, encola la orden de
  envío con el vehículo y chofer del viaje. Mientras Zoho confirma, el trabajo del paso espera sin escalar.
- En un conflicto, reasignar transporte vuelve a escribir; cerrar el trabajo de decisión acepta los valores de Zoho
  (entrega confirmada e incidencia `zoho_conflict` resuelta). El barrido no relee un conflicto sin cambios.
- Entregar (o cargar en viaje) una entrega con flotilla o transportista sin paquete se rechaza con `package_missing`.
- Con `customer_pickup` y paquete sin orden de envío no se marca entregado en Zoho.
- `trip.cancel` no está en la lista blanca de la PWA del chofer (`chofer/api/commands`): el chofer avisa y despacho
  cancela. Las paradas de un viaje cancelado conservan su estado `pending`/`arrived` (nadie las visitó); lo que dice
  que el viaje no salió es el estado del viaje.
- El tablero de despacho lee hasta 300 entregas y 60 viajes del día (`BOARD_DELIVERY_LIMIT`, `BOARD_TRIP_LIMIT`):
  topes elegidos a ojo, nunca medidos con volumen real.
- Background Sync no existe en iOS/Safari: ahí la cola del chofer se vacía cuando la página vuelve a tener señal, así
  que un teléfono con la PWA cerrada no reenvía nada hasta que alguien la abre.
- `DELIVERY_EVIDENCE_MIME_TYPES` acepta `image/heic` y `image/heif`, pero `file-validation.ts` resuelve esa firma
  (`ftyp`, sin marca para `heic`) como `video/mp4`: una foto HEIC de iPhone se rechaza al subirla con «Tipo declarado
  (image/heic) no coincide con el contenido (video/mp4)». Hoy la evidencia real son JPEG, PNG, WebP y PDF.
- Nada de esto se ha visto contra Zoho real: el espejo del embarque, el marcado de entregado y la cancelación se han
  probado sólo con `ZOHO_BOOKS_MOCK` y con dobles en las pruebas.
