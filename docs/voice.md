# Voz y supervisión (Twilio ↔ LiveKit)

Única fuente de verdad sobre llamadas internas y externas, IA en llamadas, grabación, supervisión y retención.

## 1. Arquitectura

```
Teléfono (PSTN) ──▶ Twilio Voice ──(webhook POST /api/webhooks/voice/twilio)──▶ Next.js
                         │                 firma X-Twilio-Signature (HMAC-SHA1 propio)
                         │◀── TwiML <Dial><Sip>sip:{callId}@{LIVEKIT_SIP_DOMAIN}</Sip></Dial>
                         ▼
                 LiveKit SIP trunk ──▶ sala `call-_{callId}` ◀── navegador / agente (token de sala)
                                              │
                        webhooks (participant_joined/left, room_finished, egress_ended)
                                              ▼
                                   POST /api/webhooks/voice/livekit
                                              │
   LiveKit Egress ──(S3-compatible, directo)──▶ R2 bucket "recordings" (nunca por el proceso web)
```

| Pieza                                                                       | Archivo                                                                                      |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Cliente LiveKit (config Zod, mock, tokens, egress, SIP, webhooks)           | `src/modules/voice/livekit-service.ts`                                                       |
| Servicio de llamadas (estados, permisos, controles, supervisión, retención) | `src/modules/voice/voice-service.ts`                                                         |
| IA en llamadas (answer STT→LLM→TTS, copiloto, resumen)                      | `src/modules/voice/voice-ai-service.ts`                                                      |
| Ajustes (catálogo de tareas, IA por cuenta, grabación por defecto)          | `src/modules/voice/voice-settings.ts`                                                        |
| Acceso a grabaciones/transcripciones                                        | `src/modules/voice/voice-access.ts`                                                          |
| Jobs                                                                        | `src/modules/voice/voice-jobs.ts`                                                            |
| Firma Twilio                                                                | `src/modules/voice/twilio-signature.ts`                                                      |
| Tools del asistente                                                         | `src/modules/ai/tools/voice-tools.ts`                                                        |
| Webhooks                                                                    | `src/app/api/webhooks/voice/{twilio,livekit}/route.ts`                                       |
| API                                                                         | `src/app/app/calls/api/**`, `src/app/app/admin/voice/api/settings`                           |
| UI                                                                          | `/app/calls` (`src/components/calls/*`), `/app/admin/voice` (`src/components/voice-admin/*`) |

### Modelos (Prisma, ya existentes)

`VoiceCall` (type internal|inbound|outbound; status ringing→active→ended|missed|failed; `aiState` active|paused|off; `aiGeneration`; `recordingState` off|recording|stopped; `egressId`, `recordingObjectId`, `transcriptObjectId`, `recordingExpiresAt`, `transcriptExpiresAt`, `summary`), `VoiceParticipant` (identity, userId, role caller|callee|agent|ai|supervisor), `VoiceTranscriptSegment` (generation), `VoiceSupervision` (listen|whisper|barge).

Identidades en la sala: `user-{userId}` (humanos UNIK), `sup-{userId}` (supervisores), `ai-{callId}` (IA), `sip-{callId}` (parte externa saliente). Los participantes SIP entrantes reciben la identidad que asigne la regla de despacho de LiveKit y se registran como `caller`.

### Modo simulado

Sin `LIVEKIT_URL` el módulo funciona en **mock** (salas, tokens, egress y SIP en memoria; respuestas con `mock: true`). Sirve para desarrollo y tests. Los webhooks en mock exigen la cabecera `X-Livekit-Mock-Secret` = `LIVEKIT_MOCK_WEBHOOK_SECRET`.

## 2. Variables de entorno

