# UNIK System

UNIK System es una aplicación empresarial full-stack diseñada como un **Modular Monolith**. El frontend y el backend coexisten dentro del mismo proyecto y repositorio, y se despliegan juntos.

UNIK opera como capa de inteligencia y operación sobre **Zoho Inventory/Books** (fuente de verdad del negocio): sincroniza las entidades comerciales, las normaliza a tablas propias y ofrece workspaces operativos, comunicaciones omnicanal, voz y un **asistente de IA con gobierno real** (permisos, aprobaciones, auditoría).

## Arquitectura

- **Tipo:** Modular Monolith
- **Repositorio:** único
- **Proyecto:** único (no hay carpetas `frontend` y `backend` separadas)
- **Módulos de dominio:** `src/modules/`
- **Detalle:** `docs/architecture/current-state.md` y `docs/decisions/ADR-001-modular-monolith.md`

## Stack tecnológico

- Next.js 15 (App Router) + React 19
- TypeScript (strict mode)
- Node.js `>= 22`
- PostgreSQL + Prisma ORM
- Zod
- Tailwind CSS 4 + shadcn/ui
- Vitest + Playwright + Storybook
- Docker
- GitHub → Railway (deploy automático)

## Módulos principales

| Área                 | Ruta                                                        | Módulo                                                                                         |
| -------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Asistente IA         | `/app/assistant`                                            | `src/modules/ai` + `src/modules/agents` (220+ tools, multi-agente, routing JEV, delegación, venue Daytona, UI generativa, memoria, misiones, triggers) |
| Órdenes de venta     | `/app/sales/orders`                                         | `src/modules/sales`                                                                            |
| Cotizaciones         | `/app/quotes`                                               | `src/modules/quotes`                                                                           |
| Facturas / Pagos     | `/app/invoices`, `/app/payments`                            | `src/modules/invoices`, `src/modules/payments`                                                 |
| Compras              | `/app/purchase-orders`, `/app/bills`, `/app/vendor-credits` | módulos homónimos                                                                              |
| Productos / Paquetes | `/app/products`, `/app/packages`                            | `src/modules/products`, `src/modules/packages`                                                 |
| Contactos            | `/app/contacts/customers`, `/app/contacts/vendors`          | `src/modules/contacts`                                                                         |
| Bandeja omnicanal    | `/app/inbox`                                                | `src/modules/comms` (WhatsApp/SMS/Telegram vía Twilio)                                         |
| Chat interno         | `/app/chat`                                                 | `src/modules/chat`                                                                             |
| Campañas             | `/app/campaigns`                                            | `src/modules/campaigns`                                                                        |
| Llamadas             | `/app/calls`                                                | `src/modules/voice` (LiveKit + Twilio SIP + `services/voice-agent`)                            |
| Archivos             | `/app/files`                                                | `src/modules/storage` (Cloudflare R2 / S3)                                                     |
| Notificaciones       | `/app/notifications`                                        | `src/modules/notifications` (in-app + web push)                                                |
| Extensiones          | `/app/admin/extensions`                                     | `src/modules/extensions` (MCP, OpenAPI, skills, plugins, Composio)                             |
| Administración       | `/app/admin/*`                                              | usuarios, roles, integraciones, asistente, chat, voz, conocimiento                             |

## Integración Zoho

`src/modules/integrations/zoho/` sincroniza por polling: órdenes de venta, cotizaciones (estimates), facturas, órdenes de compra, facturas de compra, pagos, productos/items, paquetes, contactos y créditos de proveedor.

```
Zoho API → sync engine → IntegrationSnapshot (RAW) → normalizer → tablas de negocio
                                                              → EntityChangeEvent → Notification
```

El detalle está en `docs/integrations/zoho.md` y `docs/architecture/current-state.md`.

## Asistente IA — UNIVERSO

El asistente vive en `/app/assistant` y como servidor MCP (`/api/mcp`). Comparte orquestador, tools, permisos y aprobaciones. Ver `docs/ai-unified.md` y `docs/agents.md`.

