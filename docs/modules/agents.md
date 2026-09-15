# IA coordinada por áreas (`src/modules/agents/`)

La capa de agentes hace que cada área tenga una "IA coordinadora" que avisa, pide, destraba y propone, sin
crear otra IA: **todo pasa por la IA existente** (`runAssistant`, registro de tools con `executeTool`, propuestas
`AiProposal`, superficies de copiloto, chat interno, notificaciones, `UsageMeter` y jobs). Un "agente" es una
**identidad** (usuario bot + rol fijo + superficies + disparadores) sobre ese motor, no un modelo ni un loop nuevo.

Estado: implementado y validado localmente (unitarias con FakePrisma y el escenario
`tests/integration/agents-protocol.int.test.ts` contra PostgreSQL real con proveedor de IA guionizado). Nada se ha
ejecutado en producción; ver `docs/pilot-runbook.md` §11.7. Plan: sección 5 del plan maestro.

Módulos relacionados: [núcleo operativo](./operations.md), [inventario](./inventory.md),
[logística](./logistics.md) y [IA unificada](../ai-unified.md).

## Arquitectura

```
commit de un comando operativo ─► onOperationalEvents / onCaseStarted ─┐
@mención a un bot en el chat ─► onBotMentioned ────────────────────────┤  (después del commit, sin bloquear)
propuesta de un agente que falló al ejecutarse ─► enqueueProposalFailed┤
escaneo de atorados (1 h) ─► case.stuck ───────────────────────────────┘
                                   ▼
             job agents.dispatch (1 intento, dedupe por evento/mensaje/propuesta)
                                   ▼
                    matriz de disparo (trigger-matrix.ts, pura)
            ┌──────────────────────┴──────────────────────┐
         REGLAS (0 LLM)                             DECISIONES LLM (guardas en orden)
  sala del expediente, plantillas,           activado → modo → horario → presupuesto →
  solicitud de compra por faltante,          persona atendiendo → tope por caso → dedupe 24 h
  avisos directos al responsable                          ▼
                                             runAgentTurn → runAssistant (usuario bot,
                                             contexto agent, allowlist, tool_choice required)
                                                          ▼
                                   propuesta en la sala + aviso a aprobadores · línea de conclusión ·
                                   evento ai.turn con tokens/costo · consumo medido una sola vez
```

Principios:

- **Traspasos entre áreas = reglas + plantillas.** El modelo sólo entra en cuatro excepciones: texto libre que
  interpretar, bloqueo o vencimiento, mención humana y acción aprobada que falló (más la revisión de atorados).
- **La IA nunca decide negocio.** Las escrituras de negocio son propuestas que aprueba una persona del alcance; los
  bots no aprueban ni rechazan, ni siquiera sus propias propuestas.
- **El motor no depende de un turno.** Si el proveedor falla, el turno queda como `ai.turn_failed`; las plantillas y
  el trabajo con dueño ya existían.

## Identidades (`identities.ts`, `identity-catalog.ts`, `permissions.ts`)

`ensureAgentIdentities()` corre al arrancar (`src/instrumentation-node.ts`, tras `ensureOperationsSeed`) y crea o
repara, de forma idempotente y segura con varias instancias:

| Identidad (`AgentIdentity.key`) | Usuario bot | Rol de sistema | Cubre |
|---|---|---|---|
| `area:ventas` | `ia_ventas` | `agent_ventas` | Ventas |
| `area:compras` | `ia_compras` | `agent_compras` | Compras |
| `area:inventario` | `ia_inventario` | `agent_inventario` | Inventario |
| `area:manufactura` | `ia_manufactura` | `agent_manufactura` | Manufactura |
| `area:logistica` | `ia_logistica` | `agent_logistica` | Logística |
| `area:contabilidad` | `ia_contabilidad` | `agent_contabilidad` | Contabilidad |
| `admin` | `ia_admin` | `agent_admin` | Administración y toda la empresa (Control Tower) |

