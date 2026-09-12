# Comunicaciones omnicanal (bandeja, solicitudes internas, compromisos)

Única fuente de verdad sobre cómo UNIK recibe y envía mensajes de WhatsApp, SMS y Telegram, y cómo se apoyan en ellos las solicitudes internas, el directorio de responsables y los compromisos.

## 1. Arquitectura

```
Twilio (WhatsApp/SMS) ──POST form──▶ /api/webhooks/twilio/messaging?accountId=…   ─┐
Telegram Bot API ──────POST json──▶ /api/webhooks/telegram/{accountId}             ─┤
                                                                                    ▼
                         adapter.parseWebhook (firma / secret token, constante en tiempo)
                                                                                    ▼
                    recordInboundMessage → CommMessage (UNIQUE accountId+externalId) → CommConversation
                                     │                                   │
                                     ├─ palabras BAJA/STOP/ALTA → ConsentRecord
                                     ├─ media → job comms.process_inbound → StorageObject (comm_media)
                                     └─ publishRealtime inbox:{teamKey} · user:{assignedTo}

Bandeja (/app/inbox) ──POST messages──▶ sendOutboundMessage (consentimiento, adjuntos, cuenta activa)
                                             └─▶ getChannelAdapter(provider).send (idempotencyKey = message.id)
```

| Pieza                                                | Archivo                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| Contrato de adaptadores                              | `src/modules/comms/channel-adapters.ts`                                         |
| Adaptador Twilio (WhatsApp/SMS)                      | `src/modules/comms/adapters/twilio-adapter.ts`                                  |
| Adaptador Telegram                                   | `src/modules/comms/adapters/telegram-adapter.ts`                                |
| Registro de adaptadores                              | `src/modules/comms/adapters/index.ts`                                           |
| Cuentas (números/bots) y credenciales                | `src/modules/comms/comms-accounts-service.ts`                                   |
| Contactos y duplicados revisables                    | `src/modules/comms/comms-contacts-service.ts`                                   |
| Conversaciones, mensajes, notas, relevo              | `src/modules/comms/comms-service.ts`                                            |
| IA asistiva (resumen, respuesta, traducción, relevo) | `src/modules/comms/comms-ai.ts`                                                 |
| Directorio de responsables                           | `src/modules/comms/responsibles-service.ts`                                     |
| Solicitudes internas con expediente                  | `src/modules/comms/requests-service.ts`                                         |
| Compromisos y sugerencias heurísticas                | `src/modules/comms/commitments-service.ts`                                      |
| Almacenamiento (upload/acceso)                       | `src/modules/comms/comms-storage.ts`                                            |
| Jobs                                                 | `src/modules/comms/comms-jobs.ts`                                               |
| Tools del asistente                                  | `src/modules/ai/tools/comms-tools.ts`                                           |
| UI bandeja / solicitudes / admin                     | `src/components/inbox`, `src/components/requests`, `src/components/comms-admin` |

### Reglas que no cambian

- **Un mensaje externo se guarda una sola vez.** `CommMessage` tiene `@@unique([accountId, externalId])`; los webhooks son idempotentes (reintentos → 200 sin duplicar). En Telegram el `externalId` es `<chatId>:<messageId>` porque el id de mensaje solo es único por chat.
- **Una sola puerta de salida.** Todo mensaje saliente pasa por `sendOutboundMessage`, que verifica consentimiento, cuenta activa, acceso del usuario a la cuenta y a los adjuntos, crea el `CommMessage` en `queued` y llama al adaptador con `idempotencyKey = message.id`. Si el proveedor no confirma (timeout), el mensaje queda `queued` con `providerMeta.uncertain = true` y se reconcilia con el status callback.
- **Consentimiento.** Palabras clave entrantes (`BAJA`, `STOP`, `CANCELAR`, `UNSUBSCRIBE` / `ALTA`, `START`) crean `ConsentRecord`. Con el último registro en `opted_out` no se envía nada, salvo respuesta a un mensaje entrante posterior dentro de 24 h.
- **Equipos.** `CommAccount.teamKeys` son claves de rol. Un usuario con `inbox.use` ve una cuenta si alguno de sus roles está en `teamKeys`; `inbox.admin` y `super_admin` ven todo. Los ids nunca conceden acceso.
- **Secretos.** Credenciales en `ExtensionConnection` cifrada (extensión `comm.twilio` / `comm.telegram`, kind `api`, egreso limitado a `api.twilio.com` / `api.telegram.org`). Nunca vuelven al navegador ni a logs. Fallback: variables de entorno.
- **Salidas HTTP** solo con `safeFetch` (HTTPS, hosts aprobados, DNS público, tamaño y timeout acotados).
- **La IA nunca envía sola.** El panel de IA produce texto para el operador; la tool `sendInboxMessage` es `external_send` y siempre genera una propuesta que el usuario aprueba.

## 2. Permisos

