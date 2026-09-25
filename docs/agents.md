# UNIVERSO — Runtime multi-agente

Sistema de agentes sobre el asistente existente: un **agente principal** por
usuario + **especialistas** definidos por el usuario + **subagentes delegados**
por tarea. Todo el runtime es **aditivo**: `runAssistant` y `mission.tick`
siguen haciendo el trabajo; los módulos nuevos los envuelven con identidad
(agente + versión + run + traceId), routing JEV, delegación formal y
observabilidad.

> **Flag:** el runtime nuevo corre solo con `UNIK_AGENT_RUNTIME_V2=true`.
> Sin él, el asistente funciona byte a byte igual que antes (modo LEGACY).

## Esquema

Migración `20260925140000_universo_agent_runtime` (idempotente, aditiva):

| Modelo | Papel |
| --- | --- |
| `Tenant` / `TenantMembership` | Semilla multiempresa; `tenantId` resuelve fail-soft a `unik` |
| `Agent` | Principal (`kind=principal`, fijado `sortOrder=0`), especialista o transitorio; persona, icono/color, `toolAllowlist`, `modelDefault`, `autonomy`, `venuePolicy`, presupuesto |
| `AgentVersion` | Snapshot de persona/modelo por cambio (`currentVersionId`) |
| `AgentGrant` | Permit/deny/require_approval por `tool:x` o `effect:x` |
| `AgentRun` | Cada turno/delegación: `traceId`, linaje (`parentRunId`/`rootRunId`), modelo, tokens, costos |
| `AgentEvent` | Journal del run (routing envelope, tools, errores) |
| `AgentTask` | DAG de delegación: `objective`, `capsule`, `dependsOn`, `rootRunId` |
| `AgentMessage` | Buzón entre agentes (reporte de workers al padre) |
| `Workspace` / `WorkspaceLease` | Venue **central** compartida por usuario + lease por run (cola 90 s) |
| `Trigger` | Rutinas always-on: `time`, `condition`, `entity_change`, `webhook`, `manual` |

Además, `tenantId`/`agentId` se agregaron a 11 modelos existentes (memoria,
misiones, conversaciones, cache de tools — fix de fuga cross-tenant incluido).

## Módulos (`src/modules/agents/`)

| Archivo | Qué hace |
| --- | --- |
| `agent-service.ts` | `ensurePrincipal` (auto-creado por usuario), CRUD, versioning, `assignConversationAgent` |
| `agent-runtime.ts` | `executeAgentTurn`: inyecta persona al system prompt, intersecta el menú de tools con `toolAllowlist`, aplica `modelDefault`; llama a `runAssistant` |
| `run-recorder.ts` | Envuelve `runAssistant`: abre/cierra `AgentRun` + eventos — graba TODO, invisible para el usuario |
| `tenancy.ts` | `resolveTenantId` fail-soft a `unik` hasta que exista una segunda empresa |
| `delegation.ts` | Tool `delegateTask`: cápsula ≤8k (nunca el historial), worker `agent.task.run` en sesión fresca, `AgentMessage` + SSE `agent.task`/`agent.message` |
| `task-graph.ts` | DAG: `dependsOn` (re-encola o cancela en cascada), fan-out máx 4, `runGraph` para el panel |
| `workspace-service.ts` | `Workspace` shared + `WorkspaceLease` por run — dos agentes no se pisan la computadora |
| `trigger-service.ts` | `trigger.tick` cada 60 s: dispara en sesión fresca; `condition` usa sondas **deterministas sin LLM** (tools read-only whitelisted); `action.kind='playbook'` corre un `VenuePlaybook` sin LLM |
| `policy.ts` | ToolGateway paso 4d en `executeTool`: grants > matriz autonomía×efecto > presupuesto por periodo — solo acota |
| `memory-router.ts` | Scopes tenant→user→agent→thread; modos `full/on_demand/off` (workers en `on_demand`); inyecta memoria al prompt por agente |

`src/modules/ai/decisions/routing-envelope.ts` (B3): UNA llamada JEV decide 10
preguntas (`path/domains/needsRAG/browser/computer/delegation/modelClass/
parallel/fanout/risk`), deadline 600 ms, fallback heurístico — queda en el
journal del run.

## APIs (`/app/assistant/api/*`)

| Ruta | Contenido |
| --- | --- |
| `GET/POST /agents` | Lista del equipo / crear especialista |
| `PATCH/DELETE /agents/[id]` | Editar (crea `AgentVersion`) / archivar (el principal no se archiva) |
| `GET /runs/[id]` | Run + eventos + DAG de tasks |
| `POST /tasks/[id]/cancel` | Cancelar task + cascada |
| `GET/POST/PATCH/DELETE /triggers` | Rutinas |
| `GET /workspace` | Workspace central + lease actual |
| `GET /usage` | `{llm, venue, jev, runs, spent}` medido real (sums de `AgentRun`, `VenueSession.billedMinutes`, eventos `route`) |

`POST /chat` acepta `agentId` opcional; `AiConversation.agentId` fija el agente
del hilo.

## Front (`src/components/assistant/agents/`)

`AgentSidebar` ("Tu equipo", JEFE fijado, misiones recientes), `OpsPanel`
(pantalla venue EN VIVO + terminal vivo + misiones + vigilancias + aprobaciones
+ costo), `MissionCard`, `ActivityCard`, `AgentMessageCard`, `RoutineChip`,
`NewAgentSheet`, `TweaksPanel`, `AgentAvatar`. Meta del mensaje: `meta.agent`
(avatar por respuesta), `meta.agentMessages` (fold "Mensajes de X"),
`meta.routineCreated` (chip). SSE: `agent.task`/`agent.message` en `user:{id}`.

## Verificación

Typecheck 0 errores · lint 0 errores · 500+ tests · `next build` completo ·
migración pasa los checks de idempotencia (`prisma-migrations.test.ts`).

**Pendiente de validación manual:** aplicar la migración en producción,
activar `UNIK_AGENT_RUNTIME_V2`, crear un especialista y pedir "delega…" al
principal (ver la task en el terminal del OpsPanel y el reporte plegado en el
chat).
