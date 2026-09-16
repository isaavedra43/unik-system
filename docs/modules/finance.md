# Contabilidad interna (`src/modules/finance/`)

Contabilidad interna es el **libro de dinero de la operación**: qué entró, qué salió, a quién se le debe, quién debe,
cuánto cuesta cada área y si el mes cuadra. No es contabilidad fiscal: **no hay SAT ni CFDI aquí**. Es contabilidad de
gestión, con un libro de partida doble inmutable que sólo se corrige por **reverso**.

Reglas que gobiernan el módulo:

- **Toda entrada o salida real tiene contraparte, responsable y evidencia.**
- **Ningún asiento se modifica después de cerrar**: la única corrección es un reverso espejo, fechado en un periodo
  abierto y nunca antes del original. Un reverso no se reversa y un asiento se reversa una sola vez.
- Un asiento necesita al menos dos renglones y `Σ debe = Σ haber` exacto.

Estado: implementado y validado localmente (reglas puras, servicios con FakePrisma y escenarios contra PostgreSQL
real). Migración `20260916150000_add_finance` **no aplicada** en producción. El cierre de un mes real y el emparejado
de un pago real de Zoho están **PENDIENTE PRODUCCIÓN** (ver `docs/pilot-runbook.md` §11.12).

## Modelos

| Modelo                                         | Para qué                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `CashAccount`                                  | Caja, banco, tarjeta, caja chica o cartera digital, con su saldo.                                      |
| `FinanceCategory`, `CostCenter`                | Catálogo de categorías (`income`, `expense`, `transfer`, `payroll`, `tax`, `debt`) y centros de costo. |
| `LedgerEntry` (+`LedgerLine`)                  | Asiento balanceado e inmutable con sus dimensiones.                                                    |
| `Obligation` (+`ObligationSettlement`)         | Por pagar y por cobrar, con vencimiento, antigüedad y liquidaciones.                                   |
| `Expense` (+`ExpenseSplit`, `ExpenseTemplate`) | Gasto capturado con comprobante, reparto y plantillas (incluidas las recurrentes).                     |
| `Budget`                                       | Presupuesto por centro y categoría contra el real.                                                     |
| `Employee`, `PayrollRun` (+`Line`)             | Directorio de empleados (no todo empleado tiene login) y corridas de nómina.                           |
| `PeriodClose`                                  | Cierre diario y mensual con sus revisiones.                                                            |

## Estados

- **Gasto**: `draft` → `pending_approval` → `approved` → `posted`; `rejected`. Los que todavía necesitan a alguien
  antes de cerrar el periodo son `draft`, `pending_approval` y `approved`.
- **Obligación**: `expected` → `partially_settled` → `settled`; `written_off`, `cancelled`.
  Reprogramar (`finance.obligation.reschedule`, botón «Reprogramar» del tablero de obligaciones) sólo cambia
  `dueAt`/`expectedCashAt` de una obligación **abierta**: no es un hecho contable, así que no crea asiento ni reversa
  ninguno. Antes había que cancelarla (lo que sí reversa su asiento) y volver a crearla, o dejarla vencida en falso —
  y «obligaciones vencidas» es una tile en vivo del área y una alerta del Control Tower.
- **Cuenta y catálogo**: `active` / `closed` / `archived`.

## Flujo

1. **Captura rápida de gasto.** Formulario, texto, voz, foto, plantilla o recurrente
   (`finance.capture_expense`). `expense-rules.ts` sugiere la clasificación por historial y por área (con palabras
   clave de respaldo: gasolina → combustible, caseta → viáticos…). La propuesta de la IA **nunca pisa lo que la
   persona escribió**.
2. **Duplicados** (`expense-duplicates.ts`). Exacto: misma llave `monto|fecha|proveedor` o mismo hash del
   comprobante. Difuso: montos dentro del ±1 % del mayor, fechas dentro de ±3 días y proveedores compatibles. Un
   choque marca el gasto `suspect` y la persona lo resuelve (único o duplicado) antes de enviarlo. La decisión se
   conserva mientras no cambie la identidad del gasto.
