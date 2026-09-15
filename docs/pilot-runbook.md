# Piloto: manual de configuración, activación gradual y checklist

Este documento cierra la Entrega 16 del plan. Nada de lo aquí descrito se ha ejecutado contra servicios reales: cada bloque termina con lo que **el usuario** verifica antes de ampliar.

## 0. Orden recomendado de activación

1. Migraciones y almacenamiento R2 (Entregas 1–6).
2. Secretos y ejecutor común (7), luego una extensión de prueba (8–10).
3. Copiloto y biblioteca (11): no requieren servicios externos.
4. Un número de WhatsApp o un bot de Telegram en la bandeja (13-A).
5. Voz con LiveKit + Twilio en una sola cuenta (14).
6. Una campaña de ensayo con 10 destinatarios, después lotes reales (15).

Cada paso se activa por variables de entorno y permisos: sin variables, la funcionalidad queda visible pero inactiva (modo mock o error claro), nunca escribe en proveedores reales.

## 1. Migraciones (Railway Pre-deploy)

```bash
npx prisma migrate deploy
```

Migraciones nuevas (todas aditivas, sin DROP):

| Migración                                         | Contenido                                                                                                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260912100000_add_object_storage_jobs_realtime` | StorageObject, UploadSession, StorageConfig, BackgroundJob, RealtimeEvent; columnas opcionales en adjuntos/artefactos                                                                             |
| `20260912110000_add_extensions_skills_proposals`  | Extension*, ExtensionConnection, OAuthState, AiProposal, ExtensionExecution, Skill, SkillRun, UsageMeter                                                                                          |
| `20260912120000_add_copilot_studio_comms_voice`   | AiUserPreference, AiMemory, Knowledge*, Comm*, Responsible, Commitment, ConsentRecord, Campaign*, Voice* + índice GIN de búsqueda (Studio*, InternalRequest* y Quote se eliminan en la siguiente) |
| `20260912130000_drop_studio_requests_quotes`      | Elimina las tablas del estudio visual, solicitudes internas y cotizaciones locales (módulos retirados)                                                                                            |

Después de aplicar: `GET /api/health` debe seguir respondiendo `database: connected`.

## 2. Permisos nuevos (asignar desde /app/admin/access → Roles)

`files.admin` · `extensions.view` · `extensions.manage` · `extensions.connect` · `skills.manage` · `knowledge.manage` · `inbox.use` · `inbox.assign` · `inbox.admin` · `campaigns.view` · `campaigns.manage` · `campaigns.approve` · `calls.use` · `calls.supervise` · `calls.admin`.

`super_admin` los tiene todos automáticamente.

## 3. Variables de entorno por bloque

Ver `.env.example` (comentado). Resumen mínimo:

| Bloque                  | Variables                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Almacenamiento          | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_FILES`, `R2_BUCKET_RECORDINGS`, `R2_BUCKET_QUARANTINE`, opcional `R2_BACKUP_*` |
| Secretos de extensiones | `UNIK_SECRETS_MASTER_KEY` (openssl rand -base64 32), `UNIK_SECRETS_KEY_ID`, `APP_URL`                                                                  |
| Comunicaciones          | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WEBHOOK_BASE_URL`, `TELEGRAM_BOT_TOKEN` (o conexiones cifradas desde /app/admin/comms)              |
| Books                   | `ZOHO_BOOKS_ORGANIZATION_ID`, `ZOHO_BOOKS_MOCK=false` cuando esté validado                                                                             |
| Voz                     | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_SIP_TRUNK_ID`                                                                         |
| Jobs                    | `UNIK_JOB_WORKER_ENABLED` (default true; una sola réplica ejecuta schedulers Zoho; los jobs sí soportan varias réplicas)                               |

## 4. Almacenamiento R2 — activación

Sigue `docs/storage.md` §3 (buckets privados, token, CORS con `ExposeHeaders: ETag`, lifecycle de cuarentena) y §10 (checklist). Verificación del usuario:

