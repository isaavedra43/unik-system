# IA unificada de UNIK (asistente, copilotos y MCP)

Una sola IA vive en tres superficies y en el servidor MCP. Todas comparten orquestador,
tools, permisos, aprobaciones, memoria personal y contexto reciente.

| Superficie | Dónde | Ruta de turno | Hilo (`AiConversation.context.kind`) |
|---|---|---|---|
| Asistente IA | `/app/assistant` (+ widget flotante) | `POST /app/assistant/api/chat` | `null` / `{page}` |
| Copiloto de bandeja externa | aside en `/app/inbox` | `POST /app/inbox/api/conversations/{id}/copilot` | `inbox_copilot` (`commConversationId`) |
| Copiloto de chat interno | aside en `/app/chat` | `POST /app/chat/api/channels/{id}/copilot` | `chat_copilot` (`chatChannelId`) |
| Servidor MCP | agentes externos | `POST /api/mcp` | sin hilo (audita como tool calls) |

## Configuración en un solo lugar

`Asistente IA → Preferencias y memoria` (`AssistantPreferencesPanel`) edita la fila
`AiUserPreference` del usuario:

- **Modo de trabajo** (`mode`): pausada / a petición / autónoma con verificación. Aplica en
  todas las superficies (en pausada se ocultan las tools con efectos en todas partes).
- **Copiloto en bandeja externa** (`inboxCopilotMode`) y **en chat interno**
  (`chatCopilotMode`): activo / a petición / apagado. Los paneles muestran el modo como
  insignia de solo lectura con enlace a `/app/assistant?settings=1`; ya no hay selector
  dentro del panel (`PATCH /app/inbox/api/copilot/mode` fue eliminado).
- Tono, idioma, profundidad, formato, instrucciones personales y memoria.

Servicio: `src/modules/copilot/preferences-service.ts` (`getCopilotMode(userId, 'inbox'|'chat')`).

## Contexto compartido

- `src/modules/ai/ai-conversation-summary.ts`: tras cada turno el orquestador refresca un
  resumen corto del hilo (`AiConversation.summary`, modelo de respaldo, cada 4 mensajes).
- `buildSystemPrompt` inyecta "Contexto reciente del usuario": hasta 8 hilos de los últimos
  14 días de cualquier superficie, etiquetados (asistente / bandeja con contacto X / chat con Y).
- Memoria personal y biblioteca aprobada están disponibles en los copilotos (las tools de
  memoria ya no exigen `assistant.use`).

## Copiloto genérico

- Componente compartido `src/components/copilot/CopilotPanel.tsx` (`CopilotSurfaceConfig`:
  endpoints, `activityAt`, `draftTool`, textos). Envoltorios:
  `src/components/inbox/copilot/CopilotPanel.tsx` y `src/components/chat/ChatCopilotPanel.tsx`.
- Servidor: `src/modules/ai/copilot-surfaces.ts` (`getOrCreateSurfaceConversation`,
  `shouldRunAutoTurn`, `autoTriggerMessage`, reglas de panel compartidas).
- Chat interno: prompt `src/modules/chat/chat-copilot.ts`, tools
  `src/modules/ai/tools/chat-copilot-tools.ts` (`listChatChannels`, `getChatChannelMessages`,
  `searchChatMessages`, `summarizeChatChannel`, `proposeChatDraft`, `pinChatMessage`);
  `sendInternalChatMessage` sigue siendo el único envío (requiere aprobación).
- El orquestador inyecta `inboxConversationId` / `chatChannelId` en las tools de cada
  superficie y oculta `suggestNextActions` fuera de los paneles.

## Cobertura de tools

Nuevas o ahora habilitadas por defecto (`DEFAULT_AI_SETTINGS.enabledTools`): cotizaciones
(`queryQuotes`, `getQuoteDetail`, `searchQuoteCustomers`, `searchQuoteProducts`,
`previewQuote`, `createQuote`, `updateQuote`, `getQuotePdf`), skills (`listSkills`,
`runSkill`, `getSkillRunStatus`), chat interno, bandeja (`listInboxConversations`…),
campañas y voz (`startOutboundCall` sigue opt-in).

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
- Los artefactos quedan ligados al mensaje que los produjo (`AiArtifact.messageId`) y se muestran como tarjeta con vista previa (PDF inline) en el asistente y en los copilotos, también al recargar. TTL por defecto 90 días; los compartidos se protegen.
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

## Capa de inteligencia (2026-09-13, tarde)

Fix raíz del error `400 Invalid 'tools': array too long … 130` de OpenAI: ya no se manda el catálogo completo.

