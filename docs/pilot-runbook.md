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

Los del programa de Operaciones (Expedientes, Inventario, Logística, Compras, Ventas/CRM, Manufactura y
Contabilidad: 42 llaves en total) se asignan con la entrega que los estrena y están en la §11, cada uno con lo que
abre: §11.3 `operations.*`, §11.4 `inventory.*`, §11.5 `logistics.*`, §11.9 `purchases.*`, §11.10 `crm.*`,
§11.11 `manufacturing.*` y §11.12 `finance.*`.

**Llaves de aprobador de área** (las que hacen a una persona aprobadora de las propuestas de la IA de su área y de
las aprobaciones de negocio que ese área firma). No se inventó ninguna `<área>.approve`: se crearon las dos que
hacían falta de verdad y las otras cuatro áreas usan la llave que ya concentra sus decisiones. Fuente:
`AREA_REGISTRY[...].permissions.approve` y `AREA_APPROVER_PERMISSION_CANDIDATES`; tabla completa en
`docs/modules/areas.md` §3.

| Área         | Llave de aprobador                      |
| ------------ | --------------------------------------- |
| Ventas       | `crm.manage`                            |
| Compras      | `purchases.approve`                     |
| Inventario   | `inventory.adjust` o `inventory.manage` |
| Manufactura  | `manufacturing.approve_incidents`       |
| Logística    | `logistics.manage_fleet`                |
| Contabilidad | `finance.approve`                       |

Dale la llave de aprobador a **dos** personas distintas por área: nadie firma lo que él mismo pidió, y compras,
pagos y nómina piden dos firmas desde el umbral (nómina siempre).

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

Las verificaciones **PENDIENTE PRODUCCIÓN** de cada entrega del plan se acumulan aquí. Las secciones son
**aditivas**: se agregan al final para no renumerar las anteriores (otros documentos ya apuntan a §11.1 y §11.7), así
que el número de sección **no** es el orden de entrega — cada encabezado dice a qué entrega del plan corresponde. Las
§11.9 a §11.12 (Compras, CRM, Manufactura y Contabilidad) se implementaron antes que la §11.8.

Nada de esta sección se ha ejecutado en Railway. Por decisión del dueño los indicadores de
`IntegrationConfig('operations')` nacen **encendidos** (la excepción es `crmSalesOrderWrite`): los frenos reales son
los permisos, `cutoverDate`, los presupuestos y el horario de la IA. Por eso cada sección empieza por los permisos que
hay que asignar.

### 11.1 Migraciones del programa (creadas, NO aplicadas)

Las del programa son aditivas (`CREATE TABLE`, `CREATE INDEX`, `ADD COLUMN`, `ADD CONSTRAINT`), sin `DROP`, `RENAME`
ni `ALTER COLUMN`; la excepción es la última de la tabla, que corrige deriva heredada y por eso sí recrea
restricciones y renombra un índice (detalle abajo). Se aplicaron desde cero sólo en bases locales desechables
(`unik_schema_check` y `unik_preview`) y **no dejan deriva frente al esquema**. Se aplican con
`npx prisma migrate deploy` en el Pre-deploy de Railway:

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
| `20260916181500_align_legacy_schema_drift`    | **Corrección de deriva heredada** (ver abajo): FK faltante de `AiAttachment.messageId`, `ON UPDATE` de tres FK de detalle, dos defaults de `internal_chat_config`, nombre de un índice de `IntegrationEntityState`                                  |

Antes de estas va `20260914170000_package_shipment_fields` (paquetes), que tampoco está aplicada en la base local.

#### Deriva heredada: corregida por `20260916181500_align_legacy_schema_drift`

Hasta esta migración, `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel
prisma/schema.prisma` **no quedaba vacío**: una base construida con `prisma migrate deploy` (el camino de Railway) no
era la base que describe el esquema que usa el cliente de Prisma. Los cinco desajustes son anteriores al programa
(migraciones de septiembre 4 a 13) y ninguno toca los modelos nuevos de operaciones, compras, manufactura,
contabilidad, CRM o logística, que sí estaban completos:

| Desajuste                                                    | Origen                                                                                               | Efecto real                                                                                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `AiAttachment_messageId_fkey` no existía                     | `20260909120000` creó sólo el índice; `20260913160500` dio la FK a `AiArtifact` pero no a ésta       | Borrar un `AiMessage` dejaba adjuntos apuntando a un mensaje inexistente en vez de poner `messageId` en NULL (`onDelete: SetNull`) |
| `InvoiceItem`/`PackageItem`/`PurchaseOrderItem`: `ON UPDATE` | `20260910140000`, `20260910150000`, `20260910160000` escribieron `ON DELETE CASCADE` sin `ON UPDATE` | Postgres puso `NO ACTION`; Prisma genera `CASCADE`. Sin efecto práctico (los ids son cuid y no se actualizan), pero es deriva      |
| `internal_chat_config.id` sin `DEFAULT 'singleton'`          | `20260910120000`                                                                                     | Sólo metadato: todos los `create` de Prisma ya mandan el id                                                                        |
| `internal_chat_config.value` con `DEFAULT ''`                | `20260910170000` (lo necesitaba para añadir la columna NOT NULL)                                     | Sólo metadato; la columna sigue NOT NULL                                                                                           |
| Índice `IntegrationEntityState_..._remoteModifi`             | `20260904120000` usó un nombre de 71 caracteres que Postgres truncó a 63                             | Mismo índice, nombre distinto al que genera Prisma (`..._remoteMo_idx`)                                                            |

La migración correctiva **no borra tablas, columnas ni datos**: los únicos `DROP` son de restricciones que vuelve a
crear en la misma transacción con la definición correcta, y el único `RENAME` es de índice (con un bloque `DO` que
tolera las tres situaciones posibles: nombre viejo, nombre nuevo o ambos). Antes de crear la FK de `AiAttachment`
pone en NULL los `messageId` huérfanos, igual que hizo `20260913160500` con `AiArtifact`.

- [ ] Aplicarla en la ventana de despliegue y no con carga de escritura encima: `ADD CONSTRAINT ... FOREIGN KEY` toma
      `SHARE ROW EXCLUSIVE` sobre la tabla hija y valida las filas existentes (son tablas de detalle pequeñas).
- [ ] Tras `prisma migrate deploy`, comprobar deriva cero contra la base desplegada:
      `npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code`
      (0 = sin diferencias, 2 = hay diferencias).

La red que impide que la deriva vuelva es `tests/integration/schema-parity.int.test.ts` (`npm run test:integration`):
corre ese mismo `migrate diff` contra la base de integración y además verifica las cinco correcciones una por una.
`prisma validate`, `tsc`, `eslint` y las pruebas con `FakePrisma` **no** miran la base y no pueden detectarlo.

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

### 11.7 Capa de IA coordinada (agentes por área)

En la tabla de la sección 8 del plan esta capa se reparte entre las entregas 1 (identidades, matriz y despachador
sólo con reglas) y 2 (disparadores con LLM); se entregó junta y se verifica junta.

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

