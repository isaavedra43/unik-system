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
