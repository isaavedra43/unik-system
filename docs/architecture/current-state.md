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

## Phase 5 - Business Normalization (implementada, pendiente de migración y verificación)

- Nuevos modelos `SalesOrder` y `SalesOrderItem` en `prisma/schema.prisma`.
- Migración versionada aditiva `20260901000000_add_business_sales_orders`.
- Metadata de normalización en `IntegrationSnapshot`: `normalizedAt`, `normalizationVersion`, `normalizationErrorCode`.
- `src/modules/sales/sales-orders-normalizer.ts` mapea Zoho RAW a datos de negocio con Zod + `Prisma.Decimal`.
- `CURRENT_SALES_ORDER_NORMALIZER_VERSION = 1`.
- Normalización automática después de cada sync y scheduler tick.
- Endpoint manual `POST /api/internal/zoho/normalize/sales-orders`.
- Endpoints de lectura `GET /api/internal/sales-orders` y `GET /api/internal/sales-orders/{id}`.
- Serialización de `Decimal` como string.
- No backfill de 23.000 históricas; no se toca `IntegrationSnapshot.payload`.

**FASE 5 implementation complete, pending production migration, deployment and verification with real Zoho payloads.**

## Phase 6.1 - Authentication / Users / Roles / Permissions (implementada, pendiente de migración, bootstrap y verificación en producción)

- Sesiones respaldadas por PostgreSQL (`AuthSession` guarda solo SHA-256 del token; el token vive en cookie HttpOnly `unik_session`, SameSite=Lax, Secure en producción, TTL 12 h).
- Modelos nuevos: `User`, `Role`, `UserRole`, `RolePermission`, `AuthSession`, `AuditLog` (migración aditiva `20260831190000_add_auth_foundation`).
- Passwords con bcryptjs (cost 12); política mínimo 12 caracteres; contraseñas temporales generadas con `crypto.randomBytes`, mostradas una sola vez y nunca persistidas en claro.
- Lockout: 5 intentos fallidos → 15 minutos de bloqueo (campos en `User`, sin Redis).
- Permission Registry code-first (`src/modules/auth/permissions.ts`): permisos `users.*` y `roles.*`; `RolePermission.permissionKey` se valida contra el registry. Agregar módulos futuros no requiere migración.
- `super_admin` (rol de sistema) bypass total de permisos, protegido contra delete/edición, con protecciones de último super admin y escalación de privilegios.
- Autorización deny-by-default server-side: `requireAuthenticatedUser`, `requirePermission`, `assertPermission`, etc. (`src/modules/auth/authorization.ts`).
- UI: `/login`, `/change-password` (forzado), `/app` layout protegido, `/app/account/security`, `/app/admin/users`, `/app/admin/roles`, `/app/admin/roles/[id]`; Server Actions + service layer.
- Bootstrap del primer super_admin: `POST /api/internal/auth/bootstrap` (X-UNIK-API-Key, solo con 0 usuarios, luego 409 permanente).
- Audit log de eventos administrativos/seguridad (sin UI todavía).

**FASE 6.1 Authentication / Users / Roles / Permissions implemented, pending production migration/bootstrap/verification.**

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
- Existen **2 modelos de negocio iniciales**: `SalesOrder`, `SalesOrderItem`.
- Existen **6 modelos de autenticación/autorización**: `User`, `Role`, `UserRole`, `RolePermission`, `AuthSession`, `AuditLog`.
- Migraciones versionadas: `20260831182914_add_integration_sync_foundation`, `20260831183000_add_business_sales_orders` y `20260831190000_add_auth_foundation`.
- Los datos de Zoho se guardan como snapshots RAW + modelos de negocio normalizados.

## Not Implemented Yet

- Activación del scheduler interno en producción (`ZOHO_SALES_ORDERS_SCHEDULER_ENABLED=true` en Railway).
- Migración/bootstrap/verificación de FASE 6.1 en producción.
- Detección de eliminaciones.
- Webhooks de Zoho.
- Modelos de negocio adicionales (Customer, Item, Invoice, Payment, Vendor).
- Otros módulos de Zoho fuera de Sales Orders.
- Módulos de ventas, compras, inventario, logística, finanzas, reportes e IA (frontend de negocio).
- UI de Audit Log.

## Endpoints

| Método | Ruta                                        | Auth             |
| ------ | ------------------------------------------- | ---------------- |
| `GET`  | `/api/health`                               | No               |
| `GET`  | `/api/internal/zoho/sales-orders`           | `X-UNIK-API-Key` |
| `GET`  | `/api/internal/zoho/sales-orders/{id}`      | `X-UNIK-API-Key` |
| `POST` | `/api/internal/zoho/sync/sales-orders`      | `X-UNIK-API-Key` |
| `POST` | `/api/internal/zoho/normalize/sales-orders` | `X-UNIK-API-Key` |
| `GET`  | `/api/internal/sales-orders`                | `X-UNIK-API-Key` |
| `GET`  | `/api/internal/sales-orders/{id}`           | `X-UNIK-API-Key` |
| `POST` | `/api/internal/auth/bootstrap`              | `X-UNIK-API-Key` |

Rutas web autenticadas por sesión (cookie `unik_session`): `/login`, `/change-password`, `/app`, `/app/account/security`, `/app/admin/users`, `/app/admin/roles`, `/app/admin/roles/[id]`.

## Next Planned Phase

Activar el scheduler interno en Railway (`ZOHO_SALES_ORDERS_SCHEDULER_ENABLED=true`) y observar el consumo real de API durante varios ciclos antes de decidir la normalización de datos.

## Phase 8 — Almacenamiento seguro, asistente extensible y comunicaciones (implementado, pendiente de migración y validación externa)

Plan maestro ejecutado en 16 entregas (ver `docs/pilot-runbook.md` para el orden de activación):

- **Almacenamiento** (`src/modules/storage`, `docs/storage.md`): Cloudflare R2 privado vía AWS SDK v3, registro central `StorageObject` + `UploadSession`, subida directa multipart a cuarentena, validación por firma real del formato, promoción a clave final, descargas con URL firmada corta o streaming autenticado con `Range`, migración reanudable de archivos heredados, respaldo incremental a cuenta separada y restauración con checksum. Cola durable de jobs en PostgreSQL (`src/modules/jobs`) y eventos SSE con cursor (`src/modules/realtime`).
- **Extensiones** (`src/modules/extensions`, `docs/extensions.md`): ejecutor común con clasificación de efectos y propuestas de aprobación, conexiones cifradas (AES-256-GCM) con OAuth PKCE, control de egreso (HTTPS, dominios, DNS, redirecciones), MCP remoto (SDK oficial), APIs tipadas desde OpenAPI, skills declarativas y plugins versionados.
- **Copiloto** (`src/modules/copilot`, `docs/copilot.md`): modos, personalización, memoria personal con aprendizaje controlado, biblioteca aprobada con búsqueda de texto completo.
- **Comunicaciones omnicanal** (`src/modules/comms`, `docs/communications.md`), **campañas** (`src/modules/campaigns`), **voz LiveKit/Twilio** (`src/modules/voice`, `docs/voice.md`).
- Retirados (2026-09-12): estudio visual, solicitudes internas, cotizaciones locales y mapa de pendientes; sus tablas se eliminan en la migración `20260912130000_drop_studio_requests_quotes`.

Migraciones: `20260912100000`, `20260912110000`, `20260912120000` (aditivas) y `20260912130000` (elimina tablas de módulos retirados). Ninguna aplicada; ningún servicio externo validado.
