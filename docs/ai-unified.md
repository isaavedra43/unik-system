# IA unificada de UNIK (asistente y MCP)

La IA vive en el asistente y en el servidor MCP. Comparte orquestador, tools,
permisos, aprobaciones, memoria personal y contexto reciente.

> **UNIVERSO (2026-10, flag `UNIK_AGENT_RUNTIME_V2`):** encima de esta misma
> base corre el runtime multi-agente — un agente principal por usuario +
> especialistas + subagentes delegados con identidad propia (persona, modelo,
> toolAllowlist), `AgentRun`/`AgentEvent` por turno, routing JEV por envelope,
> delegación con cápsulas, DAG de tasks, venue central con lease, triggers
> always-on, ToolGateway por agente y memoria con scopes. Detalle completo en
> `docs/agents.md`. Sin el flag, todo lo descrito aquí corre igual en modo LEGACY.

| Superficie   | Dónde            | Ruta de turno                  | Hilo (`AiConversation.context.kind`) |
| ------------ | ---------------- | ------------------------------ | ------------------------------------ |
| Asistente IA | `/app/assistant` | `POST /app/assistant/api/chat` | `null` / `{page}`                    |
| Servidor MCP | agentes externos | `POST /api/mcp`                | sin hilo (audita como tool calls)    |

Los copilotos embebidos en `/app/inbox` y `/app/chat` (y el widget flotante) fueron
eliminados por completo para rehacerlos desde cero: paneles, rutas
`/app/inbox/api/conversations/{id}/copilot` y `/app/chat/api/channels/{id}/copilot`,
`proposeInboxDraft`/`proposeChatDraft`, los prompts de superficie y las preferencias
`inboxCopilotMode`/`chatCopilotMode`. Los hilos `inbox_copilot`/`chat_copilot`
históricos quedan ocultos en el historial del asistente (`copilot-surfaces.ts`). Las
tools de lectura de chat (`listChatChannels`, `getChatChannelMessages`,
`searchChatMessages`, `summarizeChatChannel`, `pinChatMessage`) y de bandeja
(`listInboxConversations`…) siguen disponibles para el asistente.

## Configuración en un solo lugar

`Asistente IA → Preferencias y memoria` (`AssistantPreferencesPanel`) edita la fila
`AiUserPreference` del usuario:

- **Modo de trabajo** (`mode`): pausada / a petición / autónoma con verificación. En
  pausada se ocultan las tools con efectos.
- Tono, idioma, profundidad, formato, instrucciones personales y memoria.

Servicio: `src/modules/copilot/preferences-service.ts`.

## Contexto compartido

- `src/modules/ai/ai-conversation-summary.ts`: tras cada turno el orquestador refresca un
  resumen corto del hilo (`AiConversation.summary`, modelo de respaldo, cada 4 mensajes).
- `buildSystemPrompt` inyecta "Contexto reciente del usuario": hasta 8 hilos de los últimos
  14 días del asistente, etiquetados.
- Memoria personal y biblioteca aprobada están disponibles en el asistente (las tools de
  memoria ya no exigen `assistant.use`).

## Copiloto genérico (eliminado)

- Los paneles de copiloto de `/app/inbox` y `/app/chat` se eliminaron junto con sus rutas,
  prompts y tools exclusivas (`proposeInboxDraft`, `proposeChatDraft`,
  `suggestNextActions` en turnos automáticos). Se reconstruirán desde cero.
- Sobreviven en `src/components/copilot/`: las tarjetas compartidas del asistente
  (`ProposalCard`, `PlanCard`, `MissionCard`, `MessageFeedback`, `ConfidenceBadge`) y
  `copilot-types.ts` con los parsers y etiquetas de tool que usa el asistente.
- `src/modules/ai/copilot-surfaces.ts` quedó reducido a los `kind` históricos
  (`inbox_copilot`/`chat_copilot`/`assistant_mission`) para ocultarlos del historial y
  al prefijo `⟦auto:` que usa la autocorrección de acciones fallidas.
- Chat interno: `src/modules/ai/tools/chat-copilot-tools.ts` conserva
  `listChatChannels`, `getChatChannelMessages`, `searchChatMessages`,
  `summarizeChatChannel`, `pinChatMessage` para el asistente;
  `sendInternalChatMessage` sigue siendo el único envío (requiere aprobación).

## Cobertura de tools

Nuevas o ahora habilitadas por defecto (`DEFAULT_AI_SETTINGS.enabledTools`): cotizaciones
(`queryQuotes`, `getQuoteDetail`, `searchQuoteCustomers`, `searchQuoteProducts`,
`previewQuote`, `createQuote`, `updateQuote`, `getQuotePdf`), skills (`listSkills`,
`runSkill`, `getSkillRunStatus`), chat interno, bandeja (`listInboxConversations`…),
campañas, voz (`startOutboundCall` sigue opt-in), web (`webSearch`, `webResearch`,
`webCrawl`, `fetchUrl`), media/imágenes, venue (`browserAct`, `venueExec`…) y
`renderInteractiveUi`.