- `User.isBot = true`, contraseña inutilizable (no es bcrypt). El login rechaza bots con el mensaje genérico y
  `getCurrentSession` tampoco acepta una sesión de bot. No hay DMs con bots.
- Cada bot tiene **un solo rol** con permisos fijos: `chat.use`, `operations.view` y las lecturas/acciones de su
  área que existan en el registro (lista explícita en `AGENT_AREA_PERMISSION_CANDIDATES`; hoy, por ejemplo, Inventario
  suma `inventory.view|count|reserve` y `products.view`; Logística `logistics.view|dispatch` y `packages.view`; la IA
  administradora sólo `operations.manage`). Nunca `super_admin`, `operations.admin`, usuarios/roles ni `*.admin`: el
  arranque quita cualquier otro rol y lo audita; `buildBotActor` falla si encuentra `super_admin`.
- La IA administradora lee las tools de Control Tower (`getCompanyPulse`, `findStuckCases`, `whoIsBlocking`,
  `simulateDelay`) por la regla `allowActor` del registro (`isAdministratorBot`), sin tener `operations.admin`.
- Lo que edita un administrador no se sobrescribe en el arranque: modo, presupuestos, nombre y si el bot está activo.
- Valores por omisión de `AgentIdentity`: `mode = active`, `dailyTokenBudget = 150000`, `monthlyCostBudgetUsd = 40`,
  `maxTurnsPerCasePerDay = 4`, `quietHours = null` (usa el horario global).

## Superficies (copilotos para personas)

Misma IA, mismo `CopilotPanel`, un hilo por superficie. El modo de cada usuario vive en
`AiUserPreference.surfaceModes` (Asistente IA → Preferencias y memoria).

| Superficie | Ruta del turno | Hilo (`context.kind` / llave) | Acceso | Modo inicial | Adaptador |
|---|---|---|---|---|---|
| Área | `GET/POST /app/operations/api/areas/[key]/copilot` | `area_copilot` / `areaKey` | `operations.view`, permiso del módulo del área o persona del área | a petición | `AreaCopilotPanel` |
| Expediente (sala) | `GET/POST /app/operations/api/cases/[id]/copilot` | `case_copilot` / `caseId` | `authorizeOperationsChannel` | a petición | `CaseRoomCopilotPanel` |
| Mi trabajo | `GET/POST /app/operations/api/mywork/copilot` (página `/app/mywork`) | `mywork_copilot` / `userId` | cualquier sesión | activo | `MyWorkCopilotPanel` |
| Control Tower | `GET/POST /app/admin/control-tower/api/copilot` | `control_tower_copilot` / `scope` | `operations.admin` | a petición | `ControlTowerCopilotPanel` |

- Prompts cortos en `prompts/` (base de agente ≤2.4k caracteres; superficie ≤4.8k), con todo dato variable
  envuelto con `wrapUntrusted`. En turnos de fondo `buildAgentBasePrompt` sustituye al prompt general.
- El orquestador fija tools por superficie (`AREA_ONLY_TOOLS`, `CASE_ONLY_TOOLS`, `MYWORK_ONLY_TOOLS`,
  `CONTROL_TOWER_ONLY_TOOLS`), inyecta `areaKey`/`caseId` y ofrece la tarjeta de borrador `proposeAreaAction` sólo en
  estas cuatro superficies humanas. El contexto de tabla que manda la UI llega como `context.tableContext`, acotado y
  envuelto como dato.
- Las acciones rápidas del chat usan `POST /app/operations/api/requests/[id]/respond` y
  `POST /app/operations/api/proposals/[id]` (el servidor valida el alcance; el cliente sólo oculta botones).

## Protocolo IA↔IA (≤1 llamada al modelo; normalmente 0)

Ejemplo "Inventario avisa a Compras que faltan 4 pz":

1. El motor acepta el plan "6 de existencia + 4 de compra" y emite `demand.shortfall_confirmed`; su paso
   `solicitar_compra` crea la `AreaRequest` `purchase_shortfall` y emite `request.created`.
