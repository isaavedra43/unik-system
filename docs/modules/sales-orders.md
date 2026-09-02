# Sales Orders Operations Workspace

## Overview

The Sales Orders Operations Workspace (`/app/sales/orders`) is a read-only view
of sales orders synced from Zoho, enhanced with advanced filtering,
personalization, export, entity watching, and in-app notifications.

## Routes

| Route                                 | Description                                         |
| ------------------------------------- | --------------------------------------------------- |
| `/app/sales/orders`                   | Main workspace with table, filters, columns, export |
| `/app/sales/orders/api`               | POST API for paginated/filtered data                |
| `/app/sales/orders/[id]`              | Full detail page for a single order                 |
| `/app/sales/orders/[id]/api`          | GET API for order detail + change events            |
| `/app/notifications`                  | Notifications center                                |
| `/app/notifications/api`              | GET API for paginated notifications                 |
| `/app/notifications/api/unread-count` | GET API for unread count                            |

## Permissions

| Key                        | Label                     | Description                           |
| -------------------------- | ------------------------- | ------------------------------------- |
| `sales_orders.view`        | Ver órdenes de venta      | Access the workspace and detail       |
| `sales_orders.export`      | Exportar órdenes de venta | Export to CSV or Excel                |
| `sales_orders.watch`       | Seguir órdenes de venta   | Watch orders for change notifications |
| `sales_orders.share_views` | Compartir vistas          | Share saved views with other users    |

## Architecture

### Data Flow

```
Zoho API → Sync → IntegrationSnapshot → Normalizer → SalesOrder/SalesOrderItem
                                                         ↓
                                              Change Detection
                                                         ↓
                                              EntityChangeEvent
                                                         ↓
                                              Notification (per watcher)
                                                         ↓
                                              UI: Workspace / Detail / Bell
```

### Module Structure

```
src/modules/sales/
  permissions.ts                  — Permission definitions
  sales-orders-columns.ts         — Column registry (single source of truth)
  sales-orders-filters.ts         — Zod schemas for filters, sort, query, views
  sales-orders-service.ts         — Data service (query, filter, sort, export)
  sales-orders-contract.ts        — Canonical UI DTOs + mappers
  sales-orders-helpers.ts         — Display helpers (date, currency, status)
  sales-orders-change-events.ts   — Change detection + notification creation
  table-preferences-service.ts    — Per-user table layout persistence
  table-views-service.ts          — Saved views (private/shared) CRUD
  entity-watch-service.ts         — Entity watch CRUD + bulk operations
  notifications-service.ts        — Notification queries + mark read
```

### UI Components

```
src/components/sales/
  SalesOrdersWorkspace.tsx        — Main workspace (table, toolbar, filters)
  SalesOrderPreviewDrawer.tsx     — Quick preview drawer
  SalesOrderDetail.tsx            — Full detail page
  NotificationsPage.tsx           — Notifications center
```

### Database Models

| Model                 | Purpose                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `UserTablePreference` | Per-user column layout (order, visibility, widths, pinning, density) |
| `TableView`           | Saved views (private or shared) combining query + presentation       |
| `EntityWatch`         | User follows an entity for change notifications                      |
| `EntityChangeEvent`   | Diff of meaningful field changes (idempotent via sourceSnapshotId)   |
| `Notification`        | In-app notification for watchers                                     |

## Features

### Table

- **Column reordering**: Drag-and-drop via `@dnd-kit/sortable`
- **Column visibility**: Toggle via column manager dropdown
- **Column resizing**: Drag resize handle on each header
- **Column pinning**: Pin left or right (sticky columns)
- **Density**: Compact, normal, comfortable
- **Sticky header**: Header stays visible during scroll
- **Horizontal scroll**: For wide tables with many columns

### Filtering

- **Text operators**: contains, not_contains, equals, not_equals, starts_with, is_empty, is_not_empty
- **Select operators**: equals, not_equals, in, not_in, is_empty
- **Number operators**: equals, greater_than, greater_or_equal, less_than, less_or_equal, between
- **Date operators**: equals, before, after, between + shortcuts (today, yesterday, this_week, this_month, last_7_days, last_30_days)
- **Boolean operators**: equals
- **Filter logic**: AND / OR groups
- **Filter chips**: Visual representation of active filters with quick remove

### Sorting

- Single-column sort (click header)
- Multi-column sort (shift+click)
- Visual indicators (asc/desc arrows)

### Personalization

- **Table preferences**: Persisted in PostgreSQL (UserTablePreference)
- **Saved views**: Private or shared (TableView)
- **URL state**: Search, filters, sort, page are in URL (shareable)
- **Presentation state**: Column layout, density, page size in DB (not URL)

### Export

- **Formats**: CSV (with BOM for Excel) and XLSX (via exceljs)
- **Scopes**: Current page, selected rows, all filtered results
- **Columns**: Default visible or all columns
- **Audit**: Export events recorded in AuditLog