| Variable                                                 | Uso                                                                                                                                                                                                                         |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`   | Servidor LiveKit. Vacío `LIVEKIT_URL` = modo simulado.                                                                                                                                                                      |
| `LIVEKIT_SIP_TRUNK_ID`                                   | Trunk SIP saliente configurado en LiveKit hacia Twilio.                                                                                                                                                                     |
| `LIVEKIT_SIP_DOMAIN`                                     | Dominio SIP del proyecto (`<proyecto>.sip.livekit.cloud`). Se deriva de `LIVEKIT_URL` si falta.                                                                                                                             |
| `LIVEKIT_MOCK_WEBHOOK_SECRET`                            | Solo mock: secreto de los webhooks simulados.                                                                                                                                                                               |
| `TWILIO_AUTH_TOKEN`, `TWILIO_WEBHOOK_BASE_URL`           | Validación de `X-Twilio-Signature` (la URL firmada se reconstruye desde la base configurada, nunca desde `Host`).                                                                                                           |
| `R2_*` (storage)                                         | Credenciales y bucket `recordings` (ver `docs/storage.md`).                                                                                                                                                                 |
| `R2_EGRESS_ACCESS_KEY_ID`, `R2_EGRESS_SECRET_ACCESS_KEY` | Opcional. Token R2 **de solo escritura** para egress. Recomendado en producción: el servidor de egress solo necesita `PutObject` en `recordings`; sin estas variables se usan las credenciales generales de almacenamiento. |

## 3. Configuración manual (pendiente del usuario)

1. **LiveKit**: crear proyecto, API key/secret; configurar webhook `https://<app>/api/webhooks/voice/livekit` (firmado con la API key).
2. **SIP**: en LiveKit crear _inbound trunk_ (números Twilio permitidos) y _outbound trunk_ hacia el dominio SIP de Twilio (`<sid>.sip.twilio.com` o Elastic SIP Trunking) con autenticación; crear _dispatch rule_ de tipo **Callee** con prefijo `call-` y sin aleatorizar (LiveKit une la llamada a `call-_{callee}`; el TwiML manda `sip:{callId}@dominio;transport=udp`, así que la sala resultante es `call-_{callId}`, la misma que crea UNIK). El trunk entrante debe aceptar cualquier número (lista de números vacía) y limitar por IP a los rangos de señalización de Twilio Programmable Voice. Anotar `LIVEKIT_SIP_TRUNK_ID`.
3. **Twilio**: en el número de voz, "A call comes in" → `POST https://<app>/api/webhooks/voice/twilio`; habilitar SIP hacia el dominio de LiveKit (BYOC/Elastic SIP Trunking); registrar la cuenta como `CommAccount` (`provider` twilio_*, `identifier` = número E.164, `teamKeys` = claves de rol de los equipos).
4. **R2**: bucket `unik-recordings-*` privado; crear token de solo escritura y ponerlo en `R2_EGRESS_*`. Region `auto`, endpoint `https://<account>.r2.cloudflarestorage.com`.
5. **IA**: en `/app/admin/assistant` activar voz (`voiceEnabled`, `sttModel`, `ttsVoice`); en `/app/admin/voice` decidir qué cuentas atiende la IA, catálogo de tareas y grabación por defecto.

## 4. Permisos y alcance (siempre en servidor)

