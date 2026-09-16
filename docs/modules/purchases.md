# Compras y Laboratorio de Sourcing (`src/modules/purchases/`)

Compras convierte una **necesidad** (una partida del expediente que no se cubre con existencia, o una solicitud de
otra área) en una **solicitud de compra**, la cotiza con varios proveedores por la bandeja, la vuelve **orden de
compra** con aprobación y pago, y la cierra con una **recepción** que sí entra al inventario. El Laboratorio de
Sourcing busca proveedores nuevos en la web y en catálogos autorizados cuando los de siempre no alcanzan.

Regla que gobierna todo el módulo: **el material que sólo se espera nunca aparece disponible**. Ningún estado de la
orden toca el inventario; sólo una recepción registrada crea el movimiento de entrada.

`purchase-orders/` sigue siendo el módulo de **solo lectura** de las órdenes de compra históricas de Zoho. Compras es
otra cosa: son las órdenes que UNIK emite.

Estado: implementado y validado localmente (reglas puras, servicios con FakePrisma y escenarios contra PostgreSQL
real). Migración `20260916140000_add_purchases` **no aplicada** en producción. El envío real de una RFQ por WhatsApp
con plantilla aprobada y la llave de Brave están **PENDIENTE PRODUCCIÓN** (ver `docs/pilot-runbook.md` §11.9).

## Modelos

| Modelo                                                                | Para qué                                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `Supplier` (+`SupplierProduct`, `SupplierEvaluation`)                 | Proveedor de UNIK con sus canales, condiciones de pago, calificación y catálogo aprendido. |
| `PurchaseRequest` (+`PurchaseRequestLine`)                            | Lo que hay que comprar, con su origen (expediente, solicitud de área o manual).            |
| `Rfq` (+`RfqLine`, `RfqInvitation`, `RfqResponse`, `RfqResponseLine`) | Cotización pedida a varios proveedores y sus respuestas interpretadas.                     |
| `ProcurementOrder` (+`Line`, `Allocation`)                            | Orden de compra de UNIK con su aprobación, pago, envío y asignación a necesidades.         |
| `GoodsReceipt` (+`GoodsReceiptLine`)                                  | Lo que realmente llegó, con diferencias y evidencia.                                       |
| `SourcingSearch`, `SourcingCandidate`                                 | Búsquedas del laboratorio y empresas encontradas, deduplicadas.                            |

Folios por `Sequence`: `PRV-` proveedor, `SC-` solicitud, `RFQ-` cotización, `OC-` orden, `RC-` recepción.

## Estados

- **Solicitud**: `draft` → `open` → `consolidated` → `sourcing` → `ordered` → `closed` | `cancelled`.
  Sus líneas: `open` → `ordered` → `received` | `cancelled`. El estado de la solicitud lo calculan sus líneas
  (`request-rules.ts`), nunca se escribe a mano.
- **RFQ**: `draft` → `sent` → `collecting` → `compared` → `closed` | `cancelled`.
  Invitación: `pending` → `sent` | `failed` → `replied` | `declined` | `expired`.
  Respuesta: `parsed` | `needs_review` → `confirmed` | `rejected` → `selected`.
- **Orden** (`orders-state.ts`): `draft` → `pending_approval` → `approved` → (`pending_payment` si es pago
  anticipado) → `awaiting_receipt` → `partially_received` → `received` → `closed`; `cancelled` sólo antes de
  cualquier recepción; `disputed` mientras una recepción tenga diferencia abierta.
- **Recepción**: `draft` → `posted` | `disputed`. Diferencias: `short`, `over`, `damaged`, `wrong_item`; se resuelven
  con `replacement`, `credit`, `return` o `accept`.
- **Candidato de sourcing**: `new` → `contacted` → `rfq_sent` → `quoted` → `approved` | `rejected` | `promoted`.

## Flujo

1. **Necesidad → solicitud.** El motor manda una `AreaRequest` a Compras (`purchase_shortfall`,
   `material_shortfall` o `direct_delivery`); el job `purchases.shortfall_sync` la convierte en `PurchaseRequest`
   ligada al expediente y a la partida. También se puede capturar a mano (`purchases.request`).
2. **Consolidar.** `consolidationKey = zohoItemId|semana ISO` (hora de Ciudad de México). El job
   `purchases.consolidate_suggest` (24 h) abre un trabajo cuando dos solicitudes distintas piden el mismo artículo
   en la misma semana; consolidarlas conserva la trazabilidad de cada necesidad.
3. **Cotizar (RFQ).** Se invita a varios proveedores y se les escribe por la bandeja omnicanal
   (`messaging-eligibility.ts`: WhatsApp fuera de la ventana de 24 h **exige plantilla aprobada**, y a un candidato
   del laboratorio sólo se le escribe con consentimiento `opted_in`). El hilo queda etiquetado `rfq:{rfqId}`.
