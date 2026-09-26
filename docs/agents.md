# UNIVERSO — Runtime multi-agente

Sistema de agentes sobre el asistente existente: un **agente principal** por
usuario + **especialistas** definidos por el usuario + **subagentes delegados**
por tarea. Todo el runtime es **aditivo**: `runAssistant` y `mission.tick`
siguen haciendo el trabajo; los módulos nuevos los envuelven con identidad
(agente + versión + run + traceId), routing JEV, delegación formal y
observabilidad.

> **Runtime V2 activo por defecto.** Los agentes (persona, lista de tools,
> delegación y consolidación del equipo) solo existen en esta ruta. Para volver
> al asistente clásico: `UNIK_AGENT_RUNTIME_V2=false`.

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

| Archivo                | Qué hace                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-service.ts`     | `ensurePrincipal` (auto-creado por usuario), CRUD, versioning, `assignConversationAgent`                                                                                                                                                                                                                                                                                                                                                                              |
| `agent-runtime.ts`     | `executeAgentTurn`: inyecta persona al system prompt, intersecta el menú de tools con `toolAllowlist`, aplica `modelDefault`; llama a `runAssistant`                                                                                                                                                                                                                                                                                                                  |
| `run-recorder.ts`      | Envuelve `runAssistant`: abre/cierra `AgentRun` + eventos — graba TODO, invisible para el usuario                                                                                                                                                                                                                                                                                                                                                                     |
| `tenancy.ts`           | `resolveTenantId` fail-soft a `unik` hasta que exista una segunda empresa                                                                                                                                                                                                                                                                                                                                                                                             |
| `delegation.ts`        | Tool `delegateTask`: cápsula ≤8k (nunca el historial), worker `agent.task.run` en sesión fresca (hasta 25 min), `AgentMessage` + SSE `agent.task`/`agent.message`. Fan-out máx **10** por run, profundidad máx 2. Cuando termina la ÚLTIMA tarea de un run, el director recibe un turno de **consolidación** (`agent.run.consolidate`, máx 2 rondas): revisa cada entrega, re-delega una corrección si algo falla y presenta el resultado (SSE `agent.consolidating`) |
| `task-graph.ts`        | DAG: `dependsOn` (re-encola o cancela en cascada), `runGraph` para el panel                                                                                                                                                                                                                                                                                                                                                                                           |
| `workspace-service.ts` | `Workspace` shared + `WorkspaceLease` por run — dos agentes no se pisan la computadora                                                                                                                                                                                                                                                                                                                                                                                |
| `trigger-service.ts`   | `trigger.tick` cada 60 s: dispara en sesión fresca; `condition` usa sondas **deterministas sin LLM** (tools read-only whitelisted); `action.kind='playbook'` corre un `VenuePlaybook` sin LLM                                                                                                                                                                                                                                                                         |
| `policy.ts`            | ToolGateway paso 4d en `executeTool`: grants > matriz autonomía×efecto > presupuesto por periodo — solo acota                                                                                                                                                                                                                                                                                                                                                         |
| `memory-router.ts`     | Scopes tenant→user→agent→thread; modos `full/on_demand/off` (workers en `on_demand`); inyecta memoria al prompt por agente                                                                                                                                                                                                                                                                                                                                            |

`src/modules/ai/decisions/routing-envelope.ts` (B3): UNA llamada JEV decide 10
preguntas (`path/domains/needsRAG/browser/computer/delegation/modelClass/
parallel/fanout/risk`), deadline 600 ms, fallback heurístico — queda en el
journal del run.

## APIs (`/app/assistant/api/*`)

| Ruta                              | Contenido                                                                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET/POST /agents`                | Lista del equipo / crear especialista                                                                                                                                                                                  |
| `PATCH/DELETE /agents/[id]`       | Editar (crea `AgentVersion`) / archivar (el principal no se archiva)                                                                                                                                                   |
| `GET /runs/[id]`                  | Run + eventos + DAG de tasks                                                                                                                                                                                           |
| `GET /tasks`                      | Tareas delegadas de las últimas 48 h (dueño = dueño del run padre) — historia del panel Equipo                                                                                                                         |
| `POST /tasks/[id]/cancel`         | Cancelar task + cascada                                                                                                                                                                                                |
| `GET/POST/PATCH/DELETE /triggers` | Rutinas — **solo las de agentes del usuario** (el tenant es compartido); incluye pausadas para reanudar                                                                                                                |
| `GET/POST /sites`                 | Sitios publicados por los agentes / despublicar-publicar (`/sites/{slug}` es público, con CSP sandbox)                                                                                                                 |
| `GET /workspace`                  | Workspace central + lease actual                                                                                                                                                                                       |
| `GET /usage`                      | `{llm, venue, venueMinutes, jev, runs, spent}` — `venue` en USD, `venueMinutes` aparte (antes se mostraban minutos como dólares)                                                                                       |
| `GET /venue/state?surface=`       | Estado PASIVO: navegador (`ready/stage/reason` + frame si `surface=browser`) y escritorio (`running` + frame si `surface=desktop`) por separado, `pendingInputs`, `teach`; nunca despierta ni mantiene viva la sandbox |
| `POST /venue/session`             | `start` / `stop` (+ `surface`) — encender o apagar desde el panel (permiso `browser.use`; 409 si no hay Daytona)                                                                                                       |
| `POST /venue/browser`             | El usuario toma el control del navegador del agente: dirección, clic/escritura/scroll sobre el frame, pestañas; graba pasos si «Enséñale» está activo                                                                  |
| `POST /venue/desktop`             | Escritorio VNC: encender, clic/escritura/teclas/scroll, abrir terminal/archivos/navegador/editor                                                                                                                       |
| `GET /venue/viewer`               | URL firmada (1 h) de noVNC para ver el escritorio a pantalla completa en otra pestaña                                                                                                                                  |
| `POST /venue/exec`                | Terminal del usuario en la computadora virtual (permiso `venue.exec`)                                                                                                                                                  |
| `GET /venue/files`, `/venue/file` | Explorar, descargar (adjunto, máx 25 MB) y subir (máx 10 MB, a `~/uploads`) archivos de la computadora                                                                                                                 |
| `POST /venue/teach`               | «Enséñale»: `start` graba, `save` convierte la grabación en un playbook ACTIVO, `discard` la descarta                                                                                                                  |

| Ruta                     | Contenido                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `GET /home?agentId=`     | Inicio personalizado: spec json-render armada solo con registros del usuario (`{empty, spec, counts, generatedAt}`) |
| `GET/POST /capabilities` | Catálogo de capacidades con estado real para el usuario / «Probar» un servidor MCP (latencia y error reales)        |
| `GET /models`            | Modelos servibles + `health` (cortocircuito por modelo)                                                             |
| `POST /voice/transcribe` | Audio (WAV 16 kHz, máx 10 MB) → texto. Permiso `assistant.voice` y voz activa en Admin                              |
| `POST /voice/speak`      | Texto (máx 4000) → MP3. Mismo permiso y ajuste                                                                      |

`POST /chat` acepta `agentId`, `effort` (`instant|light|medium|high|ultra`),
`capabilities` (ids del catálogo; el servidor los traduce a tools) y
`context.voice`; `AiConversation.agentId` fija el agente del hilo.

## Front (`src/components/universo/`) — reconstruido desde cero

`/app/assistant` monta `UniversoApp` (hoja de estilo única
`src/styles/universo.css`, namespace `uv-*`, solo tokens `--unik-*` y paleta
`--agent-hue-*`; la hoja vieja `universo-chat.css` y los componentes de
`src/components/assistant/` y `copilot/` se eliminaron — quedan el panel de
administración, `copilot-types.ts` y `AssistantPreferencesPanel`). Tres
columnas redimensionables (layout en `localStorage`); en tablet/móvil el equipo
es un cajón y el espacio de trabajo una hoja completa.

| Carpeta      | Qué contiene                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell/`     | `Sidebar` (equipo con estado en vivo, «En curso», misiones y rutinas, conversaciones agrupadas con buscar ⌘K / favorita / renombrar / borrar), `UserMenu` (preferencias y memoria, apps y extensiones, tema, densidad, animaciones, modo Misión por defecto, instalar la app), `NewAgentDialog` (34 especialistas por área o 7 equipos completos; rutinas como `Trigger` real; el director arranca el equipo con su _kickoff_), `AppsList` (Composio)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `chat/`      | `useChatStream` (SSE: tokens, razonamiento, tools, tarjetas, archivos, aprobaciones, acciones, modelo y respaldo; reconexión que espera la respuesta persistida; reintentar/detener), `Chat`, `Message` (modelo, esfuerzo, tiempo y costo de cada respuesta), `WorkLog` (razonamiento + pasos en una línea de tiempo plegable, en vivo mientras responde), `Markdown` (+ resaltado de código), `Composer` (bandeja de adjuntos: subidas en paralelo con progreso, reintento, cancelación, miniaturas y envío en espera; arrastrar, pegar o soltar en toda la conversación; dictado; modo voz; Misión/Directo), `PlusMenu` + `CapabilityMenu` (todas las capacidades reales con su estado: internet, navegador, computadora, documentos, equipo, rutinas, MCP, APIs, plugins, habilidades y apps), `EffortPicker` (Ultra-rápido · Ligero · Medio · Alto · Ultra), `Welcome` (saludo + inicio personalizado) |
| `cards/`     | `Cards` (KPIs, tablas ordenables con CSV, fuentes web, registros, notas, progreso, línea de tiempo, gráficas, media, conectar app, MCP UI e interfaces interactivas en iframe sandbox), `GenUi` (tarjetas **json-render** con el catálogo UNIK: se validan en servidor y navegador), `Agentic` (aprobación, plan, misión en vivo, reporte del equipo, rutina, trabajo del equipo), `ArtifactCard` (PDF/Excel/Word/CSV/tabla/gráfica con vista previa)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `voice/`     | `useVoiceSession` (micrófono con cancelación de eco → detector de voz → WAV 16 kHz → `/voice/transcribe` → el MISMO turno del chat → respuesta leída frase por frase con `/voice/speak`; interrupción al hablar encima), `VoicePanel` (anclado en lugar del composer: la conversación, tarjetas y aprobaciones siguen visibles), `speakable.ts` y `audio.ts` (funciones puras con pruebas)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `workspace/` | `Workspace` (pestañas Navegador · Computadora · Equipo · Archivos; historia desde los tool records del hilo + eventos `workspace.*` en vivo), `useVenue` (una sola fuente de verdad del navegador y el escritorio, sondeo adaptativo), `LiveScreen` (clic/escritura/teclas/scroll mapeados a coordenadas reales), `BrowserView`, `ComputerView` (escritorio, terminal, archivos, apps corriendo), `TeamView`, `FilesView`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

- Las aprobaciones aparecen **debajo de la respuesta que las pidió** (por el
  record `needs_approval` de la misma tool); las del turno en vivo, al final.
  La tarjeta del equipo sigue a la respuesta que delegó.
- Eventos: `agent.task` en `user:{id}`; `agent.message`, `agent.consolidating`
  y `workspace.*` en `assistant:{conversationId}` (sobres
  `{channel,type,payload}` — se lee `payload`).
- Storybook: `Universo/App` (conversación, oscuro, bienvenida, trabajando,
  navegador arrancando, escritorio, voz simulada, voz desactivada),
  `Universo/Tarjetas`, `Universo/Tarjetas generativas` y `Universo/Voz`, con
  API simulada (`stories/fixtures.ts`, solo historias; la voz simulada
  responde un tono en lugar de una voz real).

## Icono flotante y app de escritorio

- `AssistantWidget` (`src/components/universo/Widget.tsx`): FAB en todas las
  páginas excepto `/app/assistant`; abre el mismo `Chat` (misma API) con la
  página como contexto, y ↗ lleva a la conversación en la experiencia completa.
- **App de escritorio = PWA** (`manifest.ts` + `public/sw.js`); «Instalar la
  app» está en el menú del usuario (`beforeinstallprompt` o instrucciones por
  plataforma).

## Superficies de control (3)

| Superficie           | Estado                                             | Dónde                                                                |
| -------------------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| Navegador del agente | Chromium real en la venue (controlador Playwright) | Espacio de trabajo → Navegador (en vivo, tomar el control, Enséñale) |
| Computadora virtual  | Escritorio Linux (VNC) + terminal + archivos       | Espacio de trabajo → Computadora                                     |
| **Apps por API**     | Toolkits Composio conectados por el usuario        | Menú «+» → Apps conectadas · Espacio de trabajo → Equipo             |

### Arranque del navegador dentro de la venue (`daytona-venue.ts`)

- Un solo arranque en vuelo por sandbox (lock en memoria) + enfriamiento de
  45 s: el poll del panel y el tool del agente ya no se matan entre sí con
  `pkill`.
- El controlador (`browser-controller.mjs`, puerto 3100) se lanza en una
  **sesión de proceso Daytona** (`process.createSession` + `runAsync`) para que
  sobreviva al `executeCommand`; fallback `nohup`.
- `provision.sh` usa `sudo -n` cuando no es root, instala Chromium con
  `npx playwright install chromium` (+ `install-deps`) y deja marcadores
  (`UNIK_PROV_OK`, `UNIK_PROV_FAIL=…`, `UNIK_CHROME_PATH=…`,
  `UNIK_CHROME_MISSING_LIBS`) que `diagnose()` devuelve como motivo real al
  usuario en vez de un 502 mudo.
- `GET /venue/state` es pasivo (`attachVenue(..., {heal:false})`): el panel
  puede consultar cada pocos segundos sin provocar reinicios.

## Computer use — modelo rápido y barato

Los turnos que piden operar la computadora virtual (dominio `venue` en
`detectDomains`) se marcan `classification.computer` y salen del reparto por
tier: usan la tarea `computer` de `model-policy` → `computerUseModel` (Admin →
Reparto de modelos) → env `UNIK_COMPUTER_MODEL` → **`google/gemini-2.5-flash`
vía OpenRouter** ($0.30/$2.50 por 1M, visión+tools+1M ctx) cuando hay llave de
OpenRouter → si no, el modelo de rutina. Elección explícita del usuario siempre
gana. Las decisiones JEV (envelope) se conservan para routing/fanout.

## Esfuerzo en lugar de «Automático» (`effort-levels.ts`, `effort-policy.ts`)

El usuario elige cuánto pensar, no qué motor. Cada nivel es una política real:

| Nivel        | Modelo                           | Razonamiento | Pasos | Verificación                                                       |
| ------------ | -------------------------------- | ------------ | ----- | ------------------------------------------------------------------ |
| Ultra-rápido | el más veloz capaz               | mínimo       | ≤4    | ninguna                                                            |
| Ligero       | el del día a día                 | bajo         | ≤8    | 1 pasada determinista                                              |
| Medio        | según el tier (JEV o heurística) | por tier     | admin | checks + escalado por confianza + revisión de respuestas complejas |
| Alto         | modelo potente que razona        | alto         | ≥16   | checks + revisión                                                  |
| Ultra        | el más potente disponible        | alto         | ≥24   | checks + revisión independiente                                    |

- El modelo sale del catálogo por capacidades entre los proveedores con llave;
  nunca se enruta a un proveedor sin credenciales. La elección explícita de un
  modelo sigue ganando.
- Cadena de respaldo: si el modelo falla (llave, modelo no habilitado,
  proveedor caído, respuesta vacía) el turno sigue con el siguiente candidato;
  `model-health.ts` deja el modelo fallido al final por un tiempo.
- El interruptor de Admin «Revisión interna de respuestas» manda sobre todos
  los niveles, Ultra incluido (política de costos).
- JEV decide la ruta una vez por turno (`routeTurn`) y el modelo la recibe como
  guía (`describeRouteForPrompt`). Cada respuesta muestra modelo, esfuerzo,
  tiempo, costo estimado y los respaldos usados.

## Capacidades (`capability-catalog.ts`)

El «+» del composer lista todo lo que el agente puede usar, con el estado real
para ese usuario (listo, degradado, falta conectar, caído, desactivado). El
composer envía **ids**; `resolvePickedCapabilities` los traduce a tools en el
servidor, así el cliente nunca inyecta nombres de tools. Lo elegido se fuerza
en el menú del turno.

## MCP confiable (`src/modules/extensions/`)

Sesiones Streamable HTTP reutilizables, presupuesto de tiempo propio para
`tools/call`, un reintento si la sesión expiró (404) y salud por servidor
(`mcp-health.ts`): dos fallas de transporte seguidas sacan sus tools del menú
del modelo por un tiempo, luego pasa una llamada de prueba. Las tools de un
servidor sin la conexión del usuario tampoco se ofrecen. «Probar» en el
selector hace un diagnóstico real.

## Tarjetas generativas (json-render) e inicio personalizado

- `@json-render/core` + `@json-render/react` 0.21 con catálogo propio
  (`src/modules/ai/genui/catalog.ts`: 26 componentes y 8 acciones — preguntar,
  prellenar, abrir el espacio de trabajo, abrir enlace, abrir conversación,
  descargar, decidir una aprobación, copiar).
- Tool `renderUi`: el agente compone la tarjeta; `sanitizeGenUiSpec` la valida
  en el servidor y otra vez en el navegador (solo componentes y props del
  catálogo, expresiones permitidas — nunca `$computed` —, enlaces https o de la
  app, árbol acíclico y tamaños acotados). No se ejecuta código del modelo.
- Las aprobaciones desde una tarjeta usan las mismas rutas
  `/proposals/{id}/approve|reject` (permisos y auditoría del servidor).
- Inicio (`genui/home-data.ts` + `genui/home.ts`): decisiones pendientes, lo
  que quedó a medias, seguimientos, rutinas, lo que el usuario pide seguido,
  archivos recientes, avisos y capacidades disponibles que aún no usa. Cada
  consulta está acotada al usuario; si una sección falla, se omite.

## Voz (`src/components/universo/voice/`)

- Es la voz de los agentes: cada frase entra al mismo hilo con
  `context.voice = true` (mismo agente, tools, aprobaciones y tarjetas); el
  prompt agrega el bloque «MODO VOZ ACTIVO» (respuestas cortas, sin markdown,
  los detalles en tarjetas).
- Captura con AudioWorklet servido desde `/public` (la CSP no permite blobs),
  detector de voz adaptativo con pre-roll, WAV 16 kHz y filtro de
  alucinaciones de Whisper.
- La respuesta se lee mientras se genera, frase por frase, con 3 frases
  sintetizadas por adelantado. Hablar encima (o «Interrumpir») corta la voz;
  el resto de la respuesta queda en el chat y la transcripción solo registra
  lo que sí se dijo.
- Si la voz del servidor no está disponible (sin llave, proveedor caído) usa
  la del navegador, sin interrupción por voz (la voz del sistema no tiene
  cancelación de eco). Si Admin la desactivó o el usuario no tiene permiso
  (401/403) se detiene, libera el micrófono y lo dice: nunca la rodea.

## Adjuntos

La validación del archivo corre al momento (`runJobInline`: reclamo atómico
del job) en vez de esperar un hueco en la cola que comparte con tareas largas;
si la cola ya lo tomó, se espera como antes. El tipo MIME se infiere por
extensión cuando el navegador no lo da.

## Seguridad de pantallas (memory-only)

Las capturas de pantalla de la venue **nunca se persisten**: viajan solo por
SSE (`workspace.screen`) y por `GET /venue/state` (respondido con
`Cache-Control: no-store`). El orquestador aplica `stripScreenData` antes del
audit (`AiToolCall.result`), del mensaje `tool` persistido y del payload al
modelo — para "ver" la pantalla el modelo usa `analyzeImage` (visión acotada),
nunca el base64 como texto. `secure-input` ya canaliza credenciales
request→controller→página sin tocar modelo ni DB.

## Verificación

Typecheck 0 errores · lint 0 errores · 745 tests · `next build` completo ·
Storybook build · barrido con Playwright de las historias UNIVERSO
(1440/1024/768/390, claro y oscuro; sin desborde horizontal ni errores de
consola) · voz de punta a punta en Chromium con micrófono simulado (turno
completo, interrupción repetida, voz desactivada por Admin) · migraciones pasan
los checks de idempotencia (`prisma-migrations.test.ts`).

**Pendiente de validación manual (producción):** aplicar
`20261028000000_published_sites`; encender el navegador y el escritorio desde
el panel (Daytona real); tomar el control y grabar un «Enséñale»; pedir al
director un trabajo en equipo y ver la consolidación; publicar un sitio;
conectar una app de Composio; subir adjuntos en Railway; cada nivel de
esfuerzo y el respaldo de modelos con las llaves reales; servidores MCP
reales; voz con micrófono y OpenAI reales; el inicio con datos reales.
