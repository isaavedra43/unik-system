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
- `client.ts` — cliente HTTP genérico hacia Zoho Inventory y Books. En la Fase 1 sólo hacía GET; hoy acepta
  `GET | POST | PUT | DELETE` porque existen escrituras de paquetes/órdenes de envío y cotizaciones (ver
  `docs/integrations/zoho.md` → "Escrituras hacia Zoho").
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
- Se enciende con `IntegrationConfig('zoho').isEnabled` (desactivado por defecto, editable en `/app/admin/integrations`).
  El flag original `ZOHO_SALES_ORDERS_SCHEDULER_ENABLED` ya no lo lee el código y está marcado como obsoleto en `.env.example`.
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

Conteo verificado en `prisma/schema.prisma` del commit `6e24501` (2026-09-15): **104 modelos** y **33 migraciones**
en `prisma/migrations/` (de `20260831182914_add_integration_sync_foundation` a `20260914170000_package_shipment_fields`).

| Dominio                                  | Modelos | Cuáles                                                                                                                                                                                                                               |
| ---------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Integración (técnicos)                   | 5       | `IntegrationEntityState`, `IntegrationSnapshot`, `IntegrationSyncRun`, `IntegrationConfig`, `IntegrationApiCall`                                                                                                                     |
| Autenticación y auditoría                | 6       | `User`, `Role`, `UserRole`, `RolePermission`, `AuthSession`, `AuditLog`                                                                                                                                                              |
| Negocio normalizado desde Zoho           | 16      | `SalesOrder`, `SalesOrderItem`, `Contact`, `Product`, `Package`, `PackageItem`, `Invoice`, `InvoiceItem`, `Quote`, `QuoteItem`, `QuoteWriteRequest`, `CustomerPayment`, `PurchaseOrder`, `PurchaseOrderItem`, `Bill`, `VendorCredit` |
| Workspaces, seguimiento y notificaciones | 7       | `UserTablePreference`, `TableView`, `EntityWatch`, `EntityChangeEvent`, `Notification`, `PushSubscription`, `UserNotificationSettings`                                                                                               |
| Asistente IA, propuestas y copiloto      | 12      | `AiUserDigest`, `AiConversation`, `AiMessage`, `AiMessageFeedback`, `AiToolCall`, `AiApiCall`, `AiAttachment`, `AiArtifact`, `AiConfig`, `AiProposal`, `AiUserPreference`, `AiMemory`                                                |
| Biblioteca aprobada                      | 3       | `KnowledgeSource`, `KnowledgeSourceVersion`, `KnowledgeChunk`                                                                                                                                                                        |
| Chat interno                             | 27      | `InternalChat*`                                                                                                                                                                                                                      |
| Almacenamiento, jobs y realtime          | 5       | `StorageObject`, `UploadSession`, `StorageConfig`, `BackgroundJob`, `RealtimeEvent`                                                                                                                                                  |
| Extensiones y skills                     | 9       | `Extension`, `ExtensionVersion`, `ExtensionCapability`, `ExtensionConnection`, `OAuthState`, `ExtensionExecution`, `Skill`, `SkillRun`, `UsageMeter`                                                                                 |
| Comunicaciones omnicanal                 | 8       | `CommAccount`, `CommContact`, `CommConversation`, `CommMessage`, `CommNote`, `Responsible`, `Commitment`, `ConsentRecord`                                                                                                            |
| Campañas                                 | 2       | `Campaign`, `CampaignRecipient`                                                                                                                                                                                                      |
| Voz                                      | 4       | `VoiceCall`, `VoiceParticipant`, `VoiceTranscriptSegment`, `VoiceSupervision`                                                                                                                                                        |

- Los datos de Zoho se guardan como snapshots RAW (`IntegrationSnapshot`) + modelos de negocio normalizados (ver `docs/integrations/zoho.md`).
- 5 migraciones contienen `DROP TABLE`/`DROP COLUMN` (limpieza de tablas retiradas): `20260909210000_drop_legacy_zoho_inventory_tables`, `20260909230000_drop_all_obsolete_tables`, `20260910160000_expand_modules_add_payments_po_bills_vendorcredits`, `20260912100000_add_object_storage_jobs_realtime` y `20260912130000_drop_studio_requests_quotes`.

### Modelos del plan de Operaciones (esquema listo, sin commit y sin aplicar)

Verificado el 2026-09-15 en el árbol de trabajo (sin commit): `prisma/schema.prisma` tiene **189 modelos** (104 + 85
nuevos) y hay **41 migraciones**. Las 8 nuevas son aditivas y NO están aplicadas en ninguna base real; el orden de
aplicación y su contenido están en `docs/pilot-runbook.md` §11.1.