> Revalidación del 2026-09-16: `agents-protocol.int.test.ts` vuelve a pasar, pero **fallaba de forma
> intermitente** y la causa no estaba en esa suite — ver §11.14. Antes de volver a leer esta línea como verde,
> corre `npm run test:integration` **sin otra corrida encima**.

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

### 11.8 Experiencia de operaciones (áreas, Expediente 360, Torre de Control)

Corresponde a la sección 7 del plan (experiencia por área, Control Tower y UNIK Neural Operations), que la tabla de
la sección 8 reparte entre varias entregas; se entregó junta al final.

**IMPLEMENTADO:** el marco común de áreas y las seis áreas completas (`/app/areas/{área}` con panel, centro de
trabajo, comunicaciones, vista especial y subpáginas), el Expediente 360 (`/app/operations` y
`/app/operations/cases/{id}`), «Mi trabajo», la Torre de Control con sus seis vistas —incluido el editor de
configuración de operaciones y el CRUD de `ApprovalPolicy` con vista previa de aprobadores— y UNIK Neural
Operations con sus cinco herramientas. Detalle en `docs/modules/areas.md` y `docs/modules/control-tower.md`.

**VALIDADO LOCALMENTE** (cifras del día en que se cerró la entrega): `tsc --noEmit` (0 errores), `eslint`
(0 errores, 35 avisos = línea base), `vitest --project unit` (249 archivos, 3 487 pruebas),
`npm run test:integration` contra `unik_schema_check` (7 archivos, 79 pruebas), `next build` y `storybook build`.

> Las cifras del proyecto `integration` **ya no son ésas**: el 2026-09-16 pasaron de 7 archivos / 79 pruebas a
> **11 archivos / 101 pruebas** en una sola jornada, y siguen creciendo. Una cifra que no cuadra aquí **no es un
> fallo**: es una foto vieja, y lo que toca es volver a medirla
> (`npm run test:integration | tail -3`), no dar por rota la entrega. Lo mismo vale para las de `unit`. Y antes de
> concluir que la puerta está roja, lee §11.14: una corrida en rojo casi siempre es otra corrida encima.

**VALIDADO EN NAVEGADOR** — esto es nuevo en esta entrega y conviene repetirlo antes de producción. Se levantó
`next start` contra una base de vista previa desechable (`unik_preview`, copia de `unik_system` + `migrate deploy`)
sembrada con `scripts/seed-operations-preview.mjs`, y `e2e/operations-visual.spec.ts` recorrió las 62 pantallas
—las 60 de siempre más las dos páginas de gestión que viven bajo un área sin ser espacios del registro
(`/app/areas/contabilidad/gastos/nuevo` y `/app/areas/inventario/perfiles`)— en **los cuatro anchos que exige el
plan**: 1366×900, 1024×768, 768×1024 y 390×844. En cada pantalla y en cada ancho: sin errores de consola, sin scroll
horizontal, sin contenido recortado que nadie pueda alcanzar, sin controles fuera de la pantalla, sin
`undefined`/`NaN` visibles y sin páginas en blanco. Última corrida: **14 pruebas en verde, 4.2 min, 305 capturas**
(62 a 1366 y 81 a cada uno de 1024, 768 y 390).

Cada página se abre una vez a 1366 y se vuelve a medir redimensionando (las reglas responsivas son media queries y
`useIsMobile`/`useWideScreen` escuchan `matchMedia`, así que se repintan solas). Lo que el redimensionado no ejercita
—la hidratación ya en ese ancho, porque el servidor siempre pinta la variante ancha— lo cubre la prueba «carga
directa a 1024, 768 y 390», que abre con **carga directa** panel, centro de trabajo y vista especial de cada área más
el resumen de la Torre de Control (donde vive `useWideScreen`, que cambia en 1280: por eso 1024 no es un ancho de
adorno). `PREVIEW_WIDTHS=768` acota la corrida a un solo ancho cuando se persigue un breakpoint. Cómo reproducirlo:

```bash
dropdb --if-exists unik_preview && createdb unik_preview
pg_dump --no-owner --no-privileges unik_system | psql -q unik_preview
DATABASE_URL=postgresql://<usuario>@localhost:5432/unik_preview npx prisma migrate deploy
DATABASE_URL=postgresql://<usuario>@localhost:5432/unik_preview \
  node --experimental-strip-types scripts/seed-operations-preview.mjs --reset
DATABASE_URL=postgresql://<usuario>@localhost:5432/unik_preview \
  node scripts/create-preview-session.mjs --out /tmp/preview-auth.json --base-url http://localhost:3100

# Servidor de vista previa (sin claves de IA reales, Zoho en mock)
DATABASE_URL=postgresql://<usuario>@localhost:5432/unik_preview ZOHO_BOOKS_MOCK=true \
  OPENAI_API_KEY=<clave_de_prueba> npx next start -p 3100

# Proyecciones y tableros (con la cookie de la sesión de vista previa)
curl -X POST -H 'Content-Type: application/json' -b "unik_session=$TOKEN" -d '{"wait":true,"full":true}' \
  http://localhost:3100/app/admin/control-tower/api/projections/rebuild
for a in ventas compras inventario manufactura logistica contabilidad; do
  curl -X POST -b "unik_session=$TOKEN" "http://localhost:3100/app/areas/$a/api/dashboard"; done

PREVIEW_BASE_URL=http://localhost:3100 PREVIEW_STORAGE_STATE=/tmp/preview-auth.json \
  PREVIEW_SCREENS=/tmp/screens npx playwright test e2e/operations-visual.spec.ts
```

Los dos scripts **se niegan a correr** si `DATABASE_URL` no apunta a `unik_preview` o `unik_schema_check`, y
`create-preview-session.mjs` no toca contraseñas: inserta la misma fila `AuthSession` que escribe `login()` (la base
sólo guarda el SHA-256 del token). Sin `PREVIEW_STORAGE_STATE` la suite visual se salta entera, así que
`npm run test:e2e` en una laptop sin nada levantado no se pone en rojo.

Al automatizar 1024 y 768 apareció **un defecto real que 1366 y 390 no podían ver**: en el visor de procesos
(`/app/admin/control-tower/neural/procesos`), a 768 px la app ya está en su superficie móvil pero con ancho de
tableta, así que la rejilla `.neural-mini-grid` reparte varias pistas de 11 rem y el nodo del paso —que lleva el
ancho fijo del lienzo, 13,75 rem— se salía de su pista (206 px de contenido en una caja de 168) y sus insignias
quedaban fuera de la caja sin barra para alcanzarlas. A 1366 la lista móvil ni siquiera se dibuja y a 390 la rejilla
es de una sola columna más ancha que el nodo, por eso pasaba en los dos anchos que sí estaban automatizados.
Corregido en `src/styles/operations/neural-ops.css` (la celda de la rejilla y el nodo dentro de ella se encogen:
`min-width: 0` y `width: auto`); verificado con la suite en rojo contra el build anterior y en verde contra el nuevo.

