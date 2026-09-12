# Campañas (Entrega 15)

Envíos masivos por WhatsApp, SMS y Telegram con audiencia y contenido **congelados**, consentimiento verificado antes de cada envío, presupuesto, ensayo, vista exacta por destinatario, baja durante la campaña, procesamiento por lotes recuperable (hasta 500.000 destinatarios) con prioridad para la atención humana y medición de consumo.

## 1. Piezas

| Pieza                                             | Archivo                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| Contrato (canales, estados, Zod, render sin eval) | `src/modules/campaigns/campaign-contract.ts`                        |
| Lectura de snapshots y render compartido          | `src/modules/campaigns/campaign-snapshots.ts`                       |
| Servicio (acciones humanas)                       | `src/modules/campaigns/campaign-service.ts`                         |
| Dispatcher (envío por lotes)                      | `src/modules/campaigns/campaign-dispatcher.ts`                      |
| Jobs                                              | `src/modules/campaigns/campaigns-jobs.ts`                           |
| Tools del asistente                               | `src/modules/ai/tools/campaigns-tools.ts`                           |
| API                                               | `src/app/app/campaigns/api/**`                                      |
| UI                                                | `src/app/app/campaigns/page.tsx`, `src/components/campaigns/*`      |
| Pruebas                                           | `src/modules/campaigns/*.test.ts` (+ `testing/in-memory-prisma.ts`) |

Permisos: `campaigns.view` (ver, destinatarios, vista exacta), `campaigns.manage` (crear, congelar, ensayar, presupuesto, pausar/reanudar/cancelar), `campaigns.approve` (aprobar y programar el envío real). El canal SSE `campaign:{id}` exige `campaigns.view`.

Los envíos salen exclusivamente por `getChannelAdapter(provider).send` (`src/modules/comms/channel-adapters.ts`); el ensayo usa `MockChannelAdapter`.

## 2. Ciclo de vida

```
draft ──congelar──▶ rehearsal ──ensayar + solicitar──▶ pending_approval ──aprobar──▶ scheduled ──scheduler/ahora──▶ running ──▶ completed
  ▲                     │                                                                    │            ▲
  └──── descongelar ◀───┘ (borra recipients, vuelve a draft)                       pausar ──▶ paused ──reanudar┘        cancelar ──▶ cancelled
```

### Audiencia congelada

`freezeCampaign` recorre los `CommContact` que cumplen el filtro (`tags` con modo alguna/todas, `excludeTags`, sin `duplicateOfId`) en páginas de 1000 y aplica: **último `ConsentRecord` del canal = `opted_in`** (sin registro = sin consentimiento; `opted_out` gana), identificador válido (E.164 para WhatsApp/SMS —10-15 dígitos sin `+` se normalizan—, id numérico para Telegram). Crea `CampaignRecipient` por lotes de 1000 con `batchNo = floor(índice / batchSize)` y la personalización capturada en ese momento (`nombre`, `primer_nombre`, `telefono`, `email`). Guarda `audienceSnapshot = { filter, count, frozenAt, excluded }`. Cambiar etiquetas o contactos después **no altera** la audiencia (prueba `campaign-service.test.ts`).

### Contenido congelado

`contentSnapshot = { body, templateKey?, variables, frozenAt }`. Variables `{{clave}}` se sustituyen por texto (sin evaluación); faltantes → vacío y se reportan. Editar audiencia/contenido tras congelar responde 409: hay que **descongelar** (vuelve a `draft`, borra destinatarios, cancela jobs si estaba programada).

### Ensayo y vista exacta

`rehearse(campaignId, sampleSize)` renderiza N destinatarios congelados y los pasa por `MockChannelAdapter` (nada sale). `renderForRecipient(campaignId, recipientId)` devuelve el texto final exacto de cualquier destinatario (`GET /preview/:recipientId`).

### Presupuesto y aprobación

`budgetLimit` y `costPerMessage`. Aprobar (`campaigns.approve`) exige congelación + ensayo; si `costPerMessage × count > budgetLimit` responde 409 salvo `allowPartialBudget` (la campaña se pausará sola al agotar el presupuesto). `scheduledAt` opcional: si es ≤ ahora arranca de inmediato; si no, el scheduler la inicia.

## 3. Lotes, jobs y recuperación