## MCP

### UNIK como servidor MCP (`/api/mcp`)

Variables: `UNIK_MCP_API_KEY` (≥16 caracteres), `UNIK_MCP_ACTOR_USERNAME` (usuario con cuyos
permisos actúan los agentes), opcional `UNIK_MCP_ALLOW_USER_HEADER=true` para elegir el
usuario con la cabecera `X-UNIK-User`. Transporte Streamable HTTP sin estado; las tools con
efectos devuelven `status: "needs_approval"` y una persona las aprueba dentro de UNIK.

Ejemplo (Claude Desktop / Cursor):

```json
{
  "mcpServers": {
    "unik": {
      "url": "https://TU-DOMINIO/api/mcp",
      "headers": { "Authorization": "Bearer TU_UNIK_MCP_API_KEY" }
    }
  }
}
```

Prueba rápida con el SDK: `UNIK_MCP_API_KEY=... MCP_URL=https://TU-DOMINIO/api/mcp node scripts/mcp-smoke.mjs` o
`curl -H "Authorization: Bearer $KEY" https://TU-DOMINIO/api/mcp` (GET responde el descriptor).

### UNIK como cliente MCP (Admin → Extensiones → MCP)

Flujo: crear extensión MCP (URL, dominios, **roles autorizados** — sin roles solo la ve
super_admin) → "Descubrir herramientas" → clasificar cada capacidad (efecto, aprobación,
habilitar) → "Aprobar y habilitar". En desarrollo `UNIK_MCP_ALLOW_INSECURE_LOCAL=true`
permite `http://localhost` y direcciones privadas (nunca en producción).

Correcciones incluidas: las skills de un plugin ya no se enrutan al runtime HTTP,
`requireApproval` de un paso de skill ahora exige aprobación de verdad (`forceApproval`) y
las skills respetan la lista de tools habilitadas por el administrador.

## Capacidades completas (2026-09-13)

### Documentos

- Formatos: PDF, Excel, **Word (`generateWordReport`, `docx`)**, CSV, imagen SVG, tabla y gráfica en el chat. Cotizaciones siempre con el PDF oficial de Zoho.
- Los artefactos quedan ligados al mensaje que los produjo (`AiArtifact.messageId`) y se muestran como tarjeta con vista previa (PDF inline) en el asistente, también al recargar. TTL por defecto 90 días; los compartidos se protegen.
- Enlaces: `APP_URL` define el dominio real (`src/lib/app-url.ts`); las tools devuelven URLs absolutas y la IA tiene prohibido inventar hosts. Enlaces compartibles firmados: `/api/files/shared/<token>` (`artifact-share.ts`, secreto `UNIK_SHARE_LINK_SECRET` o `UNIK_SECRETS_MASTER_KEY`). Los envíos por chat interno/WhatsApp convierten los enlaces privados en compartibles automáticamente.
- Revisiones: cada artefacto guarda `meta.spec` (tool de datos + argumentos + generador); `getArtifactSpec` permite rehacerlo con cambios.

### Mensajería, llamadas y cotizaciones

- `sendMessageToContact` / `sendBulkMessages` (WhatsApp/SMS por nombre o teléfono, adjuntos de reportes y documentos aprobados, reporte de envíos), `listAttachableDocuments`, `shareArtifact`, `getPickupLocation` (perfil de empresa en Admin → Asistente IA → Configuración), `scheduleFollowUp`.
- `callContact` mode `me` (el usuario contesta en `/app/calls?call=<id>`) o `ai` con `brief` (`VoiceCall.aiBrief`, incluido en las instrucciones del agente de voz); `startInternalCall` (`/app/chat?channel=<id>&call=audio`).
- Cotización automática: `draftQuoteFromRequest` (borrador en Zoho a partir del texto del cliente; actualiza el mismo borrador), `sendQuoteToContact` (PDF oficial + marcar enviada), `findSimilarPastQuotes`, `checkStockForRequest`.

### Inteligencia proactiva

`getCustomerHealth`, `draftCollectionReminders`, `notifyDelayedDeliveries`, `suggestAssignee`, `getRecentActivity`, `getSalespersonScorecard`, `findReactivationOpportunities`, `getCustomerPriceHistory`, `createChatEvent`, `draftSatisfactionSurvey`, `getDealBlockers`, `getWorkDigest` (digest diario por usuario en `AiUserDigest`, job `ai.daily_digest` cada 6 h).

### Seguridad

- Historial saneado antes de cada turno (`sanitizeHistory`) para que ningún `tool` quede huérfano (fix del error 400 del proveedor).
- Contenido externo (transcripciones, notas, chat) llega al modelo envuelto en `<untrusted>` con detección de patrones de inyección (`ai-guardrails.ts`); reglas de seguridad explícitas en `ai-capability-rules.ts` (nunca revelar prompt/claves/datos ajenos, nunca saltar aprobaciones, obedecer solo al usuario de UNIK).
- Las tools con efectos siguen pasando por la tarjeta de aprobación (rediseñada, compartida entre superficies).