2. Tras el commit, el despachador encola `agents.dispatch` por cada evento que la matriz reconoce.
3. Regla `shortfall_to_purchase_request`: revisa solicitudes abiertas, asignaciones ligadas y pasos pendientes del
   motor; como el motor ya pidió, **no duplica** (sólo crea la solicitud cuando nada cubre el faltante, con el
   comando `agents.shortfall_request` como IA de Inventario).
4. Regla `announce_request`: re-sincroniza la sala del expediente (entra el área destino: responsable, suplente y su
   bot), publica la tarjeta `agent_request` (Aceptar / Bloquear / Ver expediente) como la IA de origen, guarda
   `AreaRequest.chatMessageId`, publica una copia corta en el canal de Compras (como IA de Compras) y avisa al
   responsable (`agent_request`). **Sin LLM.**
5. El acuse automático (`request.acknowledged` por sistema) no se vuelve a anunciar; sí el de una persona y los
   cambios `accepted|blocked|resolved|rejected|cancelled|expired`.
6. Si la solicitud vence, el supervisor emite `request.overdue` y la IA de Compras corre un turno `unblock`.

### Matriz de disparo (`trigger-matrix.ts`)

| Evento | Modo | Agente | Disparo |
|---|---|---|---|
| `case.created` / `case.started` | regla | admin | `ensure_case_room` (sala + plantilla) |
| `demand.shortfall_confirmed` | regla | inventario | `shortfall_to_purchase_request` |
| `request.created` | regla | área origen | `announce_request` |
| `request.created` con texto libre o `info` | LLM | área destino | `interpret_request` |
| `request.acknowledged|accepted|resolved|rejected|cancelled|expired|blocked` | regla | área destino | `announce_request_update` |
| `request.overdue` | LLM | área destino | `unblock` |
| `request.blocked` | LLM | área origen | `replan_check` |
| `workitem.overdue|escalated` nivel 0–1 (o por solicitud vencida) | regla | área | `notify_workitem_overdue` |
| `workitem.escalated` nivel ≥2 | LLM | área | `unblock` |
| `incident.opened` sin texto / con texto | regla / LLM | área | `announce_incident` / `triage` |
| `case.replanned` con nota de una persona | LLM | ventas | `replan_check` |
| `case.stuck` (24 h sin eventos, sin entrega) | LLM | admin | `stuck_review` |
| `chat.mention_agent` | LLM | bot mencionado | `mention` |
| `proposal.failed` | LLM | bot proponente | `action_failed` |
| `case.delivered` | regla (+ resumen una vez si hubo incidencias) | admin | `announce_case_delivered` / `case_summary` |

### Guardas de una decisión LLM (`dispatcher.ts`)

En orden; cada salto escribe `ai.turn_skipped` con `payload.reason` y suma `skipped` en `UsageMeter('ai_agent')`:

1. `agents_disabled` / `trigger_disabled` — `settings.agents.enabled` y `llmTriggers[trigger]`.
2. `identity_missing` / `agent_paused` / `on_demand` — `on_demand` sólo deja `mention` y `action_failed`.
   En una mención, `sender_forbidden` si quien escribió no es una persona activa que pueda actuar por el área del
   bot (`canActForArea`): el bot nunca presta sus permisos.
3. `quiet_hours` — se re-encola al final de la ventana (la mención se contesta ya); si el diferido ya existía no se
   registra otro salto.
4. `budget_degraded` (≥ `degradeAtPct`, equivale a a petición) / `budget_exhausted` (100 %: pausa, una plantilla
   "en pausa por presupuesto, atiende {responsable}" al día, evento `ai.budget_exhausted` y aviso a dirección).
5. `already_handled` — el hilo del bot ya tiene un turno del MISMO disparo y objeto (`solicitud=…`, `mensaje=…`)
   después del evento; otros turnos del hilo compartido nunca lo cancelan. `human_handling` — una persona escribió en
   la sala después del evento (no aplica a menciones).
6. `case_turn_cap` — `ai.turn` + `ai.turn_failed` de TODOS los bots en el expediente hoy contra
   `maxTurnsPerCasePerDay`, más el tope propio de la identidad cuando es menor.
