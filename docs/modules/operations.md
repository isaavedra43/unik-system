# Operaciones — núcleo operativo (`src/modules/operations/`)

El núcleo convierte cada venta de Zoho en un **expediente** (`OperationalCase`) que se sigue de punta a punta: qué
se necesita, de dónde sale (existencia, compra, producción, entrega directa), quién tiene que hacer qué y para
cuándo, qué se atoró y qué pasó. Todo cambio entra por **comandos idempotentes** que escriben eventos, trabajo,
notificaciones y jobs en una sola transacción. Un **supervisor determinista** revisa cada 4 minutos que nada quede
sin dueño ni sin plazo.

Estado: implementado y validado localmente (pruebas unitarias con FakePrisma y escenarios contra PostgreSQL real en
una base desechable). Las migraciones del programa **no están aplicadas** en producción (ver
`docs/pilot-runbook.md` §11). Decisión del dueño: todo funciona desde el minuto uno; los flags nacen en `true` y los
frenos son `cutoverDate`, permisos, presupuestos y horario de la IA.

Módulos hermanos: [inventario progresivo](./inventory.md) y [logística con Zoho](./logistics.md).

## Arquitectura

```
Zoho (sync) → normalizador de OV ─┬─ primera importación → job ops.case.start ─┐
                                  └─ cambio → job ops.case.replan ─────────────┤
reconciliador (5 min) → ops.case.start (órdenes elegibles sin expediente) ─────┤
"Iniciar seguimiento" (UI) → case.start manual ────────────────────────────────┤
                                                                               ▼
                   executeCommand(cmd) ── ledger OperationalCommand (idempotencia)
                                        └─ transacción única: handler + eventos + outbox (jobs)
                                           + notificaciones + auditoría + cierre del ledger
                                                                               │ commit
                                             wakeJobWorker · realtime (case:/area:/user:) · listeners
                                                                               ▼
       motor del expediente (blueprint sales_fulfillment@1): pasos → work items / solicitudes entre áreas /
       reservas de inventario / órdenes de entrega → eventos → avance del expediente
                                                                               ▲
                  supervisor (ops.supervisor, 4 min): huérfanos, vencidos, sincronizaciones, dueños ausentes…
```

Principios:

- **Una sola puerta de escritura.** Toda mutación operativa es un comando registrado con `registerCommand`. Las
  rutas, los jobs, la cola offline y (más adelante) las tools de IA ejecutan `executeCommand`. El barril
  `register-commands.ts` importa todos los módulos de comandos; lo cargan las rutas de comandos, las server actions
  de `/app/operations` y el barril de jobs (`src/modules/jobs/register-handlers.ts`).
- **Nada silencioso.** Cada paso listo tiene un work item con dueño y fecha, o una espera explícita. Lo que se
  atora abre una incidencia con dueño.
- **Zoho es la autoridad** de órdenes de venta y paquetes; UNIK escribe en Zoho sólo por el outbox con relectura.

## Modelos (migración `20260916120000_add_operations_core`)

