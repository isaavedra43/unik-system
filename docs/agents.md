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

| Modelo                         | Papel                                                                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Tenant` / `TenantMembership`  | Semilla multiempresa; `tenantId` resuelve fail-soft a `unik`                                                                                                                  |
| `Agent`                        | Principal (`kind=principal`, fijado `sortOrder=0`), especialista o transitorio; persona, icono/color, `toolAllowlist`, `modelDefault`, `autonomy`, `venuePolicy`, presupuesto |
| `AgentVersion`                 | Snapshot de persona/modelo por cambio (`currentVersionId`)                                                                                                                    |
| `AgentGrant`                   | Permit/deny/require_approval por `tool:x` o `effect:x`                                                                                                                        |
| `AgentRun`                     | Cada turno/delegación: `traceId`, linaje (`parentRunId`/`rootRunId`), modelo, tokens, costos                                                                                  |
| `AgentEvent`                   | Journal del run (routing envelope, tools, errores)                                                                                                                            |
| `AgentTask`                    | DAG de delegación: `objective`, `capsule`, `dependsOn`, `rootRunId`                                                                                                           |
| `AgentMessage`                 | Buzón entre agentes (reporte de workers al padre)                                                                                                                             |
| `Workspace` / `WorkspaceLease` | Venue **central** compartida por usuario + lease por run (cola 90 s)                                                                                                          |
| `Trigger`                      | Rutinas always-on: `time`, `condition`, `entity_change`, `webhook`, `manual`                                                                                                  |

Además, `tenantId`/`agentId` se agregaron a 11 modelos existentes (memoria,
misiones, conversaciones, cache de tools — fix de fuga cross-tenant incluido).

## Módulos (`src/modules/agents/`)

| Archivo                | Qué hace                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-service.ts`     | `ensurePrincipal` (auto-creado por usuario), CRUD, versioning, `assignConversationAgent`                                                                                                      |
| `agent-runtime.ts`     | `executeAgentTurn`: inyecta persona al system prompt, intersecta el menú de tools con `toolAllowlist`, aplica `modelDefault`; llama a `runAssistant`                                          |
| `run-recorder.ts`      | Envuelve `runAssistant`: abre/cierra `AgentRun` + eventos — graba TODO, invisible para el usuario                                                                                             |
| `tenancy.ts`           | `resolveTenantId` fail-soft a `unik` hasta que exista una segunda empresa                                                                                                                     |
| `delegation.ts`        | Tool `delegateTask`: cápsula ≤8k (nunca el historial), worker `agent.task.run` en sesión fresca, `AgentMessage` + SSE `agent.task`/`agent.message`                                            |
| `task-graph.ts`        | DAG: `dependsOn` (re-encola o cancela en cascada), fan-out máx 4, `runGraph` para el panel                                                                                                    |
| `workspace-service.ts` | `Workspace` shared + `WorkspaceLease` por run — dos agentes no se pisan la computadora                                                                                                        |
| `trigger-service.ts`   | `trigger.tick` cada 60 s: dispara en sesión fresca; `condition` usa sondas **deterministas sin LLM** (tools read-only whitelisted); `action.kind='playbook'` corre un `VenuePlaybook` sin LLM |
| `policy.ts`            | ToolGateway paso 4d en `executeTool`: grants > matriz autonomía×efecto > presupuesto por periodo — solo acota                                                                                 |
| `memory-router.ts`     | Scopes tenant→user→agent→thread; modos `full/on_demand/off` (workers en `on_demand`); inyecta memoria al prompt por agente                                                                    |

`src/modules/ai/decisions/routing-envelope.ts` (B3): UNA llamada JEV decide 10
preguntas (`path/domains/needsRAG/browser/computer/delegation/modelClass/
parallel/fanout/risk`), deadline 600 ms, fallback heurístico — queda en el
journal del run.

## APIs (`/app/assistant/api/*`)