4. **Interpretar la respuesta.** El job `purchases.rfq_interpret` lee el mensaje del proveedor con el modelo de
   utilidad y llena un esquema Zod (`rfq-rules.ts`). El texto del proveedor es **dato no confiable**: va envuelto en
   el prompt y nada de lo que diga dispara una acción. Si la confianza es baja queda `needs_review` para una persona.
5. **Comparar.** `rfq-scoring.ts` calcula el **costo puesto en bodega** por unidad de la RFQ (precio · unidades por
   unidad de RFQ + prorrateo de flete y otros por valor, con impuesto y tipo de cambio) y un puntaje 0–1 =
   0.50 costo + 0.25 tiempo de entrega + 0.15 (1 − riesgo) + 0.10 especificación. El riesgo sale de
   `supplier-rating.ts` (promedio ponderado de las evaluaciones con vida media de 180 días).
6. **Orden de compra.** Se crea en `draft`, se envía a aprobación (`purchases.approve`; **doble firma desde el umbral
   configurado**, $50,000 MXN por omisión y editable en administración) y, aprobada, `finance-bridge.ts` registra la
   obligación por pagar en Contabilidad. Si es pago anticipado se pide la autorización de pago (`payment`) antes de
   liberarla. La orden se manda al proveedor por WhatsApp/SMS/Telegram o como PDF, y el hilo queda etiquetado
   `oc:{orderId}`.
7. **Asignar.** Cada cantidad comprada queda asignada a una necesidad o a reposición (`ProcurementAllocation`, con
   `@@unique([orderLineId, demandId])`): no existe material comprado "para el montón".
8. **Recibir.** `purchases.receive` registra lo que llegó con foto. Una diferencia abre incidencia
   (`purchase_difference`), deja la orden `disputed` y sólo la cierra la resolución acordada con el proveedor. La
   recepción registrada crea el movimiento de entrada en inventario y libera la partida del expediente.
9. **Entrega directa del proveedor.** Cuando el material no pasa por bodega, Compras confirma la entrega y el job
   `purchases.direct_delivery_sync` la registra como entrega en Logística.

**Reparto de lo recibido cuando una partida surte a varias ventas.** El tope de cada asignación es
`receiptReservationCap` (`orders-state.ts`): lo que esa venta todavía necesita, acotado por lo que **esta partida** le
prometió **menos lo que ya le surtió antes**. Sin el segundo tope, una recepción parcial posterior volvería a darle a
la primera venta lo que estaba apartado para la segunda. Lo ya surtido se lee distinto en cada camino: en bodega, de
las reservas de stock que crearon las recepciones anteriores de la misma partida (`suppliedByOrderLine`); en entrega
directa —donde no hay reserva porque el material nunca entra— del contador `ProcurementAllocation.directDeliveredQty`,
que `confirmDirectDelivery` incrementa en la misma transacción en que arma el plan de entregas. Dentro del tope, el
reparto es FIFO por fecha prometida del expediente (`distributeFifo`).

## Comandos (`purchases-commands.ts`)

Todos pasan por `executeCommand` del núcleo (ledger, idempotencia por `commandId`, guarda de versión, eventos y jobs
en la misma transacción).

| Familia     | Comandos                                                                                                                                                      | Permiso                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Proveedores | `supplier.create/update/link_zoho/product_upsert/evaluate`, `candidate.promote`                                                                               | `purchases.manage_suppliers`                   |
| Candidatos  | `candidate.set_status`                                                                                                                                        | `purchases.sourcing`                           |
| Solicitudes | `request.create/cancel/consolidate`, `request.sync_shortfall`, `request.suggest_consolidation`                                                                | `purchases.request` (las dos últimas, sistema) |
| RFQ         | `rfq.create/invite/record_sends/reconcile_sends/record_interpretation/manual_response/confirm_response/reject_response/compare/select_response/cancel/expire` | `purchases.manage_orders`                      |
| Órdenes     | `order.create/update/submit/request_payment/mark_sent/allocate_line/cancel/close`, `order.followup_failed`                                                    | `purchases.manage_orders`                      |
| Recepciones | `receipt.record/post/resolve_difference/confirm_direct`, `receipt.sync_direct`, `receipt.direct_sync_failed`                                                  | `purchases.receive`                            |
| Sourcing    | `sourcing.search`, `sourcing.record_results`                                                                                                                  | `purchases.sourcing`                           |

## Jobs (`purchases-jobs.ts`)