| Modelo                               | Para qué                                                                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Area`                               | Las 7 áreas (`ventas`, `compras`, `inventario`, `manufactura`, `logistica`, `contabilidad`, `administracion`); `responsibleArea` = slug de `Responsible.area`.                                       |
| `OperationalCase`                    | Expediente `EXP-000123` (número de `Sequence('case')` en la misma transacción). Estado, fase, dueño, datos de la OV.                                                                                 |
| `CaseDemand`                         | Una necesidad por partida surtible de la OV, con cantidad en unidad base.                                                                                                                            |
| `DemandAllocation`                   | De dónde sale cada necesidad: `stock`, `purchase`, `manufacture`, `direct_supplier`. Estados `planned → reserved/requested → in_progress → ready → delivered` (`reopened`, `released`, `cancelled`). |
| `ProcessVersion` / `CaseStep`        | Definición versionada del proceso con checksum y pasos instanciados por caso, necesidad o asignación (`scopeKey`).                                                                                   |
| `WorkItem`                           | Trabajo con dueño, suplente, plazo, evidencia requerida y escalera.                                                                                                                                  |
| `AreaRequest`                        | Solicitud estructurada entre áreas ligada a un objeto, siempre acompañada de su work item.                                                                                                           |
| `Incident`                           | Problema con dueño y `dedupeKey` (se reabre si se repite tras resolverse).                                                                                                                           |
| `OperationalEvent`                   | Bitácora inmutable (PK `id, occurredAt`); nunca se poda.                                                                                                                                             |
| `OperationalCommand`                 | Ledger de comandos: estado, hash del payload, resultado.                                                                                                                                             |
| `EvidenceLink` / `ObjectRelation`    | Evidencias (archivo, nota, conteo, relectura de Zoho) y grafo de relaciones entre objetos.                                                                                                           |
| `Sequence`                           | Folios atómicos (`INSERT … ON CONFLICT DO UPDATE … RETURNING`).                                                                                                                                      |
| `ApprovalPolicy` / `ApprovalRequest` | Aprobaciones de negocio (doble firma, autoaprobación por monto).                                                                                                                                     |

## Comandos idempotentes (`commands.ts`)

`executeCommand({commandId, type, actor, aggregate, expectedVersion?, payload, deviceId?, occurredAt?}, user?)`
devuelve `CommandResult {status: accepted|completed|pending_external|rejected, errorCode?, message?, aggregateVersion, emittedEventIds, createdWorkItemIds, data?, replayed?}`.

- **Ledger.** El `commandId` se reclama con `INSERT … ON CONFLICT DO NOTHING` antes de la transacción. Repetirlo
  devuelve el resultado guardado (`replayed: true`); si otra ejecución sigue en curso responde `accepted`; un reclamo
  de más de 60 s o fallido se vuelve a tomar. Mismo id con otro payload → `command_id_conflict`.
- **Versión.** `expectedVersion` distinto → `version_conflict`. El motor sube la versión del agregado antes del
  handler (el handler no la toca). Creaciones usan `aggregate: 'none'` con un id natural estable
  (p. ej. `so:{zohoSalesOrderId}`).
- **Transacción única** (timeout 20 s): handler, eventos, `enqueueJob({tx})`, `notifyUser({tx})`, auditoría y
  cierre del ledger. Tras el commit: `wakeJobWorker()`, realtime y listeners. Si falla, no se publica nada.
- **Rechazos esperados** no lanzan: `status: 'rejected'` con código estable y mensaje en español. Los de validación,
  permiso o tipo desconocido no se guardan; los del handler y los conflictos de versión sí, y se re-devuelven al
  repetir el comando. Un error inesperado deja el ledger en `failed` y el mismo id se puede reintentar.
- **Contexto** (`CommandContext`): `emit`, `outbox`, `notify`, `realtime`, `audit`, `createWorkItem`,
  `openIncident`, `createAreaRequest`, `relate`. Los helpers que reciben `tx` usan `requireCommandContext(tx)`.
- No usar `dedupeKey` en `ctx.notify`: un P2002 dentro de la transacción la aborta; la idempotencia ya la da el
  ledger.

Comandos registrados en este núcleo:

| Tipo                                                                                             | Quién                                                       |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `case.start` (id natural `so:{id}`), `case.advance`, `case.replan`, `case.cancel`                | sistema; personas con `operations.manage`                   |
| `workitem.start`, `workitem.wait`, `workitem.complete`, `workitem.reassign`, `workitem.escalate` | dueño, suplente, `operations.manage`, sistema               |
| `request.acknowledge`, `accept`, `block`, `resolve`, `reject`, `cancel`, `expire`                | responsable del área destino (acuse automático por sistema) |
| `incident.acknowledge`, `incident.resolve`, `incident.dismiss`                                   | dueño o `operations.manage`                                 |
| `evidence.attach`                                                                                | participantes del trabajo u objeto                          |
| `approval.decide`                                                                                | aprobadores elegibles (nunca el solicitante ni bots)        |
| `supervisor.*`, `operations.seed_responsible_check`                                              | sólo sistema                                                |

Los módulos de dominio agregan los suyos (ver inventario y logística).

## Blueprint `sales_fulfillment@1` (`process-blueprints/`)

Quince pasos con área, tipo, alcance, dependencias, evidencia, SLA, dueño y cierre (`manual` o por `condition`):

| Paso                        | Área         | Alcance    | Cierre                                                                               |
| --------------------------- | ------------ | ---------- | ------------------------------------------------------------------------------------ |
| `verificar_disponibilidad`  | inventario   | necesidad  | manual (`availability_result`) o auto si hay existencia controlada suficiente        |
| `plan_abastecimiento`       | ventas       | necesidad  | manual (`allocation_plan`) o auto si todo se cubre con existencia controlada         |
| `reservar_stock`            | inventario   | asignación | condición (motor `reserve_stock`)                                                    |
| `solicitar_compra`          | compras      | asignación | condición (solicitud `purchase_shortfall`)                                           |
| `esperar_recepcion`         | compras      | asignación | manual (`receipt_movement`)                                                          |
| `ordenar_produccion`        | manufactura  | asignación | condición (solicitud `transformation`)                                               |
| `esperar_produccion`        | manufactura  | asignación | manual (`produce_movement`)                                                          |
| `coordinar_entrega_directa` | compras      | asignación | condición                                                                            |
| `confirmar_entrega_directa` | logistica    | asignación | manual (`delivery_evidence`)                                                         |
| `preparar_pedido`           | inventario   | caso       | manual (`issue_movements`)                                                           |
| `planear_entrega`           | logistica    | caso       | condición (motor `plan_delivery` → orden de entrega)                                 |
| `asignar_transporte`        | logistica    | caso       | condición (embarque confirmado por relectura de Zoho; se omite si el cliente recoge) |
| `entregar`                  | logistica    | caso       | condición (entregas cerradas)                                                        |
| `cierre_operativo`          | ventas       | caso       | automático al entregar todo                                                          |
| `cierre_financiero`         | contabilidad | caso       | automático cuando la OV está facturada y pagada en Zoho                              |

Cambiar `sales-fulfillment.ts` exige publicar otra versión: la misma versión con otra definición se rechaza con
`process_version_mismatch`.

## Arranque, replaneación y cancelación

- **Política de arranque** (`start-policy.ts`): OV no anulada ni enviada, creada en Zoho desde `cutoverDate`
  (`created_time`, respaldo `orderDate`) y, si hay `pilotLocationIds`, de esas bodegas. El arranque manual
  («Iniciar seguimiento», `operations.manage`) salta corte y piloto, nunca los filtros de estado.
- **Ganchos del normalizador** (`sales-order-hooks.ts`): primera importación → `ops.case.start`
  (dedupe `case:so:{id}`); cambio → `ops.case.replan` si hay expediente vivo. Nunca lanzan.
- **Reconciliador** (`ops.case.reconcile_orders`, 5 min, lotes de 200): órdenes elegibles sin expediente.
- **Replaneación** (`replan.ts`): cantidad a la baja libera y vuelve a reservar (o pide cancelar la compra); a la
  alza reabre el plan; línea nueva o eliminada crea o cancela la necesidad; dirección parchea la entrega sin
  transporte o abre incidencia `order_change_conflict` con trabajo a Logística. Lo ya comprometido abre incidencia.
- **Cancelación** (orden anulada en Zoho o `case.cancel`): libera reservas, cancela entregas (encola la cancelación
  del embarque en Zoho si UNIK lo escribió), vence solicitudes, cancela pasos y trabajo y, por cada asignación en
  vuelo, manda `AreaRequest cancel` y abre `cancellation_compensation`.

## Trabajo, solicitudes, incidencias, evidencias y aprobaciones

- **Work items** (`work-items-service.ts`): `open → in_progress → waiting → done|cancelled` (`escalated`). Completar
  valida `requiredEvidence`. Dueño por `resolveAreaAssignee`: `Responsible` del área (titular activo, o suplente)
  → `Area.leadUserId` → Administración → super_admin más antiguo → `no_responsible`.
- **Escalera** (config `escalation`): nivel 0 avisa a dueño y suplente (reemplaza a un dueño inactivo), 1 pasa al
  líder de área, 2 a Administración, 3 abre `sla_breach` crítica. Reasignar con nueva fecha la reinicia.
- **Solicitudes entre áreas** (`request-kinds.ts`, `area-requests-service.ts`): catálogo `availability_check`,
  `purchase_shortfall`, `payment_authorization`, `vendor_pickup`, `transformation`, `material_shortfall`,
  `finished_goods`, `delivery_update`, `create_package_in_zoho`, `resolve_difference`, `customer_notice`, `cancel`,
  `escalation`, `info`, con payload validado por Zod y pares origen→destino. `freeText` ≤ 800 (mostrar escapado).
  Acuse automático; aceptar/bloquear/resolver/rechazar sólo por el responsable humano del área destino.
- **Incidencias** (`incidents-service.ts`): tipos `sla_breach`, `orphan_case`, `stock_conflict`, `count_dispute`,
  `zoho_conflict`, `zoho_failure`, `partial_delivery`, `owner_absent`, `order_change_conflict`,
  `cancellation_compensation`, `ai_failure`, `purchase_difference`, `excess_scrap`, `quality_failure`,
  `production_substitution`, `zoho_readback_mismatch`, `sales_order_readback_mismatch`. Resolver cierra los
  seguimientos; descartar los cancela.
- **Evidencias** (`evidence-service.ts`, `operations-storage.ts`): destino de subida `operations_evidence`
  (propósito de almacenamiento `evidence`, imagen/PDF/audio, 15 MB, descarga restringida).
- **Aprobaciones** (`approvals-service.ts`): sin filas de política se derivan de `approvalThresholds` (compras y
  pagos: 1 firma, 2 desde 50 000 MXN; gastos autoaprobados bajo 2 000 MXN; nómina 2). Un rechazo rechaza. Las
  solicitudes pendientes con `expiresAt` vencido las marca `expired` el supervisor (regla 8).

## Supervisor (`supervisor.ts`, `supervisor-rules.ts`)

Job recurrente `ops.supervisor` cada 4 minutos, un intento, consultas de máximo 200 filas. Cada hallazgo es un
comando de sistema con `commandId = sup:{tipo}:{objeto}:{bucket}`: un tick repetido o dos instancias a la vez no
actúan dos veces (validado contra PostgreSQL real).

1. Expedientes huérfanos → intenta avanzar el caso; sigue huérfano → `orphan_case` + seguimiento a Administración.
2. Work items vencidos → `workitem.escalate` al nivel que corresponde (salta esperas con fecha futura).
3. Sincronizaciones con Zoho estancadas → re-encola el job owed; 60 min sin avance → `zoho_failure` + trabajo.
4. Solicitudes vencidas → `request.overdue` una vez y escalación del trabajo.
5. Reservas de más de `reservationAlertDays` sin preparar → trabajo a Ventas; reclamos legados vencidos se liberan.
6. Dueños inactivos de trabajo y expedientes → suplente o responsable del área; nadie → `owner_absent`.
7. Cierre financiero cuando la OV está facturada y pagada y no queda otro trabajo.
8. Aprobaciones vencidas → `expired`, trabajo de aprobación cancelado, aviso al solicitante (`approval.expired`).
9. Evento `supervisor.tick` con contadores y medidores `UsageMeter` dimensión `ops.supervisor`.

Con `flags.supervisor = false` o `isEnabled = false` no hace nada.

## Eventos y tiempo real

`OPS_EVENTS` (`types.ts`): `case.*` (created, status_changed, phase_changed, owner_changed, replanned, stuck,
delivered, operational_closed, financial_closed, cancelled), `demand.*`, `allocation.*`, `step.*` (incluye
`reopened`, `reverted`, `engine_failed`), `workitem.*` (created, reassigned, started, waiting, completed, cancelled,
overdue, escalated), `request.*`, `incident.*`, `stock.*`, `order.prepared`, `delivery.*`, `evidence.attached`,
`zoho.*`, `approval.*` (requested, voted, approved, rejected, expired), `supervisor.tick`, `ai.*`. Inventario y
logística agregan los suyos.

Canales SSE en `/app/realtime/api/stream`:

| Canal        | Mensajes                        | Autorización                                                                                  |
| ------------ | ------------------------------- | --------------------------------------------------------------------------------------------- |
| `case:{id}`  | `ops.events`                    | `operations.view`, dueño del caso, dueño/suplente de un trabajo del caso o miembro de la sala |
| `area:{key}` | `ops.events`, `ops.requests`    | `operations.view` o miembro activo del canal del área                                         |
| `user:{id}`  | `ops.workitems`, notificaciones | el propio usuario                                                                             |

Reacciones en la transacción (`onOperationalEventsInTransaction`): encolan con `enqueueJob({tx})`, junto con el
estado, el avance de expedientes ante hechos de otros módulos (`ops.case.advance`, `case-service.ts`) y el acuse
automático de solicitudes (`ops.request.auto_ack`, `area-requests-service.ts`); un reinicio justo después del commit
no las pierde. `onOperationalEvents` queda para lo que puede perderse sin daño (la capa de agentes, `onCaseStarted`).

## Jobs

| Job                         | Cuándo                                             | Qué hace                                            |
| --------------------------- | -------------------------------------------------- | --------------------------------------------------- |
| `ops.case.start`            | normalizador, reconciliador, «Iniciar seguimiento» | `case.start` (manual: como la persona que lo pidió) |
| `ops.case.replan`           | cambio de OV en Zoho                               | `case.replan`                                       |
| `ops.case.advance`          | hechos de otros módulos (en su transacción)        | `case.advance`                                      |
| `ops.request.auto_ack`      | al crear una solicitud (en su transacción)         | `request.acknowledge` como sistema                  |
| `ops.case.reconcile_orders` | cada 5 min                                         | encola arranques faltantes                          |
| `ops.supervisor`            | cada 4 min (1 intento, 3.5 min)                    | tick del supervisor                                 |
| `ops.relations_rebuild`     | bajo demanda (`operations.admin`)                  | reconstruye `ObjectRelation` sin duplicar ni borrar |

Los rechazos de negocio completan el job (son resultados); los de concurrencia lanzan para que la cola reintente. En
el ledger un `concurrency_conflict` queda `failed` (el mismo `commandId` se vuelve a ejecutar) y un `commandId` de otro
actor se rechaza con `command_id_conflict`. La configuración se carga antes de abrir la transacción y queda fija en
ella; responsables y preferencias se leen con la conexión de la transacción (fija `connection_limit` en
`DATABASE_URL`).
`startRecurringScheduler` revisa cada 60 s para que el supervisor conserve su cadencia.

## Permisos

| Permiso             | Uso                                                                      |
| ------------------- | ------------------------------------------------------------------------ |
| `operations.view`   | Ver expedientes, trabajo de áreas, incidencias y canales `case:`/`area:` |
| `operations.manage` | Iniciar seguimiento, avanzar, replanear, cancelar, reasignar, escalar    |
| `operations.admin`  | Configuración, reconstrucción de relaciones, aprobador de respaldo       |

Categorías de notificación (grupo «Operaciones»): `ops_workitem`, `ops_escalation`, `ops_incident`, `ops_request`,
`approval_requested`, `approval_decided`.

## Configuración (`IntegrationConfig` con `source = 'operations'`)

Se siembra al arrancar (`seed.ts`, tolera arranques simultáneos) con caché de 10 s. `isEnabled = false` apaga todo.

| Clave                             | Default                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `cutoverDate`                     | instante de la siembra (sólo órdenes posteriores arrancan solas)                                                         |
| `flags`                           | `salesToCase`, `inventory`, `logistics`, `purchases`, `manufacturing`, `finance`, `crm`, `agents`, `supervisor` = `true` |
| `pilotLocationIds`                | `[]` (todas las bodegas)                                                                                                 |
| `slaDefaults` (min)               | action 240, wait 1440, approval 240, verification 120, external_sync 60, incident_followup 240                           |
| `escalation`                      | `afterMinutes [0, 120, 480]`, `ladder [backup, area_lead, administracion]`                                               |
| `externalSyncStaleMinutes`        | 15                                                                                                                       |
| `legacyClaimTtlDays`              | 14                                                                                                                       |
| `reservationAlertDays`            | 7                                                                                                                        |
| `provisionalVerificationMaxHours` | 72                                                                                                                       |
| `approvalThresholds`              | `procurementDoubleApprovalMxn 50000`, `expenseAutoApproveMxn 2000`                                                       |

Se edita con `updateOperationsConfig(patch)` (merge profundo, Zod estricto, guarda optimista, auditoría). La siembra
también crea las 7 áreas y abre `owner_absent` (una vez al día) por cada área sin `Responsible` activo.

## Rutas y UI

- `/app/operations` (`operations.view`): lista paginada de expedientes con filtros Abiertos/Cerrados/Todos y botón
  «Iniciar seguimiento» (`operations.manage`, validado en servidor). Entrada «Expedientes» en la navegación.
- `POST /app/operations/api/commands` (un comando) y `POST /app/operations/api/commands/batch`
  (`{deviceId, commands ≤ 50}`): sesión obligatoria; el actor es siempre el usuario de la sesión; cada comando del
  lote tiene su propio resultado y HTTP (`rejectionHttpStatus` cubre códigos de inventario y logística).
- Cola offline del navegador: `src/lib/offline-commands.ts` (IndexedDB `unik-commands`, lotes de 50, reintento al
  volver la conexión) y hook `src/lib/hooks/use-offline-command-queue.ts`.
- Pendiente (entregas de experiencia): detalle `/app/operations/cases/{id}`, «Mi trabajo» (`/app/mywork`) y Control
  Tower. Las notificaciones ya enlazan a esas rutas.

## Errores

`OperationsError(code, message, {httpStatus?, details?})` (`errors.ts`). Códigos del núcleo: `invalid_payload`
422, `unknown_command` 400, `unauthenticated` 401, `forbidden`/`actor_mismatch`/`self_approval`/`not_eligible` 403,
`not_found` 404, `version_conflict`/`concurrency_conflict`/`command_id_conflict`/`invalid_state`/`no_responsible`/
`no_approvers`/`approval_closed`/`approval_expired`/`already_voted` 409, `missing_evidence` 422, además de los del
motor (`case_not_eligible`, `step_condition_pending`, `process_version_mismatch`, `plan_quantity_mismatch`,
`plan_stock_exceeded`, `stock_not_promisable` 409) y los de inventario y logística.

## Pruebas

- Unitarias (`npx vitest run --project unit`): reglas puras (blueprint, condiciones, instanciación, planeador,
  política de arranque, replaneación, supervisor, catálogo de solicitudes) y servicios con FakePrisma
  (`testing/fixtures.ts`, `testing/case-fixtures.ts`).
- Integración contra PostgreSQL real (`npm run test:integration`, proyecto vitest `integration`,
  `tests/integration/operations-scenarios.int.test.ts`). Sólo corre con `UNIK_INTEGRATION_DATABASE_URL` apuntando a
  una base **local y desechable** con todas las migraciones (se niega a otra; p. ej. `unik_schema_check`). Siembra
  sus datos, trunca las tablas del programa y los limpia al final. Escenarios: flujo completo con stock controlado;
  stock desconocido (conteo → provisional → promesa humana); división existencia + compra; orden modificada tras
  reservar; cancelación con compensación; reclamo legado; dos órdenes compitiendo en transacciones concurrentes
  (FOR UPDATE); comando repetido (offline y en paralelo); entrega con cantidad distinta; Zoho falla al asignar
  transportista; Zoho devuelve otro valor; responsable ausente; supervisor idempotente. Sólo se simulan las
  escrituras a Zoho y el push.

## Cómo operar

1. Aplicar migraciones y desplegar; al arrancar se siembran la configuración y las áreas.
2. Configurar un `Responsible` activo (con suplente) para cada una de las 7 áreas y, si aplica, `Area.leadUserId`.
   Las incidencias `config:responsible_missing:{área}` se resuelven solas en el siguiente arranque.
3. Revisar `cutoverDate` y `pilotLocationIds` antes de dejar que las ventas nuevas abran expedientes.
4. Para una orden anterior al corte: `/app/operations` → «Iniciar seguimiento».
5. Vigilar `supervisor.tick` (eventos) y `UsageMeter` `ops.supervisor`; las incidencias abiertas indican qué está
   atorado y a quién le toca.
6. Apagar todo de golpe: `isEnabled = false` en la configuración de operaciones.

## Limitaciones conocidas

- Las políticas de aprobación por defecto viven en memoria (derivadas de la config); falta la UI para editarlas.
- No hay kind `direct_delivery`: la entrega directa usa `purchase_shortfall` con texto explicativo.
- El vendedor de Zoho se asigna como dueño sólo si su nombre coincide exactamente con un usuario activo.
- Un conteo que deja existencia `PROVISIONAL` no avanza solo el expediente: se cierra el work item de verificación.
- La replaneación detecta cambios de dirección sólo con el evento de cambio de la OV (`changes.fields`).
- `StepDef.escalation` se guarda, pero la escalación usa la escalera global de la configuración.
- El motor no convierte reclamos legados automáticamente: Inventario confirma el reclamo sobre la necesidad del
  expediente (se rechaza si esa necesidad ya tiene su existencia reservada).
