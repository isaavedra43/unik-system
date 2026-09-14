# Reparto de modelos por tipo de tarea (política de costos)

Un solo lugar decide qué modelo atiende cada tipo de trabajo:
`src/modules/ai/model-policy.ts` → `modelForTask(settings, task)`.

Objetivo: el volumen diario (muchas llamadas por usuario) va al proveedor de
tarifa plana (Canopy Wave: Kimi K2.6 / MiniMax M3) y el proveedor por token
(OpenAI) se reserva para lo complejo.

## Tareas

| Tarea | Setting | Quién la pide |
|---|---|---|
| `simple` | `routingSimpleModel` | Turnos del asistente clasificados como simples (saludos, confirmaciones). |
| `routine` | `routingStandardModel` | Turnos "estándar": consultas y acciones diarias (ventas, clientes, cotizaciones, mensajes, bandeja, chat, copilotos). |
| `complex` | `routingComplexModel` | Análisis, comparaciones, reportes ejecutivos, adjuntos, planes multi-paso. |
| `utility` | `utilityModel` | Procesos de fondo: resumen de hilos (`ai-conversation-summary`), digest diario (`ai-digest-service`), borradores/resúmenes de bandeja (`comms-ai`) y chat (`chat-ai-service`), copiloto y resumen de llamadas (`voice-ai-service`), re-ranking RAG (`knowledge-service`). |
| `judge` | `qualityJudgeModel` | Juez de calidad (`ai-quality-judge`). |
| `vision` | — | Extracción de documentos (`documents-tools`): el modelo complejo si ve imágenes, si no el principal. |

Cadena de respaldo cuando una fila está vacía: tarea → rutina → `deployment`
(principal). `utility` hereda de `simple`; `judge` hereda de `utility`. Una
instalación sin configurar se comporta igual que antes.

`fallbackDeployment` es distinto: solo se usa a mitad de un turno cuando el
modelo elegido falla (error del proveedor).

## Cómo cambia el modelo por proveedor

Los settings guardan ids de modelo. `ai-client.chatCompletion({ model })`
resuelve el proveedor con `getProviderForModelId` (catálogo → modelos
detectados por la llave → ids con "/" → proveedor default). Por eso cualquier
fila puede apuntar a OpenAI o a Canopy sin más configuración.

## Admin

`/app/admin/assistant` → sección **Reparto de modelos por tipo de tarea**
(`components/assistant/admin/ModelPolicyConfig.tsx`):

- Presets: **Canopy para rutina, OpenAI para lo complejo** (recomendado),
  **Todo en Canopy**, **Todo en OpenAI**.
- Cada fila acepta cualquier id; la lista sugerida sale de
  `/app/assistant/api/models` (solo proveedores configurados).
- Casilla "Clasificar mensajes automáticamente" = `routingEnabled`. Apagada,
  todos los turnos usan el principal; el usuario siempre puede fijar un
  modelo en el chat (eso gana sobre la política).

Preset recomendado:

| Fila | Modelo |
|---|---|
| Simples | `minimax/minimax-m3` |
| Rutina | `moonshotai/kimi-k2.6` |
| Complejas | `gpt-4o` |
| Fondo | `minimax/minimax-m3` |
| Juez | `minimax/minimax-m3` |
| Principal | `gpt-4o` |
| Emergencia | `gpt-4o-mini` |

Voz (Whisper/TTS), embeddings y OCR de imágenes siguen en OpenAI; el agente de
voz usa su propio `agentSettings.model`.