| Job                              | Qué hace                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `purchases.sourcing_search`      | Corre una búsqueda del laboratorio (progreso en `job:{id}`).                        |
| `purchases.rfq_interpret`        | Lee la respuesta de un proveedor con el modelo de utilidad.                         |
| `purchases.consolidate_suggest`  | Cada 24 h: trabajo con las solicitudes del mismo artículo y semana.                 |
| `purchases.rfq_expire`           | Cada 1 h: RFQ vencidas y limpieza de las ranuras viejas del acelerador de sourcing. |
| `purchases.shortfall_sync`       | Solicitud de área por faltante → solicitud de compra.                               |
| `purchases.order_followup`       | Tras la aprobación: obligación por pagar y, si es anticipado, autorización de pago. |
| `purchases.direct_delivery_sync` | Entrega directa confirmada → orden de entrega en Logística.                         |

## Laboratorio de Sourcing

Configuración propia en `IntegrationConfig('sourcing')` (cambios con `operations.admin`, porque son hosts de salida y
credenciales): `allowedHosts` (los **únicos** dominios de los que se bajan páginas de catálogo), `braveConnectionId`,
`dailyBudgetUnits`, `cacheTtlDays`, cuenta y plantillas aprobadas de RFQ y de orden.

Reglas de legalidad, no negociables (`robots-check.ts`):

- `robots.txt` se respeta siempre (RFC 9309). Un archivo ausente (4xx) permite; uno inalcanzable (5xx o red)
  **prohíbe** hasta poder leerlo.
- Una petición cada 2 s por host como máximo (o el `Crawl-delay` si es mayor), coordinada entre instancias por
  `UsageMeter`.
- **Nunca se resuelve un CAPTCHA**: la página se abandona y se degrada a contacto por WhatsApp o teléfono.

Presupuesto (`sourcing-budget.ts`): las unidades estimadas se **reservan** atómicamente al encolar la búsqueda (el día
nunca se pasa del tope aunque haya búsquedas concurrentes o una IA en bucle) y lo no usado se libera al terminar. El
día que se cobra es el día **reservado**, que viaja en el payload del job.

Dedupe (`sourcing-dedupe.ts`): la identidad de una empresa es dominio web > teléfono > nombre normalizado; los
dominios de correo genéricos y los directorios (Facebook, MercadoLibre, Sección Amarilla…) nunca identifican a una
empresa. Un candidato que ya es `Supplier` o proveedor de Zoho se marca en vez de parecer nuevo.

## Tools de IA (`src/modules/ai/tools/procurement-tools.ts`)

`listPurchaseRequests`, `searchSuppliers`, `runSourcingSearch`, `listSourcingCandidates`, `draftRfq`, `sendRfq`,
`interpretRfqReply`, `compareRfq`, `createProcurementOrderDraft`, `submitProcurementOrder`, `recordGoodsReceipt`.

La `ia_compras` sólo ofrece cuatro en sus turnos automáticos (tope de 20 esquemas por identidad, ver
`src/modules/agents/tool-allowlist.ts`): `listPurchaseRequests`, `draftRfq`, `compareRfq` y
`submitProcurementOrder`. El resto queda disponible para las personas (asistente y copiloto del área). Ninguna tool
aprueba, recibe material ni toca el padrón de proveedores: `PURCHASES_AGENT_ACT_PERMISSIONS` deja fuera
`purchases.approve`, `purchases.receive`, `purchases.manage_suppliers` y `purchases.export`.

## Área Compras (`/app/areas/compras/...`)

