# Zoho (Inventory + Books) - Integración

Verificado contra el código el 2026-09-16 en el árbol de trabajo (la escritura de órdenes de venta llegó con el plan
de Operaciones y todavía no está en un commit). Lo que ocurre en producción no se verifica desde el repositorio.

## Resumen

- **Lectura:** 10 entidades de Zoho se sincronizan por polling a PostgreSQL (snapshot RAW + tablas normalizadas).
- **Escritura:** tres flujos escriben en Zoho desde UNIK:
  1. Paquetes y órdenes de envío (Zoho Inventory) — `src/modules/packages/packages-shipping-service.ts`.
  2. Cotizaciones (Zoho Books) — `src/modules/quotes/quotes-write-service.ts`.
  3. Órdenes de venta desde una cotización aceptada (Zoho Inventory) —
     `src/modules/crm/sales-order-write-service.ts`. **Apagada por omisión**: exige el permiso
     `crm.create_sales_order` y el indicador `crmSalesOrderWrite` de `IntegrationConfig('operations')`, que arranca en
     `false` porque el conjunto de campos de `POST /salesorders` no se ha validado contra la organización real.
- **`ZOHO_BOOKS_MOCK=true`** simula las tres escrituras sin llamar a Zoho.

## Estructura

```
src/modules/integrations/
├── integration-config-service.ts   # IntegrationConfig('zoho'): scheduler encendido/apagado, intervalos, cuota
├── integration-api-call-logger.ts  # IntegrationApiCall: bitácora de llamadas
└── zoho/
    ├── config.ts                    # variables ZOHO_* (validación lazy) e isZohoBooksMockEnabled()
    ├── auth.ts                      # OAuth: access token vía refresh token, cacheado
    ├── client.ts                    # zohoGet/Post/Put/Delete (Inventory), zohoBooksGet/Post/Put/Delete (Books), ZohoApiError
    ├── zoho-sync-engine.ts          # runSync (scan/hydrate/sync/quick), baselineEntity, presupuesto de llamadas, lock por entidad
    ├── zoho-scheduler-factory.ts    # scheduler genérico por entidad
    ├── <entidad>.ts                 # llamadas RAW a la API de cada entidad
    ├── <entidad>-sync.ts            # adaptador de sincronización
    ├── <entidad>-scheduler.ts       # scheduler de la entidad
    ├── packages-shipment-sweep.ts   # relectura de paquetes (barrido y bajo demanda)
    ├── shipments.ts                 # ESCRITURA Inventory: órdenes de envío y edición de paquete
    ├── estimates.ts                 # lectura + ESCRITURA Books: cotizaciones
    └── sales-orders.ts              # lectura + ESCRITURA Inventory: createSalesOrder (POST /salesorders)
```

Todas las peticiones agregan `organization_id` (Books usa `ZOHO_BOOKS_ORGANIZATION_ID` si existe) y el header
`Authorization: Zoho-oauthtoken ...`. Un error de Zoho se lanza como `ZohoApiError` (`operation`, `httpStatus`,
`zohoCode`, `zohoMessage`).

## OAuth

- El access token se obtiene con `POST {ZOHO_ACCOUNTS_BASE_URL}/oauth/v2/token` usando el refresh token (`grant_type=refresh_token`).
- Se cachea en memoria mientras siga vigente (margen de 60 s) y se renueva al expirar; las peticiones concurrentes comparten una sola renovación.
- Ningún token ni secreto se loguea ni se expone en errores.
- Las cotizaciones requieren el scope `ZohoBooks.estimates.ALL` en el refresh token (mensaje `ZOHO_AUTH` de `quotes-write-service.ts`).

## Variables de entorno

