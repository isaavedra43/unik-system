# UNIK System - Current State

> Última actualización: 2026-09-25. Este documento resume el estado del **código**;
> la validación contra servicios reales se registra en `docs/pilot-runbook.md` y
> en las secciones "pendiente de validación manual" de cada doc de módulo.

## Architecture

- **Modular Monolith**: un solo repositorio; frontend y backend coexisten en Next.js (App Router).
- **Deploy**: GitHub → Railway. `Dockerfile` multi-stage (deps → build → runner)
  con `output: 'standalone'`: la imagen final solo carga `.next/standalone`
  (node_modules trazados por nft), `public`, `.next/static`, los assets del
  venue (`src/modules/venues/assets`) y el CLI de Prisma para el pre-deploy.
  El pre-deploy ejecuta `node scripts/prisma-deploy.mjs`
  (marca migraciones fallidas como rolled-back y luego `migrate deploy`); nunca se usa
  `npx prisma migrate deploy` directo. Las migraciones nuevas deben ser idempotentes
  y aditivas — `src/modules/shared/prisma-migrations.test.ts` lo verifica en CI.
- **Runtime**: Node.js `>=22`, PostgreSQL + Prisma. Schedulers y cola de jobs corren
  dentro del mismo proceso web (una sola réplica asumida para schedulers; la cola
  `BackgroundJob` sí tolera réplicas por reclamo atómico).

## Infraestructura implementada

- **Autenticación/RBAC** (`src/modules/auth`, `docs/authentication.md`): sesiones en
  PostgreSQL (hash SHA-256, cookie HttpOnly `unik_session`, 12 h), bcrypt, lockout,
  permission registry code-first (~89 claves), `super_admin`, deny-by-default,
  auditoría (`AuditLog`).
- **Almacenamiento** (`src/modules/storage`, `docs/storage.md`): Cloudflare R2/S3,
  cuarentena → promoción, validación por firma de formato, URLs firmadas, streaming
  con `Range`, respaldo incremental.
- **Jobs** (`src/modules/jobs`): cola durable en `BackgroundJob`, schedulers recurrentes
  con dedupe keys, arranque en `instrumentation.ts` (`UNIK_JOB_WORKER_ENABLED`).
- **Realtime** (`src/modules/realtime`): SSE con cursor durable (`RealtimeEvent`),
  canales `user:{id}`, `inbox:{team}`, `call:{id}`, `campaign:{id}`, `assistant:{conv}`, `venue:{id}`.
- **Notificaciones** (`src/modules/notifications`, `docs/notifications.md`): `notifyUser`,
  preferencias por categoría, Web Push VAPID, despachador post-transacción.

## Integración Zoho (fases 1-5, implementadas)

`src/modules/integrations/zoho/`: OAuth con refresh token cacheado, cliente GET,
y un **motor de sync genérico** (`zoho-sync-engine.ts`) + scheduler por entidad
(`zoho-scheduler-factory.ts`). Patrón por entidad:

```
Zoho list → IntegrationEntityState (needsSync) → detalle → IntegrationSnapshot (RAW)
  → normalizer → tabla de negocio → snapshot-diff → EntityChangeEvent → Notification
```

Entidades sincronizadas: **sales orders, estimates/quotes, invoices, purchase orders,
bills, payments, products/items, packages (con shipment_order), contacts (customers/
vendors), vendor credits**. Modo `baseline` para históricos sin descargar detalle.
Botones "Actualizar" por módulo disparan sync `quick` manual.

## Workspaces de negocio

Patrón compartido (`src/components/common/EntityWorkspace.tsx` + column registry +
filtros Zod por módulo): tabla con DnD/resize/pinning/density, filtros avanzados,
vistas guardadas (`TableView`, privadas/compartidas), export CSV/XLSX auditado,
`EntityWatch` → notificaciones de cambios. Rutas: `/app/sales/orders`, `/app/quotes`,
`/app/invoices`, `/app/payments`, `/app/purchase-orders`, `/app/bills`,
`/app/vendor-credits`, `/app/products`, `/app/packages`, `/app/contacts/*`.
Detalle en `docs/modules/sales-orders.md` (referencia del patrón) y
`docs/modules/packages.md`.

## Comunicaciones (implementadas; verificación externa por runbook)

- **Bandeja omnicanal** `/app/inbox` (`src/modules/comms`, `docs/communications.md`):
  WhatsApp/SMS vía Twilio y Telegram Bot API; webhooks firmados e idempotentes,
  consentimiento BAJA/ALTA, compromisos, responsables, duplicados revisables.
  _El panel de copiloto embebido fue retirado (2026-09-25): la IA asiste desde
  `/app/assistant` vía `comms-tools.ts`._