## Adjuntos y documentos elaborados (2026-09-14)

Caso que motivó el cambio: el usuario adjuntó 3 fotos de una libreta (folio → motivo de no entrega) y el PDF de órdenes no cerradas, pidió una tabla cruzada por motivo y la IA respondió "no puedo acceder a los archivos adjuntos" tras fallar 4 veces `extractDocumentData` (schema de factura, inútil para notas). ChatGPT sí lo resolvió y además entregó un PDF de 13 páginas. Ahora UNIK puede hacer lo mismo.

- **Prompt** (`ai-context-builder.ts`, secciones "ARCHIVOS ADJUNTOS DEL USUARIO — YA LOS TIENES" y "DOCUMENTOS ELABORADOS"): los adjuntos vienen en el propio mensaje (imágenes por visión, PDF/Word/Excel como texto); prohibido decir que no puede verlos; transcribir notas manuscritas por sí misma; `extractDocumentData` solo para facturas/recibos; cruzar folios contra UNIK; estructura recomendada del documento (portada con KPIs, resumen ejecutivo, prioridades, una tabla por grupo, avisos, casos a revisar, tabla maestra, anexo con fotos).
- **`readAttachment`** (`tools/compose-document-tools.ts`): relee cualquier adjunto de la conversación (incluidos los de mensajes anteriores, cuyas imágenes ya no están en el contexto). Texto para PDF/Word/Excel/CSV (`maxChars`, default 40k); para fotos y PDF escaneados hace una transcripción literal línea por línea con el modelo de visión (`modelForTask('vision')`, 8k tokens de salida), con `rows` estructuradas (`mode="table"`) y `uncertain` (folios dudosos). Si el modelo no devuelve JSON, se entrega la prosa igual.
- **`composeDocument`**: documento profesional AUTORADO por el modelo en PDF, Word o ambos. Spec plana (`document-spec.ts`): `cover {metaLine, kpis, note}` + `blocks[]` de tipo heading / paragraph (normal, lead, muted, note) / bullets (ordered) / callout (info, success, warning, danger, muted) / kpis / keyValue / table (columns, rows, totalsRow, caption, footnote, detail) / bars (gráfica horizontal con % del total) / image (attachmentId) / divider / pageBreak, y `appendix.includeAttachments` para anexar las fotos originales (JPG/PNG; `imageDimensions` lee el tamaño del header). Límites: 120 bloques, 4 000 filas, 12 imágenes de anexo. Aquí las filas SÍ las escribe el modelo (el orquestador NO las reemplaza: la tool no está en `ARTIFACT_TOOLS`, pero sí en `ARTIFACT_TOOL_NAMES` para que no cuente como "última consulta de datos").
- **Generadores**: `document-pdf-generator.ts` (pdfkit, flujo con portada, encabezado corrido, pie "Página X de N", tablas con filas medidas por `heightOfString`, columnas cortas sin salto, pills de estado, fila TOTAL, líneas detail, barras, avisos, imágenes escaladas) y `document-docx-generator.ts` (docx con header/footer, KPIs en tabla, tablas, barras como celdas sombreadas, `ImageRun`). Helpers de tabla del generador tabular (`resolveColumns`, `cellText`, `measureLines`) ahora se exportan. Tests: `document-generators.test.ts`.
- **Routing y presupuesto**: una imagen con una petición real (≥ 8 palabras, "tabla", "cruza", "compara", "reporte"…) va al tier `complex` (`model-router.ts`); en turnos complejos o con adjuntos el orquestador pide `max(maxTokens, 12 000)` tokens de salida, acotado al `maxOutput` del modelo (`resolveTurnMaxTokens`). El texto inyectado de un adjunto sube a 24 000 caracteres (`MAX_TEXT_CHARS`).
- `extractDocumentData` ahora acepta 8k tokens de salida y su error indica usar `readAttachment` cuando el archivo no es una factura.
- Etiquetas de UI en `copilot-types.ts` ("Leyendo el adjunto", "Redactando el documento"). Tools habilitadas por defecto y en `CORE_TOOL_NAMES`.

## Nivel ChatGPT: razonamiento, cruce determinista y revisión (2026-09-14, tarde)

Segunda ronda tras comparar de nuevo con ChatGPT (GPT-5 "Alta", 3 min de razonamiento): nuestra IA con gpt-4o transcribió mal folios (23328 por 23338, 23359 por 23378…), no cruzó contra el sistema, dijo "un momento", escribió una imagen markdown rota y el PDF salió con 16 páginas reales (12 en blanco por el pie de página). Cambios:

