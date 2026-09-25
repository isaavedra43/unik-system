# Asistente: modos, personalización, memoria y biblioteca aprobada

> **2026-09-25:** los paneles de copiloto embebidos en `/app/inbox` y `/app/chat`
> fueron retirados. Este documento cubre lo que sobrevive en el módulo
> `src/modules/copilot/`: las **preferencias del asistente** (`AiUserPreference`),
> la **memoria personal** (`AiMemory`) y la **biblioteca de conocimiento**
> (`KnowledgeSource`). Los modos por superficie (`inboxCopilotMode`,
> `chatCopilotMode`) ya no existen; quedan `mode` y `planMode`.

## Modos (por usuario, `AiUserPreference.mode`)

| Modo                   | Comportamiento                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `paused`               | Responde y redacta borradores. Las herramientas con efectos (`external_send`, `business_write`, `destructive`) no se ofrecen al modelo. |
| `on_request` (default) | Consulta lo que se pide; las acciones con efectos generan una propuesta que el usuario aprueba en el chat.                              |
| `autonomous_verified`  | Encadena consultas y verifica resultados por sí mismo; las acciones con efectos siguen requiriendo aprobación humana.                   |

Personalización: tono (profesional/cercano/directo), idioma (es/en), profundidad (breve/normal/detallado), formato (markdown/texto/tablas), instrucciones personales. Se inyecta en el system prompt (`buildPreferencesPrompt`). UI: botón **Preferencias y memoria** en la barra lateral del asistente. API: `GET/PATCH /app/assistant/api/preferences`.

## Memoria personal (`AiMemory`)

- Visible, editable y eliminable por su dueño (`/app/assistant/api/memory`, `[id]`, `DELETE` todo).
- El usuario crea recuerdos activos; lo que el asistente propone (`rememberForUser`, incluidas correcciones) queda **pendiente** hasta que el usuario confirma (`[id]/confirm`). Aprendizaje controlado, nunca silencioso.
- Se inyectan hasta 30 recuerdos activos por recencia; los pendientes solo se mencionan como "no confirmados".
- **Scopes por agente** (`src/modules/agents/memory-router.ts`, runtime V2): los recuerdos llevan `tenantId`/`agentId`/`conversationId` y el router decide qué inyectar por alcance (tenant → user → agent → thread) y modo (`full` para el principal, `on_demand` para workers delegados, `off`).

## Biblioteca aprobada (`KnowledgeSource` → versiones → fragmentos)

- Tipos de fuente: `document` (PDF, Word .docx, Excel .xlsx, CSV, TXT, Markdown, HTML, JSON), `url` (una página), `website` (hasta 20 páginas del mismo dominio) y `text`. Las descargas web pasan por `safeFetch`.
- Subida: la pestaña **Subir** sube varios archivos a la vez (target `knowledge_library`) y crea fuente + primera versión en un paso: `POST /app/admin/knowledge/api/sources` con `storageObjectId`, `url` o `text`. Una versión nueva de una fuente existente usa el target `knowledge_source` y `POST /sources/:id/versions`.
- Cada versión se procesa en un job (`knowledge.process_version`). Extracción en `knowledge-extract.ts` (puro, probado): Excel/CSV repiten el encabezado en cada fila y agrupan por hoja (un fragmento nunca pierde qué significa cada número); Word vía mammoth conserva títulos, listas y tablas; las páginas web conservan títulos y tablas. Luego fragmentación (~1800 caracteres con solapamiento) y embeddings.
- Solo las versiones **aprobadas** de fuentes **vigentes** (`expiresAt`) son citables y enviables. `autoApprove` en la versión la aprueba en cuanto termina de procesarse.
- `visibility`: `internal` vs `publishable`. `category` y `useWhen` ("cuándo usarla") guían a la IA para elegir el archivo correcto. `searchKnowledgeLibrary` acepta `visibility="publishable"` para contenido que sale a clientes.
- Envío de archivos: `findShareableDocument` elige EL archivo (aprobado, publicable, vigente, con archivo) para pedidos como "mándale el PDF de promociones" y responde `single | ambiguous | none`; nunca sustituye por otro archivo. `resolveMediaObjectIds` adjunta siempre la versión **aprobada** (antes tomaba la última procesada, aunque no estuviera aprobada).
- Eliminar (`DELETE /sources/:id`) borra la fuente, sus versiones, su índice y los archivos que nada más referencia; queda en auditoría (`knowledge.source_deleted`).
- UI `/app/admin/knowledge`: Todo · Para compartir · Subir · Conexiones (MCP/API/plugins de Extensiones, solo lectura) · Probar la IA (búsqueda y "¿qué archivo mandaría?", `GET /api/shareable?q=`). Panel lateral por fuente: vista previa (PDF, Word, hojas, texto web), lo que lee la IA, versiones, ajustes, archivar y eliminar.
- Requiere el worker de jobs: con `UNIK_JOB_WORKER_ENABLED=false` las subidas se quedan en "validando" y nada se procesa.
- Un adjunto de cliente en el chat no entra a la biblioteca; alguien con `knowledge.manage` lo añade explícitamente.

## Propuestas de comunicación interna

`sendInternalChatMessage` (efecto `external_send`): el asistente propone un mensaje al chat interno; el usuario lo aprueba en la tarjeta de propuesta. Nunca se envía solo. Acepta `channelId` (de `listChatChannels`), `recipient` (nombre del grupo o de la persona — resuelto en `prepareArgs` contra canales y `findUsersByQuery`; ambiguo → error con candidatos) o `recipientUserId` (de `findUsers`; el DM se crea con `createDmChannel` al ejecutar, solo si se aprobó). Opcional `priority: 'urgent'`.

## Herramientas nuevas

`searchKnowledgeLibrary`, `rememberForUser`, `listUserMemory`, `forgetMemory`, `sendInternalChatMessage` (habilitadas por defecto en `enabledTools`).

## Pruebas

`src/modules/copilot/copilot.test.ts`: fragmentación con secciones y solapamiento, tsquery segura, prompt de preferencias y memoria.

## Pendiente de validación manual

Búsqueda FTS con datos reales tras aplicar la migración; extracción de PDF escaneados (sin OCR: se reporta "sin texto").