| Permiso        | Qué permite                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `inbox.use`    | Ver y responder conversaciones de las cuentas de sus equipos, notas internas, tomar conversaciones sin asignar, compromisos propios, adjuntar archivos |
| `inbox.assign` | Asignar a otros, cambiar estado de cualquier conversación de sus equipos, relevar, confirmar/descartar duplicados                                      |
| `inbox.admin`  | Cuentas (números/bots, credenciales, webhooks), responsables, ver todas las cuentas y solicitudes                                                      |
| `requests.use` | Crear y dar seguimiento a solicitudes internas (ve las propias y las asignadas)                                                                        |

El asignado de una conversación puede cambiar su estado y relevarla aunque no tenga `inbox.assign`.

## 3. Configuración de Twilio (WhatsApp y SMS)

1. **Credenciales.** En `/app/admin/comms` → Nueva cuenta → proveedor WhatsApp o SMS, número en E.164, equipos, y Account SID + Auth Token (se cifran). Alternativa: `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` en el entorno (la cuenta queda "Variables de entorno").
2. **URL pública.** `TWILIO_WEBHOOK_BASE_URL=https://tu-dominio` (sin barra final). Se usa para validar la firma: Twilio firma la URL pública, no la interna de Railway. Si falta, se usa la URL recibida (solo válido si el proceso ve la URL pública).
3. **Webhooks en Twilio Console** (sender de WhatsApp o número SMS):
   - _When a message comes in_ → `POST https://tu-dominio/api/webhooks/twilio/messaging?accountId=<id de la cuenta>` (el botón "URL" del panel la copia). Si se omite `accountId`, la cuenta se resuelve por el campo `To`.
   - _Status callback URL_ → la misma URL (los callbacks llevan `MessageStatus` y actualizan `sent/delivered/read/failed/undelivered`).
4. **Firma.** `X-Twilio-Signature = base64(HMAC-SHA1(authToken, url + Σ(clave+valor ordenados)))`, comparada en tiempo constante. Petición sin firma válida → 403 y no se guarda nada.
5. **Media entrante.** Se descarga en el job `comms.process_inbound` (Basic auth, hasta 25 MB, hosts `api.twilio.com`, `*.twiliocdn.com`, `*.amazonaws.com`) y se guarda como `StorageObject` con propósito `comm_media`.
6. **Media saliente.** Twilio descarga el adjunto desde una URL firmada del almacenamiento (`authorizeDownload`). Requiere R2 con `preferSignedUrls`; con el driver de disco el envío con adjuntos falla con un mensaje claro (el texto sí se envía si se manda sin adjuntos).
7. **Plantillas.** Fuera de la ventana de 24 h WhatsApp exige plantilla: `sendOutboundMessage` acepta `templateKey` (Content SID) y `templateVariables`; el motor de campañas los usa.
8. **Probar conexión** consulta la cuenta (`GET /Accounts/{sid}.json`); no envía mensajes.

## 4. Configuración de Telegram

1. Crea el bot con @BotFather y copia el token.
2. `/app/admin/comms` → Nueva cuenta → Telegram, usuario del bot, equipos, token (cifrado) — o `TELEGRAM_BOT_TOKEN` en el entorno.
3. Al crear (o al pulsar "rotar secreto") se muestra **una sola vez** el `secret_token`; UNIK guarda solo su sha256 en `CommAccount.webhookSecret`.
4. Registra el webhook:

   ```
   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://tu-dominio/api/webhooks/telegram/<accountId>&secret_token=<SECRETO>
   ```

5. Cada update llega con `X-Telegram-Bot-Api-Secret-Token`; si no coincide → 403.
6. Fotos, documentos, audios y videos se resuelven con `getFile` en el job de entrada (no en el webhook) y se guardan en `comm_media`.
7. Los envíos con adjuntos suben los bytes por multipart (`sendPhoto` / `sendDocument`), sin necesidad de URL pública.
8. "Probar conexión" usa `getMe` y `getWebhookInfo` (muestra la URL registrada y el último error reportado por Telegram).

## 5. Bandeja (`/app/inbox`)

- Tres columnas: lista con filtros (canal, estado, asignación, búsqueda ILIKE en contacto/mensajes, paginación por cursor), conversación (mensajes, estados de entrega, media, notas internas, asignación, estado, prioridad, redactor con adjuntos) y **panel fijo de IA** (resumen, sugerencia insertable, traducción, compromisos sugeridos, compromisos del contacto y relevo asistido). En móvil se muestra una columna a la vez.
- Tiempo real: SSE `/app/realtime/api/stream` con canales `inbox:{roleKey}` y `user:{id}`. Los eventos solo llevan ids (nunca texto), el cliente vuelve a pedir lo que muestra.
- Adjuntos: `uploadFile` con destino `{ type: 'comm_conversation', id }` (imagen/PDF/audio/mp4, 25 MB). Los ids viajan como `mediaObjectIds`; el servidor vuelve a validar que el remitente pueda leerlos.
- **Relevo asistido de operador**: reasigna y añade una nota interna con un resumen generado por IA a partir de los últimos mensajes; si la IA falla, la nota lleva los últimos 5 mensajes en texto plano.
- Duplicados: al crear/actualizar contactos se buscan coincidencias (teléfono E.164, correo normalizado, o nombre normalizado + mismo dominio). El contacto queda `pending` con el sospechoso en `duplicateOfId`. Un humano confirma (fusión: conversaciones, compromisos, consentimientos y solicitudes pasan al sobreviviente; el duplicado queda `confirmed` apuntando a él) o descarta.

