# Frontend Dependencies — UNIK

## CORE INSTALLED

| Dependency                    | Purpose                               | Production | Where used                                    |
| ----------------------------- | ------------------------------------- | ---------- | --------------------------------------------- |
| `tailwindcss`                 | Motor de estilos utility-first        | build      | `postcss.config.mjs`, `src/styles/shadcn.css` |
| `@tailwindcss/postcss`        | PostCSS plugin v4                     | build      | `postcss.config.mjs`                          |
| `class-variance-authority`    | Variants tipadas                      | yes        | shadcn components                             |
| `clsx`                        | Concatenación condicional de clases   | yes        | `cn()`                                        |
| `tailwind-merge`              | Merge inteligente de clases Tailwind  | yes        | `cn()`                                        |
| `lucide-react`                | Iconos oficiales                      | yes        | toda UI                                       |
| `motion`                      | Animaciones                           | yes        | `src/lib/motion`                              |
| `next-themes`                 | Light/Dark/System                     | yes        | `src/components/providers.tsx`                |
| `sonner`                      | Toast                                 | yes        | `src/components/providers.tsx`                |
| `react-hook-form`             | Forms complejos client-side           | yes        | forms avanzados                               |
| `@hookform/resolvers`         | Integración Zod con RHF               | yes        | forms avanzados                               |
| `date-fns`                    | Manipulación de fechas                | yes        | date pickers, formatos                        |
| `recharts`                    | Gráficas                              | yes        | dashboards, reportes IA                       |
| `@tanstack/react-table`       | Tablas avanzadas                      | yes        | `DataTable`                                   |
| `@tanstack/react-virtual`     | Virtualización                        | yes        | listas/tablas grandes                         |
| `@dnd-kit/*`                  | Drag & drop (core/sortable/utilities) | yes        | reorden de columnas en workspaces             |
| `radix-ui` / `@base-ui/react` | Primitivas accesibles                 | yes        | componentes `src/components/shadcn`           |
| `cmdk`                        | Command palette                       | yes        | `command.tsx`                                 |
| `vaul`                        | Drawer                                | yes        | `drawer.tsx`                                  |
| `react-day-picker`            | Date picker                           | yes        | `calendar.tsx`                                |
| `leaflet` + `react-leaflet`   | Mapas                                 | yes        | ubicaciones de chat                           |
| `livekit-client`              | WebRTC cliente                        | yes        | `CallRoom.tsx`                                |
| `@mcp-ui/client`              | Renderer `ui://` de servidores MCP    | yes        | `McpUiFrame` (asistente)                      |

## STORYBOOK / TESTING

| Dependency                   | Purpose                    | Production | Where used             |
| ---------------------------- | -------------------------- | ---------- | ---------------------- |
| `storybook`                  | UI Lab                     | dev        | `.storybook/`          |
| `@storybook/nextjs-vite`     | Framework Vite for Next    | dev        | `.storybook/main.ts`   |
| `@storybook/addon-a11y`      | Accesibilidad              | dev        | Storybook              |
| `@storybook/addon-vitest`    | Component tests            | dev        | Storybook              |
| `vitest`                     | Unit/component tests       | dev        | `vitest.config.ts`     |
| `playwright`                 | E2E y visual regression    | dev        | `playwright.config.ts` |
| `@vitest/browser-playwright` | Browser testing con Vitest | dev        | `vitest.config.ts`     |

## APPROVED ON DEMAND

NO instalar hasta que un módulo realmente lo necesite:

- `@tanstack/react-query`
- `react-resizable-panels`
- `react-dropzone`
- `MapLibre GL`
- `React Flow`
- `Tiptap`
- `Embla Carousel`
- `MSW`

(Nota: `@dnd-kit/*`, `cmdk`, `vaul`, `react-day-picker` y `leaflet` ya están
instalados — ver tabla CORE.)

## NOT ALLOWED WITHOUT REVIEW

- `moment.js`
- Icon libraries extra sin justificación
- Component libraries masivos que dupliquen shadcn
- Paquetes no oficiales con analytics/llamadas externas
