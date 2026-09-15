# Component Inventory — UNIK

Tabla viva de componentes compartidos. Mantener actualizada.

| Component     | Path                                                                        | Purpose                                                                                 | Variants                                                             | Story   | Category     |
| ------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------- | ------------ |
| Button        | `src/components/shadcn/button.tsx`                                          | Acciones                                                                                | default, secondary, outline, ghost, destructive, link                | planned | Actions      |
| Input         | `src/components/shadcn/input.tsx`                                           | Text input                                                                              | -                                                                    | planned | Forms        |
| Label         | `src/components/shadcn/label.tsx`                                           | Form labels                                                                             | -                                                                    | planned | Forms        |
| Checkbox      | `src/components/shadcn/checkbox.tsx`                                        | Boolean                                                                                 | -                                                                    | planned | Forms        |
| Switch        | `src/components/shadcn/switch.tsx`                                          | Toggle                                                                                  | -                                                                    | planned | Forms        |
| Select        | `src/components/shadcn/select.tsx`                                          | Dropdown select                                                                         | -                                                                    | planned | Forms        |
| Dialog        | `src/components/shadcn/dialog.tsx`                                          | Modal                                                                                   | -                                                                    | planned | Overlays     |
| Drawer        | `src/components/shadcn/drawer.tsx`                                          | Side panel                                                                              | -                                                                    | planned | Overlays     |
| Sheet         | `src/components/shadcn/sheet.tsx`                                           | Side panel                                                                              | -                                                                    | planned | Overlays     |
| Dropdown Menu | `src/components/shadcn/dropdown-menu.tsx`                                   | Context menu                                                                            | -                                                                    | planned | Navigation   |
| Tabs          | `src/components/shadcn/tabs.tsx`                                            | Tab navigation                                                                          | -                                                                    | planned | Navigation   |
| Card          | `src/components/shadcn/card.tsx`                                            | Content containers                                                                      | -                                                                    | planned | Data Display |
| Badge         | `src/components/shadcn/badge.tsx`                                           | Status/labels                                                                           | default, secondary, outline, destructive                             | planned | Data Display |
| Avatar        | `src/components/shadcn/avatar.tsx`                                          | User avatars                                                                            | -                                                                    | planned | Data Display |
| Table         | `src/components/shadcn/table.tsx`                                           | Table primitives                                                                        | -                                                                    | planned | Data Display |
| DataTable     | `src/components/patterns/DataTable.tsx`                                     | Enterprise table                                                                        | sorting, pagination, loading, empty                                  | planned | Patterns     |
| ErrorState    | `src/components/patterns/ErrorState.tsx`                                    | Error de vista de datos con reintento                                                   | default, compact, sin reintento                                      | yes     | Patterns     |
| LoadingState  | `src/components/patterns/LoadingState.tsx`                                  | Skeleton con la forma del contenido                                                     | table, kpi, chat, list                                               | yes     | Patterns     |
| StatCard      | `src/components/patterns/dashboard/StatCard.tsx`                            | Tile de KPI (sustituye AssistantAdminStatCard / ChatAdminStatCard)                      | tone default/success/warning/danger/info, delta, href, live, loading | yes     | Dashboard    |
| KpiGrid       | `src/components/patterns/dashboard/KpiGrid.tsx`                             | Rejilla responsiva de StatCard (4→3→2→1 en 1366/1024/640; con 4 u 8 tiles, 4→2→1)       | columns 2, 3, 4                                                      | yes     | Dashboard    |
| ChartCard     | `src/components/patterns/dashboard/ChartCard.tsx`                           | Marco de gráfica o bloque de dashboard (la altura es mínima: el contenido alto crece)   | loading, empty, error con reintento, actions, height auto            | yes     | Dashboard    |
| TrendChart    | `src/components/patterns/dashboard/TrendChart.tsx`                          | Serie temporal (Recharts) con tabla accesible                                           | line, area, multi-serie, empty                                       | yes     | Dashboard    |
| BarBreakdown  | `src/components/patterns/dashboard/BarBreakdown.tsx`                        | Barras horizontales por categoría (Recharts)                                            | tone por barra, valueFormat, empty                                   | yes     | Dashboard    |
| StatusStrip   | `src/components/patterns/dashboard/StatusStrip.tsx`                         | Barra proporcional por estado (CSS, role img + leyenda)                                 | con/sin leyenda, empty                                               | yes     | Dashboard    |
| AlertList     | `src/components/patterns/dashboard/AlertList.tsx`                           | Alertas con severidad textual, enlace y hora                                            | info/warning/danger, max, moreHref, empty                            | yes     | Dashboard    |
| chart-theme   | `src/components/patterns/dashboard/chart-theme.ts` (+ `use-chart-theme.ts`) | Paleta `--unik-chart-1..6`, orden de series `SERIES_TONE_ORDER` y props de ejes/tooltip | —                                                                    | n/a     | Dashboard    |

> Kit de dashboard: importa por ruta directa (p. ej. `@/components/patterns/dashboard/StatCard`). El barrel `@/components/patterns` no incluye gráficas: `TrendChart`, `BarBreakdown` y `useChartTheme` dependen de `recharts` y están en `@/components/patterns/dashboard/charts`.
>
> Orden de series por defecto (`toneAt`): brand, warning, info, success, muted, danger. Se eligió con el validador de paleta (OKLab ΔE ×100, protanopia/deuteranopia): el peor par adyacente mide ΔE 12 (CVD) / 16.5 (visión normal) en tema claro y 11.1 / 18.5 en oscuro. En el orden de los tokens, brand e info (dos azules marino) medían ΔE 9 en tema claro. Una serie que significa bueno/malo usa `success`/`danger` explícitamente.
>
> Migración a `StatCard` (Asistente, Chat, Integraciones, Monitoreo de extensiones, Archivos, Voz y Campañas): se adoptó el diseño único del kit. La etiqueta va arriba en mayúsculas, el valor en `text-lg`/600 y el icono en una caja de 40 px con radio `md`. Sólo hay hover cuando la tarjeta es enlace (`href`). Los cortes responsive son los de `KpiGrid`. Antes, Integraciones y Monitoreo ponían el valor arriba y Chat usaba `text-xl`/700 con hover. El tono refleja un estado real del dato (umbral con `successRateTone` o conteo > 0). Las métricas sin umbral, como latencia o duración, van en tono neutro.

## Cómo actualizar

Al agregar un componente shared, añadir fila con:

- Nombre
- Path exacto
- Propósito de 1 línea
- Variantes
- Si tiene story
- Categoría