| Variable                                                                                                                            | Uso                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_ORGANIZATION_ID`, `ZOHO_API_BASE_URL`, `ZOHO_ACCOUNTS_BASE_URL` | Obligatorias cuando se llama a Zoho. Validación lazy en `config.ts`; el error sólo nombra las variables faltantes. |
| `ZOHO_BOOKS_ORGANIZATION_ID`                                                                                                        | Opcional. Organización de Books; por defecto `ZOHO_ORGANIZATION_ID`.                                               |
| `ZOHO_BOOKS_MOCK`                                                                                                                   | Opcional. `1`, `true`, `yes` u `on` activan el modo simulado (ver abajo). Se puede leer aunque falten las demás.   |
| `UNIK_INTERNAL_API_KEY`                                                                                                             | Valor esperado en el header `X-UNIK-API-Key` de los endpoints internos.                                            |

`ZOHO_SALES_ORDERS_SCHEDULER_ENABLED` es obsoleta: ningún archivo de `src/` la lee y en `.env.example` quedó
comentada y marcada como tal. Los schedulers se encienden desde `IntegrationConfig` (ver "Schedulers").

## Entidades sincronizadas (10)

Los 10 schedulers se arrancan en `src/instrumentation-node.ts`, escalonados cada 30 s.

| `entityType`      | Producto  | API RAW              | Adaptador                                               | Scheduler                      | Normalizador                                                | `quick` real |
| ----------------- | --------- | -------------------- | ------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------- | ------------ |
| `sales_order`     | Inventory | `sales-orders.ts`    | `sales-orders-sync.ts` (motor propio `syncSalesOrders`) | `sales-orders-scheduler.ts`    | `src/modules/sales/sales-orders-normalizer.ts`              | Sí           |
| `contact`         | Inventory | `contacts.ts`        | `contacts-sync.ts`                                      | `contacts-scheduler.ts`        | `src/modules/contacts/contacts-normalizer.ts`               | Sí           |
| `item`            | Inventory | `items.ts`           | `products-sync.ts`                                      | `products-scheduler.ts`        | `src/modules/products/products-normalizer.ts`               | Sí           |
| `package`         | Inventory | `packages.ts`        | `packages-sync.ts`                                      | `packages-scheduler.ts`        | `src/modules/packages/packages-normalizer.ts`               | Sí           |
| `invoice`         | Inventory | `invoices.ts`        | `invoices-sync.ts`                                      | `invoices-scheduler.ts`        | `src/modules/invoices/invoices-normalizer.ts`               | No           |
| `estimate`        | **Books** | `estimates.ts`       | `estimates-sync.ts`                                     | `estimates-scheduler.ts`       | `src/modules/quotes/quotes-normalizer.ts`                   | No           |
| `bill`            | Inventory | `bills.ts`           | `bills-sync.ts`                                         | `bills-scheduler.ts`           | `src/modules/bills/bills-normalizer.ts`                     | No           |
| `purchaseorder`   | Inventory | `purchase-orders.ts` | `purchase-orders-sync.ts`                               | `purchase-orders-scheduler.ts` | `src/modules/purchase-orders/purchase-orders-normalizer.ts` | No           |
| `customerpayment` | Inventory | `payments.ts`        | `payments-sync.ts`                                      | `payments-scheduler.ts`        | `src/modules/payments/payments-normalizer.ts`               | No           |
| `vendorcredit`    | Inventory | `vendor-credits.ts`  | `vendor-credits-sync.ts`                                | `vendor-credits-scheduler.ts`  | `src/modules/vendor-credits/vendor-credits-normalizer.ts`   | No           |

"`quick` real" = el adaptador declara `supportsModifiedTimeSort: true` (o, en órdenes de venta, su motor lee sólo
páginas recientes). Donde dice "No", `quick` se comporta como `sync`.

## Modos de sincronización

Motor genérico `runSync` (`zoho-sync-engine.ts`), `maxDetailFetches` 1–500 (default 50):

| Modo       | Qué hace                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `scan`     | Recorre todas las páginas del listado y actualiza sólo el estado resumido (`IntegrationEntityState`). Sin detalles.                          |
| `hydrate`  | Toma de la BD las entidades con `needsSync = true` y descarga su detalle. Sin listado.                                                       |
| `sync`     | `scan` completo + `hydrate`.                                                                                                                 |
| `quick`    | Lee sólo las `quickScanPages` páginas más recientes (default 2) + `hydrate`. Sin orden por fecha de modificación cae a `sync`.               |
| `baseline` | `baselineEntity`: marca como sincronizado el estado histórico pendiente sin descargar detalles ni crear snapshots. Una sola vez por entidad. |

Órdenes de venta (`sales-orders-sync.ts`): `scan`, `sync` y `quick` (páginas recientes), `maxDetailFetches` 1–200
(default 50), más `baseline`.

### Detección de cambios y snapshots

- El listado es el detector de cambios: se compara `last_modified_time` con `IntegrationEntityState`. Registro nuevo o
  timestamp distinto → `needsSync = true`; sin cambio → sólo `lastSeenAt`.
- `needsSync` sólo se limpia cuando el detalle se descargó y guardó.
- El detalle RAW se guarda en `IntegrationSnapshot` con unicidad `(source, entityType, externalId, remoteModifiedAt)`;
  cada ejecución deja metadata técnica en `IntegrationSyncRun` (sin payloads).
- Después del RAW, el normalizador de cada módulo escribe las tablas de negocio. Órdenes de venta:
  `CURRENT_SALES_ORDER_NORMALIZER_VERSION = 2`; un snapshot más viejo que la fila normalizada se salta (`STALE_SNAPSHOT`).

### Quién lanza cada modo

| Origen                               | Modo                                                                                                                                              | Dónde                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduler automático                 | `schedulerMode` (default `quick`); `sync` completo cuando el último `sync` completado tiene más de `fullScanIntervalMs` (default 12 h; 0 = nunca) | `zoho-scheduler-factory.ts`, `sales-orders-scheduler.ts`, `contacts-scheduler.ts`                                                                              |
| Botón "Actualizar" de cada workspace | `quick`, `maxDetailFetches` 30 (órdenes de venta: 20)                                                                                             | `src/app/app/{sales/orders,contacts/customers,contacts/vendors,products,packages,invoices,quotes,bills,purchase-orders,payments,vendor-credits}/sync/route.ts` |
| Administración → Integraciones       | órdenes de venta, `quick` por defecto (acepta `scan`/`sync`); permiso `integrations.manage`                                                       | `POST /app/admin/integrations/api/trigger`                                                                                                                     |
| Endpoints internos                   | ver tabla siguiente                                                                                                                               | `src/app/api/internal/zoho/`                                                                                                                                   |

### Schedulers

- Encendido: `IntegrationConfig('zoho').isEnabled` (fallback `schedulerEnabled: false`), editable desde administración.
- Un tick local cada `checkIntervalMs` (5 min) que sólo consulta PostgreSQL; la sincronización está pendiente cuando el
  último `sync`/`quick` completado supera `getEffectiveSyncInterval`: 30 min en horario laboral (8–19 h) y 2 h fuera de
  él. La hora se calcula con `UNIK_TIMEZONE` (America/Mexico_City según `integration-config-service.ts`).
- Tras un `FAILED`, espera `failedRetryCooldownMs` (30 min). Detalles por corrida: `schedulerMaxDetailFetches` (30).
- Presupuesto compartido de llamadas: `maxDailyCalls` 5000 y `maxCallsPerMinute` 40 (`withZohoRateBudget`).
- `SyncAlreadyRunningError` se trata como skip. Un fallo se loguea y el siguiente tick reevalúa; nunca tumba Next.js.

### Concurrencia (una sola réplica)

El lock por entidad y el presupuesto de llamadas viven en `globalThis` (`zoho-sync-engine.ts`), así que el scheduler y
las rutas manuales comparten un lock por proceso. Con 2+ réplicas cada una tendría su propio lock y presupuesto: antes
de escalar hace falta lock y cuota respaldados en BD.

## Endpoints internos

| Método | Ruta                                                                                                    | Auth                           | Cuerpo                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------- |
| `GET`  | `/api/internal/zoho/sales-orders`, `/api/internal/zoho/sales-orders/{id}`                               | `X-UNIK-API-Key`               | Devuelve RAW de Zoho (sólo lectura)                                               |
| `POST` | `/api/internal/zoho/sync/sales-orders`, `/api/internal/zoho/sync/contacts`                              | `X-UNIK-API-Key`               | `{ "mode": "scan" \| "sync" \| "quick" \| "baseline", "max_detail_fetches"?: n }` |
| `POST` | `/api/internal/zoho/sync/{bills,invoices,packages,payments,products,purchaseorders,vendorcredits}`      | Sesión + `integrations.manage` | `{ "mode": "baseline" }` o cualquier otro cuerpo → `sync`                         |
| `GET`  | mismas rutas `sync/*` de sesión                                                                         | Sesión + `integrations.view`   | Última corrida y corrida activa                                                   |
| `POST` | `/api/internal/zoho/normalize/{sales-orders,contacts}`                                                  | `X-UNIK-API-Key`               | Normaliza snapshots pendientes                                                    |
| `POST` | `/api/internal/zoho/normalize/{bills,invoices,packages,payments,products,purchaseorders,vendorcredits}` | Sesión + `integrations.manage` | Normaliza snapshots pendientes                                                    |
| `GET`  | `/api/internal/sales-orders`, `/api/internal/sales-orders/{id}`                                         | `X-UNIK-API-Key`               | Órdenes normalizadas; `Decimal` como string                                       |

Los endpoints de sync devuelven sólo un resumen técnico (`run_id`, páginas, registros, detalles, llamadas); nunca
datos de negocio ni snapshots.

## Escrituras hacia Zoho

Los tres flujos siguen la misma regla: **Zoho es la fuente de verdad**. Se escribe en Zoho primero y lo que UNIK guarda
es lo que Zoho devuelve o lo que se relee de Zoho, nunca un cálculo local (salvo el modo simulado).

### Paquetes y órdenes de envío (Zoho Inventory)

| Operación                                    | Llamada a Zoho (`shipments.ts`)                         | Función del servicio                                           | Ruta UNIK                                    | Permiso         |
| -------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------- | --------------- |
| Asignar transportista (crear orden de envío) | `POST /shipmentorders?package_ids=…&salesorder_id=…`    | `shipPackage` (sin `zohoShipmentId`)                           | `POST /app/packages/{id}/shipment`           | `packages.ship` |
| Editar el envío                              | `PUT /shipmentorders/{id}`                              | `shipPackage` (con `zohoShipmentId`)                           | `POST /app/packages/{id}/shipment`           | `packages.ship` |
| Marcar entregado                             | `POST /shipmentorders/{id}/status/delivered`            | `markPackageDelivered` (o `shipPackage` con `delivered: true`) | `POST /app/packages/{id}/shipment/delivered` | `packages.ship` |
| Cancelar envío                               | `DELETE /shipmentorders/{id}`                           | `cancelPackageShipment`                                        | `DELETE /app/packages/{id}/shipment`         | `packages.ship` |
| Editar fecha/notas del paquete               | `PUT /packages/{id}` (Zoho exige `date` y `line_items`) | `editPackage`                                                  | `POST /app/packages/{id}/edit`               | `packages.edit` |

Flujo **escribir → releer → parche local** (`packages-shipping-service.ts`):

1. Valida la entrada con Zod (`shipmentInputSchema`, `packageEditSchema`) y carga el paquete: no existe → 404; sin
   `zohoSalesOrderId` → 409.
2. Escribe en Zoho. Crear o editar una orden de envío **no** cambia el `last_modified_time` del paquete, por eso el
   paso 3 es obligatorio (comentario de `shipments.ts`).
3. Relee el paquete con `refreshPackageOnDemand(id, { force: true })` (`packages-shipment-sweep.ts`). Si responde
   `refreshed`, la fila local ya es exactamente lo que Zoho guardó (`source: 'zoho'`).
4. Si la relectura no puede hacerse ahora (`busy` por presupuesto o `failed`), aplica el cambio localmente y deja
   `lastDetailFetchedAt = null` para que el barrido de envíos lo relea pronto (`source: 'local'`).
5. Registra auditoría (`packages.shipped`, `packages.shipment_updated`, `packages.delivered`,
   `packages.shipment_cancelled`, `packages.edited`) con `metadata.source` = `zoho` | `local` | `mock`.

Errores: `PackageShippingError(message, status)`. Error de Zoho → 502 con el mensaje de Zoho (si menciona el número de
envío, sugiere activar la numeración automática); faltan credenciales → 503; paquete sin artículos leídos al editar → 409. Las rutas convierten `ZodError` en 400. Detalle del barrido de envíos: `docs/modules/packages.md`.

Pruebas: `src/modules/packages/packages-shipping-service.test.ts`.

### Cotizaciones (Zoho Books)

| Operación         | Llamada a Zoho (`estimates.ts`)                                                  | Función (`quotes-write-service.ts`)            | Permiso (`src/app/app/quotes/actions.ts`) |
| ----------------- | -------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| Crear             | `POST /estimates?ignore_auto_number_generation=false` (Zoho asigna el folio)     | `createQuote`                                  | `quotes.create`                           |
| Clonar            | igual que crear                                                                  | `cloneQuote`                                   | `quotes.create`                           |
| Editar            | `GET /estimates/{id}` (control de conflicto) + `PUT /estimates/{id}`             | `updateQuote`                                  | `quotes.edit`                             |
| Cambiar estado    | `POST /estimates/{id}/status/{sent\|accepted\|declined}` + `GET /estimates/{id}` | `changeQuoteStatus`                            | `quotes.change_status`                    |
| Enviar por correo | `POST /estimates/{id}/email` + `GET /estimates/{id}`                             | `emailQuote`                                   | `quotes.send_email`                       |
| Releer / PDF      | `GET /estimates/{id}` / PDF oficial                                              | `refreshQuoteFromZoho` / `getQuotePdfFromZoho` | —                                         |

`deleteEstimate` existe en `estimates.ts` pero nada lo llama. Las tools de IA de cotizaciones
(`src/modules/ai/tools/quotes-tools.ts`) importan `changeQuoteStatus` y `QuoteWriteError` de este mismo servicio.

Reglas del servicio:

- **Persistencia única:** toda respuesta de Zoho pasa por `persistEstimateFromZoho`: upsert en `IntegrationSnapshot`,
  `IntegrationEntityState` con `needsSync = false` y `normalizeQuoteSnapshot` con `force`. Lo local queda igual a lo
  que produciría la sincronización.
- **Folios:** nunca se envía `estimate_number`.
- **Conflictos:** `updateQuote` compara el `last_modified_time` de Zoho con `expectedRemoteModifiedAt`; si Zoho es más
  nuevo, guarda la versión de Zoho y lanza `QuoteConflictError` (409).
- **Errores** (`QuoteWriteError(code, status)`): `ZOHO_AUTH` 502 (HTTP 401 o código 57), `ZOHO_RATE_LIMIT` 503,
  `ZOHO_<código>` 502, `ZOHO_NOT_CONFIGURED` 503, `ZOHO_TIMEOUT` 504 ("verifica en Zoho antes de reintentar"),
  `UNEXPECTED` 500.

**Ledger de idempotencia `QuoteWriteRequest`** (`requestKey @unique`; el formulario genera una clave por sesión):

1. `createQuote`/`cloneQuote` insertan `{ requestKey, operation: 'create', status: 'pending' }`.
2. Si la clave ya existe (violación única `P2002`):
   - `completed` con `quoteId` → **replay**: devuelve esa cotización y no llama a Zoho.
   - `pending` con menos de 2 min (`PENDING_REQUEST_TTL_MS`) → `REQUEST_IN_PROGRESS` (409).
   - `failed`, o `pending` de 2 min o más → vuelve a `pending` y reintenta con la misma clave.
3. Éxito → `completed` con `quoteId` y `zohoEstimateId`. Error → `failed` con `errorMessage` (best-effort: si esa
   escritura falla, se reporta el error original).

Pruebas: `src/modules/quotes/quotes-write-service.test.ts`.

### Órdenes de venta desde una cotización aceptada (Zoho Inventory)

Entregado por la Entrega 5 del plan de Operaciones. **Apagado por omisión**: con credenciales reales hacen falta el
permiso `crm.create_sales_order` y el indicador `crmSalesOrderWrite` de `IntegrationConfig('operations')` (arranca en
`false`; ver `src/modules/operations/operations-config.ts`). Con `ZOHO_BOOKS_MOCK=true` el indicador no se exige: el
permiso sí.

| Operación                              | Llamada a Zoho (`sales-orders.ts`)                      | Función (`sales-order-write-service.ts`)                 | Ruta UNIK                                                           | Permiso                  |
| -------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------ |
| Crear la orden de una cotización       | `POST /salesorders?ignore_auto_number_generation=false` | `createSalesOrderFromQuote`                              | `POST /app/areas/{areaKey}/api/ventas/quotes/{quoteId}/sales-order` | `crm.create_sales_order` |
| Relectura y conciliación (5 s después) | `GET /salesorders/{id}`                                 | `runSalesOrderReadback` (job `crm.sales_order_readback`) | —                                                                   | — (job del sistema)      |

La misma escritura la ejecuta la tool de IA `createSalesOrderFromQuote` (`src/modules/ai/tools/crm-tools.ts`), que es
`enabledByDefault: false`, tiene `effect: 'business_write'` y nunca la corre un agente automático
(`src/modules/agents/permissions.ts` excluye `crm.create_sales_order` a propósito: crear la orden es decisión de una
persona).

Reglas del servicio:

- **Folios:** nunca se envía `salesorder_number`; Zoho asigna el folio. El folio de la cotización viaja como
  `reference_number` (`buildSalesOrderPayload` en `sales-order-rules.ts`: `customer_id`, `date`, `line_items`,
  `discount_type` y, si existen, `reference_number`, `salesperson_id`/`salesperson_name`, `notes`, `terms`,
  `is_discount_before_tax`, `discount`, `shipping_charge`).
- **La cotización debe estar `accepted`** y se relee de Zoho antes de convertirla (Zoho es la fuente de verdad).
- **Nunca dos órdenes para una cotización:** se rechaza (`quote_already_converted`, 409) si ya hay una solicitud
  completada para esa cotización o una orden sincronizada que lleve su folio como referencia.
- **Persistencia única:** la respuesta se guarda como `IntegrationSnapshot` y se normaliza con el normalizador de
  órdenes de venta existente — el mismo camino que la sincronización —, así que la fila `SalesOrder` dispara el gancho
  que abre el expediente operativo. La oportunidad queda ligada y ganada, con actividad `order_created`.
- **Errores:** `CrmError(message, code, status)` — `invalid_payload` 400, `forbidden` 403, `not_found` 404,
  `quote_not_accepted` / `quote_already_converted` / `request_key_conflict` 409, `module_disabled` 503,
  `zoho_shape` 502.

**Ledger de idempotencia `SalesOrderWriteRequest`** (`requestKey @unique`), el segundo usuario del ledger genérico
`src/modules/integrations/zoho/write-request-ledger.ts` (mismas reglas que `QuoteWriteRequest`: replay de una llave
completada, 409 mientras está en vuelo, reintento de una fallida o vencida, y la llave no se reutiliza para otra
cotización ni otra persona). La ruta de UI arma la llave como `ui:so:{quoteId}:{userId}` — por cotización y persona,
nunca por día, así que un reintento cualquier día es la misma solicitud. En cuanto Zoho devuelve el id, éste se
escribe en el ledger **antes** de cualquier otro paso: un reintento tras una falla local relee esa orden en vez de
crear otra.

**Relectura (`crm.sales_order_readback`)**: 5 segundos después compara la copia de Zoho con la cotización (cliente,
referencia, conceptos, cantidades y total ±1). Si difieren o la orden no está, abre la incidencia
`sales_order_readback_mismatch` ("Orden de venta distinta en Zoho") para Ventas; con Zoho real además re-normaliza la
copia fresca.

Pruebas: `src/modules/crm/sales-order-write-service.test.ts` (permiso, cotización no aceptada, replay de la llave,
reintento tras falla local, conversión doble rechazada, con Zoho simulado y con el cliente de Zoho mockeado) y
`src/modules/crm/sales-order-rules.test.ts` (`buildSalesOrderPayload`, `buildMockSalesOrderResponse` y la comparación
de la relectura).

## Modo simulado `ZOHO_BOOKS_MOCK`

`isZohoBooksMockEnabled()` (`config.ts`). Cuando está activo:

| Área                                              | Comportamiento                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cotizaciones (`quotes-write-service.ts`)          | `mockEstimateResponse` arma localmente una respuesta con forma de Zoho (folio `MOCK-00001` a partir del conteo de `Quote`, totales calculados localmente) y la persiste por el mismo camino; los cambios de estado parten del último snapshot; `refreshQuoteFromZoho` devuelve lo local; el PDF no está disponible (`MOCK_NO_PDF`, 503). El ledger `requestKey` funciona igual. |
| Sync de cotizaciones (`estimates-sync.ts`)        | `listPage` devuelve una lista vacía: no se lee nada de Zoho Books.                                                                                                                                                                                                                                                                                                              |
| Vendedores (`quotes-salespersons.ts`)             | No consulta la lista de vendedores de Zoho.                                                                                                                                                                                                                                                                                                                                     |
| Tools de IA de cotizaciones (`quotes-tools.ts`)   | Respetan el modo (sin envío real ni PDF de Zoho).                                                                                                                                                                                                                                                                                                                               |
| Paquetes (`packages-shipping-service.ts`)         | Las cuatro operaciones escriben el cambio directo en la BD, sin relectura; ids simulados `mock-<timestamp>` y `NE-MOCK-<paquete>`; auditoría con `source: 'mock'`.                                                                                                                                                                                                              |
| Órdenes de venta (`sales-order-write-service.ts`) | `buildMockSalesOrderResponse` arma localmente una respuesta con forma de Zoho (folio `SO-MOCK-00001` a partir del conteo de `SalesOrder` con ese prefijo) y la persiste por el mismo camino; el indicador `crmSalesOrderWrite` no se exige (el permiso sí); la relectura compara contra el último snapshot y no re-normaliza. El ledger `requestKey` funciona igual.            |

El modo **no** detiene la sincronización de lectura de las entidades de Inventory: si el scheduler está encendido y
hay credenciales, sigue llamando a Zoho.

## Lo que todavía NO existe

- Webhooks de Zoho (los webhooks de `src/app/api/webhooks/` son de voz, Telegram y Twilio).
- Detección de eliminaciones: nada se marca borrado por no aparecer en el listado (el barrido de paquetes sólo marca
  como leído un paquete que responde 404).
- Escritura hacia Zoho de facturas, contactos, productos, pagos, órdenes de compra, facturas de proveedor y notas de
  crédito. (Crear una orden de venta desde una cotización **sí** existe desde la Entrega 5, pero sólo se ha ejercido
  con `ZOHO_BOOKS_MOCK=true`: el conjunto de campos que acepta la organización real está sin validar y por eso el
  indicador `crmSalesOrderWrite` arranca apagado.)
- Borrar cotizaciones desde UNIK (`deleteEstimate` sin uso).
- Lock y presupuesto de llamadas compartidos entre réplicas.
- Estado en producción (scheduler encendido, migraciones, credenciales): no verificable desde el repositorio.