7. `duplicate_trigger` — mismo `triggerHash` en 24 h.

Una guarda que lanza excepción deja `ai.turn_failed` (`dispatch_error`). Sólo el texto libre escrito por una persona
(`actorType = user`) lleva a `interpret_request` o `triage`: lo que escribe el motor o otro turno de IA nunca dispara
otro turno. El escaneo de atorados salta los expedientes ya revisados hoy (turno, salto o job en cola) y lee más
páginas para llegar a los siguientes.

### Turno de agente (`agent-runner.ts` + orquestador)

- `runAgentTurn` arma el actor bot (`buildBotActor`), el hilo de la sala o del área y llama `runAssistant` con
  `context.agent` y un mensaje `⟦auto:…⟧` (texto humano envuelto con `wrapUntrusted`).
- El orquestador ofrece sólo `AGENT_TOOL_ALLOWLIST[área]` (15–19 tools, orden estable) ∩ permisos del bot, rechaza
  cualquier otra tool aunque el modelo la nombre, usa `modelForTask('routine')`, tope de iteraciones
  `min(maxToolIterations, agents.maxIterationsPerAutoTurn)`, sin rate limit, resumen, aprendizaje ni juez.
- Primera llamada con `tool_choice: 'required'`. Si el proveedor lo rechaza, el runner reintenta una vez con
  `agent.forceToolName = 'concludeAgentTurn'` (tool por nombre; sólo si está entre las ofrecidas).
- Contrato de salida: `concludeAgentTurn({outcome: acted|no_action|needs_human, message≤300})`. El turno TERMINA en
  cuanto concluye (sin otra llamada al modelo, también en la última iteración permitida); el runner publica `message`
  como una línea `agent_reply` si `outcome ≠ no_action`, con las `@` neutralizadas (en menciones responde citando el
  mensaje). Sin empujones de "respuesta incompleta" ni verificación de folios en turnos de agente.
- Contexto por turno: sólo la directiva del turno (nunca el historial del hilo compartido del bot); los resultados de
  tools se recortan a 4000 caracteres y `getCaseSnapshot` devuelve a los bots una vista compacta. El reintento por
  `tool_choice` reutiliza la directiva ya escrita.
- Menciones: las tools actúan sólo donde la persona que mencionó puede actuar y leen sólo el expediente de la sala o
  los que esa persona puede abrir (`ctx.agentOnBehalfOfUserId`, `ctx.agentCaseId`). Las solicitudes que crea un bot
  guardan a la persona que causó el turno (`ObjectRelation caused_by`): nunca firma el pago que pidió; sin persona
  identificable, el pago exige dos firmas.
- `proposal` → tarjeta `agent_proposal` en la sala (sin argumentos, con `approverUserIds`: el resto de la sala la ve
  sólo lectura) + evento `ai.proposal_created` en la cronología + aviso `agent_proposal` a cada aprobador. La
  cronología del expediente excluye los eventos de auditoría `ai.turn*`.
- `done` → evento `ai.turn` con `trigger`, `triggerHash`, `model`, `promptTokens`, `completionTokens`, `costUsd`,
  `flatRate`, `toolsUsed`, `proposalIds`, `outcome`, `chatMessageId`. `error` → `ai.turn_failed`, sin reintento.
- El consumo lo registra **una vez** el orquestador (`recordAgentUsage`) en `ai_agent`, `ai_area`, `ai_case` y el
  medidor del usuario.

## Aprobaciones (`extensions/proposals-service.ts`)

- `approverScope {caseId, areaKey, userIds: [responsable, suplente], permission?}` se fija en cada turno de agente.
  Deciden el proponente humano o una persona del alcance (listada o con el permiso). Un ajeno recibe 404; un bot 403.
- La propuesta se ejecuta con la persona que aprueba como actor y `agentAreaKey` = área de la propuesta: las tools de
  operaciones exigen que la acción caiga en esa área.