- **Modelos con razonamiento** (`providers/openai.ts`): `isReasoningModel` (gpt-5*, o*) → `max_completion_tokens` + `reasoning_effort`, sin `temperature` (`buildGenerationParams`, con test). `ChatCompletionOptions.reasoningEffort`. Catálogo: `gpt-5`, `gpt-5-mini`, `gpt-5.1`. `listRemoteModels` en OpenAI + ruta `POST /app/admin/assistant/api/providers/openai/models` (guarda los ids de chat en `providerConfigs.openai.models`). Panel "Reparto de modelos": botón **Detectar modelos de OpenAI** y preset **Máxima calidad (GPT-5, como ChatGPT)** (complejo/principal = GPT-5, rutina en Canopy si está, `reasoningEffort=high`, revisión activada). Settings nuevos: `reasoningEffort` (default high, solo tareas complejas; estándar = low, simple = minimal) y `answerReviewEnabled` (default true).
- **Presupuesto**: turnos complejos o con adjuntos piden ≥ 32k tokens de salida en modelos que razonan (≥ 12k en los demás), tope `maxOutput`.
- **Adjuntos previos siempre disponibles** (orquestador 7.4): los archivos de mensajes anteriores (hasta 6) se re-adjuntan al turno actual si no es un saludo, etiquetados "enviado en un mensaje anterior". "Dame un PDF con todo" vuelve a ver las fotos.
- **Directivas por turno** (`turn-directives.ts`, puro, con tests): al final del system prompt se agrega el protocolo concreto del turno — adjuntos + análisis (readAttachment por imagen con `validateOrders`, `lookupSalesOrdersByNumber` con todos los folios, clasificación, estructura de respuesta obligatoria, prohibiciones), documento (composeDocument vs generatePdfReport) o tarea compleja.
- **Cruce determinista** (`tools/lookup-tools.ts`): `lookupSalesOrdersByNumber(numbers[])` busca hasta 400 folios en una llamada (cliente, vendedor, ticket, pago, envío, saldo) y para los que no existen sugiere folios reales a un dígito de distancia (`nearbyNumberVariants`: sustitución, transposición, dígito de más/menos). `readAttachment` ahora devuelve `orderCheck` (folios transcritos que no existen + lectura probable) y usa `reasoningEffort=medium`, 12k tokens, timeout 180 s.
- **Consistencia del documento**: `composeDocument` rechaza (no genera) cuando un título anuncia "N órdenes/registros…" y su tabla trae otro número (`findCountMismatches`, con test); timeout 180 s.
- **Respuestas a medias y revisión interna** (orquestador): si la respuesta final termina en "un momento / voy a…", el modelo recibe una nota interna y continúa (una vez). En turnos complejos los tokens se retienen (`bufferAnswer`), un revisor (`ai-answer-review.ts`, modelo complejo con esfuerzo bajo) busca faltantes, cifras que no cuadran, tablas cortadas o categorías inventadas, y el modelo reescribe una vez con la crítica; la UI muestra el chip "Revisando la respuesta" (`reviewAnswer`). Las imágenes markdown se eliminan del texto (`stripMarkdownImages`).
- **PDF**: el pie de página se dibuja con `margins.bottom = 0` y el generador verifica que el número de páginas no cambió; test con `pdf-parse` (`numpages === pageCount`).
- Prompt: sección "CÓMO TRABAJA UN ANALISTA SENIOR" y excepción a "más de 8 filas → generateTable" para tablas de análisis propias.

**Tercera ronda (misma tarde): 10 minutos y "network error".** Con GPT-5 el turno tardó ~10 min y la conexión se cortó. Causas y fixes:

- Sin latidos en el SSE y con la respuesta en búfer pasaban minutos sin bytes → el proxy/navegador corta el stream. Ahora `/app/assistant/api/chat` manda un comentario SSE (`: ping`) cada 15 s; los parsers ignoran las líneas que no empiezan con `data:`.
- Si aun así se corta, `AssistantChat` no falla: muestra "el asistente sigue trabajando" y sondea la conversación cada 6 s (hasta 15 min) hasta que aparece la respuesta persistida (`waitForPersistedAnswer`).
- `readAttachment` con GPT-5 corría sin streaming con 12k tokens y esfuerzo medium bajo un timeout de 180 s (expiraba y el modelo reintentaba). Ahora: esfuerzo low, 6k tokens, timeout 300 s. Y cuando el modelo del turno razona y ve imágenes (GPT-5), la directiva le pide transcribir él mismo y saltarse esa pasada (una llamada pesada menos); `lookupSalesOrdersByNumber` sigue corrigiendo folios.
- `reasoningEffort` por defecto baja a `medium` (high multiplicaba minutos en cada pasada); el cliente OpenAI tiene `timeout` 15 min y `maxRetries: 1` (un reintento silencioso duplicaba llamadas de minutos). Turnos con adjuntos ofrecen ≤ 48 tools (prompt más corto en cada pasada).
- En modo búfer la UI muestra el chip "Redactando la respuesta" (`draftAnswer`) mientras el modelo escribe, y "Revisando la respuesta" durante la revisión.

**Cuarta ronda (GPT-5 ya responde, pero 10 min, PDF no pedido y presentación pobre).**

