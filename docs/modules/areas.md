# Áreas operativas (`/app/areas/{área}`)

Sección 7 del plan. Las seis áreas de la empresa —Ventas, Compras, Inventario, Manufactura, Logística y
Contabilidad— comparten un mismo marco: cada una abre con el mismo esqueleto, los mismos espacios y la misma IA al
lado, y cada módulo de dominio enchufa lo suyo sin reescribir nada del marco.

Administración no es un área: vive en la Torre de Control (`docs/modules/control-tower.md`).

---

## 1. Mapa de la superficie

| Ruta                                 | Qué es                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `/app/areas/{área}`                  | Redirige al panel.                                                          |
| `/app/areas/{área}/dashboard`        | Panel: 8 tiles, 2 gráficas y alertas del área.                              |
| `/app/areas/{área}/trabajo`          | Centro de trabajo: la tabla de filas (`EntityWorkspace`) con sus acciones.  |
| `/app/areas/{área}/comunicaciones`   | Chat del área + solicitudes entre áreas + bandeja externa del área.         |
| `/app/areas/{área}/{vista especial}` | La vista propia del área (radar, sourcing, mapa, tablero, despacho, libro). |
| `/app/areas/{área}/{subpágina}`      | Listas y páginas de gestión declaradas por el área.                         |
| `/app/areas/{área}/{espacio}/{id}`   | Detalle de una fila.                                                        |

La vista especial de cada área:

| Área         | Vista especial            | Subpáginas                                                                   |
| ------------ | ------------------------- | ---------------------------------------------------------------------------- |
| Ventas       | `radar` (Radar de cierre) | `oportunidades`, `pipeline`                                                  |
| Compras      | `sourcing`                | `ordenes`, `rfq`, `proveedores`                                              |
| Inventario   | `mapa`                    | `existencias`, `conteos`, `movimientos`, `ubicaciones`                       |
| Manufactura  | `tablero`                 | `ordenes`                                                                    |
| Logística    | `despacho`                | `viajes` (+ `flota` y `chofer`, fuera de las pestañas)                       |
| Contabilidad | `libro` (Libro de caja)   | `gastos` (+ `obligaciones`, `nomina`, `presupuestos`, `cierre`, `catalogos`) |

---

## 2. Cómo enchufa un área (contratos)

Todo pasa por dos registros. **El registro es la fuente de verdad**: `nav-config.ts` lo espeja y
`nav-config.test.ts` compara ambos, así que agregar un espacio y no tocar la navegación rompe la prueba a propósito.

### Servidor — `src/modules/areas/<área>/register.ts`

```ts
registerAreaServer('<área>', {
  workRowBranches, // ramas SQL de las filas propias del área
  loadDashboard, // panel del área
  getRowDetail, // detalle de una fila propia
});
registerAreaLiveTiles('<área>', tiles); // opcional: tiles que no deben envejecer
```

Las ramas se construyen **siempre** con `areaWorkRowSelect` (rellena las 24 columnas canónicas en orden, que es lo
que hace válido el `UNION ALL`) y su `rowKind` tiene que estar declarado en `AREA_REGISTRY.<área>.workCenter.rowKinds`;
una rama de un tipo no declarado se ignora a propósito.

El barril `src/modules/areas/register-all.ts` importa los seis módulos **con imports literales**, uno por área. No
usar plantillas (`./${key}/register`): Webpack las resuelve pero Vite no, y las registraciones desaparecían en
silencio bajo vitest. `register-all.test.ts` exige que las seis carguen.

### Cliente — `src/components/areas/<área>/register-client.tsx`

```ts
registerAreaClient('<área>', { SpecialView, renderCell, rowKindLabels });
```

`src/components/areas/register-all-client.tsx` también importa literalmente, y sólo el área que se está viendo.

### Acciones por fila

Una rama ofrece acciones poniéndolas en `extra.actions`:

```ts
{ id, label, commandType, aggregateType, payload?, aggregateId?, form?, tone?, confirm?, permissions?, participantOnly? }
```

`payload` y `aggregateId` no son decorativos: **todo comando de dominio de este repo exige su propio id dentro del
payload** (`{orderId}`, `{expenseId}`…) y revalida que el agregado coincida. Sin ellos la acción rebota con
`invalid_payload`. `getRowActions` filtra por permiso y por participación; el estado lo filtra la rama en SQL.

---

## 3. Permisos

Ninguna llave inventada: se usan las de cada módulo.

Tabla copiada de `AREA_REGISTRY[...].permissions` (`src/modules/areas/area-registry.ts`); quien tenga **cualquiera**
de las llaves de una columna la cumple.

