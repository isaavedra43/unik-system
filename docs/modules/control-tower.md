# Torre de Control y UNIK Neural Operations (`/app/admin/control-tower`)

Secciones 7.7, 7.8 y 7.9 del plan. Es la vista de dirección: cómo va la operación ahora mismo, quién la está
moviendo, qué se salió del camino, y —en Neural Operations— cómo se mueve de verdad el proceso frente a cómo está
definido.

Toda la superficie exige `operations.admin`. La página lo pide, cada server action lo repite
(`requireControlTowerActor`) y cada servicio lo vuelve a comprobar (`assertControlTowerAccess`).

---

## 1. Las siete pestañas

| Vista                   | Qué muestra                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/resumen`              | 8 KPIs, expedientes por fase, actividad 24 h, vencidos por área, alertas, carga por área y salud técnica (Zoho, jobs, proyecciones, IA). |
| `/personas`             | Quién está en qué ahora: área, en curso, abiertos, vencidos, su siguiente pendiente y su último evento.                                  |
| `/excepciones`          | `EntityWorkspace` sobre las 8 clases de excepción, con los comandos reales del núcleo por fila.                                          |
| `/aprobaciones`         | Propuestas de IA + aprobaciones de negocio + work items `approval` abiertos.                                                             |
| `/auditoria`            | `AuditLog` acotado a objetos operativos, filtrable y paginado.                                                                           |
| `/configuracion`        | Editor de la configuración de operaciones y CRUD de `ApprovalPolicy` con **vista previa real** de a quién pediría firma.                 |
| `/neural/{herramienta}` | Las cinco herramientas de minería de procesos.                                                                                           |

La salud de Zoho es **la última corrida de cada entidad** (`latestSyncRunsSql`, un `DISTINCT ON (source, entityType)`
sobre `IntegrationSyncRun`), no «las últimas N corridas»: leer una ventana de corridas hacía desaparecer del panel a la
entidad que dejaba de sincronizar, que es justo la que hay que ver. Una entidad callada más de 120 minutos sin error que
lo explique levanta la alerta `sync_stale` (la que falla levanta `sync_failing`), y la lista de la tarjeta pone primero
lo que está mal porque se corta en 8 filas y hay más entidades que eso.

Neural Operations: `procesos` (el proceso definido, dibujado desde `ProcessVersion.definition` con el acomodo de
`process-layout.ts`), `variantes` (caminos reales, cuellos de botella, matriz de traspasos, causas de bloqueo y
retrabajo), `grafo` (la red de objetos, con perspectivas, profundidad 1-3, escenas guardadas y deslizador de
instante), `replay` (la historia de un expediente reconstruida con `foldCaseState`) y `simulacion` (qué pasa si un
paso se retrasa o un área pierde capacidad).

---

## 2. Datos: dos cadencias que no hay que confundir

| Job                       | Cada   | Qué recalcula                                                                            |
| ------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| `areas.dashboard_refresh` | 5 min  | El **resumen** de la Torre (alcance `control_tower` de `DashboardSnapshot`).             |
| `ct.projections_refresh`  | 15 min | Las **proyecciones** de minería: `variants`, `step_metrics`, `handoffs`, `block_causes`. |

La pantalla de variantes/cuellos/traspasos/causas lee proyecciones, así que su frescura es de 15 minutos y se dice
en pantalla. `GET /api/projections/rebuild` devuelve `minutesAgo` y `stale` por proyección.

El **recálculo total** se pide desde `/resumen`, en la tarjeta «Proyecciones e IA»
(`ProjectionsRebuildButton` → `POST /api/projections/rebuild {full:true}`). Por omisión **encola**
`ct.projections_refresh` (deduplicado por `projectionsDedupeKey`: diez clics son una corrida) y contesta 202;
marcando «Esperar el resultado» corre en línea y devuelve qué escribió cada proyección, que es lo único que sirve
para ver **cuál** falló. `projectionsRebuildFeedback` (puro, en `overview-model.ts`) decide el texto y no disfraza
de éxito una corrida con fallos.

Las proyecciones son **incrementales por marca de agua** (`CtProjectionWatermark`). Como `OperationalEvent.id` se
asigna al insertar y no al confirmar, cada corrida relee además una ventana de 10 minutos por `recordedAt`. Los días
se recalculan **enteros** con `upsert` sobre la llave natural: repetir una corrida deja exactamente el mismo
resultado. Una proyección que falla no detiene a las demás y su marca de agua no avanza.

Para añadir una proyección hay que tocar cuatro sitios en `projections-service.ts`: `PROJECTION_KEYS`,
`PROJECTION_LABELS`, una `refreshX(window)` y su `await run(...)`. Regla que no se afloja: recalcular el día
completo, nunca sumar diferencias, o los percentiles quedan mal al reintentar.

El scope `control_tower` entra al job de tableros con
`registerDashboardSnapshotProvider({ scopeType: 'control_tower', ... })`. Ojo: los proveedores registrados sólo
corren cuando `refreshDashboardSnapshots` se llama sin `areaKeys` — el botón «Actualizar» de un área no refresca la
Torre, a propósito.

---

## 3. El grafo

`queryOperationalGraph` recorre `ObjectRelation` con una CTE recursiva en **ambas direcciones**. `UNION` (no
`UNION ALL`) deduplica, y por eso no puede ciclar. Profundidad ≤3 y tope de 2 000 nodos los acota el servidor; la
pantalla dibuja como máximo 500 (`GRAPH_RENDER_LIMIT`) y lo dice cuando recorta.

El `at` del deslizador es real: `validFrom <= at AND (validTo IS NULL OR validTo > at)`.

Para añadir un tipo de nodo: una entrada en `NODE_LOADERS` (la clave es el `fromType`/`toType` real) y su etiqueta en
`GRAPH_NODE_TYPE_LABELS`. Sin lector, el nodo sale con su id y el grafo no se rompe. Una **relación** nueva hay que
meterla en la perspectiva o el recorrido no la sigue (falla en silencio).

### Enmascarado

`maskNode` se aplica **siempre** antes de devolver un nodo: `operations.admin` abre la Torre pero **no** levanta la
máscara de importes (`finance.view`) ni de datos de contacto (`customers.view`). Hay pruebas que lo fijan.

---

## 4. Seguridad que no hay que aflojar

1. Orden y filtros de la tabla de excepciones son lista blanca; un campo desconocido lanza `CtExceptionQueryError`
   → 422.
2. `projections-sql.ts` **no** usa `Prisma.raw` (hay una prueba que lee el SQL armado). `exceptions-service.ts` sí,
   pero sólo con nombres de columna de la constante `SORT_COLUMNS`: un orden nuevo se agrega ahí **y** al enum de
   Zod, nunca se construye con texto del cliente.
3. Las acciones por fila sólo se **ofrecen** a quien el motor dejaría actuar, y la lista de quién es esa gente vive
   en **un solo sitio**: `OPERATIONS_OPERATOR_PERMISSIONS` (`src/modules/operations/permissions.ts`) =
   `operations.manage` **u** `operations.admin`; además, la persona responsable de la fila (dueño/suplente del
   trabajo, dueño de la incidencia, responsable del área destino de la solicitud). `operations.admin` entra porque
   es el permiso con el que el plan abre esta superficie (7.7): mientras no entró, quien administraba operaciones
   veía todas las excepciones sin un solo botón, y `work-actions.ts` ya se los pintaba en el centro de trabajo del
   área — el motor contestaba 403 a un botón que la propia app acababa de dibujar. Lo fijan
   `exception-actions.test.ts` y, del lado del motor, `work-items-service.test.ts`,
   `incidents-service.test.ts` y `area-requests-service.test.ts`. `operations.view` sigue siendo mirar.
4. La metadata de auditoría y los textos de terceros se muestran como dato (resumen `clave: valor` escapado), nunca
   como instrucción.
5. La bitácora que viaja al navegador para el replay lleva el payload recortado a las 21 llaves que `foldCaseState`
   realmente lee (`REPLAY_PAYLOAD_KEYS`). **Si alguien amplía `foldCaseState` y lee otra llave, tiene que agregarla
   ahí** o el estado reproducido pierde ese dato en silencio. Y al revés: no agregar llaves «por si acaso», porque
   la bitácora lleva datos de negocio que esa pantalla no necesita.

---

## 5. Espejos que hay que mantener

Lo que viaja al navegador no puede importar Prisma, así que hay constantes replicadas **con una prueba que las
compara** contra las del servidor: `exceptions-model.ts` replica `EXCEPTION_KINDS`/`_LABELS`, `settings-model.ts`
replica `OPS_FLAGS`/`OPS_FLAG_LABELS` y `control-tower-views.ts` re-exporta el vocabulario de Neural desde
`neural/neural-model.ts` (fuente única: si renombran una herramienta, falla el typecheck en vez de dejar una pestaña
apuntando a un 404).

---

## 6. El tiempo

Los días de las proyecciones son **días UTC** (las consultas usan `(columna)::date` sobre `timestamp` sin zona, la
convención de Prisma en este esquema). Una pantalla que hable de «hoy» en hora de México no cuadrará con esos
números; si se quiere cambiar, se decide en `projections-service.ts`, no en la UI.

---

## 7. Motor de dibujo

`ProcessCanvas.tsx` y `GraphCanvas.tsx` son los **únicos** dos archivos que importan `@xyflow/react`, y ambos se
cargan con `dynamic({ ssr: false })`. Toda la lógica (posiciones, recorte, inspector, fusión al expandir) vive en
módulos puros con pruebas, así que cambiar de motor es reescribir esos dos archivos. Ver
`docs/decisions/ADR-002-graph-renderer.md`.

En ≤768 px el lienzo no se monta: se muestran las listas equivalentes.

---

## 8. Qué NO está verificado

- El rendimiento del grafo a profundidad 3 con volumen real (la base de prueba está prácticamente vacía).
- `blockCauseProductSql` depende de que `AreaRequest.payload` traiga `sku` y `productName`; si un módulo escribe
  otras llaves, las causas por producto salen vacías en silencio.
- `listPendingProposals(actor)` devuelve las propuestas que **esa** persona puede decidir, no todas las del sistema.
- La auditoría filtra por una lista fija de `targetType` (`AUDIT_TARGET_TYPES`, en
  `src/components/control-tower/audit-model.ts`): un módulo que audite con un tipo nuevo no se ve hasta que se agregue
  ahí. La lista es UNA sola —la importan la pantalla, la ruta `api/audit` y la primera carga de `[view]/_data.ts`— y
  `audit-model.test.ts` falla si una acción de fila de un área declara un agregado que no está en ella, porque
  `executeCommand` audita con `targetType: cmd.aggregate.type`.
- Fuera del selector quedan los objetos que no son de la operación (usuarios, roles, chat, extensiones, campañas): se
  auditan igual y se consultan en su propia administración.
- El costo de IA del inspector del grafo sólo existe para el nodo `operational_case` (medidor `ai_case`). Ningún otro
  tipo de nodo tiene medidor propio, así que su chip no aparece; y como la Torre entera exige `operations.admin`, la
  regla `aiCost` de `maskNode` no oculta nada en esta pantalla (sirve si el nodo viaja a otra superficie).