**PENDIENTE PRODUCCIÓN** (PENDIENTE DE VALIDACIÓN MANUAL — nada de esto se ha hecho con datos reales):

Acceso y navegación

- [ ] Con un usuario de cada área (no super admin), abrir `/app/areas/{su área}`: ve sus cinco pestañas y **no** ve
      las de las demás áreas en el menú lateral.
- [ ] Un chofer con `logistics.drive` y sin `logistics.view` abre `/app/areas/logistica/chofer` (ya no da 404) y
      **no** puede abrir panel, centro de trabajo ni comunicaciones de Logística.
- [ ] `operations.admin` abre la Torre de Control; comprobar que los importes y los datos de contacto del grafo
      siguen enmascarados si no tiene además `finance.view` / `customers.view`, y decidir si eso es lo que se quiere.
- [ ] **La misma máscara ya se aplica al detalle de una fila del centro de trabajo** (`maskRowFields`, misma tabla
      que el grafo): abrir el cajón de una orden de compra con una cuenta que tenga `purchases.view` pero **no**
      `finance.view` y comprobar que el «Total» dice «Importe oculto (requiere Contabilidad)» en vez del número, y
      que el teléfono/correo del proveedor y el contacto de una entrega piden `customers.view`. **Decisión
      pendiente:** si el área debe ver sus propios importes sin `finance.view`, se concede esa llave a los roles del
      área (o se cambia la regla en `graph-mask.MASK_RULES`, que es la única tabla). El nombre del cliente o del
      proveedor **no** se enmascara.
- [ ] `operations.admin` **sí** actúa sobre una excepción (reasignar / escalar / cerrar), igual que
      `operations.manage` y que la persona responsable de la fila: es el permiso con el que el plan abre la Torre
      (7.7) y el motor lo acepta desde `OPERATIONS_OPERATOR_PERMISSIONS`. Comprobar con una cuenta que tenga
      **sólo** `operations.admin` que el botón responde 200 y no 403, y con una que tenga sólo `operations.view`
      que no se le ofrece ninguno.
- [ ] Recalcular las proyecciones desde `/resumen` → tarjeta «Proyecciones e IA» → «Reconstruir» (encolado) y,
      una vez, marcando «Esperar el resultado»: debe decir qué escribió cada proyección y bajar el `stale`.

La experiencia con datos reales

- [ ] Abrir el panel de las seis áreas con el volumen real y comparar cada uno de los 8 tiles contra lo que la gente
      del área cree que es cierto. El cálculo más pesado es «ubicaciones sin conteo > 30 d» de Inventario.
- [ ] Centro de trabajo de cada área: filtrar, ordenar, guardar una vista **con filtros propios del área** (esto
      reventaba antes de esta entrega), compartirla y exportar.
- [ ] Ejecutar una acción por fila de cada área y confirmar en `OperationalCommand` que se registró una sola vez;
      repetirla desde dos pestañas debe dar `replayed`.
- [ ] Expediente 360 de un expediente real: fases, siguiente paso, necesidades con su confianza de inventario,
      entrega, evidencias y cronología; abrirlo desde una notificación y desde una tarjeta del chat.
- [ ] Comprobar la regla de acceso al expediente: alguien que no es miembro de la sala ni participante ve el aviso
      de «no tienes acceso», no una página vacía.
- [ ] Comunicaciones de un área: el canal existe, las solicitudes se pueden aceptar/bloquear/responder y la bandeja
      externa muestra sólo las cuentas del área.
- [ ] **Antes de revisar la pestaña «Externos»: marcar el equipo del área en cada canal.** El arranque crea los seis
      roles `equipo_<área>` (`ensureAreaTeamRoles`, `src/modules/areas/area-teams.ts`) porque el registro los declara
      en `comms.inboxTeamKeys`, pero **no asigna ningún canal**: en `/app/admin/comms` → pestaña **Canales**, editar
      cada número de WhatsApp / SMS / Telegram y marcar el equipo que lo atiende (`equipo_ventas`, `equipo_compras`,
      …). Sin ese paso la pestaña «Externos» del área abre vacía —lo dice la propia pantalla— aunque la bandeja
      general sí tenga conversaciones. Asignar además el rol a las personas del área (`/app/admin/access` → Roles),
      que es lo que las deja ver esas conversaciones junto con `inbox.use`.
- [ ] Torre de Control → Configuración: cambiar un indicador y confirmar que el aviso describe lo que dejará de
      pasar; crear una `ApprovalPolicy` y comprobar que la **vista previa** nombra a las personas correctas.

Móvil y campo (con teléfonos reales, no emulador)

- [ ] `/app/areas/{área}/trabajo` en un teléfono: tarjeta de siguiente acción, acción primaria a un toque, barra
      inferior sin tapar contenido y sin scroll horizontal.
- [ ] **Escanear una etiqueta QR impresa** con teléfono y con pistola lectora: el codificador de QR es propio y
      **nunca se ha escaneado**; hacerlo antes de imprimir un lote (el componente ya imprime el texto como respaldo).
- [ ] Contar una ubicación real de punta a punta: iniciar conteo → capturar líneas → cerrar → ver la promoción a
      `CONTROLLED` o la disputa.
- [ ] Capturar una nota de evidencia **sin señal** y confirmar que se envía sola al volver la conexión.
- [ ] PWA de chofer: viaje del día, llegar a una parada, registrar una entrega con foto y una fallida sin señal.

Zoho y lo externo (nada de esto se ha probado contra la organización real)

- [ ] Asignar transportista a una entrega y ver el espejo en Zoho; provocar un desacuerdo y comprobar que la entrega
      queda en `conflict` con su pastilla y aparece en «Entregas en conflicto» de la Torre.
- [ ] Crear una orden de venta desde una cotización aceptada (`crm.create_sales_order` + indicador
      `crmSalesOrderWrite`).
- [ ] Enviar una RFQ real por plantilla aprobada de WhatsApp y confirmar que la respuesta se interpreta.

Rendimiento y frescura

- [ ] Medir el grafo de la Torre a profundidad 3 con el volumen real; si se pone lento, revisar índices de
      `ObjectRelation` antes de subir topes.
- [ ] Confirmar las dos cadencias: `areas.dashboard_refresh` (5 min) para los paneles y el resumen de la Torre, y
      `ct.projections_refresh` (15 min) para variantes/cuellos/traspasos/causas; que la frescura que muestra la
      pantalla coincida con la realidad.
- [ ] Revisar los topes con datos reales: mapa de inventario 500 ubicaciones, `listVariants` 5 000 expedientes,
      exportaciones 2 000 filas, grafo 500 nodos dibujados.

**Defectos reales encontrados en esta pasada visual y ya corregidos** (útiles como regresión):

- Dos errores de hidratación que tiraban y volvían a dibujar árboles enteros en el cliente: dnd-kit numeraba sus ids
  de accesibilidad con un contador de módulo (afectaba a **todas** las tablas `EntityWorkspace`, incluidas las de
  Zoho) y `VoiceDictationButton` decidía si existir con `typeof window` durante el render (afectaba al copiloto, al
  asistente y a los compositores de chat).
