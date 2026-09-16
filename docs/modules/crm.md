# Ventas / CRM y Radar de Cierre (`src/modules/crm/`)

CRM recoge lo que hoy se pierde: **la venta antes de que sea venta**. Una conversación en la bandeja, una llamada o
una cotización se vuelve una **oportunidad** con etapa, responsable y siguiente acción; el **Radar de Cierre** apunta
todos los días a las que se están enfriando, con el porqué y con el mensaje ya redactado. Cuando la cotización se
acepta, UNIK crea la orden de venta en Zoho **una sola vez** y el expediente arranca solo.

Reglas que gobiernan el módulo:

- **Ninguna oportunidad activa sin responsable ni siguiente acción.**
- **Una orden creada desde UNIK abre un solo expediente**, y un reintento nunca duplica la orden de venta.
- Los mensajes del cliente son **dato no confiable**: viajan dentro de `<untrusted>` en los prompts y nada de lo que
  digan dispara una acción.

Estado: implementado y validado localmente. Migración `20260916150100_add_crm` **no aplicada** en producción. La
creación de una orden de venta real en Zoho y el contraste del radar contra una revisión manual están **PENDIENTE
PRODUCCIÓN** (ver `docs/pilot-runbook.md` §11.10). `crmSalesOrderWrite` está **apagada por omisión**.

## Modelos

| Modelo                                 | Para qué                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `PipelineStage`                        | Etapas del embudo con su orden, probabilidad, tipo (`open`/`won`/`lost`) y SLA.                |
| `Opportunity` (+`OpportunityActivity`) | Oportunidad `OPP-` con cliente, valor, etapa, responsable, siguiente acción y línea de tiempo. |
| `SalesOrderWriteRequest`               | Ledger de escritura a Zoho de «cotización aceptada → orden de venta», con su llave.            |
| `RadarSignal`                          | Señal del radar con su puntaje, motivo, explicación y mensaje sugerido.                        |

Embudo sembrado (editable con `crm.manage_stages`): Nuevo (10 %, SLA 24 h) → Contactado (25 %, 72 h) → Cotizado
(50 %, 120 h) → Negociación (70 %, 168 h) → Ganado (100 %) / Perdido (0 %).

## Estados

- **Oportunidad**: `open` → `won` | `lost` | `dormant`. La etapa manda: mover a una etapa `won` sella `wonAt`, a una
  `lost` exige motivo y sella `lostAt`, y mover a una etapa abierta **reabre** una oportunidad cerrada limpiando esos
  campos.
- **Origen**: `inbox`, `call`, `manual`, `quote`, `web`.
- **Actividades**: las que una persona captura a mano son `note`, `call`, `task`, `objection` y
  `objection_resolved`; el resto las escriben los mensajes, las cotizaciones, las órdenes y los cambios de etapa
  (`message_in/out`, `quote_sent/viewed/accepted/declined`, `stage_change`, `order_created`, `ai_suggestion`).

## Radar de Cierre (`radar-rules.ts`)

`puntaje = clamp(round(base × peso de la etapa × peso del valor), 0, 100)`.

| Señal                 | Condición                                                                  | Base                            |
| --------------------- | -------------------------------------------------------------------------- | ------------------------------- |
| `no_first_reply`      | el cliente escribió y la conversación nunca tuvo respuesta saliente, ≥ 2 h | 60 + min(30, h/2)               |
| `no_followup`         | hubo respuestas pero el cliente escribió al final, silencio ≥ 24 h         | 40 + min(45, h/6)               |
| `quote_expiring`      | cotización enviada (o vista) que vence en d ≤ 3 días naturales             | 50 + (3−d)·15, +10 si vista     |
| `next_action_overdue` | oportunidad abierta con la siguiente acción vencida (d días enteros)       | 50 + min(40, d·5)               |
| `objection_open`      | objeción sin resolver ≥ 48 h                                               | 55                              |
| `high_intent`         | probabilidad ≥ 0.6, mensaje entrante en las últimas 48 h y sin cotización  | 70                              |
| `repurchase_overdue`  | ≥ 3 órdenes, intervalo mediano m días, días desde la última > 1.3·m        | 45 + min(40, (días/m − 1.3)·50) |
| `delivery_incident`   | incidencia alta o crítica abierta en un expediente del cliente             | 75                              |

`no_first_reply` y `no_followup` son **excluyentes**: la primera es para conversaciones que nadie ha contestado
(prospectos nuevos), la segunda para las que van en marcha y el cliente está esperando. El silencio se mide desde el
último mensaje del cliente y los días naturales son los de Ciudad de México. Cada señal vive una hora desde que se
calculó (el refresco corre cada 15 min), topada por el fin natural de la condición.