- [ ] `/app/admin/files` muestra **Cloudflare R2** y jobs activos.
- [ ] Subir imagen en chat y asistente → `ready`; reproducir audio/video con adelanto.
- [ ] Archivo con extensión falsa → rechazado con motivo.
- [ ] Migración `inventory → dry-run → copy → verify → reconcile` con reporte sin fallos.
- [ ] Respaldo + restauración de un objeto; anotar tiempo real.
- [ ] Medir subida/descarga desde México contra Railway (no afirmar rapidez sin medir).

## 5. Extensiones — activación

Sigue `docs/extensions.md`. Verificación:

- [ ] Configurar `UNIK_SECRETS_MASTER_KEY`; guardar una conexión y comprobar que nunca vuelve al navegador.
- [ ] Crear extensión MCP de prueba → descubrir → clasificar → aprobar → habilitar para un rol → verla en el asistente solo con ese rol.
- [ ] Invocar directamente una capacidad deshabilitada por API → denegada.
- [ ] Cambiar el esquema en el servidor MCP → herramienta bloqueada y propuestas invalidadas.
- [ ] Importar OpenAPI con `$ref` remoto → aviso, no se descarga.
- [ ] Propuesta aprobada se ejecuta una sola vez; segundo clic → 409.
- [ ] Suspender extensión con jobs pendientes → jobs cancelados.

## 6. Copiloto y biblioteca

- [ ] Cambiar modo a **Pausada** y comprobar que el asistente no ofrece envíos ni cambios comerciales.
- [ ] Corrección propuesta por el asistente aparece como pendiente y solo cuenta al confirmarla.
- [ ] Subir un PDF a la biblioteca, aprobar y verificar que `searchKnowledgeLibrary` lo cita con versión; contenido interno no aparece con `visibility=publishable`.

## 7. Comunicaciones (ver `docs/communications.md`, `docs/campaigns.md`)

- [ ] Registrar un número de WhatsApp (Twilio) con webhook `https://APP/api/webhooks/twilio/messaging?accountId=...` y verificar firma.
- [ ] Bot de Telegram con `setWebhook` + `secret_token`.
- [ ] Mensaje entrante duplicado (reintento de webhook) → una sola fila.
- [ ] Respuesta desde la bandeja; reenvío tras BAJA → bloqueado.
- [ ] Compromiso vencido genera aviso.
- [ ] Campaña: audiencia y contenido congelados, ensayo con muestras, vista exacta por destinatario, presupuesto, baja durante la campaña evita siguientes envíos, pausa/reanudación sin duplicados.

## 8. Voz (ver `docs/voice.md`)

- [ ] SIP trunk Twilio ↔ LiveKit y webhooks configurados; llamada interna entre dos usuarios.
- [ ] "Pausar IA" detiene transcripción y descarta resultados tardíos; grabación con control separado visible.
- [ ] Egress a bucket `recordings` con token de solo escritura; grabación reproducible por streaming autenticado; retención 30/90 días.
- [ ] Supervisor sin permiso no obtiene token; con permiso puede escuchar/intervenir.
- [ ] Petición oral de cotización oficial → propuesta, nunca creación directa.

## 9. Capacidad y observabilidad

- Dimensionar por separado: instancia web (100 operadores, SSE ≈ 1 conexión por pestaña; PostgreSQL pool) y LiveKit/Twilio (50 llamadas concurrentes según plan del proveedor). Los jobs masivos corren con prioridad `bulk` (500) por debajo de la atención humana (`interactive` 10).
- Consumo: `/app/admin/extensions` → Consumo (por extensión) y `UsageMeter` (storage por usuario/entorno/propósito, campañas, proveedor, llamadas).
- Eventos con cursor: `/app/realtime/api/stream` (reconexión sin pérdida).

## 10. Qué NO se ha validado (honestidad operativa)