- **Chat interno** `/app/chat` (`src/modules/chat`): canales, DMs, threads,
  reacciones, polls, eventos RSVP, mensajes programados, snippets, llamadas internas.
  _Copiloto embebido retirado igual que el de la bandeja; quedan utilidades AI
  ligeras (traducción por mensaje)._
- **Campañas** `/app/campaigns` (`docs/campaigns.md`): audiencia y contenido
  congelados, ensayo con mock adapter, presupuesto, lotes recuperables.
- **Voz** `/app/calls` (`docs/voice.md`): LiveKit + Twilio SIP, IA en llamadas
  (worker aparte en `services/voice-agent`, OpenAI Realtime), grabación R2 con
  retención, supervisión listen/whisper/barge.

## Asistente IA (`/app/assistant` + MCP server)

`src/modules/ai/` + `src/modules/agents/` (`docs/ai-unified.md`, `docs/agents.md`).
Base: orquestador SSE con loop de tools, selección semántica de tools, routing de
modelos por tier (OpenAI, Anthropic, Gemini, Ollama, CanopyWave, OpenRouter,
local; GPT-5/o-series con reasoning effort), memoria personal (`AiMemory`),
biblioteca de conocimiento (`KnowledgeSource` + FTS + embeddings), misiones,
artefactos (PDF/Word/Excel/CSV/charts/tablas), UI generativa (spec JSON cerrada +
iframes sandboxed `renderInteractiveUi`), verificación determinista de respuestas
y revisión interna. Escrituras → `AiProposal` con aprobación humana exacta.

- **Runtime multi-agente UNIVERSO** (`src/modules/agents/`, flag
  `UNIK_AGENT_RUNTIME_V2`, migración `20260925140000_universo_agent_runtime`):
  `Agent` principal por usuario + especialistas + transitorios; `AgentRun`/
  `AgentEvent` con `traceId` por turno; `AgentTask` DAG con `dependsOn` y
  `delegateTask` (cápsula, worker `agent.task.run`, `AgentMessage` al padre);
  routing envelope JEV (10 decisiones, 600 ms, fallback); `Workspace`/`Lease`
  venue central; `Trigger` (time/condition/entity_change/webhook/playbook,
  `trigger.tick` 60 s); ToolGateway (grants, autonomía×efecto, presupuesto);
  `MemoryRouter` por scope; `tenantId` en `CurrentUser` (fail-soft `unik`).
- **Front agentes** (`src/components/assistant/agents/`): sidebar "Tu equipo"
  con JEFE fijado, `OpsPanel` (pantalla venue + terminal vivo + misiones +
  vigilancias + aprobaciones + costo vía `GET /api/usage`), tarjetas
  Mission/Activity/AgentMessage/RoutineChip, mode pills Misión/Mensaje.
- **APIs**: `/agents`, `/runs/[id]`, `/tasks/[id]/cancel`, `/triggers`,
  `/workspace`, `/usage`; `POST /chat` acepta `agentId`.

- **Venue** (`src/modules/venues`): VM Daytona desechable, controller Playwright,
  screenshots post-acción, `secureInput` para credenciales sin pasar por el modelo.
- **Extensiones** (`src/modules/extensions`, `docs/extensions.md`): MCP remoto,
  OpenAPI→tools, skills declarativas, plugins ZIP; secretos AES-256-GCM, egreso
  policiado (`safe-fetch`), `UsageMeter`.
- **Composio** (`docs/composio.md`): catálogo real de apps vía REST v3.1, política
  por toolkit/rol, efectos clasificados por UNIK.
- **MCP server** (`/api/mcp`): UNIK expone sus tools a agentes externos;
  efectos → `needs_approval`.

## Retirados

- Estudio visual, solicitudes internas y cotizaciones locales (2026-09-12,
  migración `20260912130000_drop_studio_requests_quotes`).
- Módulo Visual Studio (2026-09-23+, migración `20260923231444_visual_studio`
  eliminada del schema; verificar estado de la tabla en producción).
- Widget flotante del asistente y copilotos embebidos de inbox/chat (2026-09-25).

## Estado del repositorio

- ~127 modelos Prisma, ~80 migraciones versionadas, 300+ rutas API, ~200 K líneas
  `src/`, tests con Vitest (`*.test.ts` junto a módulos) + Playwright (`e2e/`) +
  Storybook.

## Pendiente de validación manual (nunca marcada como pasada por agentes)

Sync real por entidad en producción, webhooks Twilio/Telegram firmados, R2 real,
LiveKit/SIP real, Composio real, venue Daytona real, MCP externo real. El detalle
por bloque está en `docs/pilot-runbook.md` y en la sección "pendiente de
validación manual" de cada documento de módulo.