- **Universo de folios** (`lookup-tools.ts` → `reconcileWithExpected`, puro con test): el orquestador extrae los `OV-xxxxx` de los adjuntos de texto (el PDF de órdenes) y los pasa a las tools como `ctx.attachmentOrderNumbers`; `lookupSalesOrdersByNumber` acepta `expectedNumbers` (o usa el del contexto) y devuelve `universe`: `misreadCorrected` (folio anotado que no está en la lista pero está a un dígito de uno no reclamado → se corrige aunque exista en la BD como otra orden), `withoutRequest` (órdenes de la lista sin nota) y `notInUniverse`. Corrige el fallo de "existe en el sistema, luego está bien" (23359/23385/23338/23384 eran lecturas erróneas que sí existían como otras órdenes cerradas).
- **Documentos solo si se piden**: `wantsDocument(message, lastAssistantContent)` (petición explícita o "sí/dale" tras una oferta) decide si `composeDocument` se ofrece al modelo; si no, la tool ni aparece. La directiva dice explícitamente "el usuario NO pidió archivo".
- **Sin revisión para modelos que razonan**: `bufferAnswer`/revisión interna solo cuando el modelo del turno no es GPT-5/o-series (esos ya verifican mientras piensan); con GPT-5 la respuesta se transmite en vivo. Menos pasadas: lectura+cruce (1) → respuesta (2).
- **Formato**: la directiva pide `##`/`###`, listas de una por línea y párrafos cortos; `AssistantMarkdown` ahora distingue tamaños de encabezado (`assistant-md-heading-1..4`), soporta listas `1)`, viñetas anidadas por sangría, `---` y saltos de línea dentro de un párrafo.

**Quinta ronda: se adelanta, no se equivoca, aprende, más rápida.**

- **Sugerencias con un clic** (`followups.ts`): la IA cierra respuestas con datos con `Sugerencias: [acción] · [acción] · [acción]` (antes de "Confianza:"); el orquestador la guarda en `AiMessage.meta.followUps` y `AssistantMessage` la muestra como chips que envían el texto al escribirlo (solo en el último mensaje).
- **Verificación determinista antes de entregar** (`answer-checks.ts`, todos los modelos): folios citados que ninguna tool devolvió en el turno (`collectFolios` sobre cada resultado) y encabezados "### Grupo — 20"/"(20)" cuya tabla markdown no trae ese número de filas → nota interna y una pasada de corrección (chip "Revisando la respuesta"). Máx. 2 correcciones por turno.
- **Aprende de correcciones** (`ai-learning.ts`, setting `learningCaptureEnabled`): si el mensaje corrige o define algo ("no, Producción significa…", "para nosotros Recolección es…"), un pase de fondo con el modelo utilitario extrae hasta 3 reglas durables y las propone como recuerdos `pending` (fuente `correction`, tag `auto`) que el usuario confirma en Preferencias y memoria; evita duplicados por similitud. El prompt pide aplicar las definiciones de la memoria al clasificar.
- **Caché de prompt**: la fecha/hora sale del encabezado y va al final del system prompt; las tools ofrecidas se ordenan por nombre → prefijo estable entre pasadas y turnos (OpenAI reutiliza el prefijo cacheado: primer token más rápido y más barato).

**Sexta ronda: dinero solo si se pide, encabezado del PDF, versiones del mismo archivo.**

- **Dinero estrictamente opt-in** (`report-customization.ts`): `resolveReportCustomization(message, model, base)` decide `showTotals` solo con las palabras del usuario en ese mensaje (o lo que tenía la versión anterior); `enforceMoneyOptIn` quita Total/Saldo de `columns`/`addColumns`/`asColumn` y apaga la fila de totales; `applySummaryCardCustomization` descarta tarjetas de dinero aunque el modelo pase `showSummaryCards: true`; `applyColumnCustomization` ya no acepta columnas de dinero "explícitas" del modelo. Cierra el hueco por el que aparecieron Total y Saldo pendiente sin pedirlos.
- **Encabezado** (`pdf-generator.ts`): pdfkit envuelve el título aunque se pida una línea; ahora se reduce la fuente (18→13) y si aún no cabe se envuelve a propósito y el subtítulo baja según la altura medida (antes se encimaban).
- **Cambios sobre el mismo archivo** (`revisions.ts` + orquestador 8.66): `isRevisionRequest` detecta "quita/agrega/cambia/ponlo en vertical/mismo reporte…"; se busca el último artefacto de la conversación con `meta.spec`, se agrega al prompt "CAMBIOS SOBRE EL ÚLTIMO ARCHIVO" (tool, versión y parámetros), y cuando el modelo llama la misma tool los parámetros previos van debajo de los nuevos (`mergeRevisionArgs`; la customización se re-mezcla base → modelo → palabras del usuario). El nuevo artefacto lleva `meta.version = n+1` y `revisionOf`; el anterior `supersededBy`; la tarjeta muestra "v2" y "sustituido por una versión nueva"; el resultado de la tool trae `revision.note` para que lo presente como versión, no como archivo nuevo. Un `blocks` mayor de 200k chars no se guarda en el spec.

