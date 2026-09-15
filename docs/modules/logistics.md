# Logística con Zoho (`src/modules/logistics/`)

Logística toma lo que el expediente dejó listo, lo convierte en **órdenes de entrega**, asigna transporte escribiendo
la orden de envío en Zoho **por el outbox con relectura**, organiza viajes y paradas, y registra la entrega con
evidencia física. Una entrega incompleta reabre el remanente en lugar de perderlo, y una escritura a Zoho que falla o
regresa distinto nunca se oculta: queda como estado explícito con incidencia y trabajo.

Estado: núcleo implementado y validado localmente (reglas puras, FakePrisma con `shipPackage` simulado y escenarios
contra PostgreSQL real). Migración `20260916130000_add_inventory_logistics_core` **no aplicada** en producción. Flag
`logistics` de la configuración de operaciones. La UI de despacho, el mapa y la PWA del chofer son de la entrega 4 y
todavía no existen.

## Modelos

| Modelo               | Para qué                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `DeliveryOrder`      | Entrega de un expediente: asignaciones, paquete de Zoho, modo, destino, transporte, estado y `zohoSyncState`.    |
| `Vehicle` / `Driver` | Flotilla con capacidad (kg, m², piezas) y mantenimiento; chofer ligado a un usuario.                             |
| `Trip` / `TripStop`  | Viaje del día (`planned`, `en_route`, `done`, `cancelled`) con paradas (`pending`, `arrived`, `done`, `failed`). |
| `DeliveryEvidence`   | Foto, firma, nota o confirmación de cantidades de una entrega.                                                   |

Modos de entrega: `own_fleet`, `carrier`, `customer_pickup`, `direct_supplier`. Sólo `own_fleet` y `carrier` llevan
orden de envío en Zoho; con flotilla propia se indica vehículo y chofer.

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
paradas abiertas).

## Comandos (`logistics-commands.ts`)

| Tipo                                                                                                                       | Permiso                                                     |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `delivery.create`, `delivery.link_package`, `delivery.cancel`                                                              | `logistics.dispatch`                                        |
| `delivery.assign_transport`                                                                                                | `logistics.dispatch` + `logistics.zoho_write`               |
| `delivery.record`                                                                                                          | chofer asignado (`logistics.drive`) o `logistics.dispatch`  |
| `delivery.reconcile_shipment`, `delivery.zoho_write_failed`, `delivery.zoho_delivered`, `delivery.zoho_shipment_cancelled` | sólo sistema (jobs)                                         |
| `trip.build`, `trip.add_stop`, `trip.reorder`                                                                              | `logistics.dispatch`                                        |
| `trip.start`, `trip.arrive_stop`, `trip.complete_stop`, `trip.fail_stop`, `trip.close`                                     | chofer del viaje (`logistics.drive`) o `logistics.dispatch` |
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
`demand.fulfilled`. Propios: `delivery.package_requested|package_linked|transport_assigned|cancelled|evidence_added`,
`trip.built|stop_added|stops_reordered|started|stop_arrived|stop_completed|stop_failed|closed`,
`fleet.vehicle_created|updated`, `fleet.driver_created|updated`.

Canales SSE: `logistics:dispatch` (`logistics.dispatch`) y `trip:{id}` (`logistics.view`, `logistics.dispatch` o el
chofer del viaje), además de `case:{id}` y `area:logistica`.

## Evidencias

Destino de subida `delivery_evidence` (propósito `evidence`, imagen o PDF, 15 MB, retención protegida, descarga
restringida): `POST /app/files/api/uploads` con `target {type: 'delivery_evidence', id: '{deliveryOrderId}'}` o
`'{deliveryOrderId}:signature'`. Cada subida crea `DeliveryEvidence` + `EvidenceLink`. Lectura para la PWA:
`getDriverToday(user)` (`driver-service.ts`).

## Permisos

`logistics.view`, `logistics.dispatch`, `logistics.drive`, `logistics.manage_fleet`, `logistics.zoho_write`.

## Errores

`package_missing`, `allocation_in_delivery`, `fleet_unavailable`, `duplicate_code`, `driver_user_taken`, `in_use`,
`stops_pending`, `module_disabled` (409); `evidence_required`, `evidence_invalid`, `invalid_quantity`,
`nothing_delivered`, `capacity_exceeded` (422). Mapeados en `OPERATIONS_ERROR_HTTP_STATUS` y en
`logisticsHttpStatus(code)`.

## Pruebas

Reglas puras (`zoho-sync-state`, `route-rules`, `delivery-rules`, `fleet-rules`) y flujos con FakePrisma
(`logistics-flow.test.ts`, `trips-service.test.ts`, `logistics-storage.test.ts`). Contra PostgreSQL real
(`npm run test:integration`): flujo completo con flotilla propia y relectura igual, entrega con cantidad distinta,
Zoho falla al asignar transportista (cinco intentos → `failed`), Zoho devuelve otro valor (`conflict`).

## Cómo operar

1. Dar de alta vehículos y choferes (con su usuario) y el permiso `logistics.zoho_write` sólo a quien escribe en Zoho.
2. Vigilar las entregas `pending` sin paquete: Ventas debe crear el paquete en Zoho.
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
- No hay comando para cancelar viajes ni categoría de notificación `delivery_update`.
- Faltan la UI de despacho, el mapa Leaflet, la PWA del chofer con Background Sync, sus rutas y las tools de IA.
