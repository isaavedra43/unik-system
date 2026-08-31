# UNIK System - Current State

## Architecture

- **Modular Monolith**
- Un solo repositorio.
- Frontend y backend coexisten dentro de Next.js.

## Infrastructure

- **GitHub**: fuente del repositorio y del deployment.
- **Railway**: entorno de deployment actual.
- **PostgreSQL**: base de datos conectada y operativa.

## Currently Working

- Deployment automático GitHub → Railway.
- Aplicación Next.js ejecutándose en Railway.
- Dominio público asignado por Railway.
- Prisma Client generado y operativo.
- Conexión PostgreSQL verificada.
- `GET /api/health` responde correctamente.
- Health check devuelve `database: connected` cuando la conexión es exitosa.

## Phase 1 - Zoho Read Integration (implementada)

Capa interna en `src/modules/integrations/zoho/`:

- `config.ts` — configuración validada con Zod, carga lazy.
- `auth.ts` — OAuth vía refresh token, access token cacheado en memoria con renovación automática y una sola renovación concurrente.
- `client.ts` — cliente HTTP genérico solo GET hacia Zoho Inventory.
- `sales-orders.ts` — `listSalesOrders({ page, perPage })` y `getSalesOrder(id)`, devolviendo JSON RAW.

## Phase 2 - Railway Verification (completada)

Endpoints internos protegidos con `X-UNIK-API-Key`, verificados en Railway contra Zoho real:

- `GET /api/internal/zoho/sales-orders`
- `GET /api/internal/zoho/sales-orders/{id}`

## Phase 3 - Sales Orders Polling Sync (verificada en producción)

- Motor de polling en `sales-orders-sync.ts` con modos `scan`, `sync` y `baseline`.
- Detección de cambios mediante `last_modified_time` del listado.
- Snapshots RAW, límite `maxDetailFetches` (default 50, máx 200).
- Modo `baseline` para convertir un `scan` histórico en punto de partida sin descargar detalles ni crear snapshots.
- Endpoint `POST /api/internal/zoho/sync/sales-orders`.
- Migración Prisma versionada y aplicada.
- Baseline histórico ejecutado (22.954 Sales Orders) y protegido contra reejecución.
- Sync real verificado: una Sales Order modificada en Zoho quedó almacenada en `IntegrationSnapshot`.

## Phase 4 - Internal Scheduler (implementada, pendiente de activación)

- `src/instrumentation.ts` arranca `startSalesOrdersScheduler()` una vez por instancia, solo en runtime Node.
- `sales-orders-scheduler.ts` hace un tick cada 5 min que consulta **solo PostgreSQL** y sincroniza Zoho como máximo cada 60 min.
- `IntegrationSyncRun` (`mode = 'sync'`, `status = 'COMPLETED'`) es la fuente durable, así que un reinicio no reinicia el reloj.
- Sin Railway Cron Service y sin segundo servicio: todo vive dentro de `unik-system`.
- Feature flag `ZOHO_SALES_ORDERS_SCHEDULER_ENABLED`, desactivado por defecto.
- El lock de sincronización se guarda en `globalThis` para que scheduler y endpoint manual compartan un único lock por proceso.

**FASE 4 internal scheduler implemented, pending production enablement.** Requiere una sola réplica del servicio web.

## External Zoho Verification

Fuera del código de UNIK se probaron manualmente:

- Zoho Self Client.
- OAuth authorization.
- Refresh token y access token.
- Alcance `ZohoInventory.salesorders.READ`.
- GET de Sales Orders y GET de Sales Order por ID.

## Database

- PostgreSQL está conectado.
- Existen **3 modelos técnicos de integración**: `IntegrationEntityState`, `IntegrationSnapshot`, `IntegrationSyncRun`.
- Existe una migración versionada, ya aplicada en producción.
- **No existen modelos de negocio** ni tablas de negocio.
- Los datos de Zoho solo se guardarían como snapshots RAW, sin normalizar.

## Not Implemented Yet

- Activación del scheduler interno en producción (`ZOHO_SALES_ORDERS_SCHEDULER_ENABLED=true` en Railway).
- Normalización de datos de Zoho.
- Detección de eliminaciones.
- Webhooks de Zoho.
- Modelos de negocio (Sales Order, Customer, Item, Invoice, Payment, Vendor).
- Otros módulos de Zoho fuera de Sales Orders.
- Módulos de ventas, compras, inventario, logística, finanzas, reportes, usuarios e IA.
- Frontend funcional.
- Autenticación de usuarios.

## Endpoints

| Método | Ruta                                   | Auth             |
| ------ | -------------------------------------- | ---------------- |
| `GET`  | `/api/health`                          | No               |
| `GET`  | `/api/internal/zoho/sales-orders`      | `X-UNIK-API-Key` |
| `GET`  | `/api/internal/zoho/sales-orders/{id}` | `X-UNIK-API-Key` |
| `POST` | `/api/internal/zoho/sync/sales-orders` | `X-UNIK-API-Key` |

## Next Planned Phase

Activar el scheduler interno en Railway (`ZOHO_SALES_ORDERS_SCHEDULER_ENABLED=true`) y observar el consumo real de API durante varios ciclos antes de decidir la normalización de datos.