3. **Aprobación.** Ámbitos de aprobación de negocio `expense`, `payment` y `payroll`, con aprobador
   `finance.approve`. Los gastos por debajo del umbral configurado se autoaprueban ($2,000 MXN por omisión, editable
   en administración).
4. **Asiento.** `finance.post` asienta el gasto aprobado o un asiento manual. A partir de ahí sólo se corrige por
   reverso.
5. **Obligaciones.** Compras registra su cuenta por pagar por `finance-bridge.ts`; el expediente registra el ingreso
   esperado de la venta. Autorización de pago (`payment`) antes de liquidar. Antigüedad por cubetas
   (`obligation-rules.ts`).
6. **Conciliación de cobros** (`collections-matcher.ts`, job cada 30 min). Sólo se empareja el **remanente sin
   aplicar** de cada pago de Zoho (monto − Σ liquidaciones que ya llevan ese `zohoPaymentId`), así que un pago puede
   repartirse entre varias obligaciones y una segunda corrida nunca lo aplica dos veces. En orden: (1) por las
   facturas del pago hacia las órdenes de venta, FIFO; (2) sin cliente no se empareja; (3) una única cuenta por
   cobrar abierta del cliente con el mismo saldo se la lleva; (4) FIFO sobre las abiertas del cliente. Lo ambiguo y lo
   sobrante se vuelve el trabajo «Asignar cobro». La llave de idempotencia es
   `externalRef = zoho_payment:{zohoPaymentId}:{obligationId}` (`ObligationSettlement.zohoPaymentId` **no** es único).
7. **Nómina.** Neto = bruto − deducciones − anticipos aplicados (FIFO sobre los anticipos abiertos). El asiento es
   Dr categoría de nómina (bruto, por centro de costo) / Cr compensación `payroll_deductions` (retenciones) / Cr
   cuenta por cobrar (anticipos aplicados) / Cr por pagar (una obligación por empleado, el neto).
8. **Cierre** (`close-rules.ts`). Mensual, bloqueante: sin gastos en borrador, por aprobar o aprobados sin asentar del
   periodo; cero cobros sin asignar del periodo; integridad de efectivo por cuenta (saldo derivado del libro = saldo
   actual); cada arqueo entregado igual al saldo; libro balanceado. Avisos: mes anterior sin cerrar, nóminas
   abiertas. Diario, bloqueante: integridad de efectivo y arqueo de **cada** cuenta de caja y caja chica.
   Reabrir exige motivo de al menos 10 caracteres.

## Comandos (`finance-commands.ts`)

| Familia      | Comandos                                                                                                                                            | Permiso                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Catálogo     | `catalog.seed`, `cash_account.create/update`, `category.create/update`, `cost_center.create/update`, `budget.set`, `expense_template.create/update` | `finance.manage_catalog`                             |
| Libro        | `ledger.post_manual`, `ledger.reverse`                                                                                                              | `finance.post`                                       |
| Obligaciones | `obligation.create/settle/cancel/reschedule/write_off`, `obligation.reverse_settlement`, `payment.request_authorization`                            | `finance.manage_obligations`                         |
| Gastos       | `expense.capture/update/apply_proposal/resolve_duplicate/submit/capture_from_template`                                                              | `finance.capture_expense`                            |
| Gastos       | `expense.post/reject/reverse`                                                                                                                       | `finance.post` / `finance.approve`                   |
| Nómina       | `employee.create/update/advance`, `payroll.create/update/submit/create_obligations/pay_line/close/cancel`                                           | `finance.payroll`                                    |
| Cobros       | `collections.expect_case/apply_payment/match_payment/flag_payment/record_unexpected/cancel_voided/flag_overapplied`                                 | `finance.manage_obligations` (varios son de sistema) |
| Cierre       | `close.daily`, `close.monthly`, `close.reopen`                                                                                                      | `finance.close`                                      |
| Sistema      | `expense.run_recurring`                                                                                                                             | sólo jobs                                            |