| Área         | Ver                                            | Actuar                                                                                                                  | Aprobar                                |
| ------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Ventas       | `crm.view`, `sales_orders.view`                | `crm.manage`                                                                                                            | `crm.manage`                           |
| Compras      | `purchases.view`                               | `purchases.request`, `purchases.manage_orders`, `purchases.receive`, `purchases.sourcing`, `purchases.manage_suppliers` | `purchases.approve`                    |
| Inventario   | `inventory.view`                               | `inventory.count`, `inventory.reserve`, `inventory.adjust`, `inventory.manage`                                          | `inventory.adjust`, `inventory.manage` |
| Manufactura  | `manufacturing.view`                           | `manufacturing.manage_orders`, `manufacturing.operate`, `manufacturing.inspect`, `manufacturing.manage_boms`            | `manufacturing.approve_incidents`      |
| Logística    | `logistics.view` (+ entrada `logistics.drive`) | `logistics.dispatch`, `logistics.manage_fleet`                                                                          | `logistics.manage_fleet`               |
| Contabilidad | `finance.view`                                 | `finance.capture_expense`, `finance.post`, `finance.manage_obligations`, `finance.payroll`, `finance.close`             | `finance.approve`                      |

La columna «Aprobar» es también la lista de aprobador de área que usa la capa de IA:
`AREA_APPROVER_PERMISSION_CANDIDATES` (`agents/agent-runner.ts`) **se deriva de esta misma columna**, no la copia, así
que las dos no pueden separarse; quien tenga **cualquiera** de las llaves de su área decide las propuestas del agente
(Inventario: `inventory.adjust` **o** `inventory.manage`). Lo único que la capa de IA no añade es `operations.admin`
(sí lo añade `areaApprovePermissions` para las aprobaciones de negocio). La tabla está reproducida en
`docs/modules/agents.md` §Aprobaciones y en la lista de asignación del piloto (`docs/pilot-runbook.md` §2).

`operations.admin` abre cualquier área. Sobre el **núcleo** (trabajos, incidencias, solicitudes) actúan los dos
permisos transversales: `OPERATIONS_OPERATOR_PERMISSIONS` = `operations.manage` **u** `operations.admin`
(`src/modules/operations/permissions.ts`), que es la constante que leen tanto `work-actions.ts` como el motor
(`assertCanActOnWorkItem`, `assertCanHandleIncident`, `assertHumanDecider`). Ninguno de los dos sustituye a los
permisos de **dominio** del área (una orden de compra sigue exigiendo `purchases.*`).

**Puerta gruesa vs autorización.** El layout usa `areaEntryPermissions(area)` —los permisos de vista **más** los de
`permissions.entry`— y no es la autorización: cada espacio vuelve a exigir `areaViewPermissions`, y las páginas con
audiencia propia comprueban la suya. El único caso hoy es Logística: un chofer tiene `logistics.drive` y nunca
`logistics.view`, y sin esa puerta su propia PWA (`/app/areas/logistica/chofer`) le daba 404. Ensanchar la puerta no
le muestra ningún espacio: `area-registry.test.ts` lo fija.

**Enmascarado del detalle.** Ver una fila no es ver todos sus datos. El detalle (cajón y página) pasa por
`maskRowFields` (`src/modules/areas/row-mask.ts`), que aplica **la misma tabla que la Torre de Control**
(`control-tower/graph-mask.MASK_RULES`, no una copia): los **importes** exigen `finance.view` y los **datos de
contacto** (teléfono, correo, el contacto de una entrega) exigen `customers.view`; `operations.admin` no levanta
ninguna de las dos (sólo `super_admin`). Lo que se oculta es el dato, y el renglón sigue ahí con su explicación
(«Importe oculto (requiere Contabilidad)»), nunca un hueco. El **nombre** que identifica la fila (cliente,
proveedor) no se enmascara, exactamente como `maskNode` borra el objeto `contact` del nodo pero conserva su
`label`. Una rama de dominio sólo tiene que **marcar** su campo con `markSensitive(field(…), 'amount' | 'contact')`:
el enmascarado lo aplica el servicio al final, así que no se puede olvidar.

---

## 4. Filtros, orden y vistas guardadas

- Los campos filtrables y ordenables son **lista blanca por área** (`work-columns.ts`). Un campo desconocido lanza
  `AreaWorkQueryError` → 422; nunca se ignora en silencio.
- `Prisma.raw` sólo recibe nombres de columna ya validados contra el registro; todo lo que escribe una persona viaja
  como parámetro. Hay pruebas de inyección y de escape de comodines.
- Las columnas propias de un área se declaran en `extraColumns` y se filtran/ordenan como `extra.<campo>`.
- **Vistas guardadas:** `createAreaViewAction` pasa `areaViewConfigSchema(area)` a `createTableView`. Sin eso el
  servicio valida con el esquema de órdenes de venta y guardar una vista con un filtro del área reventaba con un
  ZodError crudo. Compartir una vista exige el permiso de acción del área, no `sales_orders.share_views`.
- La llave de preferencias es `areas:<área>:work`; el seguimiento usa `EntityWatch.entityType = 'area_work_row'` con
  el id `<rowKind>:<sourceId>`.

---

## 5. Panel: instantánea + tiles en vivo

`dashboard-service.ts` guarda un `DashboardSnapshot` por alcance (`area:<key>`). Al abrir un panel devuelve la
instantánea si tiene menos de 5 minutos y, si no, la calcula y la guarda: la primera persona paga una vez y el resto
lee proyección. Encima recalcula **siempre** los tiles marcados `live` (conteos indexados baratos), así que
«Vencidos» nunca es un número viejo, y la pantalla dice en voz alta su frescura («Actualizado hace 3 min · desde la
última proyección»).