- El presupuesto diario del Laboratorio de Sourcing liberaba y cobraba contra el día equivocado cuando una búsqueda
  cruzaba la medianoche UTC, así que la reserva no se devolvía nunca.
- Guardar una vista del centro de trabajo con un filtro propio del área lanzaba un ZodError crudo.
- Un chofer con `logistics.drive` recibía 404 en su propia PWA.
- En teléfono, las pastillas de filtro se encimaban con su etiqueta y las migas se reducían a una fila de «/».
- En «Mi trabajo» cada renglón medía ~300 px porque los cinco botones de acción se apilaban uno por línea.

### 11.9 Entrega 3 — Compras y Sourcing (backend + área Compras)

Las cuatro áreas de dominio (§11.9 a §11.12) comparten una limitación de la capa de IA que conviene tener presente
al revisarlas: el turno **automático** de cada identidad recibe una lista corta de tools (de tres a cinco por área,
`src/modules/agents/tool-allowlist.ts`) para que el prompt quepa y el prefijo se cachee. El resto de las tools del
módulo existen y funcionan, pero sólo desde el asistente o el copiloto de una persona.

**IMPLEMENTADO:** `src/modules/purchases/` — proveedores con productos, evaluaciones y calificación
(`supplier-rating`), solicitudes de compra con consolidación por `consolidationKey` (`zohoItemId|semana ISO`), RFQ
completa (crear, invitar, registrar envíos, interpretar la respuesta del proveedor con el modelo utilitario,
comparar con puntaje, seleccionar, expirar), órdenes de compra con doble firma desde el umbral configurado
(aprobación de negocio `procurement` → `purchases.approve`), solicitud de pago que abre la obligación en
Contabilidad (`finance-bridge.ts` → aprobación `payment`), envío al proveedor, asignaciones exactas a la necesidad
del expediente o a reposición, recepciones con diferencias y entrega directa al cliente, y el Laboratorio de
Sourcing (búsqueda con presupuesto diario de unidades, `robots.txt`, hosts permitidos, caché, dedupe, candidatos y
promoción a proveedor). Configuración propia en `IntegrationConfig('sourcing')` (requiere
`operations.admin`). Jobs: `purchases.sourcing_search`, `purchases.rfq_interpret`, `purchases.shortfall_sync`,
`purchases.order_followup`, `purchases.direct_delivery_sync` (por evento) y `purchases.consolidate_suggest` (24 h) y
`purchases.rfq_expire` (1 h, que además reconcilia invitaciones a medio enviar y limpia el acelerador de sourcing).
Área Compras en `/app/areas/compras` (panel, centro de trabajo, comunicaciones, Laboratorio de sourcing y
subpáginas de órdenes, cotizaciones y proveedores) y tools de IA en `src/modules/ai/tools/procurement-tools.ts`
(`purchases-tools.ts` sigue siendo el de las órdenes de compra de Zoho, de sólo lectura). Todo el módulo se apaga
con el indicador `purchases` de `IntegrationConfig('operations')`. Detalle en `docs/modules/purchases.md`.

Permisos nuevos (grupo **Compras** en /app/admin/access → Roles; `super_admin` los tiene por omisión):

| Llave                        | Qué abre                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `purchases.view`             | Ver el área: solicitudes, cotizaciones, órdenes, recepciones, proveedores y el laboratorio     |
| `purchases.manage_suppliers` | Alta y edición de proveedores, sus productos y evaluaciones; promover un candidato de sourcing |
| `purchases.request`          | Crear, cancelar y consolidar solicitudes de compra                                             |
| `purchases.manage_orders`    | Cotizar, crear/enviar/asignar/cancelar/cerrar órdenes de compra y solicitar su pago            |
| `purchases.approve`          | Firmar la aprobación de negocio `procurement` (doble firma desde el umbral)                    |
| `purchases.receive`          | Registrar recepciones, entregas directas del proveedor y resolver diferencias                  |
| `purchases.sourcing`         | Correr búsquedas del Laboratorio de Sourcing y trabajar los candidatos                         |
| `purchases.export`           | Exportar los listados del área                                                                 |

**VALIDADO LOCALMENTE:** `vitest --project unit` de `src/modules/purchases` (reglas puras de solicitudes, RFQ,
puntaje, normalizador de unidades, dedupe de sourcing, `robots.txt`, calificación de proveedor y estados de orden,
más los flujos con `FakePrisma`). Contra PostgreSQL desechable: `tests/integration/compras-work-rows.int.test.ts`
(las cinco ramas SQL del centro de trabajo) y los escenarios de Compras de
`tests/integration/domains-scenarios.int.test.ts` (faltante → solicitud → orden con doble firma → autorización de
pago → recepción parcial con diferencia → reserva → avance del expediente; entrega directa del proveedor; y
proveedor retrasado: lo esperado nunca cuenta como disponible y la orden aparece vencida).

**PENDIENTE PRODUCCIÓN** (PENDIENTE DE VALIDACIÓN MANUAL):

- [ ] Asignar los ocho permisos de la tabla de arriba. Ojo: **la doble firma necesita dos personas distintas** con
      `purchases.approve`; con una sola, las órdenes sobre el umbral se quedan esperando.
- [ ] Revisar en Torre de Control → Configuración el umbral `procurementDoubleApprovalMxn` (hoy $50,000 MXN) y el
      indicador `purchases`.
- [ ] Confirmar que existe `Responsible` activo (con suplente) del área `compras`: es quien recibe las solicitudes
      de faltante y aprueba las propuestas de su IA.
- [ ] Configurar el Laboratorio de Sourcing (`IntegrationConfig('sourcing')`, necesita `operations.admin`): hosts
      permitidos, conexión con la llave de Brave Search (o la extensión MCP de Brave), presupuesto diario de
      unidades, `cacheTtlDays` y `maxPagesPerSearch`. **Con la lista de hosts vacía no se consulta ningún catálogo.**
- [ ] Configurar el envío a proveedores: cuenta de bandeja (`rfqAccountId`), plantillas **aprobadas** de WhatsApp
      para RFQ y para orden de compra (`rfqTemplateKey`, `orderTemplateKey`), textos editables y nombre de la
      empresa. Sin plantilla aprobada, UNIK sólo escribe dentro de la ventana de 24 h; una invitación fuera de esa
      ventana no se envía (no se pierde: queda registrada como fallida).
- [ ] Primer ciclo real: un faltante confirmado en un expediente abre la solicitud a Compras y
      `purchases.shortfall_sync` crea la solicitud de compra con la necesidad ligada.
- [ ] **RFQ real por WhatsApp con plantilla aprobada** (nunca probado fuera de mocks) y confirmar que la respuesta
      del proveedor se interpreta; **leer la interpretación contra el mensaje original** antes de confiar en la
      comparación: la lee el modelo utilitario, no una regla.
- [ ] Orden sobre el umbral: dos firmas; orden con pago anticipado: se crea la obligación en Contabilidad y la
      autorización `payment` aparece en «Mi trabajo» de quien tiene `finance.approve`.
