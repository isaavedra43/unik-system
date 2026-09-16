# Frontend Dependencies — UNIK

## CORE INSTALLED

| Dependency                 | Purpose                              | Production | Where used                                    |
| -------------------------- | ------------------------------------ | ---------- | --------------------------------------------- |
| `tailwindcss`              | Motor de estilos utility-first       | build      | `postcss.config.mjs`, `src/styles/shadcn.css` |
| `@tailwindcss/postcss`     | PostCSS plugin v4                    | build      | `postcss.config.mjs`                          |
| `class-variance-authority` | Variants tipadas                     | yes        | shadcn components                             |
| `clsx`                     | Concatenación condicional de clases  | yes        | `cn()`                                        |
| `tailwind-merge`           | Merge inteligente de clases Tailwind | yes        | `cn()`                                        |
| `lucide-react`             | Iconos oficiales                     | yes        | toda UI                                       |
| `motion`                   | Animaciones                          | yes        | `src/lib/motion`                              |
| `next-themes`              | Light/Dark/System                    | yes        | `src/components/providers.tsx`                |
| `sonner`                   | Toast                                | yes        | `src/components/providers.tsx`                |
| `react-hook-form`          | Forms complejos client-side          | yes        | forms avanzados                               |
| `@hookform/resolvers`      | Integración Zod con RHF              | yes        | forms avanzados                               |
| `date-fns`                 | Manipulación de fechas               | yes        | date pickers, formatos                        |
| `recharts`                 | Gráficas                             | yes        | dashboards futuros                            |
| `@tanstack/react-table`    | Tablas avanzadas                     | yes        | `DataTable`                                   |
| `@tanstack/react-virtual`  | Virtualización                       | yes        | listas/tablas grandes                         |
| `@xyflow/react`            | Lienzo de nodos (React Flow 12)      | yes        | sólo `/app/admin/control-tower/neural/*`      |
| `@dnd-kit/core`            | Arrastrar y soltar accesible         | yes        | tableros y reordenar columnas                 |
| `@dnd-kit/sortable`        | Listas ordenables sobre `@dnd-kit`   | yes        | tableros y reordenar columnas                 |
| `@dnd-kit/utilities`       | Helpers (`CSS.Transform`) de dnd-kit | yes        | tableros y reordenar columnas                 |
| `radix-ui`                 | Primitivas accesibles de shadcn      | yes        | `src/components/shadcn/*`                     |
| `@base-ui/react`           | Primitiva del combobox               | yes        | `src/components/shadcn/combobox.tsx`          |
| `cmdk`                     | Paleta de comandos                   | yes        | `src/components/shadcn/command.tsx`           |
| `vaul`                     | Drawer en móvil                      | yes        | `src/components/shadcn/drawer.tsx`            |
| `react-day-picker`         | Calendario                           | yes        | `src/components/shadcn/calendar.tsx`          |
| `livekit-client`           | Sala de voz/llamada en el navegador  | yes        | `src/components/calls/CallRoom.tsx`           |
| `leaflet`                  | Motor de mapas 2D (sin WebGL)        | yes        | despacho y ubicación del chat                 |
| `react-leaflet`            | Envoltorio React de Leaflet          | yes        | despacho y ubicación del chat                 |

### `@dnd-kit/*` — condiciones de uso

Aprobada al construir el tablero de producción y el despacho (plan 7.6) y reusada por las
tablas que dejan reordenar columnas. Los tres paquetes van juntos: `sortable` y `utilities`
no funcionan sin `core`.

- Dónde se usa hoy (7 `DndContext`): `EntityWorkspace`, `SalesOrdersWorkspace`,
  `ContactsWorkspace` (reordenar columnas) y `PipelineBoard`, `ProductionBoard`,
  `DispatchBoard`, `VehicleTimeline` / `TripStopsEditor` (arrastrar tarjetas y paradas).
- **Todo `DndContext` nuevo lleva `id={useId()}`.** Sin ese `id`, dnd-kit numera sus ids de
  accesibilidad con un contador de módulo: el `aria-describedby` sale distinto en el
  servidor y en el cliente, React descarta la hidratación y **vuelve a dibujar la tabla
  entera**. Se detectó en el navegador contra el build de producción, no en las pruebas.
- Sólo en Client Components (`'use client'`): arrastrar no existe en el servidor.
- **El arrastre nunca es la única forma de hacer algo.** Hoy se cumple: `PipelineBoard`,
  `DispatchBoard` y `TripStopsEditor` registran `KeyboardSensor`; `ProductionBoard` ofrece
  «Mover a…» en cada tarjeta; las tres tablas ofrecen «Mover izquierda / Mover derecha» en
  el menú de la columna, y `TripStopsEditor` además «Subir / Bajar». Un tablero nuevo sin
  salida de teclado ni acción equivalente no pasa.

### `@xyflow/react` — condiciones de uso

Aprobada para UNIK Neural Operations (plan 7.8) por el [ADR-002](./decisions/ADR-002-graph-renderer.md).

- Se carga **únicamente** con `dynamic(() => import(...), { ssr: false })` desde
  `ProcessViewer` y `GraphExplorer` (`src/components/control-tower/neural/`). Ninguna otra
  ruta paga su bundle; si hace falta un lienzo en otro módulo, hay que revisar el ADR antes.
