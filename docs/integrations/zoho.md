# Zoho Inventory - Integración

## Qué está implementado

Capa interna de lectura (READ) hacia Zoho Inventory, ubicada en:

```
src/modules/integrations/zoho/
├── config.ts        # Configuración validada con Zod (carga lazy)
├── auth.ts          # OAuth: access token vía refresh token, con cache en memoria
├── client.ts             # Cliente HTTP genérico (solo GET) para Zoho Inventory
├── sales-orders.ts       # listSalesOrders() y getSalesOrder(salesOrderId)
└── sales-orders-sync.ts  # Motor de polling: syncSalesOrders({ mode, maxDetailFetches })
```

## OAuth

- El access token se obtiene con `POST {ZOHO_ACCOUNTS_BASE_URL}/oauth/v2/token` usando el refresh token (`grant_type=refresh_token`).
- El token se cachea en memoria y se reutiliza mientras siga vigente (margen de 60 segundos antes de expirar).
- Se renueva automáticamente al expirar; las peticiones concurrentes comparten una sola renovación en curso.
- Ningún token ni secreto se loguea ni se expone en errores.

## Operaciones disponibles

- `listSalesOrders()` → `GET /inventory/v1/salesorders` (respuesta RAW de Zoho). Acepta opcionalmente `{ page, perPage }` para paginar; sin argumentos mantiene el comportamiento original.
- `getSalesOrder(salesOrderId)` → `GET /inventory/v1/salesorders/{id}` (respuesta RAW de Zoho). El id se valida como string numérico.

Todas las peticiones agregan automáticamente `organization_id` y el header `Authorization: Zoho-oauthtoken ...`.

## Variables de entorno requeridas

- `ZOHO_CLIENT_ID`
- `ZOHO_CLIENT_SECRET`
- `ZOHO_REFRESH_TOKEN`
- `ZOHO_ORGANIZATION_ID`
- `ZOHO_API_BASE_URL`
- `ZOHO_ACCOUNTS_BASE_URL`

La validación es lazy: solo ocurre cuando una operación Zoho la necesita, para no romper builds donde la integración no se usa.

## Endpoints internos temporales de verificación

Para comprobar la integración desde Railway sin exponerla como API pública, existen dos endpoints internos protegidos con el header `X-UNIK-API-Key` (debe coincidir con `process.env.UNIK_INTERNAL_API_KEY`):

- `GET /api/internal/zoho/sales-orders` → devuelve el listado RAW de Sales Orders.
- `GET /api/internal/zoho/sales-orders/{id}` → devuelve una Sales Order individual RAW.

Ambos son **solo READ**, no guardan información y requieren autenticación interna.

## Sales Orders Polling Sync

### Por qué polling y no webhooks

El polling nos da control total sobre cuándo y cuánto consultamos, es reintentable, no depende de que Zoho entregue eventos correctamente y no requiere exponer un endpoint público. Los webhooks quedan fuera de alcance por ahora.

### Detección de cambios mediante `last_modified_time`

El listado de Zoho actúa como detector de cambios. De cada Sales Order resumida solo leemos `salesorder_id` y `last_modified_time`; el resto del JSON no se modela. Ese timestamp se compara contra el estado persistido en `IntegrationEntityState`:

- No existe el registro → se crea con `needsSync = true`.
- `last_modified_time` cambió → se actualiza y `needsSync = true`.
- No cambió → solo se actualiza `lastSeenAt`.

`needsSync` **nunca** se pone en `false` por aparecer en el listado: solo se limpia cuando el detalle fue descargado y persistido correctamente.

### Modo `scan`

Recorre todas las páginas y refresca únicamente el estado resumido. No llama `getSalesOrder()` ni guarda snapshots. Sirve para medir el volumen real antes de descargar detalles.

### Modo `sync`

Hace el mismo scan completo y después descarga el detalle **solo** de las entidades con `needsSync = true`, guardando el JSON RAW en `IntegrationSnapshot`.

### Paginación

Se usa `per_page=200` empezando en `page=1`, avanzando mientras `page_context.has_more_page` sea verdadero. Existe un límite defensivo de páginas; si se alcanza, la ejecución falla de forma controlada en lugar de iterar indefinidamente.

### `maxDetailFetches`

Limita cuántos detalles se descargan por ejecución. Default `50`, rango permitido `1`–`200`. Las entidades pendientes restantes se quedan pendientes para ejecuciones posteriores, evitando consumir la cuota de API en el bootstrap inicial.

### Snapshots RAW e idempotencia

Cada snapshot guarda la respuesta completa de `getSalesOrder(id)` sin normalizar. La unicidad `(source, entityType, externalId, remoteModifiedAt)` impide guardar dos veces la misma versión. Snapshot y actualización de estado ocurren en una transacción, así que un estado nunca queda marcado como sincronizado sin su snapshot.

### Tablas técnicas

- `IntegrationEntityState` — estado de sincronización por entidad externa.
- `IntegrationSnapshot` — versiones RAW inmutables.
- `IntegrationSyncRun` — metadata técnica de cada ejecución (sin payloads ni datos personales).

### Endpoint de ejecución

`POST /api/internal/zoho/sync/sales-orders`, protegido con el mismo `X-UNIK-API-Key`.

```json
{ "mode": "scan" }
```

```json
{ "mode": "sync", "max_detail_fetches": 50 }
```

Devuelve únicamente un resumen técnico (`run_id`, `pages_scanned`, `records_seen`, `records_pending`, `details_fetched`, `details_failed`, `api_calls`). Nunca devuelve Sales Orders ni snapshots.

### Concurrencia

Existe una protección **en memoria** que evita dos sincronizaciones simultáneas dentro de la misma instancia. **No es un distributed lock**: con múltiples instancias o réplicas en Railway todavía podrían solaparse. La estrategia definitiva se decidirá junto con el scheduler.

## Lo que todavía NO existe

- Scheduler o ejecución automática: la sincronización se dispara manualmente. La frecuencia se decidirá después de medir un `scan` real.
- Webhooks de Zoho.
- Normalización o modelos de dominio de los datos de Zoho (solo se guardan snapshots RAW).
- Detección de eliminaciones: no se marca nada como borrado por no aparecer en el listado. `lastSeenAt` queda preparado para analizarlo después.
- Modelos de negocio (Sales Order, Customer, Item, Invoice, Payment, Vendor).
- Otros módulos de Zoho: solo Sales Orders.
- Endpoints HTTP públicos de UNIK para esta integración.
- Escritura hacia Zoho (POST/PUT/PATCH/DELETE).