Todos pasan por `executeCommand` del núcleo: ledger de comandos, idempotencia por `commandId`, guarda de versión y
eventos y jobs en la misma transacción.

## Jobs (`finance-jobs.ts`)

| Job                             | Cada       | Qué hace                                                          |
| ------------------------------- | ---------- | ----------------------------------------------------------------- |
| `finance.expense_propose`       | por evento | Lee un comprobante (foto o texto) y propone los campos del gasto. |
| `finance.recurring_expenses`    | 24 h       | Corre las plantillas recurrentes que tocan hoy.                   |
| `finance.reconcile_collections` | 30 min     | Empareja los pagos de Zoho con las cuentas por cobrar esperadas.  |
| `finance.obligations_due`       | 1 h        | Avisa de lo que vence y abre el trabajo correspondiente.          |
| `finance.daily_close_reminder`  | 24 h       | Recuerda el cierre del día.                                       |

Canal de tiempo real `finance:board` (`finance.view`); categoría de notificación `finance_alert`.

## Configuración

`IntegrationConfig('finance')` (archivo propio, misma tabla que la de operaciones). Dentro de una transacción de
comando se lee con `readFinanceSettings(tx)`, nunca con el lector global cacheado (pediría una segunda conexión del
pool).

| Ajuste                      | Qué gobierna                                                                                                    | Por omisión  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------ |
| `collectionsCashAccountKey` | `CashAccount.key` donde caen los cobros de cliente sincronizados de Zoho («Sólo las liquidaciones mueven caja») | `banco_zoho` |
| `obligationsDueAlertDays`   | Anticipación del aviso diario `finance_alert` de obligaciones por vencer                                        | 3            |
| `reconcileLookbackDays`     | Antigüedad máxima de un cobro de Zoho que todavía se concilia                                                   | 120          |
| `expenseHistoryMonths`      | Meses de historia que mira la propuesta de clasificación de un gasto                                            | 6            |
| `dailyCloseReminder`        | Recordatorio a quien puede cerrar cuando ayer tuvo movimiento y quedó sin cerrar                                | `true`       |

Se editan en **Contabilidad › Catálogos** (`FinanceSettingsPanel`, permiso `finance.manage_catalog`): la pantalla
elige la cuenta de cobros del catálogo en vez de escribirla a mano y avisa en español de lo que dejaría de
funcionar (cuenta inexistente o cerrada → `cashAccountByKey` lanza `invalid_config` en cada conciliación; 0 días de
aviso → sólo se avisa de lo ya vencido; recordatorio apagado → nadie recibe el aviso de cierre). La escritura pasa
por la server action `saveFinanceSettingsAction` → `updateFinanceSettings`, que vuelve a exigir el permiso, valida
con `financeSettingsPatchSchema`, fusiona sobre lo guardado, invalida la caché y deja auditoría
(`finance.config.updated`).

## Directorio de empleados

`Employee {number, name, position?, userId?, areaKey?, costCenterId?, active}`. `userId` es único y liga al empleado
con su cuenta: **no todo empleado tiene login**, por eso es opcional. `assertEmployeeRefs` rechaza una identidad de
IA, un usuario inexistente y una cuenta ya ligada a otro empleado.

Se administra en **Contabilidad › Catálogos** (permiso `finance.payroll`): el alta toma puesto, centro de costo,
área y cuenta; el botón «Cuenta y área» de cada renglón liga o **desliga** la cuenta (`userId: null`) y cambia el
área. El selector de cuentas lo sirve `listEmployeeUserOptions` (sólo personas activas, sin correos ni roles) y
marca las ya ligadas para no ofrecer un duplicado que el comando rechazaría.