### Entity Watching

- **Watch/unwatch**: Per order or bulk (selected rows)
- **Change detection**: Compares meaningful fields only (never technical timestamps)
- **Idempotency**: sourceSnapshotId unique constraint prevents duplicate events
- **First import**: No change event created (no previous version to compare)
- **Notifications**: Created only for active watchers, idempotent per changeEventId

### Notifications

- **Bell icon**: In topbar with unread badge
- **Popover**: Shows 10 most recent notifications
- **Full page**: `/app/notifications` with mark read / mark all read
- **Polling**: Unread count refreshed every 90 seconds

## Security

- All pages and API routes check `sales_orders.view` permission
- Export requires `sales_orders.export`
- Watch requires `sales_orders.watch`
- Share views requires `sales_orders.share_views`
- Saved view editing/deleting requires ownership (or super_admin)
- Filter values are validated server-side via Zod (whitelist of fields/operators)
- Export content is generated server-side (never client-side DB access)

## Migration

Migration `20260902100000_add_sales_orders_workspace` is additive only:

- Creates 5 new tables (UserTablePreference, TableView, EntityWatch, EntityChangeEvent, Notification)
- Adds relations to User model
- No changes to existing tables or business logic

## Canonical UI contract

To avoid snake_case vs camelCase mismatches, the UI uses two canonical camelCase DTOs defined in `src/modules/sales/sales-orders-contract.ts`:

- `SalesOrderListRow` — used by the workspace, export, filters and table preferences.
- `SalesOrderDetail` — used by the detail page and preview drawer.

`getSalesOrdersWorkspace`, `getSalesOrdersForExport` and `getSalesOrderById` map Prisma results into these DTOs before sending JSON. The legacy `/api/internal/sales-orders` route keeps its original snake_case contract and is not changed.

## Display helpers

`src/modules/sales/sales-orders-helpers.ts` centralizes all presentation logic:

- `formatDateOnly(value)` — formats a commercial date (`YYYY-MM-DD`) using UTC parts so that `2026-09-01` always displays as `1 sep 2026` regardless of the user's local time zone.
- `formatDateTime(value)` — formats real timestamps in the user's locale.
- `formatCurrency(value, currencyCode?)` — `$2,396.00 MXN` or `$2,396.00`.
- `formatQuantity(value, unit?)` — preserves units such as `4 m2`.
- `getSalesOrderStatusConfig(raw, category)` — maps raw Zoho status values to Spanish labels and color tones.

Status labels are rendered from a central mapping rather than the raw English string:

| Category | Raw          | Label        | Tone    |
| -------- | ------------ | ------------ | ------- |
| order    | confirmed    | Confirmada   | info    |
| order    | closed       | Cerrada      | success |
| order    | void         | Anulada      | danger  |
| payment  | paid         | Pagada       | success |
| payment  | partial      | Parcial      | warning |
| payment  | unpaid       | Pendiente    | warning |
| invoice  | invoiced     | Facturada    | success |
| invoice  | not_invoiced | No facturada | muted   |
| shipping | shipped      | Enviado      | success |
| shipping | pending      | Pendiente    | warning |
| shipping | packaged     | Empaquetado  | info    |

Unknown raw values are humanized (`custom_status → Custom Status`) and shown with a muted tone.

## Data coverage

Only orders that have been downloaded as a Zoho detail snapshot and normalized appear in the workspace. A `baseline` run marks historical records as "needsSync = false" without creating `SalesOrder` rows or snapshots, so the workspace count can be lower than the total number of orders known by the sync scanner. This is intentional: the workspace shows real, validated detail data, not the scanned summary list.

## Corrections applied (Phase 6.3.1)

1. **Table empty fields** — the workspace table was using `column.id` (camelCase) against a snake_case DTO, so every cell read `undefined` and displayed `—`. Fixed by introducing `SalesOrderListRow` and `toSalesOrderListRow` so the UI contract matches the column registry.
2. **Date timezone bug** — `formatDate` used `new Date('2026-09-01')` and `toLocaleDateString`, which shifted the date back one day in time zones west of UTC. Fixed with `formatDateOnly` that parses and formats using UTC parts.
3. **Empty delivery method** — the normalizer now falls back to `shipping_address.address` when Zoho's `delivery_method` field is empty, based on the documented field map (`shippingAddressLine1` real-world value `RECOGE EN BODEGA`).
4. **Status labels** — raw English status values are now mapped to Spanish labels via `getSalesOrderStatusConfig` in the table, drawer and detail page.
5. **Drawer/detail UX** — both views now use a compact status strip, a top summary row, and denser 2-column field grids.
6. **Export contract** — CSV and XLSX exports now consume `SalesOrderListRow`, with human-readable status labels and currency totals matching the UI.