## 6. Solicitudes internas (`/app/requests`) y responsables

- `InternalRequest` con tipo, prioridad, fecha límite, archivos (`StorageObject` que el usuario pueda leer, validado con `resolveFileAccess`), contacto/conversación de origen, **expediente** (`dossier.facts[]` con `source: user | ai`) y línea de tiempo (`InternalRequestEvent`).
- Asignación automática: si `type` coincide con un área del directorio (`Responsible.area`, slug), se asigna al titular activo o a su respaldo. El asignado recibe un evento `request` en `user:{id}`.
- Tablero por estado o lista; detalle con timeline, expediente, adjuntos (destino `internal_request`), asignación y comentarios.

## 7. Compromisos

- `Commitment` con dueño, contacto, origen y vencimiento. Job recurrente `comms.commitments_overdue` (cada hora) marca `overdue` y publica `commitment` a `user:{owner}`.
- Sugerencias heurísticas (`suggestCommitments`) sobre texto saliente en español ("te envío… mañana a las 3 pm", "el lunes", "en 2 horas"). Solo proponen; el operador (o una tool `internal_task`) las crea.

## 8. Tools del asistente (`comms-tools.ts`)

| Tool                      | Efecto                                                                             | Permiso        |
| ------------------------- | ---------------------------------------------------------------------------------- | -------------- |
| `listInboxConversations`  | read                                                                               | `inbox.use`    |
| `getConversationMessages` | read                                                                               | `inbox.use`    |
| `draftReply`              | draft                                                                              | `inbox.use`    |
| `sendInboxMessage`        | **external_send** (propuesta obligatoria; el resumen muestra destinatario y texto) | `inbox.use`    |
| `createInternalRequest`   | internal_task                                                                      | `requests.use` |
| `resolveResponsible`      | read                                                                               | `requests.use` |
| `listCommitments`         | read                                                                               | `inbox.use`    |
| `createCommitment`        | internal_task                                                                      | `inbox.use`    |
| `findDuplicateContacts`   | read                                                                               | `inbox.use`    |

## 9. Variables de entorno

| Variable                                  | Uso                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Fallback cuando la cuenta no tiene conexión cifrada                                    |
| `TWILIO_WEBHOOK_BASE_URL`                 | URL pública usada para validar `X-Twilio-Signature` y para mostrar las URLs de webhook |
| `TELEGRAM_BOT_TOKEN`                      | Fallback del token del bot                                                             |
| `APP_URL`                                 | Base para las URLs de webhook si no hay `TWILIO_WEBHOOK_BASE_URL`                      |
| `UNIK_SECRETS_MASTER_KEY`                 | Necesaria para guardar credenciales cifradas                                           |

## 10. Checklist de validación manual (servicios reales)

1. Crear una cuenta WhatsApp en `/app/admin/comms` con credenciales; "Probar conexión" debe mostrar el nombre de la cuenta Twilio.
2. Configurar los webhooks en Twilio con la URL copiada; enviar un WhatsApp al número: aparece en `/app/inbox` en segundos (SSE), con nombre de perfil y adjunto si lo hubo.
3. Reenviar el mismo webhook (Twilio Debugger → replay): no se duplica el mensaje.
4. Responder desde la bandeja: el mensaje pasa `queued → sent → delivered → read` con los callbacks.
5. Enviar "BAJA" desde el teléfono: la bandeja rechaza el siguiente envío con "baja registrada"; escribir de nuevo desde el teléfono vuelve a permitir responder.
6. Telegram: `setWebhook` con el secreto mostrado; enviar texto y foto al bot; la foto aparece cuando termina el job `comms.process_inbound`. Un `setWebhook` con otro secreto debe producir 403.
7. Relevo asistido: asignar a otro operador; la nota interna contiene el resumen (IA o texto plano si la IA no está configurada) y el destinatario recibe el aviso.
8. Solicitud interna de tipo "instalaciones" con responsable configurado: se asigna sola y el responsable recibe el evento.
9. Compromiso con vencimiento pasado: tras el job horario queda "Vencido" y el dueño recibe el aviso.
10. Crear dos contactos con el mismo correo: el segundo aparece en "Duplicados pendientes"; fusionar mueve sus conversaciones.