- `dashboard` — tablero con tiles en vivo (`compras-dashboard.ts`).
- `trabajo` — centro de trabajo con filas `purchase_request`, `rfq`, `procurement_order`, `goods_receipt`,
  `supplier` más las comunes del núcleo; columnas extra Proveedor y Llega.

  Cada fila de dominio trae sus **acciones** en `extra.actions` (`src/modules/areas/compras/row-actions.ts`), que es
  lo que pinta la columna de acciones, el cajón y la página de detalle. El catálogo viaja como un parámetro ligado y
  la rama SQL lo filtra dentro de Postgres por el estado de la fila **y** por la regla de negocio de cada acción, para
  no ofrecer un botón que el motor iba a rechazar:

  | Fila                | Acción (comando)                                                      | Cuándo se ofrece                                                                   | Permiso                                |
  | ------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------- |
  | `purchase_request`  | Cancelar solicitud (`purchases.request.cancel`)                       | abierta y sin partidas ya ordenadas                                                | `purchases.request`                    |
  | `rfq`               | Comparar respuestas (`purchases.rfq.compare`)                         | enviada/recibiendo/comparada **con** respuestas                                    | `purchases.manage_orders`, `.sourcing` |
  | `rfq`               | Cancelar cotización (`purchases.rfq.cancel`)                          | abierta                                                                            | `purchases.manage_orders`              |
  | `procurement_order` | Enviar a aprobación (`purchases.order.submit`)                        | borrador con partidas y total > 0                                                  | `purchases.manage_orders`              |
  | `procurement_order` | Solicitar el pago (`purchases.order.request_payment`)                 | pagable, no pagada y sin obligación                                                | `purchases.manage_orders`              |
  | `procurement_order` | Cerrar orden / Cerrar aceptando el faltante (`purchases.order.close`) | recibida (o parcial/con diferencias) sin diferencias abiertas y con el pago pedido | `purchases.manage_orders`              |
  | `procurement_order` | Cancelar orden (`purchases.order.cancel`)                             | cancelable y sin recepciones contabilizadas                                        | `purchases.manage_orders`              |
  | `goods_receipt`     | Registrar recepción (`purchases.receipt.post`)                        | borrador de bodega cuya orden todavía puede recibir                                | `purchases.receive`                    |

  La fila `goods_receipt` expone la versión optimista de **su orden**, porque los comandos de recepción corren contra
  el agregado `procurement_order`. Lo que exige datos estructurados (capturar una recepción con cantidades aceptadas y
  rechazadas, elegir una respuesta de RFQ, resolver una diferencia, confirmar una entrega directa) NO está en este
  catálogo: el diálogo genérico de la tabla sólo recoge una nota o un motivo.

- `ordenes`, `rfq`, `proveedores` — subpáginas de listado y detalle.
- `sourcing` — Laboratorio de Sourcing (`src/components/areas/compras/SourcingLab.tsx`).
- `comunicaciones` — canal `area:compras` y bandeja del equipo `equipo_compras`.

API del área: `/app/areas/compras/api/{suppliers,rfqs,orders,sourcing}` (`_compras-http.ts` traduce los errores del
módulo a HTTP).

## Permisos

`purchases.view`, `purchases.manage_suppliers`, `purchases.request`, `purchases.manage_orders`, `purchases.approve`,
`purchases.receive`, `purchases.sourcing`, `purchases.export`.

`purchases.export` gobierna la exportación real del área: el botón de CSV/XLSX del centro de trabajo sólo aparece para
quien tiene esa llave y `exportAreaRowsAction` la vuelve a exigir en el servidor (`areaExportPermissions` del registro de
áreas, que también admite `operations.admin`). Ver Compras ya no alcanza para sacar sus listados.

## Pruebas

Reglas puras: `rfq-scoring`, `sourcing-dedupe`, `robots-check`, `supplier-rating`, `unit-normalizer`,
`request-rules`, `rfq-rules`, `sourcing-rules`, `orders-state`, `areas/compras/row-actions`. Con FakePrisma: `purchases-flow`, `rfq-flow`,
`purchases-receipts-hardening`, `purchases-direct`, `purchases-finance`, `sourcing-service`, `purchases-storage`.
Tools de IA: `src/modules/ai/tools/procurement-tools.test.ts`.

Contra PostgreSQL real (`npm run test:integration`): `tests/integration/domains-scenarios.int.test.ts` recorre
faltante → solicitud → orden de compra → **doble firma** → autorización y liquidación del pago (con el módulo de
finanzas real) → recepción parcial con diferencia → reserva → avance del expediente, y la entrega directa de punta a
punta (evidencia ajena rechazada, cero movimientos de existencia, job de sincronización idempotente), y el
proveedor retrasado (lo comprometido nunca cuenta como disponible y la orden aparece vencida al pasar su fecha);
`tests/integration/compras-work-rows.int.test.ts` cubre las ramas SQL del centro de trabajo.

## Limitaciones conocidas

- Todo lo externo está visto **sólo contra mocks**: no se ha enviado una RFQ real por WhatsApp con plantilla aprobada
  ni se ha usado una llave real de Brave.
- El costo puesto en bodega asume 16 % de impuesto cuando el proveedor no lo dice y marca la respuesta; una moneda
  extranjera sin tipo de cambio deja la respuesta **no comparable**.
- «ml» no se convierte nunca sin una conversión explícita del perfil del artículo (en ferretería mexicana suele ser
  «metro lineal», no mililitro).
- Los paneles interactivos de gestión (captura de recepción parcial con cantidades aceptadas y rechazadas, revisión
  de respuestas de RFQ con puntaje, tablas de producto/órdenes/evaluaciones del proveedor) **no están construidos**:
  las rutas existen y muestran lista y detalle de sólo lectura. La lógica pura ya está y está probada; falta el punto
  de extensión `DetailExtras` en `area-client-registry` y en `[space]/[id]/page.tsx`.