| Permiso           | Alcance                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calls.use`       | Crear llamadas internas/salientes, atender entrantes de cuentas cuyos `teamKeys` cruzan con sus `roleKeys` (o sin equipos), controlar llamadas donde participa, leer su transcripción y grabación.                                                |
| `calls.supervise` | Listar, escuchar, leer transcripciones e intervenir en llamadas internas y en las de cuentas cuyos `teamKeys` cruzan con sus `roleKeys`. Cuentas sin `teamKeys` solo las supervisa super_admin. Sin este permiso **no se emite token ni medios**. |
| `calls.admin`     | `/app/admin/voice`: IA por cuenta, catálogo de tareas, grabación por defecto; muestra retención (editable en Archivos).                                                                                                                           |
| super_admin       | Todo.                                                                                                                                                                                                                                             |

Los equipos de una cuenta (`CommAccount.teamKeys`) se comparan con las claves de rol del usuario (misma convención que la bandeja de comunicaciones). Conocer un id de llamada u objeto no concede acceso: fuera del alcance la API responde 404.

## 5. Controles (independientes y visibles en `/app/calls`)

- **Pausar IA / Reanudar IA**: `aiState` paused/active e incremento de `aiGeneration`. Con la IA en pausa no se aceptan segmentos STT, no se generan sugerencias, no se transcribe la grabación y la IA no habla. Todo resultado con generación anterior se descarta al llegar (`aiResultIsCurrent`). Auditado.
- **Grabar / Detener grabación**: `recordingState` con `egressId`; control separado de la IA (se puede grabar con IA pausada y viceversa). Egress compuesto de sala, solo audio, MP4 → `recordings/{callId}/{recordingId}` en R2. `egress_ended` verifica con `headObject` que el archivo existe: `ready` o `missing`. Retención `recordingRetentionDays` (30). Auditado.
- **Transferir a humano**: crea/reactiva al agente destino, retira a la IA como interlocutora (puede seguir como copiloto), notifica por `user:{id}` (`call_transfer`). Auditado.
- **Supervisar** (`calls.supervise`): `listen` = solo suscripción; `whisper` = publica con metadato `whisperTo: <identidad del agente>`; `barge` = publica normal. Aparece como badge visible en la llamada. Auditado.
- **Terminar**: detiene grabación, cierra la sala, encola resumen.

### Limitación del susurro

LiveKit no enruta audio a un solo participante. El cliente de cada participante debe ignorar las pistas cuyo `metadata.whisperTo` no coincida con su identidad; el supervisor en `whisper` es `hidden`. `livekit-client` ya está instalado y `CallRoom.tsx` conecta la sala; el filtrado de pistas por `whisperTo` queda documentado, no implementado (hoy el susurro lo oyen todos los que suscriben la pista).

## 6. IA en llamadas

- **Answer** (entrantes con IA activa para la cuenta): `POST /app/calls/api/calls/{id}/ai/turn` recibe texto o audio (multipart `audio`), transcribe (`openaiProvider.transcribe`), genera con `chatCompletion` usando `buildSystemPrompt(actor, { voice: true })` + reglas de llamada, ejecuta solo herramientas de la `VOICE_TOOL_ALLOWLIST` (lectura + `createTaskFromCall`), responde con TTS (`openaiProvider.speak`, base64 mp3) para que el cliente lo publique en la sala. Publica `ai_reply` en `call:{id}`.
- **Copiloto** (llamadas humanas): cada N segmentos (`copilotEveryNSegments`) el job `voice.copilot` publica `copilot_suggestion` (respuesta, pregunta, advertencia, tarea). Nunca habla.
- **Resumen** (`voice.summarize` al terminar o tras transcribir): `VoiceCall.summary` + compromisos + tareas sugeridas; crea `InternalRequest` solo para tipos del catálogo permitido, UNA por (llamada, tipo) (dedupe por `dossier.callId`).
- **Autorización humana**: cotizaciones oficiales, cambios comerciales y envío de documentos no están en la allowlist; si una herramienta con efecto llega al ejecutor común genera `AiProposal` (`needsApproval`) y la IA lo comunica como pendiente.
- La IA actúa con la identidad de servicio `service:voice` (permisos de lectura acotados); las tareas que crea sin humano en la llamada se asignan a `defaultTaskOwnerUserId`.

## 7. Tiempo real

Canal `call:{id}` (SSE `/app/realtime/api/stream?channels=call:{id}`): `call_updated`, `participant_joined/left`, `ai_state`, `recording_state`, `recording_ready`, `transcript_segment`, `transcript_ready`, `copilot_suggestion`, `ai_reply`, `summary_ready`, `task_created`, `supervision`, `transfer`, `call_ended`. Canal `user:{id}`: `call_invite`, `call_transfer`. Canal `inbox:{accountId}`: `call_incoming`.

## 8. Archivos y retención

- Grabaciones (`purpose: recording`) y transcripciones (`purpose: transcript`) son `restricted`: solo streaming autenticado con `Range` (`/app/files/api/objects/:id/content`). Resolutores en `voice-access.ts`: participantes, supervisores con alcance y super_admin.
- Job diario `voice.retention`: borra objetos vencidos con `deleteObjectIfUnreferenced({ force: true })`, limpia segmentos y resúmenes vencidos (`transcriptRetentionDays`, 90).

## 9. Límites conocidos

- **Agente de voz en tiempo real dentro de LiveKit (Agents)**: pendiente de validación externa. Hoy el ciclo STT→LLM→TTS es por HTTP (`/ai/turn`); un worker de LiveKit Agents puede consumir ese endpoint o sustituirlo.
- **Audio en navegador**: `src/components/calls/CallRoom.tsx` (livekit-client 2.x) conecta con el token emitido, publica micrófono si el rol lo permite y reproduce las pistas remotas; en modo simulado se muestra `CallRoomPlaceholder`. Validado solo por tipos y lint, no contra un servidor LiveKit real.
- El canal `call:` del SSE se autoriza hoy con `calls.use` (ruta de realtime, fuera de este módulo); pendiente extenderla a `calls.supervise` y a la membresía de la llamada.
- Identidad de participantes SIP entrantes: depende de la regla de despacho configurada en LiveKit.

## 10. Checklist de validación manual

- [ ] Variables `LIVEKIT_*`, `TWILIO_*`, `R2_EGRESS_*` en Railway; `/app/admin/voice` muestra LiveKit configurado y SIP con trunk.
- [ ] Llamada interna entre dos usuarios: ambos reciben token; `participant_joined` llega por webhook; estado `active`.
- [ ] Llamada saliente a un número real: SIP participant creado; audio bidireccional.
- [ ] Llamada entrante al número Twilio: webhook firmado válido, TwiML devuelto, llamada `inbound` en `/app/calls`; un agente la atiende.
- [ ] Pausar IA durante una llamada: no llegan más segmentos ni sugerencias; reanudar crea nueva generación.
- [ ] Grabar/Detener: `egress_ended` registra objeto `ready` en R2; reproducción con adelanto (`Range`); vence a los 30 días.
- [ ] Supervisar (escuchar/susurrar/intervenir) desde un usuario con `calls.supervise` de otro equipo → 403; del mismo equipo → token.
- [ ] Petición oral de cotización oficial: la IA responde que requiere autorización y registra tarea `quote_request`; no se crea ni envía cotización.
- [ ] Resumen y tareas tras terminar; una sola tarea por tipo.
- [ ] Job `voice.retention` tras vencimiento: objetos borrados en R2 y referencias limpias.
