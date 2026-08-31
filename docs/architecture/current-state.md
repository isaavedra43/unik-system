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

## Phase 3 - Sales Orders Polling Sync (implementada, no desplegada)

- Motor de polling en `sales-orders-sync.ts` con modos `scan`, `sync` y `baseline`.
- Detección de cambios mediante `last_modified_time` del listado.
- Snapshots RAW, límite `maxDetailFetches` (default 50, máx 200).
- Modo `baseline` para convertir un `scan` histórico en punto de partida sin descargar detalles ni crear snapshots.
- Endpoint `POST /api/internal/zoho/sync/sales-orders`.
- `scripts/cron/zoho-sales-orders-sync.mjs` y `npm run cron:zoho-sales-orders` listos para Railway Cron.
- Motor de sincronización soporta `scan`, `sync`, `baseline` manual y runner de cron como cliente del mismo endpoint vía HTTP.
- El Railway Cron Service es un proceso separado; el lock en memoria (`syncInProgress`) vive únicamente en el Web Service y es suficiente mientras haya una sola réplica.
- Migración Prisma versionada, generada con tooling oficial.

**Todavía no desplegado ni probado en producción.** La migración no ha sido aplicada a la base de Railway. El servicio de cron en Railway todavía debe configurarse manualmente.

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
- Existe una migración versionada, todavía **no aplicada** en producción.
- **No existen modelos de negocio** ni tablas de negocio.
- Los datos de Zoho solo se guardarían como snapshots RAW, sin normalizar.

## Not Implemented Yet

- Servicio de cron de Railway configurado en producción (el runner está listo, pero aún no se activa).
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

Desplegar y medir la FASE 3 en Railway (aplicar migración, ejecutar `scan`, medir volumen y consumo de API) antes de decidir la estrategia de scheduling.