- Ninguna llamada real a R2, Twilio, Telegram, LiveKit, Zoho Books ni servidores MCP: solo emuladores, mocks y fixtures locales.
- CORS, firmas presignadas y multipart contra R2 real; latencia desde México.
- Agente de voz en tiempo real dentro de LiveKit (Agents) y cliente WebRTC de navegador (`livekit-client`) — documentados como pendientes por el módulo de voz.
- Rasterización PNG de exportaciones (sin rasterizador instalado).

## 11. Operaciones (plan UNIK Neural Operations)

Las verificaciones **PENDIENTE PRODUCCIÓN** de cada entrega del plan se acumulan aquí, en el mismo orden en que
se entregan. Todo queda detrás de flags apagados; nada de esta sección se ha ejecutado en Railway.

### 11.1 Migraciones del programa (creadas, NO aplicadas)

Todas son aditivas (`CREATE TABLE`, `CREATE INDEX`, `ADD COLUMN`, `ADD CONSTRAINT`), sin `DROP`, `RENAME` ni
`ALTER COLUMN`. Se aplicaron desde cero sólo en una base local desechable (`unik_schema_check`, 41 migraciones) y
no agregan deriva nueva frente al esquema. Se aplican con `npx prisma migrate deploy` en el Pre-deploy de Railway:

