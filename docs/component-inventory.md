# Component Inventory — UNIK

Tabla viva de componentes compartidos. Mantener actualizada. Fuente real:
`src/components/shadcn/` (primitivas), `src/components/patterns/` (patrones de
negocio). Los estados "Story" con `planned` indican cobertura pendiente; las
stories existentes hoy son `button.stories.tsx`, `SalesOrdersWorkspace.stories.tsx`
y `GenerativeUi.stories.tsx`.

## Primitivas (`src/components/shadcn/`)

| Component     | Archivo             | Purpose                        | Category     |
| ------------- | ------------------- | ------------------------------ | ------------ |
| Accordion     | `accordion.tsx`     | Secciones colapsables          | Data Display |
| Alert Dialog  | `alert-dialog.tsx`  | Confirmaciones destructivas    | Overlays     |
| Avatar        | `avatar.tsx`        | Avatares de usuario            | Data Display |
| Badge         | `badge.tsx`         | Status/labels                  | Data Display |
| Breadcrumb    | `breadcrumb.tsx`    | Ruta de navegación             | Navigation   |
| Button        | `button.tsx`        | Acciones (tiene story)         | Actions      |
| Calendar      | `calendar.tsx`      | Date picker (react-day-picker) | Forms        |
| Card          | `card.tsx`          | Contenedores                   | Data Display |
| Checkbox      | `checkbox.tsx`      | Boolean                        | Forms        |
| Collapsible   | `collapsible.tsx`   | Colapso simple                 | Data Display |
| Combobox      | `combobox.tsx`      | Select con búsqueda            | Forms        |
| Command       | `command.tsx`       | Command palette (cmdk)         | Navigation   |
| Context Menu  | `context-menu.tsx`  | Menú contextual                | Navigation   |
| Dialog        | `dialog.tsx`        | Modal                          | Overlays     |
| Drawer        | `drawer.tsx`        | Panel lateral (vaul)           | Overlays     |
| Dropdown Menu | `dropdown-menu.tsx` | Menú desplegable               | Navigation   |
| Form          | `form.tsx`          | react-hook-form + Zod          | Forms        |
| Input         | `input.tsx`         | Text input                     | Forms        |
| Input Group   | `input-group.tsx`   | Input con addons               | Forms        |
| Label         | `label.tsx`         | Labels de formulario           | Forms        |
| Pagination    | `pagination.tsx`    | Paginación                     | Navigation   |
| Popover       | `popover.tsx`       | Popover anclado                | Overlays     |
| Progress      | `progress.tsx`      | Barra de progreso              | Feedback     |
| Radio Group   | `radio-group.tsx`   | Opciones exclusivas            | Forms        |
| Scroll Area   | `scroll-area.tsx`   | Scroll estilizado              | Layout       |
| Select        | `select.tsx`        | Dropdown select                | Forms        |
| Separator     | `separator.tsx`     | Divisor                        | Layout       |
| Sheet         | `sheet.tsx`         | Panel lateral                  | Overlays     |
| Skeleton      | `skeleton.tsx`      | Loading placeholder            | Feedback     |
| Switch        | `switch.tsx`        | Toggle                         | Forms        |
| Table         | `table.tsx`         | Primitivas de tabla            | Data Display |
| Tabs          | `tabs.tsx`          | Navegación por pestañas        | Navigation   |
| Textarea      | `textarea.tsx`      | Texto multilínea               | Forms        |
| Tooltip       | `tooltip.tsx`       | Tooltip                        | Overlays     |

## Patrones (`src/components/patterns/`)

| Component | Archivo         | Purpose                                                                                                       |
| --------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| DataTable | `DataTable.tsx` | Tabla enterprise: sorting, paginación, loading, empty, DnD, resize, pinning, density (base de los workspaces) |

## Patrones de negocio relevantes (fuera de `patterns/`)

| Componente        | Ubicación                                    | Uso                                               |
| ----------------- | -------------------------------------------- | ------------------------------------------------- |
| EntityWorkspace   | `src/components/common/EntityWorkspace.tsx`  | Workspaces genéricos por módulo (tabla+filtros)   |
| NotificationBell  | `src/components/notifications/`              | Campana con badge SSE/push                        |
| GenerativeUi      | `src/components/assistant/generative/`       | Render de specs de UI del asistente (tiene story) |
| MessageBubble     | `src/components/campaigns/MessageBubble.tsx` | Preview WhatsApp/SMS/Telegram                     |
| CallDockProvider  | `src/components/calls/CallDockProvider.tsx`  | Dock global de llamadas                           |
| ProposalCard etc. | `src/components/copilot/`                    | Tarjetas del asistente (aprobación, plan, misión) |

## Cómo actualizar

Al agregar un componente shared, añadir fila con:

- Nombre
- Path exacto
- Propósito de 1 línea
- Variantes
- Si tiene story
- Categoría