## Tools de IA (`src/modules/ai/tools/finance-internal-tools.ts`)

`captureExpenseDraft`, `proposeExpenseFields`, `checkExpenseDuplicate`, `submitExpense`, `getCashflowProjection`,
`getBudgetVsActual`, `listUnmatchedPayments`, `matchPaymentToObligation`, `getCashBook`.

La `ia_contabilidad` ofrece en sus turnos automáticos `getCashflowProjection`, `listUnmatchedPayments`,
`matchPaymentToObligation` y `getCashBook`, más `recordExpense` y `authorizePayment` del núcleo (tope de 20 esquemas
por identidad). La identidad de IA **nunca** aprueba, asienta, cierra, corre nómina, toca el catálogo ni exporta.

## Área Contabilidad (`/app/areas/contabilidad/...`)

- `dashboard` — tablero del área.
- `trabajo` — centro de trabajo con filas `expense`, `obligation`, `period_close_task` más las comunes; columnas
  extra Contraparte y Periodo.
- `gastos` — gastos capturados con su aprobación y su comprobante.
- `libro` — Libro de caja: saldos de cuentas, renglones del libro y avance del cierre.
- `catalogos` — ajustes de contabilidad (arriba), cuentas, categorías, centros de costo y directorio de empleados.
- `comunicaciones` — canal `area:contabilidad` y bandeja del equipo `equipo_contabilidad`.

## Permisos

`finance.view`, `finance.capture_expense`, `finance.approve`, `finance.post`, `finance.manage_obligations`,
`finance.payroll`, `finance.close`, `finance.manage_catalog`, `finance.export`.

## Pruebas

Reglas puras: `ledger-rules`, `obligation-rules`, `expense-rules`, `expense-duplicates`, `collections-matcher`,
`close-rules`, `close-cashflow-rules`, `payroll-rules`, `money-dates`. Con FakePrisma: `expenses-flow`,
`close-flow`, `payroll-flow`, `obligations-collections`, `finance-hardening`, `jobs-storage`, `finance-config`
(permiso, fusión parcial, fila creada la primera vez, caché y auditoría). Tools de IA:
`src/modules/ai/tools/finance-internal-tools.test.ts`. Modelo de la pantalla de ajustes:
`src/components/areas/contabilidad/finance-settings-model.test.ts` (compara sus cotas con el esquema del servidor,
que es la única fuente de verdad).

Contra PostgreSQL real (`npm run test:integration`): `tests/integration/domains-scenarios.int.test.ts` recorre el
gasto duplicado (envío bloqueado, resolución como único, firma de otra persona y asiento cuadrado), la conciliación
de **un pago de Zoho repartido entre dos cuentas por cobrar** (idempotente por `externalRef`) y la autorización y
liquidación del pago de una orden de compra con doble firma, comprobando que ningún asiento queda descuadrado ni sin
renglones.

> Esa suite comparte **una** base desechable con todas las demás y sólo vale si corre **sola**. Una corrida
> simultánea la pone en rojo con errores que parecen del producto (deadlock, FK de `Notification`, unicidad de
> `Responsible.area`); desde el 2026-09-16 el `globalSetup` del proyecto hace esperar a la segunda corrida en vez
> de dejarla corromper la base. Ver `docs/pilot-runbook.md` §11.14.

## Limitaciones conocidas

- **Sin experto contable**: tipos de cuenta mínimos y correcciones sólo por reverso; no hay reportes fiscales.
- La conciliación de cobros se ha visto **sólo contra `ZOHO_BOOKS_MOCK`**; no se ha emparejado un pago real.
- Ningún mes real se ha cerrado: las revisiones bloqueantes del cierre están probadas, pero no contra los datos y los
  arqueos de la operación.
- El Libro de caja abre con estados vacíos correctos cuando no hay `LedgerEntry`/`LedgerLine`: asentar un gasto exige
  la cadena real de comandos de partida doble.