**Cómo activarlo en producción:** Admin → Asistente IA → Configuración → Reparto de modelos → "Detectar modelos de OpenAI" (confirma que la llave lista gpt-5) → "Máxima calidad" → Guardar. Sin GPT-5 la llave sigue funcionando con gpt-4o pero sin razonamiento previo.

## Capa de inteligencia (2026-09-13, tarde)

Fix raíz del error `400 Invalid 'tools': array too long … 130` de OpenAI: ya no se manda el catálogo completo.

- **Selección de tools por turno** (`src/modules/ai/tool-selector.ts`): núcleo siempre presente (`CORE_TOOL_NAMES`) + tools fijadas por superficie + tools usadas antes en el hilo + las más relevantes al mensaje (palabras clave con sinónimos español/inglés y dominios). Tope `maxToolsPerTurn` (default 96; nunca > 128). El proveedor OpenAI recorta a 128 como último seguro. `loadMoreTools(topic)` la resuelve el orquestador: agrega las tools del tema al siguiente paso. Un tool call a una tool disponible pero no ofrecida también se ejecuta.
- **Routing de modelo** (`model-router.ts`): "Automático" en el selector (`AUTO_MODEL_ID='auto'`, default cuando `routingEnabled`) → simple (saludos/confirmaciones) usa `routingSimpleModel` (gpt-4o-mini), estándar usa `deployment`, complejo (análisis, multi-dominio, adjuntos, "Planear primero") usa `routingComplexModel || deployment`. Con imágenes/PDF escaneado se exige modelo con visión. La decisión queda en `AiMessage.meta.routing`.
- **Ejecución paralela**: en cada iteración, las tool calls consecutivas con efecto `read` (no artefactos ni planificación) corren con `Promise.all`; los resultados se finalizan en el orden del modelo. Envíos/escrituras/eliminaciones siguen secuenciales (aprobación).
- **Plan-then-execute**: tool `proposePlan` + preferencia `AiUserPreference.planMode` (auto | always | never, en "Preferencias y memoria") + botón "Planear primero" en el asistente (`planFirst` en `/app/assistant/api/chat`). La tarjeta `PlanCard` tiene "Ejecutar plan" (manda `RUN_PLAN_MESSAGE`) y "Ajustar".
- **RAG híbrido** (`embeddings-service.ts`, `rag-fusion.ts`, `knowledge-service.searchKnowledge`): `KnowledgeChunk.embedding` (double precision[], sin extensión de Postgres) con `text-embedding-3-small`; búsqueda léxica + semántica fusionadas con RRF, re-ranking opcional con modelo (`ragRerankEnabled`); fallback léxico si no hay clave. Embeddings al procesar una versión y job `ai.embeddings_backfill` cada 30 min. Cada hit trae `match: lexical|semantic|hybrid`.
- **Adjuntos**: DOCX (mammoth), XLSX (exceljs, hasta 6 hojas × 300 filas), audio (Whisper vía proveedor OpenAI), imágenes webp/gif, video (aviso de no soportado), PDF escaneado → se manda el archivo al modelo como `ContentPart` `file` (OCR con visión, `ocrFallbackEnabled`). Defaults de `allowedMimeTypes` ampliados (se migran solos si nunca se personalizaron); `maxAttachmentSizeMb` 25.
- **Documentos** (`tools/documents-tools.ts`): `listConversationAttachments`, `extractDocumentData` (JSON estricto: emisor/receptor con RFC, folio, UUID, fecha, conceptos, impuestos, totales, `checks.totalsMatch`), `draftBillFromDocument` (proveedor por RFC/nombre + productos por SKU/nombre; la bill se captura en Zoho Books, UNIK solo la sincroniza: `canCreateInZoho:false`).
- **Caché de lecturas** (`tools/tool-cache.ts`, en `executeTool` paso 6): solo tools builtin `read` de categorías de datos; TTL `toolCacheTtlLiveSeconds` (30) para periodos vivos y `toolCacheTtlHistoricalSeconds` (300) para cerrados; las tools de datos puras se comparten entre usuarios con el MISMO conjunto de permisos, las demás por usuario; cualquier tool con efecto limpia la caché; "actualiza / en tiempo real" en el mensaje → `skipCache`. Resultado marcado `cached:true, cachedAt`.
- **Confianza** (`confidence.ts`): regla de prompt "Confianza: Verificado/Estimación/Suposición — motivo" al final de respuestas con datos; el orquestador la parsea (`meta.confidence`), y si el modelo la omite la infiere de las tools del turno. La UI la quita del texto y muestra `ConfidenceBadge` (+ modelo, "auto", "en paralelo", "caché ×n").
- **Calidad** (`ai-feedback-service.ts`, `AiMessageFeedback`, `POST/DELETE /app/assistant/api/messages/[id]/feedback`): 👍/👎 con comentario en el asistente (`MessageFeedback`). Juez opcional (`ai-quality-judge.ts`, `qualityJudgeEnabled`, no bloquea) guarda `meta.judge.score` 1-5. Admin → Asistente IA → Resumen: "Calidad de respuestas" (útiles %, juez, % con datos verificados, comentarios).
- Config nueva en Admin → Asistente IA → Configuración: routing, tools por turno, caché, RAG, OCR, juez.