- [ ] Recepción parcial con diferencia: incidencia `purchase_difference`, trabajo «Resolver la diferencia» y lo
      recibido reservado para la necesidad que lo pidió (no para el inventario libre).
- [ ] Entrega directa al cliente: `purchases.direct_delivery_sync` crea la orden de entrega en Logística con la
      evidencia del proveedor.
- [ ] Ver correr los dos recurrentes: `purchases.consolidate_suggest` (24 h, abre el trabajo con las solicitudes del
      mismo artículo y semana) y `purchases.rfq_expire` (1 h).
- [ ] Sourcing con datos reales: una búsqueda respeta `robots.txt` y el presupuesto; un candidato promovido no
      duplica un proveedor existente; **un candidato no recibe mensajería sin consentimiento `opted_in`** (se le
      contacta por teléfono o correo, o después de promoverlo).
- [ ] Limitación conocida a decidir con Israel: las filas de dominio del centro de trabajo de Compras **no traen
      botones de acción** (las de Inventario, Logística, Manufactura y Contabilidad sí). Hoy la ficha de la orden,
      la comparación de la RFQ y la del proveedor se ven en **sólo lectura**: registrar una recepción, enviar al
      proveedor o pedir el pago se hace por el endpoint de comandos (`POST /app/operations/api/commands`), no desde
      la pantalla. Falta el punto de extensión `DetailExtras` del registro de áreas; la lógica ya existe y está
      probada.

### 11.10 Entrega 5 — CRM y Radar de Cierre (+ área Ventas completa)

**IMPLEMENTADO:** `src/modules/crm/` — embudo con etapas configurables (se siembran solas al primer uso y se editan
con `crm.manage_stages`), oportunidades creadas desde una conversación, una llamada, una cotización o a mano, con
línea de tiempo, actividades, vínculo a cotizaciones y órdenes de venta y cierre ganada/perdida/dormida; panel CRM
dentro de la bandeja (`ConversationCrmPanel`); creación de la orden de venta en Zoho desde una cotización aceptada
(`sales-order-write-service.ts`: ledger idempotente por `requestKey`, relectura en job y incidencia
`sales_order_readback_mismatch` cuando Zoho devuelve algo distinto); Radar de Cierre con ocho reglas puras
(`no_first_reply`, `no_followup`, `quote_expiring`, `next_action_overdue`, `objection_open`, `high_intent`,
`repurchase_overdue`, `delivery_incident`), explicación y mensaje sugerido por la IA de Ventas con su presupuesto, y
posponer / descartar / convertir en tarea. Jobs: `crm.quote_changed` (5 min), `crm.radar_refresh` (15 min),
`crm.radar_explain` (24 h), más `crm.conversation_touch`, `crm.sales_order_readback` y `crm.link_cases` por evento.
Área Ventas en `/app/areas/ventas` (panel, centro de trabajo, comunicaciones, Radar de cierre, embudo y
oportunidades) y tools de IA en `src/modules/ai/tools/crm-tools.ts`. Se apaga con el indicador `crm`; la escritura
a Zoho tiene además el suyo, `crmSalesOrderWrite`, que **nace apagado**. Detalle en `docs/modules/crm.md`.

Permisos nuevos (grupo **Ventas / CRM**):

| Llave                    | Qué abre                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `crm.view`               | Embudo, oportunidades con su línea de tiempo y el panel CRM de las conversaciones          |
| `crm.manage`             | Crear y editar oportunidades, mover etapas, registrar actividades, marcar ganada o perdida |
| `crm.manage_stages`      | Crear, renombrar, reordenar y desactivar etapas del embudo                                 |
| `crm.create_sales_order` | Convertir una cotización aceptada en orden de venta de Zoho desde UNIK                     |
| `crm.radar`              | Ver el radar, pedir la explicación a la IA, posponer, descartar o convertir en tarea       |
| `crm.export`             | Exportar oportunidades y señales                                                           |

No existe `crm.approve`: en el área Ventas **firma quien tiene `crm.manage`** (las decisiones comerciales no llevan
aprobador aparte). Para entrar al área basta `crm.view` **o** `sales_orders.view`, pero el embudo y el radar exigen
sus llaves propias.

**VALIDADO LOCALMENTE:** `vitest --project unit` de `src/modules/crm` (una prueba por regla del radar, reglas del
embudo, ledger de la escritura de orden de venta, servicio de oportunidades y radar con `FakePrisma`). Contra
PostgreSQL desechable: `tests/integration/ventas-area.int.test.ts` (ramas SQL del centro de trabajo y panel) y el
escenario de CRM de `domains-scenarios.int.test.ts` (cotización aceptada → orden de venta en Zoho **mock** → un solo
expediente aunque se reintente la conversión).

**PENDIENTE PRODUCCIÓN** (PENDIENTE DE VALIDACIÓN MANUAL):

- [ ] Asignar los seis permisos de la tabla. `crm.create_sales_order` sólo a quien deba escribir en Zoho.
- [ ] Revisar las etapas sembradas del embudo (nombres, orden y probabilidad) con el equipo comercial antes de
      capturar oportunidades: siempre tiene que quedar al menos una etapa activa abierta, una ganada y una perdida.
- [ ] Confirmar que el panel CRM aparece en la bandeja para quien además tiene acceso a esa cuenta de la bandeja.
- [ ] **Antes de encender `crmSalesOrderWrite`:** validar contra la organización real de Zoho el juego de campos de
      `POST /inventory/v1/salesorders` (cliente, almacén, lista de precios, impuestos, unidades). Mientras siga
      apagado, la conversión funciona sólo contra el mock.
- [ ] Ya encendido: convertir **una** cotización aceptada real, comprobar que la orden aparece una sola vez en Zoho,
      que la relectura coincide y que se abre un único expediente. Reintentar la conversión no debe duplicarla.
- [ ] Provocar un desacuerdo (editar la orden en Zoho antes de la relectura): incidencia
      `sales_order_readback_mismatch` con trabajo para Ventas.
- [ ] Revisar la lista del radar contra una revisión manual de la semana: cada señal debe ser algo que el vendedor
      reconozca. Las ocho reglas son deterministas; sólo la explicación usa IA.
- [ ] Confirmar el reparto: quien tiene `crm.radar` ve **sus** señales y las no asignadas; quien tiene `crm.manage`
      ve las de todos.
- [ ] Ver correr `crm.radar_refresh` (15 min) y `crm.radar_explain` (24 h). Si la IA de Ventas está en pausa o sin
      presupuesto, la explicación se salta y el radar sigue: comprobarlo bajando el presupuesto a propósito.
- [ ] Revisar la categoría de notificación `radar_signal` (llega a la app; el push viene apagado) y decidir si se
      enciende.

### 11.11 Entrega 6 — Manufactura (+ área Manufactura)