| Dominio (sección del esquema) | Modelos | Migración                                                                    |
| ----------------------------- | ------- | ---------------------------------------------------------------------------- |
| Núcleo operativo              | 16      | `20260916120000_add_operations_core`                                         |
| Capa de agentes               | 1       | `20260916120100_add_agents_layer` (más columnas en `User`, chat interno, IA) |
| Inventario progresivo         | 9       | `20260916130000_add_inventory_logistics_core`                                |
| Logística núcleo              | 6       | `20260916130000_add_inventory_logistics_core`                                |
| Compras y Sourcing            | 17      | `20260916140000_add_purchases`                                               |
| Manufactura                   | 9       | `20260916140100_add_manufacturing`                                           |
| Contabilidad interna          | 15      | `20260916150000_add_finance`                                                 |
| Ventas / CRM                  | 5       | `20260916150100_add_crm`                                                     |
| Dashboards y Control Tower    | 7       | `20260916160000_add_dashboards_control_tower`                                |

Sólo existe el esquema: los servicios, rutas y UI de estos dominios todavía no están implementados.

## Not Implemented Yet

Verificado contra el código el 2026-09-15 (commit `6e24501`).

- **Operaciones (plan UNIK Neural Operations): en implementación.** Núcleo operativo (expedientes, work items, eventos, supervisor), inventario progresivo, logística, capa de agentes IA por área y Control Tower. Hasta ahora (sin commit) sólo existen la Entrega 0 (navegación en `nav-config.ts`, kit de dashboard, cambios aditivos de infraestructura, humo `e2e/`) y el esquema Prisma con sus 8 migraciones sin aplicar; no hay servicios, rutas ni UI de estos dominios.
- Módulos de dominio propios (sin Zoho) de compras, inventario, logística, contabilidad interna y reportes: `src/modules/{purchases,inventory,logistics,finance,reports}` sólo contienen `.gitkeep`. Los datos de Zoho de esas áreas sí se leen (`purchase-orders`, `bills`, `vendor-credits`, `payments`, `invoices`, `packages`).
- Escritura hacia Zoho fuera de paquetes/órdenes de envío y cotizaciones; en particular, crear órdenes de venta.
- Webhooks de Zoho (los webhooks existentes en `src/app/api/webhooks/` son de voz, Telegram y Twilio).
- Detección de eliminaciones en Zoho durante la sincronización.
- UI general de `AuditLog`: sólo existe la auditoría del chat (`/app/admin/chat/api/audit`).
- Escalamiento a varias réplicas: locks de sincronización y presupuesto de llamadas a Zoho viven en `globalThis`.
- Integración continua: no hay `.github/workflows`. Existe humo local de Playwright en `e2e/smoke.spec.ts`, que no corre automáticamente.
- El scheduler de Zoho se enciende con `IntegrationConfig('zoho').isEnabled` (default apagado); `ZOHO_SALES_ORDERS_SCHEDULER_ENABLED` ya no la lee el código. El estado en producción (scheduler, migraciones aplicadas, bootstrap) no es verificable desde el repositorio.

## Endpoints

Rutas bajo `src/app/api/` verificadas contra el código el 2026-09-15 (39 archivos `route.ts`).