- **Multi-agente** (`UNIK_AGENT_RUNTIME_V2`, apagado por default): un agente principal por usuario (badge JEFE) + especialistas creados desde "+ Nuevo agente" + subagentes delegados por tarea. Cada turno se graba como `AgentRun` con `traceId`, linaje y costos.
- **Delegación**: `delegateTask` manda una cápsula (nunca el historial) a un worker en sesión fresca (`agent.task.run`); el reporte vuelve plegado al chat (`AgentMessage`) y al terminal vivo del panel.
- **Routing JEV**: una llamada batch decide path, dominios, delegación, modelo y riesgo (deadline 600 ms, fallback heurístico).
- **220+ tools internas** (ventas, compras, mensajería, campañas, voz, web, documentos, venue) con ToolGateway por agente (grants, autonomía×efecto, presupuesto).
- **Triggers/rutinas**: `trigger.tick` cada 60 s — horarios, condiciones deterministas sin LLM, cambios de entidad, webhooks y playbooks de venue.
- Escrituras y envíos siempre pasan por tarjeta de aprobación (`AiProposal`).
- UI generativa (tablas, tarjetas, charts, HTML interactivo sandboxed).
- Venue: computadora remota desechable (Daytona) compartida con lease por run, navegador Playwright.

## Infraestructura

- **GitHub** es el origen del repositorio y fuente del deployment.
- **Railway** ejecuta Next.js y PostgreSQL; el pre-deploy corre `node scripts/prisma-deploy.mjs`.
- **Health check:** `GET /api/health` devuelve `database: connected`.

## Requisitos

- Node.js `>= 22.0.0`
- npm `>= 10.0.0`
- PostgreSQL (variable `DATABASE_URL`)

## Comandos

```bash
npm install
npm run dev
npm run build
npm run start
npm run typecheck
npm run lint
npm run format:check
npm run prisma:generate
npm run prisma:validate
npm run test:components    # vitest (unit + storybook)
npm run test:e2e           # playwright
npm run storybook
npm run build-storybook
npm run ui:check           # typecheck + lint + format + build + storybook
```

## Documentación

| Doc                                  | Contenido                                        |
| ------------------------------------ | ------------------------------------------------ |
| `docs/architecture/current-state.md` | Estado funcional completo por fases              |
| `docs/ai-unified.md`                 | Asistente, tools, MCP, venue, documentos         |
| `docs/agents.md`                     | Runtime multi-agente UNIVERSO (schema, delegación, JEV, triggers, APIs) |
| `docs/ai-model-policy.md`            | Reparto de modelos por tarea                     |
| `docs/authentication.md`             | Sesiones, roles, permission registry             |
| `docs/integrations/zoho.md`          | Integración Zoho Inventory/Books                 |
| `docs/modules/sales-orders.md`       | Workspace de órdenes (patrón replicado)          |
| `docs/modules/packages.md`           | Paquetes y envíos                                |
| `docs/communications.md`             | Bandeja omnicanal                                |
| `docs/campaigns.md`                  | Envíos masivos                                   |
| `docs/voice.md`                      | Telefonía, IA en llamadas, agente de voz         |
| `docs/extensions.md`                 | MCP, OpenAPI, skills, plugins                    |
| `docs/composio.md`                   | Apps de terceros del asistente                   |
| `docs/storage.md`                    | Almacenamiento R2                                |
| `docs/notifications.md`              | Notificaciones in-app y push                     |
| `docs/copilot.md`                    | Preferencias, memoria y biblioteca del asistente |
| `docs/pilot-runbook.md`              | Activación gradual en producción                 |
| `docs/design-system.md` + reglas UI  | Sistema de diseño obligatorio para cambios de UI |
| `AGENTS.md`                          | Reglas operativas para agentes (Devin)           |
| `REVIEW.md`                          | Checklist de revisión UI                         |

## Nota

Las reglas operativas para agentes de IA que modifican este repo están en `AGENTS.md`; el checklist de UI en `REVIEW.md`. La verificación contra servicios reales (Zoho, Twilio, LiveKit, R2, Composio, Daytona) sigue el runbook `docs/pilot-runbook.md`.
