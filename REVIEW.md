# REVIEW.md — UI Review Checklist

Cada PR/tarea UI debe pasar esta revisión antes de considerarse terminada.

## Checklist

- [ ] No hay componente duplicado.
- [ ] No hay hardcoded colors.
- [ ] Responsive en 1366, 1024, 768, 390.
- [ ] No hay overflow horizontal no intencional.
- [ ] Keyboard navegable (Tab, Enter, Escape).
- [ ] Focus visible en elementos interactivos.
- [ ] Accesibilidad: labels, roles, contrast básico.
- [ ] Estados loading incluidos.
- [ ] Estados error incluidos.
- [ ] Estados empty incluidos.
- [ ] Dark mode considerado (tokens semánticos).
- [ ] Motion discreta y con reduced-motion.
- [ ] Permisos server-side correctos.
- [ ] Server/client boundary correcto.
- [ ] Visual regression actualizado si aplica.
- [ ] Storybook actualizado si es shared component.
- [ ] Build, lint, typecheck y format pasan.
- [ ] No datos fake de negocio en producción.

---

## Sales Orders Phase 6.3.1 — Root Cause & Manual Validation Report

### Root causes fixed

1. **Empty table cells despite data existing in the drawer**
   - The workspace received `SalesOrderListItem` with snake_case keys (`sales_order_number`, `customer_name`, etc.) but the column registry used camelCase ids (`salesOrderNumber`, `customerName`, etc.).
   - `renderCell` looked up `item[column.id]`, so every field was `undefined` and fell back to `—`.
   - Fix: created canonical `SalesOrderListRow` (camelCase) and `toSalesOrderListRow` mapper; all UI consumers now use the same key names as the column registry.

2. **Date off-by-one (`2026-09-01 → 31 ago 2026`)**
   - `formatDate` created a `new Date('2026-09-01')` interpreted as UTC midnight and then called `toLocaleDateString('es-MX')`, which shifted the date to the previous evening in time zones west of UTC.
   - Fix: `formatDateOnly` parses the ISO date and formats with `timeZone: 'UTC'` so the calendar day is preserved.

3. **Empty delivery method on orders like OV-23162**
   - Zoho payload for some orders has `delivery_method` empty but `shipping_address.address` contains `RECOGE EN BODEGA`.
   - Fix: normalizer falls back to `shipping_address.address` when `delivery_method` is empty.

4. **Raw English statuses in UI**
   - `confirmed`, `paid`, `invoiced`, `pending` were rendered literally.
   - Fix: central `getSalesOrderStatusConfig` maps raw values to Spanish labels and tone colors; applied in table, drawer and detail page.

### Files changed (high level)

- `src/modules/sales/sales-orders-contract.ts` (new)
- `src/modules/sales/sales-orders-helpers.ts` (new)
- `src/modules/sales/sales-orders-helpers.test.ts` (new)
- `src/modules/sales/sales-orders-service.ts`
- `src/modules/sales/sales-orders-columns.ts`
- `src/modules/sales/sales-orders-normalizer.ts`
- `src/components/sales/SalesOrdersWorkspace.tsx`
- `src/components/sales/SalesOrdersWorkspace.stories.tsx`
- `src/components/sales/SalesOrderPreviewDrawer.tsx`
- `src/components/sales/SalesOrderDetail.tsx`
- `src/app/app/sales/orders/actions.ts`
- `src/app/globals.css`
- `vitest.config.ts`
- `docs/modules/sales-orders.md`
- `docs/integrations/zoho-sales-order-field-map.md`

### Static validations

- `npm run typecheck` ✅
- `npm run lint` ✅ (3 pre-existing warnings)
- `npm run format:check` ✅
- `npm run build` ✅
- `npm run build-storybook` ✅
- `npx vitest run --project unit` ✅

### Manual validation plan

1. **Table data visibility**
   - Open `/app/sales/orders`.
   - Confirm every default column is populated (Fecha, Orden, Referencia, Cliente, Estado, Facturada, Pago, Envío, Total, Entrega).
   - Compare the same row against the preview drawer and full detail page; values must match.

2. **Date correctness**
   - Find an order with `orderDate = 2026-09-01` (e.g. OV-23162).
   - Verify the table, drawer and detail page all show `1 sep 2026` (not `31 ago 2026`).

3. **Delivery method**
   - Find a "RECOGE EN BODEGA" order.
   - Verify the "Método de entrega" / "Entrega" field shows `RECOGE EN BODEGA` and is no longer empty.

4. **Status labels**
   - Confirm status badges read in Spanish (`Confirmada`, `Pagada`, `Facturada`, `Pendiente`, etc.) and include a colored dot.

5. **Export**
   - Export current page to CSV and XLSX.
   - Confirm header labels match the UI, dates are `1 sep 2026`, money includes `$` and `MXN`, and status labels are in Spanish.

6. **Saved views & filters**
   - Create a filter (e.g. Estado = `Confirmada`), sort by Total, save the view, refresh, and load it.
   - Confirm query, column layout and pagination are restored.

7. **Detail page layout**
   - Open OV-23162 detail.
   - Confirm compact status strip, top summary cards, 2-column field grids, and line-item table look correct.

### Open items / needs real payload verification

- **Shipping address vs "Domicilio de entrega del material"** in the PDF: UNIK displays `salesorder.shipping_address.address` per the field map. If the PDF prints a different custom field, raw payload inspection is required before changing the source.
- **104 vs total Zoho orders**: historical baseline records without detail snapshots are intentionally not shown in the workspace.