| Migración                                     | Contenido                                                                                                                                                                                                                                           |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260916120000_add_operations_core`          | Area, OperationalCase, CaseDemand, DemandAllocation, ProcessVersion, CaseStep, WorkItem, AreaRequest, Incident, OperationalEvent (PK `id, occurredAt`), OperationalCommand, EvidenceLink, ObjectRelation, Sequence, ApprovalPolicy, ApprovalRequest |
| `20260916120100_add_agents_layer`             | `User.isBot`/`botKind`, `internal_chat_message.meta`, `AiProposal.approverScope`/`secondDecisionBy`/`secondDecidedAt`, `AiUserPreference.surfaceModes`, AgentIdentity                                                                               |
| `20260916130000_add_inventory_logistics_core` | Warehouse, StorageLocation, ProductInventoryProfile, StockItem, StockMovement, StockReservation, StockCount(+Line), LegacyCommitmentClaim, Vehicle, Driver, DeliveryOrder, Trip, TripStop, DeliveryEvidence                                         |
| `20260916140000_add_purchases`                | Supplier(+Product/Evaluation), PurchaseRequest(+Line), Rfq(+Line/Invitation/Response/ResponseLine), ProcurementOrder(+Line/Allocation), GoodsReceipt(+Line), SourcingSearch, SourcingCandidate                                                      |
| `20260916140100_add_manufacturing`            | WorkCenter, Bom(+Line/Operation), ProductionOrder, ProductionOperation, MaterialConsumption, ProductionOutput, QualityCheck                                                                                                                         |
| `20260916150000_add_finance`                  | CashAccount, FinanceCategory, CostCenter, LedgerEntry(+Line), Obligation(+Settlement), Expense(+Split/Template), Budget, Employee, PayrollRun(+Line), PeriodClose                                                                                   |
| `20260916150100_add_crm`                      | PipelineStage, Opportunity(+Activity, índices GIN), SalesOrderWriteRequest, RadarSignal                                                                                                                                                             |
| `20260916160000_add_dashboards_control_tower` | DashboardSnapshot, CtCaseVariant, CtStepMetricDaily, CtHandoffDaily, CtBlockCauseDaily, CtProjectionWatermark, CtGraphScene                                                                                                                         |

Antes de estas va `20260914170000_package_shipment_fields` (paquetes), que tampoco está aplicada en la base local.

Deriva previa, ajena al programa: `prisma migrate diff` contra una base creada desde cero no queda vacío (recrea las FK
de `InvoiceItem`, `PackageItem` y `PurchaseOrderItem`, cambia defaults de `internal_chat_config`, agrega
`AiAttachment_messageId_fkey` y renombra un índice de `IntegrationEntityState`). No la corrige ninguna de estas
migraciones; dejarla en cero requiere una migración de corrección aparte, revisada contra los datos de producción.

### 11.2 Entrega 0 — Preparación (sin cambio visible)

Cambios: navegación/migas/rutas full-bleed extraídas a `src/components/layout/nav-config.ts`; kit de dashboard en
`src/components/patterns/dashboard/` que sustituye las tarjetas de estadísticas de los paneles de administración;
infraestructura aditiva (`enqueueJob({ tx })`, `recordSalesOrderChange` devuelve el id del evento, `toCurrentUser`,
`FakePrisma` extensible, `toolChoice: 'required'`); `framer-motion` → `motion/react`; humo local en `e2e/`.

- [ ] Tras desplegar, la app arranca igual: `GET /api/health` → `database: connected`; `/login` y `/app` sin cambios.
- [ ] Menú lateral, migas y páginas a ancho completo iguales que antes para un usuario con todos los permisos y para
      uno con permisos parciales.
- [ ] Paneles de administración con tarjetas migradas (asistente, chat, extensiones y su monitoreo, archivos, voz,
      integraciones, campañas) en tema claro y oscuro a 1366/1024/640 px: cifras iguales, sin cajas vacías ni
      desbordes. Cambios visuales aceptados: etiqueta arriba del valor, icono arriba, rejilla 4→3→2→1.
- [ ] Copiloto (tarjetas de plan y propuesta) y modo de voz del asistente animan igual con `motion/react`.

### 11.3 Entrega 1 — Núcleo operativo (backend)

**IMPLEMENTADO:** `src/modules/operations/` — comandos idempotentes con ledger (`executeCommand`), eventos y
canales `case:`/`area:`, configuración `IntegrationConfig('operations')` (flags en `true`), blueprint
`sales_fulfillment@1`, work items con escalera, catálogo de solicitudes entre áreas, incidencias, evidencias,
aprobaciones de negocio (con vencimiento por el supervisor), supervisor determinista (`ops.supervisor` cada 4 min),
siembra de áreas, endpoint de comandos y lote offline (`/app/operations/api/commands[/batch]`), cola offline del
navegador y lista mínima de expedientes con «Iniciar seguimiento» en `/app/operations`. Detalle en
`docs/modules/operations.md`.

**No implementado todavía en esta entrega** (queda para las entregas de IA y experiencia): bots e identidades de
agente, salas de expediente y posts de plantilla, matriz y despachador de IA, superficie «Mi trabajo»
(`/app/mywork`), detalle del expediente (`/app/operations/cases/{id}`), pestaña «Agentes y presupuestos» y Control
Tower mínimo. Las notificaciones ya enlazan a esas rutas y darán 404 hasta que existan.

**VALIDADO LOCALMENTE:** `prisma validate`, `tsc --noEmit`, `eslint`, `vitest --project unit` (FakePrisma),
`next build`, y `npm run test:integration` contra la base desechable `unik_schema_check` (replay de comandos en serie
y en paralelo, conflicto de versión, supervisor idempotente en serie y desde dos instancias, responsable ausente).

**PENDIENTE PRODUCCIÓN** (PENDIENTE DE VALIDACIÓN MANUAL):

- [ ] Aplicar las migraciones de §11.1 con `npx prisma migrate deploy` y verificar `GET /api/health`.
- [ ] Tras el primer arranque existe `IntegrationConfig` con `source = 'operations'`, todos los flags en `true` y
      `cutoverDate` igual al instante de la siembra; existen las 7 áreas (`Area`).
- [ ] Asignar `operations.view`, `operations.manage` y `operations.admin` a los roles que correspondan.
- [ ] Configurar un `Responsible` activo con suplente para `ventas`, `compras`, `inventario`, `manufactura`,
      `logistica`, `contabilidad` y `administracion` (y `Area.leadUserId` si aplica); las incidencias
      `config:responsible_missing:{área}` se resuelven en el siguiente arranque.
- [ ] Iniciar el seguimiento de una orden real desde `/app/operations`: aparece `EXP-000001`, con work items con
      dueño y plazo, notificaciones `ops_workitem` y eventos en `case:{id}`/`area:{key}`.
- [ ] Repetir el mismo comando desde dos pestañas o un teléfono sin red: un solo efecto (resultado `replayed`).
- [ ] Dejar vencer un work item: `workitem.overdue`, escalación al suplente, al líder, a Administración y, al final,
      incidencia `sla_breach` crítica.
- [ ] Ver el tick del supervisor: job `ops.supervisor` cada 4 min, evento `supervisor.tick` y `UsageMeter` con
      dimensión `ops.supervisor`; con dos réplicas un hallazgo actúa una sola vez.
- [ ] Desactivar a un responsable con suplente: su trabajo pasa al suplente en el siguiente tick.
- [ ] Apagar `isEnabled` en la configuración de operaciones: el supervisor y los arranques automáticos se detienen.

### 11.4 Entrega 2 — Venta → expediente e inventario progresivo (backend)

**IMPLEMENTADO:** ganchos del normalizador de órdenes de venta, reconciliador (`ops.case.reconcile_orders` cada
5 min), política de arranque (`cutoverDate`, `pilotLocationIds`), replaneación y cancelación con compensaciones;
`src/modules/inventory/` con bodegas, perfiles, movimientos, reservas bajo `SELECT … FOR UPDATE`, conteos con
confianza `UNCOUNTED → PROVISIONAL → CONTROLLED`/`DISPUTED`, reclamos legados (confirmación protegida contra doble
reserva), etiquetas y consumo de reservas al entregar. Detalle en `docs/modules/inventory.md`.

**No implementado todavía en esta entrega:** PWA de conteo con escaneo, áreas Inventario y Ventas (dashboards,
centros de trabajo, mapa de ubicaciones), Control Tower `resumen`/`excepciones`/`personas`, disparadores LLM y
resúmenes de caso con IA.

**VALIDADO LOCALMENTE:** unitarias con FakePrisma y emulación de candados; contra PostgreSQL real
(`unik_schema_check`): flujo completo con stock controlado, stock desconocido (conteo → provisional → promesa humana),
división existencia + compra, orden modificada tras reservar (cantidad abajo/arriba y dirección), cancelación con
compensación, reclamo legado, dos órdenes compitiendo en transacciones concurrentes (con los candados desactivados la
prueba falla) y comando offline repetido.

**PENDIENTE PRODUCCIÓN** (PENDIENTE DE VALIDACIÓN MANUAL):

- [ ] Asignar `inventory.view`, `inventory.count`, `inventory.adjust`, `inventory.reserve` e `inventory.manage`.
- [ ] Revisar `cutoverDate` y fijar `pilotLocationIds` con una sola bodega piloto antes de dejar correr las ventas.
- [ ] Una orden nueva en Zoho de la bodega piloto abre su expediente en un ciclo de sincronización (job
      `ops.case.start`); una orden de otra bodega no.
- [ ] Una orden elegible importada con el módulo detenido la levanta el reconciliador en ≤ 5 minutos.
- [ ] Revisar la bodega creada automáticamente por la ubicación de Zoho y su ubicación `GENERAL`.
- [ ] Contar dos veces un SKU con diferencias dentro de tolerancia: `PROVISIONAL` tras el primero, `CONTROLLED` tras
      el segundo; desde entonces sus ventas se reservan solas.
- [ ] Contar con una diferencia fuera de tolerancia: `DISPUTED`, incidencia `count_dispute` y trabajo de seguimiento.
- [ ] Prometer existencia `PROVISIONAL` sólo al aceptar el plan con la casilla explícita; sin ella se rechaza.
- [ ] Modificar la cantidad y la dirección de una orden en Zoho: `case.replanned`, reservas ajustadas y entrega
      parcheada (o incidencia si ya tenía transporte).
- [ ] Anular en Zoho una orden con compra en curso: expediente `cancelled`, reservas liberadas, solicitud `cancel` a
      Compras e incidencia `cancellation_compensation`.
- [ ] Dos personas reservan a la vez el mismo SKU controlado: una se rechaza con `insufficient_stock`; nunca queda
      existencia controlada negativa.
- [ ] Registrar un compromiso anterior al corte y confirmarlo cuando la venta tenga expediente.

### 11.5 Entrega 4 — Logística con Zoho (núcleo backend)

**IMPLEMENTADO:** `src/modules/logistics/` — órdenes de entrega ligadas al expediente y al paquete de Zoho, asignación
de transporte con outbox (`ops.zoho.ship_package`), relectura y estados de sincronización, conflicto e incidencias,
entregas con evidencia física, entrega parcial con remanente, marcar entregado y cancelar embarque en Zoho, viajes y
paradas con reglas de capacidad y orden, flotilla, destino de evidencias `delivery_evidence`, barrido
`logistics.zoho_reconcile` cada 30 min y canales `logistics:dispatch`/`trip:{id}`. Detalle en
`docs/modules/logistics.md`.

**No implementado todavía en esta entrega:** despacho visual, mapa Leaflet, PWA del chofer con Background Sync y sus
rutas (`/app/logistics/driver/api/*`), tools de IA de logística.

**VALIDADO LOCALMENTE:** unitarias con `shipPackage` simulado; contra PostgreSQL real con las escrituras a Zoho
simuladas: flujo completo con flotilla propia y relectura igual, entrega con cantidad distinta, Zoho falla al asignar
transportista (cinco intentos → `failed` + `zoho_failure`), Zoho devuelve otro valor (`conflict` + `zoho_conflict`).

**PENDIENTE PRODUCCIÓN** (PENDIENTE DE VALIDACIÓN MANUAL):

- [ ] Asignar `logistics.view`, `logistics.dispatch`, `logistics.drive`, `logistics.manage_fleet` y
      `logistics.zoho_write` (este último sólo a quien escribe embarques en Zoho).
- [ ] Dar de alta vehículos y choferes ligados a su usuario.
- [ ] Una orden preparada sin paquete en Zoho queda `pending` con la solicitud `create_package_in_zoho` a Ventas; al
      crear el paquete en Zoho, el barrido lo enlaza.
- [ ] Asignar transporte a una entrega real: la orden de envío aparece en Zoho una sola vez y la relectura deja
      `readback_ok` y el paso `asignar_transporte` cerrado.
- [ ] Cambiar el transportista en Zoho y releer: la entrega queda en `conflict` con los valores de Zoho, incidencia
      `zoho_conflict` y trabajo para Logística.
- [ ] Con Zoho sin responder: `pending_external` durante los reintentos y, al agotarlos, `failed` con incidencia
      `zoho_failure`.
- [ ] Registrar una entrega sin foto ni firma: se rechaza y la orden sigue abierta; con evidencia: `delivered`, reserva
      consumida (movimiento `issue`) y entregado marcado en Zoho.
- [ ] Registrar una entrega con menos piezas: `partially_delivered`, orden hija por el remanente, incidencia
      `partial_delivery` y trabajo «Decidir remanente» para Ventas.
- [ ] Cancelar un expediente con embarque escrito por UNIK: la cancelación del embarque se refleja en Zoho.
- [ ] Una entrega offline desde el teléfono se replica una sola vez (requiere la PWA del chofer, aún no construida).

### 11.6 Correcciones de la revisión del núcleo (comandos, expedientes, inventario, logística)

**IMPLEMENTADO:**

- Cola offline por usuario: cada comando guarda quién lo registró; un lote sólo se envía con la sesión de esa persona y
  el servidor responde `actor_mismatch` (sin ejecutar ni guardar) si la sesión es de otro. Lotes 413 se parten; un
  comando que falla 20 veces espera a que la persona lo reintente o lo descarte.
- Motor de comandos: un conflicto de concurrencia queda `failed` (el mismo id se vuelve a ejecutar); un id de otro actor
  se rechaza; las reacciones que no se pueden perder (avanzar expediente, acuse de solicitudes) se encolan en la misma
  transacción; responsables, preferencias y configuración se leen con la conexión de la transacción.
- Expedientes: una reserva que falla o una solicitud rechazada regresa la partida al plan de Ventas; preparar exige
  existencia reservada o material recibido; `esperar_recepcion`/`esperar_produccion` exigen el movimiento de entrada y lo
  reservan; cada avance toma el candado del expediente; unidades sin conversión nunca se dan por disponibles;
  `asignar_transporte` espera sin escalar mientras Zoho confirma; la fase es la del paso abierto menos avanzado.
- Inventario: una necesidad nunca se reserva dos veces ni de más; la merma no se traspasa; una salida sin reserva que deja
  reservas sin cobertura abre incidencia alta; candados en orden de id; la unidad base se congela con partidas abiertas.
- Logística: el paso de transporte sólo cierra con relectura de Zoho; iniciar un viaje exige paquete y escribe el embarque
  si faltaba; cerrar la decisión de conflicto acepta los valores de Zoho; el paquete se enlaza por sus artículos; sólo
  cuenta la evidencia del intento actual; 4xx de Zoho no se reintentan.

**PENDIENTE PRODUCCIÓN** (PENDIENTE DE VALIDACIÓN MANUAL):

- [ ] Fijar `connection_limit` y `pool_timeout` en `DATABASE_URL` de Railway según las instancias (ver `.env.example`).
- [ ] En un teléfono compartido: registrar sin señal con la persona A, cerrar sesión, entrar con B: los comandos de A
      quedan «pendientes de otro usuario» y se envían cuando A vuelve a entrar.
- [ ] Una compra rechazada por Compras regresa el plan a Ventas con su propuesta.
- [ ] Iniciar un viaje con una entrega sin transporte asignado: la orden de envío aparece en Zoho y el paso de
      transporte se cierra al releerla.
- [ ] Un conflicto de Zoho que Logística acepta cerrando su trabajo deja la entrega confirmada y la incidencia resuelta.

### 11.7 Entrega 3 — Capa de IA coordinada (agentes por área)

**IMPLEMENTADO:** `src/modules/agents/` sobre la IA existente (sin otra IA ni otro loop): 7 identidades bot con rol
fijo, sala de venta por expediente y canal por área, matriz de disparo con reglas y plantillas (cero LLM), despachador
con guardas (activado, modo, horario, presupuesto, persona atendiendo, tope por expediente, dedupe), turnos de agente
por `runAssistant` con lista de tools por área y `tool_choice: 'required'`, propuestas con alcance de aprobación,
presupuestos y consumo por agente/área/expediente, copilotos de área, expediente, Mi trabajo (`/app/mywork`) y
Control Tower, jobs `agents.dispatch`, `agents.stuck_scan` (1 h) y `agents.control_tower_digest` (07:30), y pestaña
**Admin → Asistente IA → Agentes y presupuestos**. Detalle y cómo apagar en `docs/modules/agents.md`.

**No implementado todavía en esta entrega** (fase de experiencia): páginas del Expediente 360
(`/app/operations/cases/[id]`), centros de trabajo por área (`/app/areas/…`) y la página de Control Tower; los enlaces
"Ver expediente" y "Abrir centro de trabajo" de las tarjetas y notificaciones darán 404 hasta entonces. Permisos de
módulo de Compras, Manufactura, Contabilidad y CRM (sus bots sólo leen).

**VALIDADO LOCALMENTE:** `tsc --noEmit`, `eslint`, `vitest --project unit`, `npm run test:integration` contra la base
desechable `unik_schema_check` (incluye `tests/integration/agents-protocol.int.test.ts` con proveedor de IA
guionizado: sala con bots y responsables, faltante → solicitud y tarjetas sin modelo, solicitud vencida → turno con
propuesta, aprobación por la responsable y rechazo de bot y ajeno, presupuesto degradado/agotado, mención con
respuesta y `ai.turn` con tokens) y `next build`.

**PENDIENTE PRODUCCIÓN** (PENDIENTE DE VALIDACIÓN MANUAL):

- [ ] Tras aplicar `20260916120100_add_agents_layer` y arrancar: existen 7 usuarios bot (`ia_*`, `isBot = true`),
      7 filas `AgentIdentity`, los roles `agent_*` sin `super_admin` y un canal de chat por área. Ningún bot puede
      iniciar sesión (probar `ia_compras` en `/login`: mismo error genérico que una cuenta inactiva).
- [ ] Revisar en los logs de arranque que `ensureAgentIdentities` no reporte `conflicts` (p. ej. un usuario humano
      que ya se llame `ia_compras`).
- [ ] Admin → Asistente IA → Configuración: modelo `routine` (Canopy `kimi-k2.6` o el que se decida), modelo
      `utility`, sección Agentes (activado, zona horaria, horario silencioso 20:00–07:00, topes y umbrales) y cuota
      mensual de Canopy si aplica.
- [ ] Confirmar con el proveedor real que el turno automático acepta `tool_choice: 'required'`; si lo rechaza, el
      log `tool_choice_fallback` y un `ai.turn` con `retriedWithNamedTool: true` indican que funcionó el respaldo.
- [ ] `Responsible` con suplente para las 7 áreas (son quienes aprueban las propuestas de su IA) y responsable de
      Administración (recibe el digest diario en su canal).
- [ ] Iniciar una orden piloto: aparece la sala de venta con la IA administradora, la IA de Ventas, la de Inventario,
      sus responsables y el vendedor, con la plantilla de inicio.
- [ ] Un faltante confirmado: tarjeta de solicitud en la sala (Aceptar / Bloquear / Ver expediente), copia en el canal
      de Compras, notificación `agent_request` al responsable y un solo `purchase_shortfall`; sin consumo de IA.
- [ ] Dejar vencer esa solicitud en horario hábil: turno `unblock` de la IA de Compras, tarjeta de propuesta en la
      sala y aviso a responsable y suplente; aprobar desde el chat ejecuta; otro usuario no la ve.
- [ ] Mencionar `@ia_compras` en el canal de Compras: responde en hilo; en Agentes y presupuestos aparece el turno
      con tokens y costo.
- [ ] Un evento dentro del horario silencioso se difiere al final de la ventana (`ai.turn_skipped` con
      `quiet_hours`) y corre después; una mención se contesta al momento.
- [ ] Bajar temporalmente el presupuesto diario de una identidad: al 80 % se salta lo automático
      (`budget_degraded`) y avisa a dirección; al 100 % publica una sola vez "en pausa por presupuesto" y deja de
      contestar menciones. Restaurar el presupuesto (0 significa sin límite: para detener usar el modo `paused`).
- [ ] Revisar mañana a las 07:30 el digest en el canal de Administración y, tras 24 h sin movimiento de un expediente
      abierto, el turno `stuck_review`.
- [ ] Probar el apagado: modo `paused` de una identidad, `agents.enabled = false` y el flag `agents` de operaciones
      (ver `docs/modules/agents.md` → Cómo apagar).
- [ ] Revisar Admin → Asistente IA → Agentes y presupuestos: consumo por área y día, principales disparos y saltados.