Explicación con IA (`radar-explain.ts`): **una** llamada al modelo de utilidad por señal, que devuelve un JSON
`{explanation, suggestedMessage}` validado con Zod. El mensaje sugerido es sólo un borrador: enviarlo sigue pasando
por `sendInboxMessage` con aprobación.

Del borrador al mensaje: «Llevar a la bandeja» deja el texto en `sessionStorage` (`src/modules/areas/comms-draft.ts`,
clave por área, se consume UNA vez y caduca a los 30 min) y abre `/app/areas/ventas/comunicaciones?tab=externos`,
donde `InboxEmbedded` lo pone en el redactor en cuanto se elige la conversación del cliente. El borrador **nunca**
viaja en la URL: es texto escrito para un cliente concreto y no debe quedar en el historial ni en los registros del
servidor.

Quien tiene `crm.radar` ve **sus** señales y las no asignadas; quien tiene `crm.manage` ve las de todos los
vendedores. Canal de tiempo real `crm:radar`.

## Cotización aceptada → orden de venta en Zoho (`sales-order-write-service.ts`)

Segundo escritor del ledger genérico de escrituras a Zoho (`SalesOrderWriteRequest`, mismas reglas que las
cotizaciones):

1. Exige `crm.create_sales_order` y el flag `crm`; se **reclama la llave** (un replay de una llave completada
   devuelve lo mismo, 409 mientras está en vuelo, reintento de una fallida o rancia; la llave no se reutiliza para
   otra cotización ni otro usuario).
2. La cotización se relee de Zoho (**Zoho es la fuente de verdad**) y tiene que estar `accepted`. Una cotización ya
   convertida bajo otra llave, o con una orden sincronizada que lleva su folio como referencia, se rechaza: **nunca
   dos órdenes**.
3. `POST /salesorders` con cliente, referencia = folio de la cotización, vendedor y conceptos; con
   `ZOHO_BOOKS_MOCK=true` la orden simulada es `SO-MOCK-00001`. El id de Zoho se escribe en el ledger de inmediato,
   así que un reintento tras un fallo local no crea otra.
4. Relectura (`crm.sales_order_readback`, 5 s después) y comparación contra lo que pedía la cotización; una
   diferencia abre la incidencia `sales_order_readback_mismatch`.
5. `crm.link_cases` (30 s después) liga el expediente que `case.start` haya abierto para esa orden.

El descuento a nivel documento se manda como **porcentaje**, la misma convención del formulario de cotización; una
convención distinta en la organización aparece como diferencia de total en la relectura.

## Comandos (`crm-commands.ts`)

| Familia       | Comandos                                                                                                                                                            | Permiso             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Embudo        | `stage.create/update/reorder`                                                                                                                                       | `crm.manage_stages` |
| Oportunidades | `opportunity.create`, `create_from_conversation`, `update`, `move_stage`, `link_quote`, `link_sales_order`, `link_case`, `record_activity`, `mark_won/lost/dormant` | `crm.manage`        |
| Radar         | `radar.snooze`, `radar.dismiss`, `radar.convert_to_task`, `radar.set_explanation`                                                                                   | `crm.radar`         |
| Sistema       | `conversation.touch`, `quote.changed`, `sales_order.readback_mismatch`                                                                                              | sólo jobs           |

Todos pasan por `executeCommand` del núcleo.

## Embudo editable (`pipeline-service.ts`)

`PipelineStage {key, name, order, probabilityDefault, kind, slaHours?, active}`. `ensurePipelineSeed` siembra las
seis etapas por omisión cuando la tabla está vacía; a partir de ahí el embudo se edita con `crm.manage_stages`
desde **Ventas › Embudo › «Etapas del embudo»** (`StagesDialog` en `PipelineBoard.tsx`, comandos armados por
`pipeline-model.ts` y enviados por la cola sin conexión, igual que mover una tarjeta).

Qué permite: crear una etapa (la clave la genera el motor a partir del nombre), renombrarla, cambiar su
probabilidad por omisión y su SLA en horas —o quitarlo—, subirla y bajarla de posición, y apagarla o reactivarla.

Reglas que el motor vuelve a aplicar, pase lo que pase en la pantalla: una etapa **nunca se borra** (se apaga, para
que las oportunidades que pasaron por ella conserven su historia); el embudo necesita siempre al menos una etapa
activa de cada tipo (`open`, `won`, `lost`); una etapa con oportunidades abiertas o dormidas no se apaga; y no
puede haber dos etapas activas con el mismo nombre. Una etapa abierta nueva se inserta **antes** de las de cierre,
que bajan un lugar. El `slaHours` de la etapa es el que pinta el atraso de una tarjeta (`crm-dto.ts`).

## Jobs (`crm-jobs.ts`)

