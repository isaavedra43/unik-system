# ADR-002: Motor de dibujo del grafo operativo

## Estado

Aceptado — 2026-09-15 (plan 7.8c, UNIK Neural Operations)

## Contexto

UNIK Neural Operations necesita dibujar dos cosas distintas:

1. **El proceso definido** (`/admin/control-tower/neural/procesos`): entre 10 y 60 pasos
   con sus dependencias. El acomodo NO lo decide la librería: lo calcula
   `src/modules/control-tower/process-layout.ts` (capas por camino más largo +
   orden baricéntrico, sin dagre). La librería sólo pinta, hace zoom y da teclado.
2. **La red operativa** (`/admin/control-tower/neural/grafo`): expedientes, órdenes,
   entregas, obligaciones y sus relaciones. El servidor ya acota a **2 000 nodos**
   (`MAX_GRAPH_NODES` en `perspectives.ts`) y la pantalla dibuja a lo sumo **500**
   (`GRAPH_RENDER_LIMIT` en `graph-model.ts`), avisando cuando recorta.

Las dos opciones reales eran:

- **React Flow (`@xyflow/react`)**: DOM + SVG. Cada nodo es un componente de React, así
  que un nodo puede usar los mismos tokens, badges y estados de foco que el resto del ERP.
  Trae arrastre, zoom, minimapa, controles y navegación por teclado. Se degrada mal
  a partir de ~1 000 nodos visibles, porque cada nodo es un elemento del DOM.
- **Sigma.js + Graphology**: WebGL. Aguanta decenas de miles de nodos, pero un nodo se
  dibuja con una rutina de WebGL, no con un componente: perdemos los tokens, el foco
  visible, los badges y la accesibilidad del resto del sistema, y añadimos dos
  dependencias más un modelo de grafo propio (Graphology).

Ambas estaban listadas como "APPROVED ON DEMAND" en `docs/frontend-dependencies.md`.

## Decisión

**React Flow primero.** Se instala `@xyflow/react@12` y se carga **sólo** en las rutas
`/app/admin/control-tower/neural/*`, con `dynamic(() => import(...), { ssr: false })` en
`ProcessViewer` y `GraphExplorer`. Ninguna otra ruta del sistema paga ese bundle.

**Sigma.js + Graphology quedan diferidos**, no descartados. Siguen documentados como
aprobados bajo demanda, con un disparador explícito (abajo).

## Razones

- El tope real de esta fase es de 500 nodos dibujados: React Flow va sobrado.
- Los nodos son componentes de React (`StepNode`, `GraphNode`), así que usan los tokens
  `--unik-*`, los estados de foco y las insignias del propio sistema de diseño. Un nodo
  de WebGL sería un dibujo aparte, con su propia paleta y sin foco visible.
- Accesibilidad: React Flow hace los nodos enfocables y navegables con el tabulador;
  además tenemos siempre la lista equivalente (obligatoria en ≤768 px), que es la que de
  verdad hace la superficie usable con teclado y con lector de pantalla.
- Una dependencia en vez de dos, y ningún modelo de grafo adicional en el cliente: el
  recorrido ya lo hace PostgreSQL con una CTE recursiva en `graph-service.ts`.
- Se puede cambiar después sin tocar la lógica: `graph-model.ts` es puro y no sabe de
  React Flow. Sustituir el motor es reescribir `GraphCanvas.tsx`, no el explorador.

## Disparador para retomar Sigma.js + Graphology

Se instalan cuando se cumpla **cualquiera** de estas condiciones, medida sobre uso real:

- Las **escenas guardadas** (`CtGraphScene`) superan habitualmente los **500 nodos**
  —es decir, `GraphView.hiddenNodes > 0` en la mayoría de las aperturas de escena—, o
- alguien necesita explorar por encima del tope de servidor de 2 000 nodos, o
- el dibujo tarda más de ~1 s en equipos de oficina con una escena típica.

Mientras eso no pase, subir el tope de dibujo sólo empeora la experiencia: una maraña de
2 000 nodos no se lee. El camino correcto antes de cambiar de motor es acotar mejor la
perspectiva, bajar la profundidad o filtrar tipos de nodo.

## Consecuencias

- `@xyflow/react` es dependencia de producción y su hoja `dist/style.css` se importa en
  `src/app/app/admin/control-tower/neural/layout.tsx`, revestida con tokens en
  `src/styles/operations/neural-ops.css` (las variables `--xy-*` se mapean a `--unik-*`,
  de modo que el lienzo respeta el tema claro/oscuro del sistema).
- En ≤768 px NO se monta el lienzo: la misma información se lee como lista. Eso lo decide
  `useIsMobile()`, no el CSS, para no cargar la librería en un teléfono.
- El recorte a 500 nodos y su aviso viven en `graph-model.ts` (puro, con pruebas), no en
  el componente: si mañana cambia el motor, la regla no se mueve.
- La atribución de React Flow se deja visible (`hideAttribution: false`).