## Fiabilidad de acciones (2026-09-13, noche)

Correcciones tras pruebas reales en producción. **Nota:** las entradas que mencionan
"copiloto de bandeja/chat", `proposeInboxDraft`, `suggestNextActions`,
`listSurfaceConversations`, `INBOX_CONTEXT_TOOLS`, `autoInsertDrafts` o
`onInsertAttachment` describen mecanismos de los paneles embebidos **retirados el
2026-09-25**; se conservan aquí como historial. Las tools de negocio citadas
(`sendInboxMessage`, `draftQuoteFromRequest`, `sendQuoteToContact`, `callContact`…)
siguen vigentes en el asistente.

- **Cotizaciones**: `createQuote`/`previewQuote`/`updateQuote` aceptan alias del modelo (`productId`, `price`, `qty`…), buscan el producto por nombre cuando falta `itemId` y aplican el precio de lista si `rate` es 0 (`normalizeQuoteItems` + `enrichQuoteItems`). Los errores de Zoho llegan legibles con pista (`friendlyQuoteError`: scope, org, producto/cliente no encontrado, conflicto). Nuevo `getZohoBooksStatus` (simulación, credenciales, org, lectura de prueba, última cotización sincronizada).
- **Auto-corrección**: cuando una acción aprobada falla, la tarjeta roja muestra el motivo y el asistente recibe un turno automático `⟦auto:action_failed⟧` (el cliente manda `actionFailedMessage`) para diagnosticar y volver a proponer la acción corregida.
- **Llamadas**: dock flotante global (`src/components/calls/CallDockProvider.tsx`, montado en `AppShell`) que sobrevive al cambio de módulo: sonando/en llamada/terminada, timer, micrófono (`CallRoom compact`), Pasar a la IA / Pausar IA, Escalar (transferir a compañero), Grabar, Colgar, enlace al detalle. Se abre solo cuando la IA marca (`callContact` aprobado → `uiActionFromResult` → evento `unik:call:join`) o desde el botón **Llamar** del encabezado de la bandeja (`unik:call:dial`). El orquestador emite eventos `action` (join_call / open_url) para tools ejecutadas sin aprobación (`startInternalCall` abre el chat y marca).
- **Mensajes a clientes**: `customer-message-format.ts` (markdown → WhatsApp, sin placeholders "[Tu Nombre]", sin stock/datos internos salvo `keepInternalData`) aplicado en `sendInboxMessage`, `proposeInboxDraft` y `deliverToContact`. `sendInboxMessage` acepta `attachments` y **auto-adjunta** cualquier reporte cuya liga venga en el texto (`prepareCustomerMessage`): el cliente recibe el documento como media (Twilio `MediaUrl` firmado), no una liga. Enlaces compartidos toleran puntuación pegada (`verifyShareToken`) y `markdownLinksToPlain` deja espacio antes del punto.
- **Copiloto de bandeja**: regla "ENVIAR vs REDACTAR" (dile/mándale/envíale → `sendInboxMessage` con tarjeta de aprobación; redacta/sugiere → `proposeInboxDraft`) y reglas de formato/firma/datos internos/adjuntos en el prompt.
- **Modo del copiloto**: la insignia del panel abre un menú para cambiar el modo de ESA superficie escribiendo la misma preferencia unificada (`PATCH /app/assistant/api/preferences`), con enlace a todas las preferencias; el panel refresca el modo al volver a la pestaña.

### Segunda ronda de pruebas (misma noche)