- **Selección de tools por turno** (`src/modules/ai/tool-selector.ts`): núcleo siempre presente (`CORE_TOOL_NAMES`) + tools fijadas por superficie + tools usadas antes en el hilo + las más relevantes al mensaje (palabras clave con sinónimos español/inglés y dominios). Tope `maxToolsPerTurn` (default 96; nunca > 128). El proveedor OpenAI recorta a 128 como último seguro. `loadMoreTools(topic)` la resuelve el orquestador: agrega las tools del tema al siguiente paso. Un tool call a una tool disponible pero no ofrecida también se ejecuta.
- **Routing de modelo** (`model-router.ts`): "Automático" en el selector (`AUTO_MODEL_ID='auto'`, default cuando `routingEnabled`) → simple (saludos/confirmaciones) usa `routingSimpleModel` (gpt-4o-mini), estándar usa `deployment`, complejo (análisis, multi-dominio, adjuntos, "Planear primero") usa `routingComplexModel || deployment`. Con imágenes/PDF escaneado se exige modelo con visión. La decisión queda en `AiMessage.meta.routing`.
- **Ejecución paralela**: en cada iteración, las tool calls consecutivas con efecto `read` (no artefactos ni planificación) corren con `Promise.all`; los resultados se finalizan en el orden del modelo. Envíos/escrituras/eliminaciones siguen secuenciales (aprobación).
- **Plan-then-execute**: tool `proposePlan` + preferencia `AiUserPreference.planMode` (auto | always | never, en "Preferencias y memoria") + botón "Planear primero" en el asistente (`planFirst` en `/app/assistant/api/chat`). La tarjeta `PlanCard` (asistente y copilotos) tiene "Ejecutar plan" (manda `RUN_PLAN_MESSAGE`) y "Ajustar".
- **RAG híbrido** (`embeddings-service.ts`, `rag-fusion.ts`, `knowledge-service.searchKnowledge`): `KnowledgeChunk.embedding` (double precision[], sin extensión de Postgres) con `text-embedding-3-small`; búsqueda léxica + semántica fusionadas con RRF, re-ranking opcional con modelo (`ragRerankEnabled`); fallback léxico si no hay clave. Embeddings al procesar una versión y job `ai.embeddings_backfill` cada 30 min. Cada hit trae `match: lexical|semantic|hybrid`.
- **Adjuntos**: DOCX (mammoth), XLSX (exceljs, hasta 6 hojas × 300 filas), audio (Whisper vía proveedor OpenAI), imágenes webp/gif, video (aviso de no soportado), PDF escaneado → se manda el archivo al modelo como `ContentPart` `file` (OCR con visión, `ocrFallbackEnabled`). Defaults de `allowedMimeTypes` ampliados (se migran solos si nunca se personalizaron); `maxAttachmentSizeMb` 25.
- **Documentos** (`tools/documents-tools.ts`): `listConversationAttachments`, `extractDocumentData` (JSON estricto: emisor/receptor con RFC, folio, UUID, fecha, conceptos, impuestos, totales, `checks.totalsMatch`), `draftBillFromDocument` (proveedor por RFC/nombre + productos por SKU/nombre; la bill se captura en Zoho Books, UNIK solo la sincroniza: `canCreateInZoho:false`).
- **Caché de lecturas** (`tools/tool-cache.ts`, en `executeTool` paso 6): solo tools builtin `read` de categorías de datos; TTL `toolCacheTtlLiveSeconds` (30) para periodos vivos y `toolCacheTtlHistoricalSeconds` (300) para cerrados; las tools de datos puras se comparten entre usuarios con el MISMO conjunto de permisos, las demás por usuario; cualquier tool con efecto limpia la caché; "actualiza / en tiempo real" en el mensaje → `skipCache`. Resultado marcado `cached:true, cachedAt`.
- **Confianza** (`confidence.ts`): regla de prompt "Confianza: Verificado/Estimación/Suposición — motivo" al final de respuestas con datos; el orquestador la parsea (`meta.confidence`), y si el modelo la omite la infiere de las tools del turno. La UI la quita del texto y muestra `ConfidenceBadge` (+ modelo, "auto", "en paralelo", "caché ×n").
- **Calidad** (`ai-feedback-service.ts`, `AiMessageFeedback`, `POST/DELETE /app/assistant/api/messages/[id]/feedback`): 👍/👎 con comentario en asistente y copilotos (`MessageFeedback`). Juez opcional (`ai-quality-judge.ts`, `qualityJudgeEnabled`, no bloquea) guarda `meta.judge.score` 1-5. Admin → Asistente IA → Resumen: "Calidad de respuestas" (útiles %, juez, % con datos verificados, comentarios).
- Config nueva en Admin → Asistente IA → Configuración: routing, tools por turno, caché, RAG, OCR, juez.

## Fiabilidad de acciones (2026-09-13, noche)

Correcciones tras pruebas reales en producción:

- **Cotizaciones**: `createQuote`/`previewQuote`/`updateQuote` aceptan alias del modelo (`productId`, `price`, `qty`…), buscan el producto por nombre cuando falta `itemId` y aplican el precio de lista si `rate` es 0 (`normalizeQuoteItems` + `enrichQuoteItems`). Los errores de Zoho llegan legibles con pista (`friendlyQuoteError`: scope, org, producto/cliente no encontrado, conflicto). Nuevo `getZohoBooksStatus` (simulación, credenciales, org, lectura de prueba, última cotización sincronizada).
- **Auto-corrección**: cuando una acción aprobada falla, la tarjeta roja muestra el motivo y el copiloto/asistente recibe un turno automático `⟦auto:action_failed⟧` (routes de copiloto: `trigger: 'action_failed'` + `detail`; en el asistente el cliente manda `actionFailedMessage`) para diagnosticar y volver a proponer la acción corregida.
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
