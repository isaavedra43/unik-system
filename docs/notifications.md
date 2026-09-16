# Notificaciones (in-app + push a iPhone/Android)

Módulo central: `src/modules/notifications/`. Todo aviso pasa por `notifyUser` /
`notifyUsers`, que aplica las preferencias del usuario, guarda la fila
`Notification`, la publica en vivo a las pestañas abiertas (SSE canal `user:{id}`)
y la envía por **Web Push (VAPID)** a los dispositivos registrados.

## Cómo llega al teléfono

```
productor (chat, bandeja, voz, IA, seguimiento)
   └─ notifyUser()  → Notification (BD)
                    → publishRealtime('user:{id}', 'notification')  → campana / toast
                    → sendPushToUser()  → Apple/Google push  → public/sw.js `push`  → 🔔
```

- **Android / escritorio:** funciona desde el navegador (Chrome, Edge, Firefox).
- **iPhone / iPad:** solo con la app instalada en pantalla de inicio (iOS 16.4+).
  Safari sin instalar no expone `PushManager`; la pantalla de ajustes lo detecta
  y muestra las instrucciones de instalación.
- El permiso se pide únicamente desde el botón "Activar" (gesto del usuario).
- Al tocar la notificación el SW marca la fila como leída (`POST /app/notifications/api/read`)
  y enfoca/abre la app en `url`.

## Configuración

| Variable                                 | Descripción                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | `npx web-push generate-vapid-keys`. Sin ellas el push queda desactivado (in-app sigue). |
| `VAPID_SUBJECT`                          | `mailto:` o `https:` de contacto (default: `APP_URL`).                                  |
| `AI_NOTIFY_MIN_SECONDS`                  | Segundos mínimos de un turno del asistente para avisar "la IA terminó" (default 20).    |

Producción requiere HTTPS. El SW ya está en scope `/` (`src/app/layout.tsx`).

## Catálogo de categorías (`catalog.ts`)

| Categoría                                                          | Cuándo                                                                                                                                                               | Productor                                                                                                                           |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `call_incoming` (urgente)                                          | Llamada entrante que debe atender una persona, transferencia (humana o de la IA)                                                                                     | `voice-service.registerInboundCall`, `transferToHuman`, `voice-agent-service` (transfer_requested)                                  |
| `call_missed`                                                      | Llamada entrante no contestada                                                                                                                                       | `voice-service.finishCall('missed')`                                                                                                |
| `call_summary`                                                     | Resumen IA de la llamada listo                                                                                                                                       | `voice-ai-service.summarizeCall`                                                                                                    |
| `chat_message` / `chat_mention`                                    | Mensaje / mención en chat interno (respeta preferencia `all/mentions/none` y mute por canal)                                                                         | `chat-service.sendMessage`, `broadcastMessage` → `chat-notifications.ts`                                                            |
| `inbox_message`                                                    | Cliente escribe (asignado → solo asignado; sin asignar → agentes del equipo de la cuenta)                                                                            | `comms-service.recordInboundMessage` → `comms-notifications.ts`                                                                     |
| `inbox_assigned`                                                   | Te asignan una conversación                                                                                                                                          | `comms-service.updateConversation`                                                                                                  |
| `ai_task_done`                                                     | Turno del asistente ≥ umbral o `notifyWhenDone: true` en el request                                                                                                  | `ai-orchestrator` → `ai-notifications.ts`                                                                                           |
| `ai_user_message`                                                  | Tool `notifyUser` ("avísale a Karla que…")                                                                                                                           | `tools/notifications-tools.ts`                                                                                                      |
| `entity_change`                                                    | Cambio en un registro seguido (11 tipos: OV, cotización, factura, paquete, pago, OC, bill, nota de crédito, producto, cliente, proveedor)                            | `entity-change-service.ts` + `<módulo>-change-events.ts` desde cada normalizer Zoho                                                 |
| `ops_workitem` / `ops_escalation` / `ops_incident` / `ops_request` | Trabajo asignado, vencido o escalado, incidencia del área, solicitud de otra área                                                                                    | `operations/work-items-service.ts`, `supervisor.ts`, `incidents-service.ts`, `area-requests-service.ts`                             |
| `approval_requested` / `approval_decided`                          | Firma pendiente y resultado de lo que solicitaste                                                                                                                    | `operations/approvals-service.ts`                                                                                                   |
| `purchase_update`                                                  | Cotización respondida, orden aprobada o rechazada, diferencias en una recepción                                                                                      | `purchases/orders-service.ts`, `rfq-service.ts`, `receipts-service.ts` (categoría vía `purchaseNotificationCategory()`)             |
| `delivery_update`                                                  | Viaje que sale, parada entregada (completa o parcial), entrega fallida, conflicto de embarque con Zoho. Va al **dueño del expediente**, no al chofer que la registra | `logistics/trips-service.ts`, `delivery-service.ts`, `transport-service.ts` (categoría y destinatario vía `notifyDeliveryUpdate()`) |
| `production_update`                                                | Orden de producción liberada y merma fuera de tolerancia. Va a quien abrió la orden y al dueño del expediente                                                        | `manufacturing/production-service.ts`, `production-floor-service.ts` (vía `notifyProductionUpdate()`)                               |
| `finance_alert`                                                    | Obligaciones vencidas o por vencer y cierre del día pendiente                                                                                                        | `finance/finance-jobs.ts`                                                                                                           |
| `radar_signal` (push apagado por omisión)                          | Señal NUEVA del radar comercial con puntaje ≥ `RADAR_NOTIFY_MIN_SCORE` (70), una por vendedor y refresco                                                             | `crm/radar-service.ts` (`refreshRadar`)                                                                                             |
| `agent_request` / `agent_proposal` / `agent_budget`                | La IA de un área anuncia una solicitud, propone una acción o llegó a su presupuesto                                                                                  | `agents/`                                                                                                                           |
| `system`                                                           | Avisos administrativos                                                                                                                                               | —                                                                                                                                   |

Las categorías `urgent` (llamada entrante) ignoran mute y horario silencioso.

## Preferencias del usuario (`/app/account/notifications`)

`UserNotificationSettings`: push global, silenciar temporalmente (`mutedUntil`),
horario silencioso (`quietHoursStart/End` en `timezone`), y por categoría
`{ inApp, push }`. API: `GET/PUT /app/notifications/api/settings`.

Dispositivos: `PushSubscription` (uno por navegador/dispositivo, endpoint único).
API: `GET/POST/DELETE /app/notifications/api/push`, `POST …/push/test`.
Endpoints 404/410 se eliminan solos; 5 fallos seguidos también.

## Entrega tras transacciones

Las notificaciones creadas dentro de una transacción Prisma (`tx`, p. ej. los
normalizers de Zoho) quedan `pushStatus = pending`; el despachador
(`dispatchPendingNotifications`, cada 20 s en proceso + job recurrente) las
entrega tras el commit. Todo lo demás se entrega inline. Idempotencia por
`dedupeKey`.

## Cliente

- `useNotificationStream` (AppShell): campana exacta en vivo + toast con "Abrir".
- `usePushSubscription`: estados `unsupported | needs_install | server_not_configured | denied | prompt | subscribed`.
- Deep links: `/app/assistant?c=<conversationId>`, `/app/inbox?conversation=<id>`, `/app/chat?channel=<id>`, `/app/calls?call=<id>`.

## Asistente

- El request de `/app/assistant/api/chat` sigue ejecutando el turno aunque el
  cliente se desconecte (teléfono bloqueado): la respuesta se persiste y llega el push.
- Tools nuevas: `findUsers`, `notifyUser`, `getMyNotificationSettings`.