| Job                        | Cada       | Qué hace                                                                                                   |
| -------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| `crm.conversation_touch`   | por evento | Un mensaje de la bandeja actualiza la oportunidad y su línea de tiempo.                                    |
| `crm.quote_changed`        | 5 min      | Cambios de estado de cotizaciones → actividad y avance de etapa.                                           |
| `crm.radar_refresh`        | 15 min     | Recalcula las señales del radar y avisa (`radar_signal`) al vendedor de cada señal NUEVA con puntaje ≥ 70. |
| `crm.radar_explain`        | 24 h       | Explica con IA las señales que lo ameritan.                                                                |
| `crm.sales_order_readback` | 5 s        | Relee en Zoho la orden creada desde UNIK.                                                                  |
| `crm.link_cases`           | 30 s       | Liga el expediente que abrió la orden creada desde UNIK.                                                   |

## Tools de IA (`src/modules/ai/tools/crm-tools.ts`)

`listOpportunities`, `getOpportunity`, `listRadarSignals`, `explainRadarSignal`, `draftRadarMessage`,
`createOpportunityFromConversation`, `updateOpportunityStage` y `createSalesOrderFromQuote`
(**`enabledByDefault: false`**, opt-in explícito del administrador).

La `ia_ventas` ofrece en sus turnos automáticos `listOpportunities`, `listRadarSignals`, `explainRadarSignal` y
`draftRadarMessage` (tope de 20 esquemas por identidad); el resto queda para las personas.

## Área Ventas (`/app/areas/ventas/...`)

- `dashboard` — tablero comercial.
- `trabajo` — centro de trabajo con filas `case`, `opportunity`, `quote` más las comunes; columnas extra Prometido y
  Fase.
- `oportunidades` — embudo comercial con su siguiente acción.
- `pipeline` — página propia (`/app/areas/[areaKey]/pipeline`): oportunidades por etapa y cotizaciones aceptadas por
  convertir. Quien tiene `crm.manage_stages` ve además el botón **«Etapas del embudo»**, que abre el editor del
  embudo (ver abajo).
- `radar` — Radar de Cierre, ordenado por puntaje.
- `comunicaciones` — canal `area:ventas` y bandeja del equipo `equipo_ventas`.

Además, `ConversationCrmPanel` vive dentro de la bandeja omnicanal: desde una conversación se crea o se actualiza la
oportunidad sin salir del hilo.

## Permisos

`crm.view`, `crm.manage`, `crm.manage_stages`, `crm.create_sales_order`, `crm.radar`, `crm.export`.

Nota: **no existe** una clave `crm.approve`; quien gestiona el embudo (`crm.manage`) firma las decisiones
comerciales del área.

## Pruebas

Reglas puras: `radar-rules`, `opportunity-rules`, `pipeline-rules`, `sales-order-rules`. Modelo de la pantalla del
embudo: `src/components/areas/ventas/pipeline-model.test.ts`. Con FakePrisma: `opportunities-service`,
`radar-service` (incluido el aviso `radar_signal`), `sales-order-write-service` y `pipeline-service`, que manda los
tres comandos de etapa **con los payloads que arma la pantalla**, así que un cambio de forma en el tablero rompe
ahí. Las tools de IA de CRM **no tienen suite
propia** (a diferencia de Compras, Manufactura y Contabilidad): su registro se cubre en
`src/modules/ai/tools/index.test.ts` y su comportamiento sólo por las pruebas de los servicios que llaman.

Contra PostgreSQL real (`npm run test:integration`): `tests/integration/domains-scenarios.int.test.ts` recorre
cotización aceptada → orden de venta en Zoho (**mock**) → un solo expediente aunque se reintente (replay de la misma
llave, rechazo de otra llave para la misma cotización y reencolado del job de arranque);
`tests/integration/ventas-area.int.test.ts` calcula el panel de Ventas contra la base.

> Esas dos suites comparten **una** base desechable con todas las demás y sólo valen si corren **solas**. Una
> corrida simultánea las pone en rojo con errores que parecen del producto (deadlock, FK de `Notification`,
> unicidad de `Responsible.area`); desde el 2026-09-16 el `globalSetup` del proyecto hace esperar a la segunda
> corrida en vez de dejarla corromper la base. Ver `docs/pilot-runbook.md` §11.14.

## Limitaciones conocidas

- **No verificado contra Zoho real**: el conjunto de campos de `POST /salesorders` en Zoho Inventory no se ha
  validado contra la organización, por eso `crm.create_sales_order` está detrás de permiso y la escritura detrás del
  flag `crmSalesOrderWrite`, apagado por omisión.
- La lista del radar **no se ha contrastado** con una revisión manual de un vendedor: los pesos y los umbrales son
  los del plan, no los de la operación.
- La explicación del radar gasta presupuesto de IA: con el presupuesto agotado las señales siguen apareciendo, pero
  sin explicación ni mensaje sugerido.