**IMPLEMENTADO:** `src/modules/manufacturing/` — centros de trabajo con capacidad por turno, listas de materiales
opcionales con borrador → activa → retirada, órdenes de producción (transformación por omisión, o desde una BOM, o
creadas desde una solicitud de otra área por `manufacturing.intake_request`), programación con carga por turno,
reserva de materiales con reintento cuando llega el material (`manufacturing.retry_blocked`), preparación,
operaciones con inicio/pausa/fin, consumos, salida de producto terminado, **sobrante** y merma, inspección de
calidad que ordena retrabajo al fallar, sustituciones fuera de la lista y merma fuera de tolerancia por aprobación
de negocio (`production_incident` → `manufacturing.approve_incidents`), liberación con balance de materiales y
cancelación. Job recurrente `manufacturing.capacity_alerts` (1 h) que abre un pendiente por centro y turno
sobrecargado. Área Manufactura en `/app/areas/manufactura` con tablero de planta, órdenes y sus paneles de plan,
materiales y calidad (estos sí interactivos, con acciones por fila) y tools de IA en
`src/modules/ai/tools/manufacturing-tools.ts`. Se apaga con el indicador `manufacturing`. Detalle en
`docs/modules/manufacturing.md`.

Permisos nuevos (grupo **Manufactura**):

| Llave                             | Qué abre                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `manufacturing.view`              | Órdenes, tablero de planta, carga por turno, centros y listas de materiales           |
| `manufacturing.manage_boms`       | Centros de trabajo y listas de materiales (crear, editar, activar, retirar)           |
| `manufacturing.manage_orders`     | Crear, programar, reservar material, preparar, liberar y cancelar órdenes             |
| `manufacturing.operate`           | Iniciar/pausar/terminar operaciones y registrar consumos, terminado, sobrante y merma |
| `manufacturing.inspect`           | Inspecciones de calidad (una falla ordena retrabajo)                                  |
| `manufacturing.approve_incidents` | Firmar la aprobación `production_incident` y liberar con diferencia de balance        |

No existe `manufacturing.approve`: el aprobador del área es **`manufacturing.approve_incidents`**.

**VALIDADO LOCALMENTE:** `vitest --project unit` de `src/modules/manufacturing` (estados de producción, reglas de
merma y de capacidad, flujo completo y endurecimiento con `FakePrisma`). Contra PostgreSQL desechable:
`tests/integration/manufactura-work-rows.int.test.ts` (ramas SQL y catálogo de acciones por fila, incluido que una
operación apunta su comando a la orden y no a sí misma) y los dos escenarios de Manufactura de `domains-scenarios.int.test.ts`
(transformación con merma dentro y fuera de tolerancia).

**PENDIENTE PRODUCCIÓN** (PENDIENTE DE VALIDACIÓN MANUAL):

- [ ] Asignar los seis permisos de la tabla. Separar de verdad `operate` de `approve_incidents`: quien produce no
      debería autorizar su propia merma.
- [ ] Dar de alta los **centros de trabajo** con su capacidad por turno antes de programar nada: sin centros, la
      carga y las alertas de capacidad no dicen nada.
- [ ] Definir la **bodega de salida** de las órdenes (es obligatoria) y comprobar que el producto terminado y el
      sobrante entran a inventario ahí.
- [ ] Decidir qué artículos llevan lista de materiales: la BOM es opcional y la orden de transformación por omisión
      funciona sin ella. Activar una BOM real y comprobar que la orden toma sus partidas y operaciones.
- [ ] Una **orden de corte real** de punta a punta: crear → programar → reservar material → preparar → operar →
      registrar consumo, terminado, sobrante y merma → inspeccionar → liberar. Producido + consumido + sobrante +
      merma tienen que cuadrar y ser trazables a la materia prima y a la venta.
- [ ] Confirmar que **el sobrante queda vendible** (existencia en la bodega de salida, no una nota suelta).
- [ ] Merma fuera de tolerancia y sustitución fuera de la lista: ambas abren la aprobación `production_incident` con
      incidencia (`excess_scrap`, `production_substitution`) y no avanzan sin firma. Revisar la tolerancia
      configurada antes de producir en serie.
- [ ] Una inspección fallida ordena el retrabajo (`quality_failure`) y la orden no se libera.
- [ ] Una orden bloqueada por falta de material se desbloquea sola cuando entra la compra
      (`manufacturing.retry_blocked`).
- [ ] Ver correr `manufacturing.capacity_alerts` (1 h) y ajustar el horizonte si abre demasiados pendientes.

### 11.12 Entrega 7 — Contabilidad interna (+ área Contabilidad)

**IMPLEMENTADO:** `src/modules/finance/` — libro de partida doble inmutable (se corrige **sólo por reverso**),
cuentas de caja y banco, categorías y centros de costo por área (catálogo que se siembra solo la primera vez que
algo lo necesita: `caja_general`, `banco_zoho` y las categorías base), captura rápida de gastos por formulario,
texto, voz o foto con propuesta de campos por IA e historial, detección de duplicados, aprobación por umbral
(`expenseAutoApproveMxn`, hoy $2,000 MXN) y contabilización, obligaciones por pagar y cobrar con antigüedad,
liquidaciones, cancelación y castigo, conciliación de los pagos de clientes de Zoho contra las cuentas por cobrar
(un pago puede repartirse entre varias obligaciones; la llave de idempotencia es
`externalRef = zoho_payment:{id}:{obligationId}`), nómina con directorio de empleados, anticipos y corridas,
presupuestos contra real, y cierres diario y mensual con reapertura con motivo. Aprobaciones de negocio `expense`,
`payment` y `payroll`, todas con `finance.approve`. Jobs: `finance.expense_propose` (por evento),
`finance.recurring_expenses` (24 h), `finance.reconcile_collections` (30 min), `finance.obligations_due` (1 h) y
`finance.daily_close_reminder` (24 h); ninguno hace nada con el indicador `finance` apagado. Área Contabilidad en
`/app/areas/contabilidad` con Libro de caja, gastos (y captura), obligaciones, nómina, cierre, presupuestos y
catálogos, y tools de IA en `src/modules/ai/tools/finance-internal-tools.ts` (`finance-tools.ts` sigue siendo el de
las cuentas por cobrar y pagar de Zoho). Configuración propia en `IntegrationConfig('finance')`. Detalle en
`docs/modules/finance.md`.

Permisos nuevos (grupo **Contabilidad**):

| Llave                        | Qué abre                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `finance.view`               | Libro de caja, asientos, obligaciones, gastos, nómina, presupuestos y cierres     |
| `finance.capture_expense`    | Capturar gastos (formulario, texto, voz, foto), editar sus borradores y enviarlos |
| `finance.approve`            | Firmar las aprobaciones `expense`, `payment` y `payroll`                          |
| `finance.post`               | Contabilizar gastos aprobados y asientos manuales, y corregir por reverso         |
| `finance.manage_obligations` | Crear, liquidar, cancelar y castigar obligaciones y pedir autorizaciones de pago  |
| `finance.payroll`            | Directorio de empleados, corridas de nómina, anticipos y pagos de nómina          |
| `finance.close`              | Cierres diario y mensual y reapertura con motivo                                  |
| `finance.manage_catalog`     | Cuentas, categorías, centros de costo, presupuestos y plantillas compartidas      |
| `finance.export`             | Exportar renglones del libro y reportes                                           |