El job `areas.dashboard_refresh` los refresca cada 5 minutos. Un área que marque tiles `live` propios **tiene** que
registrar `registerAreaLiveTiles`, o `applyLiveTiles` les quita la marca (prefiere quitar la etiqueta a mentir).

Los números son del área: se calculan con un actor de sistema y la regla de acceso se aplica al **leer**.

---

## 6. Comunicaciones

`ensureAreaChannel` corre antes de renderizar (idempotente: crea el canal y sincroniza miembros). Tres pestañas con
URL propia (`?tab=chat|solicitudes|externos`):

- **chat** — canal del área y salas de expediente, con el `ChatConversation` existente y el copiloto al lado;
- **solicitudes** — entrantes y salientes. Los botones los decide el **servidor** (`requests-model.ts`) reusando la
  tabla de transiciones del núcleo, así que la UI nunca ofrece una decisión que el comando rechazaría;
- **externos** — la bandeja, acotada a las cuentas del área.

**Qué hay que configurar para que «externos» muestre algo.** El registro declara el equipo del área
(`comms.inboxTeamKeys`, p. ej. `equipo_ventas`) y la pestaña filtra las cuentas por
`CommAccount.teamKeys ∩ inboxTeamKeys`. El arranque crea esos seis roles si no existen
(`ensureAreaTeamRoles`, `src/modules/areas/area-teams.ts`, llamado desde `instrumentation-node.ts`): son roles
normales —no de sistema—, así que Administración puede renombrarlos, darles permisos y asignarlos, y un rol que ya
existe no se toca nunca. Lo que el arranque **no** hace es decidir qué número atiende cada área: eso se marca en
`/app/admin/comms` → Canales. Mientras ningún canal lleve la llave del equipo, la pestaña abre con un estado vacío
que **dice exactamente qué falta** (antes abría vacía y en silencio). Ver a esas conversaciones exige además
`inbox.use` y tener el rol del equipo (`canAccessAccount`).

El `freeText` de una solicitud se muestra como cita escapada: es dato de otra persona, nunca instrucción.

---

## 7. Móvil (≤768 px)

El centro de trabajo cambia de tabla a `AreaWorkMobile`: tarjeta de «siguiente acción» (`pickNextAction`), tarjetas
de trabajo con su acción primaria, y barra inferior con **Capturar** (nota que funciona sin conexión), **Escanear**
(`BarcodeDetector` cuando existe, captura manual siempre) e **IA** a pantalla completa.

El cambio ocurre en el commit de hidratación (`useIsMobile` con `useSyncExternalStore`, `getServerSnapshot = false`),
así que el servidor y el primer render del cliente coinciden.

En móvil no hay vistas guardadas, gestor de columnas, exportación ni selección múltiple: eso vive de 769 px arriba.

---

## 8. Todo lo que escribe pasa por comandos

La tabla, el cajón y el móvil usan la cola offline contra `POST /app/operations/api/commands` con el
`expectedVersion` de la fila; el detalle usa un server action para que funcione sin JavaScript. Ambos terminan en
`executeCommand`. **Ninguna regla de negocio vive en la UI.**

---

## 9. Reglas que no hay que aflojar

1. El barril importa literalmente; nada de plantillas.
2. Agregar un espacio obliga a tocar tres sitios: `area-registry.ts`, `AREA_NAV` y `LEGACY_AREAS` del test de nav.
3. Filtros y orden son lista blanca; campo desconocido → 422.
4. El detalle de una fila con expediente aplica `authorizeOperationsChannel('case')`, no `operations.view`; si no
   pasa, el cajón lo dice en vez de mostrarse vacío.
5. La cronología usa `formatTimelineLine` excluyendo `AI_TURN_EVENT_TYPES`.
6. Un canal de realtime nuevo necesita su caso en `authorizeChannel` o el cliente no recibe nada (falla en silencio).
7. CSS sólo con tokens, en `src/styles/operations/*.css`.

---

## 10. Qué NO está verificado

- Nada se ha probado contra Zoho real: el espejo de embarques, la escritura de órdenes de venta desde CRM y el envío
  de RFQ por plantilla aprobada sólo se han visto contra mocks.
- El QR de las etiquetas de inventario lo genera un codificador propio (no hay librería aprobada) y se ha validado
  por invariantes de la norma, **no escaneándolo con un teléfono o una pistola lectora**.
- Los paneles interactivos de gestión de Compras (captura de recepción parcial, revisión de respuestas de RFQ,
  tablas del proveedor) no existen: esas rutas muestran la lista y un detalle de sólo lectura. La lógica pura
  (`checkReceiptDraft`, `orderNextAction`…) sí está y está probada.
- El rendimiento con volumen real: el mapa se queda en 500 ubicaciones, `listVariants` en 5 000 expedientes y las
  exportaciones en 2 000 filas.
