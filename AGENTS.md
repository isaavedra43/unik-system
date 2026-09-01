# AGENTS.md — Reglas para cualquier agente Devin en UNIK

Este documento es OBLIGATORIO para todo agente Devin que modifique UI en UNIK.

## Antes de tocar cualquier UI

1. Leer:
   - `docs/design-system.md`
   - `docs/ui-rules.md`
   - `docs/responsive-rules.md`
   - `docs/animation-rules.md`
   - `docs/ui-quality-rubric.md`
   - `docs/icon-rules.md`

2. Revisar:
   - `src/components/shadcn/`
   - `src/components/patterns/`
   - `src/lib/motion/`
   - `src/lib/utils.ts`

3. Buscar componente existente antes de crear uno nuevo.

4. PROHIBIDO crear componentes duplicados.

5. Usar design tokens, Tailwind y shadcn siempre que sea posible.

6. Server Components por default. `use client` solo para interacción, animación, form client state, tablas, overlays.

7. Seguridad y permisos nunca se mueven a cliente.

8. Mobile, tablet y desktop deben considerarse simultáneamente.

9. Cada UI nueva debe incluir: loading, empty, error, disabled, responsive, a11y básico, cuando aplique.

10. No datos fake, no lorem ipsum, no métricas inventadas en producción.

## Workflow para nuevos patrones visuales

1. Entender tarea.
2. Inspeccionar UNIK UI actual.
3. Buscar componente/patrón existente.
4. Si no existe, consultar shadcn MCP si está disponible.
5. Comparar al menos 3 patrones conceptuales para UX importante.
6. Adaptar el mejor al UNIK Design System.
7. Implementar con tokens semánticos, no hardcodes.
8. Validar visual, responsive, accesibilidad y quality rubric.

## Componentes prohibidos de duplicar

Antes de crear `Button`, `Input`, `Table`, `Modal`, `Drawer`, `Badge`, `Tabs`, `Select`, `Dropdown`, `Tooltip`, `Popover`, `Card`, `Avatar`, buscar en `src/components/shadcn/`.

## Nuevos módulos de negocio

Ejemplo: Sales Orders

1. Revisar permissions.
2. Definir information architecture.
3. Identificar patterns existentes.
4. Usar `PageHeader`, `DataTable`, `FilterBar`, `CrudDrawer`, `StatusBadge`.
5. Permission-aware UI.
6. Server-side security.
7. Agregar stories si crea componente reusable.
8. Responsive validation.

## Tarea UI no termina hasta que

- `npm run build` pasa
- `npm run lint` pasa
- `npm run typecheck` pasa
- responsive revisado
- sin overflow horizontal
- keyboard basics revisado
- a11y revisado
- design tokens usados
- shared components reutilizados
- Storybook actualizado si crea shared component
- quality rubric >= 8.5

## Prioridades siempre

1. No romper producción.
2. Seguridad.
3. Reuse.
4. Consistencia.
5. Accesibilidad.
6. Performance.
7. Responsive.
8. Visual quality.
9. Developer/AI productivity.
10. Animation/polish.
