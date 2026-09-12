# Copiloto: modos, personalización, memoria y biblioteca aprobada

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

## Biblioteca aprobada (`KnowledgeSource` → versiones → fragmentos)

- Fuentes de tipo documento (PDF, TXT, MD, CSV, DOCX vía subida con target `knowledge_source`), texto o URL (descarga acotada por `safeFetch`).
- Cada versión se procesa en un job (`knowledge.process_version`): extracción de texto, normalización y fragmentación (~1800 caracteres con solapamiento).
- Solo las versiones **aprobadas** (`/app/admin/knowledge/api/sources/:id/approve`) son citables: búsqueda de texto completo en español (`to_tsvector('spanish')`, índice GIN creado en la migración).
- `visibility`: `internal` vs `publishable`. La tool `searchKnowledgeLibrary` acepta `visibility="publishable"` para redactar contenido que sale a clientes.
- Un adjunto de cliente en el chat no entra a la biblioteca; alguien con `knowledge.manage` lo añade explícitamente.
- UI de administración: `/app/admin/knowledge` (crear fuentes, subir archivos, texto/URL, aprobar versión, cambiar visibilidad, archivar, probar búsqueda).

## Propuestas de comunicación interna

`sendInternalChatMessage` (efecto `external_send`): el asistente propone un mensaje al chat interno; el usuario lo aprueba en la tarjeta de propuesta. Nunca se envía solo.

## Herramientas nuevas

`searchKnowledgeLibrary`, `rememberForUser`, `listUserMemory`, `forgetMemory`, `sendInternalChatMessage` (habilitadas por defecto en `enabledTools`).

## Pruebas

`src/modules/copilot/copilot.test.ts`: fragmentación con secciones y solapamiento, tsquery segura, prompt de preferencias y memoria.

## Pendiente de validación manual

Búsqueda FTS con datos reales tras aplicar la migración; extracción de PDF escaneados (sin OCR: se reporta "sin texto").