| Ruta                              | Contenido                                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET/POST /agents`                | Lista del equipo / crear especialista                                                                            |
| `PATCH/DELETE /agents/[id]`       | Editar (crea `AgentVersion`) / archivar (el principal no se archiva)                                             |
| `GET /runs/[id]`                  | Run + eventos + DAG de tasks                                                                                     |
| `POST /tasks/[id]/cancel`         | Cancelar task + cascada                                                                                          |
| `GET/POST/PATCH/DELETE /triggers` | Rutinas                                                                                                          |
| `GET /workspace`                  | Workspace central + lease actual                                                                                 |
| `GET /usage`                      | `{llm, venue, jev, runs, spent}` medido real (sums de `AgentRun`, `VenueSession.billedMinutes`, eventos `route`) |

`POST /chat` acepta `agentId` opcional; `AiConversation.agentId` fija el agente
del hilo.

## Front (`src/components/assistant/agents/`)

`AgentSidebar` ("Tu equipo", JEFE fijado, misiones recientes + **Descargar app**
— instalación PWA vía `beforeinstallprompt`), `OpsPanel` (**Superficies** +
pantalla venue EN VIVO + terminal vivo + misiones + vigilancias + aprobaciones

- costo), `MissionCard`, `ActivityCard`, `AgentMessageCard`, `RoutineChip`,
  `NewAgentSheet`, `TweaksPanel`, `AgentAvatar`. Meta del mensaje: `meta.agent`
  (avatar por respuesta), `meta.agentMessages` (fold "Mensajes de X"),
  `meta.routineCreated` (chip). SSE: `agent.task`/`agent.message` en `user:{id}`.

## Icono flotante y app de escritorio

- `AssistantWidget` (`src/components/assistant/AssistantWidget.tsx`): FAB
  fijo abajo-derecha en **todas las páginas de la app excepto `/app/assistant`**
  (donde el FAB es redundante). Abre un drawer compacto con el `AssistantChat`
  real — misma API, conversación creada lazy al primer envío, `agentId`
  incluido. El botón ↗ salta a la experiencia completa.
- **App de escritorio = PWA**: `manifest.ts` (standalone + iconos + shortcuts)
  y `public/sw.js` (fetch handler, offline, push) ya la hacen instalable.
  `InstallAppButton` captura `beforeinstallprompt`; fallback = instrucciones
  por plataforma.

## Superficies de control (3)

| Superficie                                         | Estado                                               | Dónde                                               |
| -------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| Computadora virtual                                | Venue Daytona compartida (workspace central + lease) | `OpsPanel` → Pantalla/Terminal                      |
| Páginas web del agente                             | Páginas abiertas por tools web/browser               | `OpsPanel` → Páginas                                |
| **Apps por API** (sustituye a "computadora local") | Toolkits Composio conectados por el usuario          | `OpsPanel` → Superficies / `GET /composio/toolkits` |

## Computer use — modelo rápido y barato

Los turnos que piden operar la computadora virtual (dominio `venue` en
`detectDomains`) se marcan `classification.computer` y salen del reparto por
tier: usan la tarea `computer` de `model-policy` → `computerUseModel` (Admin →
Reparto de modelos) → env `UNIK_COMPUTER_MODEL` → **`google/gemini-2.5-flash`
vía OpenRouter** ($0.30/$2.50 por 1M, visión+tools+1M ctx) cuando hay llave de
OpenRouter → si no, el modelo de rutina. Elección explícita del usuario siempre
gana. Las decisiones JEV (envelope) se conservan para routing/fanout.

## Seguridad de pantallas (memory-only)

Las capturas de pantalla de la venue **nunca se persisten**: viajan solo por
SSE (`workspace.screen`) y por `GET /venue/state` (respondido con
`Cache-Control: no-store`). El orquestador aplica `stripScreenData` antes del
audit (`AiToolCall.result`), del mensaje `tool` persistido y del payload al
modelo — para "ver" la pantalla el modelo usa `analyzeImage` (visión acotada),
nunca el base64 como texto. `secure-input` ya canaliza credenciales
request→controller→página sin tocar modelo ni DB.

## Verificación

Typecheck 0 errores · lint 0 errores · 500+ tests · `next build` completo ·
migración pasa los checks de idempotencia (`prisma-migrations.test.ts`).

**Pendiente de validación manual:** aplicar la migración en producción,
activar `UNIK_AGENT_RUNTIME_V2`, crear un especialista y pedir "delega…" al
principal (ver la task en el terminal del OpsPanel y el reporte plegado en el
chat).