- `campaigns.dispatch_batch` (`JOB_PRIORITY.bulk` = 500, por debajo de lo interactivo; `groupKey = campaign:{id}`; `dedupeKey = campaign:{id}:batch:{n}`; 5 intentos; timeout 60 min). Envía **un lote** durmiendo `60000 / ratePerMinute` ms entre mensajes.
- Antes de **cada** envío: campaña sigue `running` (pausa/cancelación aplican al instante), último consentimiento no es `opted_out` (si lo es → `opted_out`, sin envío), `budgetSpent + costo ≤ budgetLimit` (si no → campaña `paused` con `pauseReason = budget_exceeded`, auditoría y evento).
- Reclamo atómico del destinatario (`pending → queued`); crea `CommMessage` (cuenta, conversación buscada/creada, `direction = outbound`, `campaignId`, estado según adaptador), actualiza destinatario (`sent`/`failed`, `messageId`), `budgetSpent` (incremento atómico) y `stats`.
- Consumo: `recordUsage('campaign', id, 'messages', 1)` y `recordUsage('provider', account.provider, 'cost', costo)`.
- Tiempo real: `campaign.progress` cada 10 envíos y al terminar; `campaign.status` en transiciones.
- Al agotar el lote encola el siguiente; sin pendientes → `completed`.
- **Recuperación**: un lote interrumpido (reinicio, timeout, cancelación) se reanuda solo con los `pending`; los `sent` nunca se reenvían. Destinatarios que quedaron `queued` sin resultado se marcan `failed` con "resultado incierto, verificar en el proveedor". Si el lote excede 50 min se re-encola a sí mismo.
- **Concurrencia por cuenta**: solo un lote `running` por `CommAccount`; un segundo se difiere 30 s (libera su dedupeKey y se re-encola).
- `campaigns.scheduler` (recurrente cada 5 min): `scheduled → running` cuando `scheduledAt ≤ now` y re-encola lotes de campañas `running` sin job activo.

## 4. Asistente IA

| Tool                   | Efecto           | Nota                                                                                          |
| ---------------------- | ---------------- | --------------------------------------------------------------------------------------------- |
| `listCampaigns`        | `read`           |                                                                                               |
| `getCampaignStats`     | `read`           | Conteos por estado, presupuesto, ensayo.                                                      |
| `draftCampaignContent` | `draft`          | Analiza variables y muestra ejemplo; guarda en borrador si hay `campaignId`.                  |
| `createCampaignDraft`  | `internal_task`  | Crea borrador; no congela ni envía.                                                           |
| `approveCampaign`      | `business_write` | **Siempre** propuesta con nombre, destinatarios y costo; verifica que la audiencia no cambió. |

## 5. API

`/app/campaigns/api/campaigns` (GET, POST) · `/campaigns/:id` (GET, PATCH) · `/:id/freeze` · `/:id/unfreeze` · `/:id/rehearse` `{ sampleSize }` · `/:id/preview/:recipientId` (GET) · `/:id/submit` · `/:id/approve` `{ scheduledAt?, allowPartialBudget? }` · `/:id/pause` `{ reason? }` · `/:id/resume` · `/:id/cancel` · `/:id/recipients?status=&page=&pageSize=` (identificadores enmascarados) · `/app/campaigns/api/accounts` (GET) · `/app/campaigns/api/audience` (GET etiquetas, POST vista previa con conteo y motivos de exclusión).

## 6. Pruebas locales

`npx vitest run --project unit src/modules/campaigns`: consentimiento/baja/identificador al congelar, audiencia congelada inmune a cambios de etiquetas, lotes por `batchSize`, ensayo y vista exacta, aprobación con presupuesto, pausar/reanudar/cancelar; dispatcher: envío con mensajes/consumo/eventos, **baja durante la campaña evita el siguiente envío**, **presupuesto excedido pausa**, **lote interrumpido se reanuda sin duplicar**, encadenado de lotes con dedupeKey, campaña no running y fallos del proveedor.

## 7. Checklist de validación manual (pendiente del usuario)

- [ ] Añadir `import '@/modules/campaigns/campaigns-jobs';` en `register-handlers.ts` y los imports de tools en `tools/index.ts` (ver reporte de integración).
- [ ] Con una cuenta Twilio/Telegram real (adaptadores de la bandeja) crear una campaña de prueba con 3-5 contactos propios con consentimiento `opted_in`.
- [ ] Congelar, ensayar, aprobar con `scheduledAt` futuro y comprobar que el scheduler la inicia (≤ 5 min) y que `/app/campaigns` muestra progreso en vivo.
- [ ] Responder "BAJA" desde un contacto durante el envío (la bandeja registra `opted_out`) y verificar que ese destinatario queda `opted_out` sin mensaje.
- [ ] Fijar un presupuesto menor al costo total y verificar la pausa automática y el evento; ampliar y reanudar.
- [ ] Reiniciar el proceso a mitad de un lote y verificar que se reanuda sin duplicados (`CommMessage` por destinatario = 1).
- [ ] Revisar `/app/admin/extensions` → Consumo (`campaign`, `provider`).
- [ ] Prueba de volumen con datos sintéticos (p. ej. 100k contactos) en un entorno no productivo para medir la congelación y el ritmo real por cuenta.