- **Cotizar desde la bandeja**: `createQuote`/`previewQuote` se ocultan en la superficie de bandeja (`INBOX_HIDDEN_TOOLS`); la regla 4b del prompt obliga a `draftQuoteFromRequest` → `sendQuoteToContact` (una sola aprobación). Los conceptos aceptan `item_id`, `line_item_id`, `sku`, `productName`, `cantidad`, `precio`; al crear, `lineItemId` nunca viaja a Zoho (era el "line_item_id no válido") y se reutiliza como candidato de `itemId`; sin nombre se usa la descripción o el SKU.
- **Acciones sugeridas con un clic**: en los turnos automáticos del copiloto (abrir / mensaje nuevo) la primera llamada al modelo fuerza `suggestNextActions` (`toolChoice` en `ChatCompletionOptions`, soportado por el proveedor OpenAI), así siempre salen chips en vez de prosa.
- **Borrador editable con Enviar**: `DraftCard` permite editar el texto y enviarlo directo (`onSendDraft`: bandeja → `POST /app/inbox/api/conversations/[id]/messages`, chat → `POST /app/chat/api/channels/[id]/messages`); el clic es la aprobación.
- **Dictado por voz** en el compositor del copiloto (`VoiceDictationButton`, Web Speech API).
- **Llamadas**: `callContact` elige sola la cuenta de voz Twilio del equipo, normaliza el número a E.164, espera 1.5 s y verifica que la llamada no haya fallado antes de reportar "sonando"; en modo simulación (sin LiveKit) lo dice explícitamente. Las tarjetas verdes "Aprobaste la acción" traen el botón **Abrir la llamada** (`extractResultAction` lee `callId` del resultado). El dock ya no se cierra solo cuando hay error y muestra el estado real de la llamada.
- **Validación previa a la aprobación** (`ToolDefinition.prepareArgs`, paso 4b de `executeTool`): `createQuote`/`updateQuote` completan las líneas desde el catálogo (id, nombre, precio de lista) ANTES de crear la propuesta y rechazan líneas sin producto o con precio 0 con un mensaje accionable para el modelo; la tarjeta muestra los nombres reales y lo aprobado es exactamente lo que se ejecuta.
- **Búsqueda de productos para cotizar** (`findCatalogProducts` en `quotes-tools.ts`): texto completo → tokens en cualquier orden (AND) → menos tokens; tolera acentos ("lamina" ↔ "Lámina") y prioriza tokens de medida ("10xll"). Antes, "piel de elefante 10xLL" no encontraba "Piel de Elefante Cafe 10xLL" y el borrador respondía "ningún producto coincidió". Los chips rojos del copiloto ahora muestran el error exacto al hacer clic (`tool_call_end.error`).
- **Hilos del copiloto**: cada usuario puede tener varias conversaciones con el copiloto por bandeja/canal (`listSurfaceConversations`, `getOrCreateSurfaceConversation(actor, surface, { threadId, createNew })`). Rutas de copiloto: `GET ?new=1` crea, `GET ?thread=<id>` abre, `GET ?list=1` lista; `POST { threadId }` continúa un hilo. En el panel: botón **+** (nueva) e **Historial**.
- **Vendedor en cotizaciones de la IA** (`resolveSalesperson` en `quotes-tools.ts`): Zoho Books de UNIK exige vendedor en las cotizaciones; la IA lo resuelve sola: el que nombre el modelo (resuelto a su id de Zoho), el usuario si es vendedor en Zoho, el de la última cotización u orden del cliente, o el primero de la lista. Aplica en `draftQuoteFromRequest` y en `prepareArgs` de `createQuote`/`updateQuote`.
- **Cotización completa desde la bandeja**: `draftQuoteFromRequest` adjunta el PDF oficial de Zoho al chat como tarjeta (`ensureQuotePdfArtifact`, vista previa/descarga/enviar) y el orquestador inyecta `inboxConversationId` también en `draftQuoteFromRequest`/`sendQuoteToContact` (`INBOX_CONTEXT_TOOLS`), así el destinatario es SIEMPRE el contacto de la conversación. `sendQuoteToContact`, `sendMessageToContact` y `callContact` resuelven el contacto en `prepareArgs`: un nombre ambiguo ("Israel" ↔ "Israel Saavedra") se rechaza antes de la tarjeta y la IA pregunta en vez de adivinar. Los enlaces internos `/app/quotes/<id>` en mensajes a clientes se sustituyen por el PDF adjunto (`prepareCustomerMessage`).
- **Cotizar sin depender de Twilio para el archivo**: en la bandeja, el PDF oficial de la cotización se adjunta automáticamente al redactor del operador (`onInsertAttachment` → `MessageComposer.insertAttachment`, sin re-subir: usa `storageObjectId`) y el mensaje sugerido por la IA cae en el textbox (`autoInsertDrafts` en la superficie de bandeja); el operador revisa y pulsa enviar. Las tarjetas de archivo muestran **Adjuntar** en vez de "copiar enlace" cuando hay redactor, y las tarjetas de aprobación de envío tienen **Al redactor**. Los artefactos exponen `storageObjectId`, `mimeType`, `quoteId` en el DTO y en el evento SSE.
- **Acciones sugeridas robustas**: `suggestNextActions` acepta alias (`title`, `prompt`, `description`, cadenas) y `parseSuggestedActions` los normaliza, así los chips siempre aparecen tras el análisis automático.
- **Media para Twilio sin R2**: `src/modules/storage/media-share.ts` (`mediaSharePath`, token HMAC de 2 h) + `GET /api/files/media/[token]` sirven cualquier objeto listo de forma pública y firmada; `twilio-adapter.mediaUrlsFor` lo usa cuando el driver es disco o el objeto está protegido. Requiere `APP_URL` con https.
- **Cliente de la cotización desde el asistente** (`resolveQuoteCustomer` en `quotes-tools.ts`): acepta el `zohoContactId` directamente, prefiere coincidencias exactas de nombre y clientes activos sobre inactivos, y solo devuelve candidatos (con estado) cuando de verdad hay ambigüedad. Mismo camino en el asistente, la bandeja y el chat interno.