| Método                  | Ruta                                                                                                    | Auth                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET`                   | `/api/health`                                                                                           | No                                                                        |
| `GET`                   | `/api/files/media/{token}`                                                                              | Token firmado de medio (`verifyMediaToken`)                               |
| `GET`                   | `/api/files/shared/{token}`                                                                             | Token firmado de artefacto compartido (`verifyShareToken`)                |
| `POST`                  | `/api/internal/auth/bootstrap`                                                                          | `X-UNIK-API-Key` (sólo con 0 usuarios)                                    |
| `POST`, `DELETE`        | `/api/internal/dev/seed-demo-data`                                                                      | `NEXT_PUBLIC_ALLOW_DEMO_SEED=true` (sólo local) + sesión de `super_admin` |
| `GET`                   | `/api/internal/sales-orders`, `/api/internal/sales-orders/{id}`                                         | `X-UNIK-API-Key`                                                          |
| `GET`                   | `/api/internal/storage/jobs/{id}`                                                                       | `X-UNIK-API-Key`                                                          |
| `GET`, `POST`           | `/api/internal/storage/migrate`                                                                         | `X-UNIK-API-Key`                                                          |
| `GET`                   | `/api/internal/voice/agent/{context,state}`                                                             | `X-UNIK-API-Key`                                                          |
| `POST`                  | `/api/internal/voice/agent/{event,tool,transcript}`                                                     | `X-UNIK-API-Key`                                                          |
| `GET`                   | `/api/internal/zoho/sales-orders`, `/api/internal/zoho/sales-orders/{id}`                               | `X-UNIK-API-Key`                                                          |
| `POST`                  | `/api/internal/zoho/sync/{sales-orders,contacts}`                                                       | `X-UNIK-API-Key`                                                          |
| `POST`                  | `/api/internal/zoho/normalize/{sales-orders,contacts}`                                                  | `X-UNIK-API-Key`                                                          |
| `GET`, `POST`           | `/api/internal/zoho/sync/{products,packages,invoices,bills,purchaseorders,payments,vendorcredits}`      | Sesión (`unik_session`) + permiso de la entidad                           |
| `POST`                  | `/api/internal/zoho/normalize/{products,packages,invoices,bills,purchaseorders,payments,vendorcredits}` | Sesión (`unik_session`) + permiso de la entidad                           |
| `GET`, `POST`, `DELETE` | `/api/mcp`                                                                                              | `Authorization: Bearer <UNIK_MCP_API_KEY>`                                |
| `POST`                  | `/api/webhooks/telegram/{accountId}`                                                                    | Secreto de Telegram (`secret_token`)                                      |
| `POST`                  | `/api/webhooks/twilio/messaging`                                                                        | Firma `X-Twilio-Signature`                                                |
| `POST`                  | `/api/webhooks/voice/twilio`                                                                            | Firma `X-Twilio-Signature`                                                |
| `POST`                  | `/api/webhooks/voice/livekit`                                                                           | Firma de webhook de LiveKit (`WebhookReceiver`)                           |

Las rutas web y sus APIs bajo `/app/**` (`/login`, `/change-password`, `/app/**`, incluidas las `.../api` y `.../sync`
de cada módulo) se autentican por sesión (cookie `unik_session`) y validan permisos en el servidor; la lista completa
la imprime `npm run build`.

## Next Planned Phase

Plan UNIK Neural Operations (`/Users/israel/.claude/plans/plan unik system completo.md`, sección 8): tras la Entrega 0
sigue la Entrega 1 (núcleo operativo, identidades IA y "Mi trabajo"), todo detrás de flags apagados en
`IntegrationConfig('operations')` y `AiSettings.agents.enabled=false`. Las verificaciones pendientes de producción se
acumulan en `docs/pilot-runbook.md` §11. (La activación del scheduler de Zoho ya no depende de una variable de entorno:
se hace desde `IntegrationConfig('zoho')`.)

## Phase 8 — Almacenamiento seguro, asistente extensible y comunicaciones (implementado, pendiente de migración y validación externa)

Plan maestro ejecutado en 16 entregas (ver `docs/pilot-runbook.md` para el orden de activación):

- **Almacenamiento** (`src/modules/storage`, `docs/storage.md`): Cloudflare R2 privado vía AWS SDK v3, registro central `StorageObject` + `UploadSession`, subida directa multipart a cuarentena, validación por firma real del formato, promoción a clave final, descargas con URL firmada corta o streaming autenticado con `Range`, migración reanudable de archivos heredados, respaldo incremental a cuenta separada y restauración con checksum. Cola durable de jobs en PostgreSQL (`src/modules/jobs`) y eventos SSE con cursor (`src/modules/realtime`).
- **Extensiones** (`src/modules/extensions`, `docs/extensions.md`): ejecutor común con clasificación de efectos y propuestas de aprobación, conexiones cifradas (AES-256-GCM) con OAuth PKCE, control de egreso (HTTPS, dominios, DNS, redirecciones), MCP remoto (SDK oficial), APIs tipadas desde OpenAPI, skills declarativas y plugins versionados.
- **Copiloto** (`src/modules/copilot`, `docs/copilot.md`): modos, personalización, memoria personal con aprendizaje controlado, biblioteca aprobada con búsqueda de texto completo.
- **Comunicaciones omnicanal** (`src/modules/comms`, `docs/communications.md`), **campañas** (`src/modules/campaigns`), **voz LiveKit/Twilio** (`src/modules/voice`, `docs/voice.md`).
- Retirados (2026-09-12): estudio visual, solicitudes internas, cotizaciones locales y mapa de pendientes; sus tablas se eliminan en la migración `20260912130000_drop_studio_requests_quotes`.

Migraciones: `20260912100000`, `20260912110000`, `20260912120000` (aditivas) y `20260912130000` (elimina tablas de módulos retirados). Ninguna aplicada; ningún servicio externo validado.