- Su hoja `@xyflow/react/dist/style.css` se importa en
  `src/app/app/admin/control-tower/neural/layout.tsx` y se reviste con tokens en
  `src/styles/operations/neural-ops.css` (las variables `--xy-*` apuntan a `--unik-*`).
- En ≤768 px NO se monta el lienzo: la misma información se lee como lista.
- Tope de nodos dibujados: 500 (`GRAPH_RENDER_LIMIT`). El tope del servidor es 2 000.

### `leaflet` + `react-leaflet` — condiciones de uso

Aprobada para el mapa de ubicación del chat y reusada por el mapa de despacho (plan 7.6).
Se eligió sobre `MapLibre GL` (que sigue en «APPROVED ON DEMAND») porque estos dos mapas
dibujan decenas de pines sobre teselas ráster: no hay nada que justifique un motor WebGL,
y Leaflet funciona en equipos sin aceleración. Los dos paquetes van juntos y `@types/leaflet`
(devDependency) es el tipado de `leaflet`.

- Se carga **únicamente** con `dynamic(() => import(...), { ssr: false })`: Leaflet toca
  `window` al importarse. Hoy son dos puntos de carga — `ChatMessage` →
  `src/components/chat/ChatLocationMap.tsx` y `DispatchBoard` →
  `src/components/areas/logistica/DispatchMap.tsx`. Ninguna otra ruta paga su bundle.
- Su hoja `leaflet/dist/leaflet.css` la importa cada uno de esos dos componentes (no el
  layout) y se reviste con tokens en `src/styles/operations/logistica.css`
  (`.dispatch-map-canvas .leaflet-container`). Las imágenes del marcador se sirven desde
  `public/leaflet/`, no desde un CDN.
- En ≤768 px el mapa de despacho NO desaparece: es una de las tres pestañas del tablero
  (`.dispatch-column-active`, `min-height: 18rem`), porque un mapa sin alternativa en móvil
  dejaría al despachador sin la vista del día.
- **El mapa nunca es la única forma de hacer algo.** Hoy se cumple: cada pin corresponde a
  una fila de la columna «Sin asignar» o del viaje, y cargar, reordenar y entregar se hace
  desde esas listas; el mapa sólo selecciona y muestra.
- Sólo llegan números al HTML del pin (`L.divIcon`); todo texto escrito por una persona se
  pinta como hijo de React dentro del popup, nunca como markup.

## STORYBOOK / TESTING

| Dependency                   | Purpose                    | Production | Where used              |
| ---------------------------- | -------------------------- | ---------- | ----------------------- |
| `storybook`                  | UI Lab                     | dev        | `.storybook/`           |
| `@storybook/nextjs-vite`     | Framework Vite for Next    | dev        | `.storybook/main.ts`    |
| `@storybook/addon-a11y`      | Accesibilidad              | dev        | Storybook               |
| `@storybook/addon-vitest`    | Component tests            | dev        | Storybook               |
| `@storybook/addon-docs`      | Docs de las stories        | dev        | `.storybook/main.ts`    |
| `@storybook/addon-mcp`       | Storybook por MCP          | dev        | `.storybook/main.ts`    |
| `@chromatic-com/storybook`   | Regresión visual           | dev        | `.storybook/main.ts`    |
| `vitest`                     | Unit/component tests       | dev        | `vitest.config.ts`      |
| `playwright`                 | E2E y visual regression    | dev        | `playwright.config.ts`  |
| `@vitest/browser-playwright` | Browser testing con Vitest | dev        | `vitest.config.ts`      |
| `@vitest/coverage-v8`        | Cobertura (`--coverage`)   | dev        | `vitest run --coverage` |

## APPROVED ON DEMAND

NO instalar hasta que un módulo realmente lo necesite. La lista es una puerta, no una
sugerencia: `src/components/frontend-dependencies.test.ts` falla si algo de aquí abajo
aparece en `package.json`, si una fila nombra un paquete que no está instalado, si se
instala un paquete de una familia ya aprobada (`@dnd-kit/*`, `@tanstack/*`…) sin su fila,
o si un Client Component importa un paquete instalado que no tiene fila — que es como
entró Leaflet, usado en dos mapas mientras el documento sólo hablaba de `MapLibre GL`.
Fuera de esa puerta quedan la plataforma y lo que no es de frontend: `next`, `react`,
`react-dom` y `zod` (validación compartida con el servidor).

- `@tanstack/react-query`
- `react-resizable-panels`
- `react-dropzone`
- `MapLibre GL`
- `Sigma.js` + `Graphology` — motor WebGL para el grafo operativo. **Diferidos** por el
  [ADR-002](./decisions/ADR-002-graph-renderer.md). Disparador para instalarlos: que las
  escenas guardadas (`CtGraphScene`) pasen habitualmente de 500 nodos dibujados
  (`GraphView.hiddenNodes > 0` en la mayoría de las aperturas), que alguien necesite
  explorar por encima del tope de servidor de 2 000 nodos, o que el dibujo tarde más de
  ~1 s en equipos de oficina con una escena típica.
- `Tiptap`
- `Embla Carousel`
- `MSW`

## NOT ALLOWED WITHOUT REVIEW

- `moment.js`
- Icon libraries extra sin justificación
- Component libraries masivos que dupliquen shadcn
- Paquetes no oficiales con analytics/llamadas externas