**VALIDADO LOCALMENTE:** `vitest --project unit` de `src/modules/finance` (reglas del libro, duplicados de gasto,
reglas de gasto, obligaciones, nómina, cierre, emparejador de cobros, fechas y dinero, más los flujos con
`FakePrisma`). Contra PostgreSQL desechable: los escenarios de Contabilidad de
`tests/integration/domains-scenarios.int.test.ts` (gasto duplicado, resolución y aprobación; un pago de Zoho
repartido entre dos cuentas por cobrar; y la IA caída, que degrada la propuesta a reglas sin detener el gasto).

**PENDIENTE PRODUCCIÓN** (PENDIENTE DE VALIDACIÓN MANUAL):

- [ ] Asignar los nueve permisos de la tabla. Separar `capture_expense` (mucha gente) de `approve` y `post` (pocas),
      y `close` de ambas.
- [ ] Revisar el **catálogo sembrado** en Contabilidad → Catálogos: cuentas `caja_general` y `banco_zoho`,
      categorías y un centro de costo por área. Renombrar lo que no corresponda **antes** de capturar gastos: la
      contabilización posterior no se puede editar, sólo reversar.
- [ ] Confirmar en `IntegrationConfig('finance')` la cuenta que recibe los cobros de Zoho
      (`collectionsCashAccountKey`, por omisión `banco_zoho`), los días de aviso de vencimiento, la ventana de
      conciliación y el recordatorio de cierre diario.
- [ ] Revisar el umbral de autoaprobación de gastos (`expenseAutoApproveMxn`, hoy $2,000 MXN) en Torre de Control →
      Configuración, y el indicador `finance`.
- [ ] La conciliación de cobros lee los **pagos de cliente normalizados de Zoho**: confirmar que su sincronización
      está encendida, si no `finance.reconcile_collections` no encuentra nada que emparejar.
- [ ] Capturar un gasto real por foto y por voz: la propuesta de campos es de la IA — **revisarla** antes de
      aprobar. Sin proveedor de IA la captura sigue funcionando en manual.
- [ ] Capturar dos veces el mismo gasto: se detecta el duplicado y no se contabiliza dos veces.
- [ ] Un pago de Zoho que liquida **dos** cuentas por cobrar se reparte solo; uno cancelado o reducido en Zoho abre
      el pendiente de revisión en vez de corregir en silencio.
- [ ] Un **mes cerrado real**: cerrar el periodo, comprobar que ningún asiento se modifica después, hacer una
      corrección por reverso y reabrir con motivo dejando rastro.
- [ ] Una corrida de nómina real con anticipos, con su aprobación `payroll` y su pago.
- [ ] Presupuesto contra real de un mes con datos reales: comparar contra lo que el área cree que gastó.
- [ ] Ver correr los cuatro recurrentes (`finance.recurring_expenses` 24 h, `finance.reconcile_collections` 30 min,
      `finance.obligations_due` 1 h, `finance.daily_close_reminder` 24 h) y revisar que las notificaciones
      `finance_alert` llegan a quien corresponde y no en avalancha.

### 11.13 Entrega 8 — Torre de Control completa, UNIK Neural Operations e IA administradora

La columna «Verifica Israel» de esta entrega en la tabla de la sección 8 del plan pide dos cosas que **sólo se
pueden hacer con datos reales**: _«Revisar una venta real completa en la reproducción; validar conformidad contra lo
que ocurrió»_. Hasta ahora esas dos verificaciones no estaban en ninguna casilla: la §11.8 dice qué se implementó y
qué se vio en el navegador, pero lo que se vio fue la base de vista previa sembrada con cinco expedientes
inventados, que no prueba nada sobre si la reproducción cuenta bien una venta que sí pasó.

**IMPLEMENTADO** (detalle en `docs/modules/control-tower.md`): las siete pestañas de `/app/admin/control-tower`
(`resumen`, `personas`, `excepciones`, `aprobaciones`, `auditoria`, `configuracion` y `neural/{herramienta}`), las
proyecciones incrementales por marca de agua (`variants`, `step_metrics`, `handoffs`, `block_causes`) con el job
`ct.projections_refresh` cada 15 min, el grafo temporal (`queryOperationalGraph`, profundidad ≤3, tope 2 000 nodos
del servidor y 500 dibujados) con perspectivas, escenas y deslizador de instante, y las cinco herramientas Neural:
`procesos`, `variantes`, `grafo`, `replay` y `simulacion`.

**PENDIENTE PRODUCCIÓN** (PENDIENTE DE VALIDACIÓN MANUAL). Nada de esto se puede dar por bueno con la base de
vista previa: todas las casillas piden **una venta real que ya ocurrió**.

- [ ] Asignar `operations.admin` a quien vaya a abrir la Torre. Ojo con lo que **no** levanta: los importes del
      grafo siguen enmascarados sin `finance.view` y los datos de contacto sin `customers.view` (`maskNode`). Si
      dirección tiene que ver importes en el grafo, hay que darle además `finance.view` — es una decisión, no un
      descuido.
- [ ] Antes de mirar cualquier número: correr el recálculo total desde `/resumen` → «Proyecciones e IA» →
      `ProjectionsRebuildButton` con **«Esperar el resultado» marcado** (es la única forma de ver _cuál_ proyección
      falló; sin marcar encola y contesta 202). Confirmar que `GET /api/projections/rebuild` devuelve `stale:false`
      y un `minutesAgo` bajo para las cuatro.
- [ ] **Reproducción de una venta real de punta a punta** (la casilla textual del plan): elegir un expediente ya
      cerrado, abrir `neural/replay`, recorrer la línea de tiempo completa y contrastarla con lo que de verdad pasó
      —preguntando a quien la atendió, no sólo leyendo la pantalla—. Tienen que cuadrar: responsables en cada paso,
      esperas (dónde se detuvo y cuánto), decisiones y quién las firmó, documentos/evidencias e incidencias.
      Cualquier dato que la persona recuerde y la reproducción no muestre es un hueco de `REPLAY_PAYLOAD_KEYS`
      (la bitácora que viaja al navegador lleva el payload recortado a 21 llaves; lo que `foldCaseState` no lee,
      no se ve, **y no avisa**).
- [ ] **Conformidad contra lo ocurrido** (la segunda casilla textual del plan): en `neural/variantes`, comparar el
      camino real de esa misma venta contra el proceso definido. Si la conformidad sale 100 % pero la gente cuenta
      que hubo retrabajo o saltos, el que está mal es el cálculo (o el blueprint), no la operación.
- [ ] `neural/procesos`: confirmar que el proceso dibujado es el que la operación cree tener. Es el único de los
      cinco que no depende de datos reales, así que es el primero que se revisa.
- [ ] `neural/grafo` con volumen real: medir el p95 a profundidad 3 (el plan exige **< 500 ms** y escena
      ≤ 2 000 nodos). Nunca se ha medido con volumen: la base de prueba está prácticamente vacía. Revisar también
      cuántas veces el servidor contesta `truncated` y cuántas la pantalla avisa que recortó a 500.