- Tools con `requiresSecondApproval`: primera firma → `awaiting_second_approval`; la segunda la da otra persona con
  permiso. Los pagos de negocio mantienen su doble firma en `ApprovalRequest` (`authorizePayment` no la marca).
- Si una propuesta de un bot aprobada **falla al ejecutarse**, `approveProposal` encola el turno `action_failed` del
  bot (una vez por propuesta), desde cualquier ruta de decisión (asistente, bandeja, chat, operaciones).

## Chat (`chat-bridge.ts`, `templates.ts`)

- Canales `area` (uno por área: personas con los permisos del módulo, responsable, suplente, líder, el bot del área
  y la IA administradora) y `case` (sala de venta: responsables y suplentes de las áreas involucradas, sus bots y el
  dueño del expediente). Sólo el puente los crea, con `createAreaChannel`/`createCaseRoom` (protegen el
  `chatChannelId` único ante carreras). Nadie sale de estos canales; se pueden silenciar.
- `postAsAgent` publica con `sendSystemMessage`. Las plantillas (`agent_request`, `agent_proposal`, `agent_notice`,
  `agent_update`, `agent_timeline`) no notifican por chat; el despachador avisa directo al responsable. Las líneas del
  modelo (`agent_reply`) sí notifican como un mensaje normal.
- `renderAgentMessage` (21 tipos, puro) y `formatTimelineLine` (misma frase en el chat y en la cronología).
- @mención de un bot miembro → `agents.dispatch {kind:'mention'}`; superficie `case` en salas y `area` en canales.

## Presupuesto y costo (`budget.ts`, `ai-admin-service.ts`)

- `UsageMeter` por día local (zona de `settings.agents.quietHours.tz`): `ai_agent`/`ai_area`/`ai_case` con unidades
  `tokens`, `usd` (pagado; 0 en tarifa plana) y `flat_tokens`.
- `checkAgentBudget(identity)` compara tokens de hoy contra `dailyTokenBudget` y USD del mes contra
  `monthlyCostBudgetUsd` → `ok | degraded | exhausted`. **Un presupuesto de 0 o menos significa sin límite** en esa
  dimensión: para detener a un agente usa el modo `paused`, no un presupuesto en 0.
- `notifyBudgetOnce` avisa (categoría `agent_budget`, push apagado por omisión) a super administradores y a quien
  tenga `operations.admin`: como máximo un aviso de alerta y uno de agotado por identidad al día.
- Modelos de Canopy Wave cuestan US$0 por turno; con `providerConfigs.canopywave.monthlyFeeUsd` el panel muestra el
  costo amortizado por tokens de tarifa plana.

## Jobs (`agents-jobs.ts`, registrado en `src/modules/jobs/register-handlers.ts`)

| Job | Cuándo | Qué hace |
|---|---|---|
| `agents.dispatch` | lo encolan los productores | matriz, reglas y decisiones LLM con guardas (1 intento) |
| `agents.stuck_scan` | cada hora | expedientes abiertos sin entrega ni eventos en 24 h → `stuck_review` (una vez al día por expediente) |
| `agents.control_tower_digest` | revisa cada 15 min | desde las 07:30 (hora de los agentes), una vez al día: KPIs con plantilla en el canal de Administración y, opcional, tres líneas con el modelo `utility` |

Al importarse, `agents-jobs.ts` suscribe el despachador a `onOperationalEvents`, `onCaseStarted` y `onBotMentioned`.

## Seguridad

- Bots sin login ni sesión, sin `super_admin` ni `operations.admin`, un rol fijo por área.
- Toda tool de operaciones valida el área del bot (`ctx.agentAreaKey`) y el permiso de la persona; `respondAreaRequest`
  y las demás escrituras de negocio nunca las ejecuta un bot.
- Todo texto de cliente, proveedor o persona pasa por `wrapUntrusted` (prompts, mensajes `⟦auto:…⟧`, contexto de
  tabla, resúmenes, investigación de proveedores).