- [ ] `neural/simulacion`: correr un retraso y una pérdida de capacidad de un área sobre datos reales y enseñarle
      el resultado a esa área. Si no reconocen el escenario, la simulación no sirve para decidir.
- [ ] Revisar que las **causas por producto** de `neural/variantes` no salgan vacías: `blockCauseProductSql` exige
      que `AreaRequest.payload` traiga `sku` y `productName`. Un módulo que escriba otras llaves las vacía en
      silencio.
- [ ] Contrastar los **días** de las proyecciones: son días **UTC**, no días civiles de Ciudad de México. Con una
      venta real de la tarde/noche los números de «hoy» no van a cuadrar con lo que el área cree. Decidir si se
      cambia (se decide en `projections-service.ts`, no en la UI) **antes** de que dirección tome decisiones con
      esos números.
- [ ] Digest administrativo y alertas: ver llegar el digest diario al canal de Administración y provocar a
      propósito una alerta de integración (`sync_stale` con una entidad de Zoho callada > 120 min, o
      `sync_failing`) para confirmar que la tarjeta de salud la pone primero y que alguien la ve.
- [ ] Consumo de IA por área en la Torre contra el consumo real del proveedor: que cuadren, o el presupuesto por
      agente está midiendo otra cosa.
- [ ] Auditoría: confirmar que los `targetType` de los objetos que de verdad se auditan están en
      `AUDIT_TARGET_TYPES`; un módulo que audite con un tipo nuevo **no se ve** en la pestaña hasta que se agregue.

### 11.14 Exclusividad del proyecto `integration` (por qué la puerta parecía rota)

Las suites de `tests/integration` comparten **una** base desechable y cada una la deja limpia con `TRUNCATE` sobre
la lista de tablas del programa más `DELETE` por prefijo (`it_`, `it-`). Dentro de una corrida eso es seguro porque
el proyecto usa `fileParallelism: false`. **Entre corridas no lo era.** Dos `npm run test:integration` al mismo
tiempo —dos terminales, dos agentes, CI y local— se borran las filas mutuamente, y el resultado no se parece a un
conflicto sino a un defecto del producto:

- `deadlock detected` (PostgreSQL `40P01`) cuando el `TRUNCATE` de una corrida pide `AccessExclusiveLock` sobre una
  tabla mientras la otra ya tiene `AccessShareLock` sobre otra de la misma lista;
- `Unique constraint failed on the fields: (area)` al sembrar `Responsible`, porque la otra corrida ya sembró;
- `Foreign key constraint violated on the constraint: Notification_userId_fkey` a media ejecución, porque la otra
  corrida borró los usuarios que la notificación estaba a punto de referenciar.

Medido el 2026-09-16 con dos corridas encima: **2 de 4 corridas en rojo** (21 y 25 pruebas fallidas), con los
fallos repartidos entre `operations-scenarios`, `domains-scenarios`, `agents-protocol` y `operations-pool` —
ninguno reproducible al correr esa suite sola. Es exactamente el síntoma que hace dudar de una entrega entera
cuando el defecto está en el arnés.

**La red:** `tests/integration/global-setup.ts` toma un candado de aviso de sesión
(`pg_advisory_lock(0x554e, 0x494b)`) sobre la base antes del primer archivo y lo suelta al terminar. La segunda
corrida **espera su turno** e imprime `Otra corrida está usando la base "…"; esperando a que libere el candado…`
en vez de corromperla. El candado es de sesión, así que una corrida que se cae lo libera sola al cerrar la
conexión. `UNIK_INTEGRATION_LOCK_TIMEOUT_MS` (15 min por omisión) acota la espera.
`tests/integration/integration-lock.int.test.ts` lo ejerce: falla si el `globalSetup` no lo tomó.

Después del arreglo: **5 corridas completas seguidas en verde** (10 archivos y 98 pruebas en ese momento) y dos
corridas lanzadas a propósito al mismo tiempo, ambas en verde — la segunda imprimió el aviso de espera y no arrancó
hasta que la primera soltó el candado. La última corrida de esa jornada, ya con las suites que otros agregaron el
mismo día: **11 archivos, 101 pruebas, todo en verde**, y la base quedó limpia (`Responsible`, `User` y
`OperationalCase` en cero).

- [ ] Esto **no** se ha probado en CI. Si el CI corre varios jobs contra la misma base, ahora se serializan: hay
      que revisar que el timeout del job sea mayor que la suma de las corridas, o darle a cada job su propia base
      con `UNIK_INTEGRATION_DATABASE_URL`.

#### 11.14.1 El otro lado: bloqueos DENTRO de una misma corrida

El candado de aviso ordena las corridas entre sí, pero no protege del bloqueo que nace **dentro** de una: el
`TRUNCATE` del `beforeEach` pide `AccessExclusiveLock` sobre decenas de tablas a la vez, y basta con que otra
conexión del mismo proceso sostenga un `AccessShareLock` sobre cualquiera de ellas —una promesa que una prueba
anterior no esperó y sigue consultando, una transacción interactiva todavía abierta— para que el `TRUNCATE` quede
esperando; si el que bloquea necesita a su vez una tabla que el `TRUNCATE` ya tomó, PostgreSQL aborta la corrida
entera con `40P01` **desde el `beforeEach`**, el reset queda a medias y las pruebas siguientes fallan con errores
que parecen del producto (`No record was found for an update`, llaves foráneas violadas justo después de crear la
fila).

La limpieza de las tres suites grandes (`operations-scenarios`, `domains-scenarios`, `agents-protocol`) pasa por
`truncateTables()` de `tests/integration/integration-db.ts`, que ejecuta el `TRUNCATE` con `SET LOCAL lock_timeout`
y reintentos: un bloqueo pasajero hace **esperar y reintentar** en vez de matar la corrida, y uno que no se suelta
nunca termina con un mensaje que nombra la causa en vez de con un interbloqueo críptico. El mismo módulo tiene la
guarda `assertDisposableDatabase()` que esas tres suites repetían copiada (comprueba `current_database()` y que
existan las tablas que la suite necesita; complementa a `assertDisposableIntegrationUrl()`, que revisa la URL antes
de conectarse).

`tests/integration/integration-db.int.test.ts` lo ejerce contra PostgreSQL real: abre una transacción que sostiene
el candado de lectura sobre la tabla, comprueba que el `TRUNCATE` **espera** y sólo termina después de que la
suelten, que un bloqueo que no se suelta falla con el mensaje explicativo, que un error que no es de bloqueo se
propaga sin reintentos, y que la guarda de base desechable nombra las tablas que faltarían.

> Regla para suites nuevas (AGENTS.md (d)): vaciar con `truncateTables()`, no con `$executeRawUnsafe('TRUNCATE …')`
> a pelo. Y **esperar el trabajo asíncrono que la prueba dispara**: un `void promesa()` que sigue escribiendo
> después del `it` es exactamente lo que deja la base bloqueada para el `beforeEach` siguiente.