- Auditoría: `AiToolCall`, `AiApiCall`, eventos `ai.turn|ai.turn_skipped|ai.turn_failed`, decisiones de `AiProposal` y
  `ApprovalRequest`, `assistant.agents_changed` en el panel.

## Cómo operar

- **Admin → Asistente IA → Agentes y presupuestos** (`assistant.admin`): modo, presupuestos y tope por identidad;
  consumo por área, día y mes; principales disparos; saltados por presupuesto; interruptor global y por disparo.
- **Admin → Asistente IA → Configuración → Agentes**: activado, zona horaria, horario silencioso, topes, umbrales de
  degradación y aviso, disparos LLM y cuota mensual de Canopy.
- **Asistente IA → Preferencias y memoria**: cada persona elige activo / a petición / apagado para Mi trabajo, área,
  expediente y Control Tower.
- Responsables: configura `Responsible` con suplente para cada área; son quienes aprueban las propuestas de su IA.

### Cómo apagar (de lo más fino a lo más amplio)

1. Un disparo: `agents.llmTriggers[trigger] = false` (las reglas siguen).
2. Un agente: modo `on_demand` (sólo menciones y acciones fallidas) o `paused` (sin turnos; las reglas siguen).
3. Toda la IA coordinada: `agents.enabled = false` (sin turnos; plantillas, salas y avisos siguen).
4. Toda la capa, reglas incluidas: flag `agents` de la configuración de operaciones
   (`IntegrationConfig('operations').settings.flags.agents = false`, `updateOperationsConfig`, `operations.admin`):
   no se encolan ni ejecutan `agents.dispatch`.
5. El asistente completo: Admin → Asistente IA → desactivar (`AiConfig.isEnabled = false`): los turnos terminan en
   `ai.turn_failed` y el trabajo con dueño sigue.

## Pruebas

- Unitarias (`npx vitest run --project unit src/modules/agents src/modules/ai`): matriz, plantillas, identidades,
  puente del chat, resumen, prompts, despachador (duplicados, persona atendiendo, pausa, presupuesto, horario, tope,
  faltante, mención, dedupe), runner, jobs, tools, orquestador en superficies y `tool_choice` por nombre.
- Integración (`UNIK_INTEGRATION_DATABASE_URL=postgresql://…/unik_schema_check npm run test:integration`),
  `tests/integration/agents-protocol.int.test.ts` con proveedor guionizado: sala con bots y responsables al iniciar el
  expediente; faltante → solicitud, tarjeta en sala y canal con `chatMessageId` y aviso, sin modelo; solicitud vencida
  → turno con `tool_choice: 'required'`, tools dentro de la lista y propuesta con alcance en la sala; aprueba la
  responsable y se ejecuta, el bot y un ajeno son rechazados; presupuesto degradado y agotado; mención a
  `@ia_compras` con respuesta en hilo y `ai.turn` con tokens medidos una vez.

## Límites conocidos

- Las páginas `/app/operations/cases/[id]` (Expediente 360), `/app/areas/[área]/…` y `/app/admin/control-tower`
  llegan en la fase de experiencia: hasta entonces los enlaces "Ver expediente" y "Abrir centro de trabajo" dan 404.
- Compras, Manufactura, Contabilidad y CRM aún no registran permisos de módulo: sus bots sólo leen y sus canales se
  forman con responsable, suplente y líder. Al registrarlos, agrégalos a `AGENT_AREA_PERMISSION_CANDIDATES`
  (`agents/permissions.ts`) y a `AREA_ACT_PERMISSION_CANDIDATES` (`ai/tools/operations-tool-kit.ts`).
- Todavía no hay permisos `<módulo>.approve`: el alcance de aprobación es responsable + suplente.
- Al crearse una solicitud llegan dos avisos al responsable (`ops_request` del núcleo y `agent_request`), por diseño.
- El tope de ~1.2k tokens de los prompts se controla por caracteres, no con un tokenizador.
- Las carreras de `chatChannelId` y del dedupe por `triggerHash` sólo tienen prueba secuencial.
- `startOfLocalDay` y el fin del horario silencioso suponen zonas sin cambio de horario ese día.
