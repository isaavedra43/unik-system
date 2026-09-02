# AGENTS.md — Reglas para cualquier agente Devin en UNIK

Este documento es OBLIGATORIO para todo agente Devin que modifique UI en UNIK.

## REGLA OPERATIVA PERMANENTE — LIMITACIONES DE DEVIN

### Devin NO tiene acceso a

- Railway producción
- PostgreSQL producción
- Zoho real
- Postman del usuario
- Navegador autenticado del usuario
- Credenciales reales
- Datos reales fuera del repo
- Infraestructura externa del usuario

### Devin NO debe

- Aplicar migrations (`prisma migrate deploy`, `prisma db push`)
- Conectarse a DB producción
- Conectarse a Zoho
- Llamar APIs reales de UNIK
- Hacer tests end-to-end reales
- Crear usuarios reales
- Modificar una orden real
- Esperar scheduler real
- Verificar notificaciones reales
- Desplegar
- Hacer commit (sin instrucción explícita del usuario)
- Hacer push (sin instrucción explícita del usuario)
- Afirmar que algo funciona en producción

### Devin SÍ debe hacer

- Modificar código
- Crear archivos Prisma migration SQL
- Ejecutar `prisma generate`, `prisma format`, `prisma validate`
- Ejecutar `typecheck`, `lint`, `format check`, `build`
- Ejecutar Storybook build
- Ejecutar tests locales que NO dependan de servicios reales
- Usar mocks/fixtures
- Revisar SQL generado
- Revisar seguridad y arquitectura
- Documentar pruebas manuales posteriores

### Migraciones

1. Modificar `prisma/schema.prisma`
2. Generar la migration versionada usando tooling oficial/local
3. Revisar `migration.sql`
4. Confirmar que es aditiva
5. Confirmar: NO `DROP TABLE`, NO `DROP COLUMN`, NO `prisma db push`
6. **NO aplicar la migration**

El USUARIO aplicará después: `npx prisma migrate deploy` mediante el Pre-deploy ya configurado en Railway.

### Testing — Reporte final

Dividir claramente el reporte final en:

**A. VALIDACIONES QUE DEVIN SÍ EJECUTÓ**

`prisma generate`, `prisma validate`, `typecheck`, `lint`, `build`, `storybook`, unit/component tests con mocks, Playwright solo si corre completamente local con fixtures.

**B. PRUEBAS REALES PENDIENTES DEL USUARIO**

Aplicar migration en Railway, verificar health, abrir módulo en producción, probar filtros con datos reales, probar export CSV/XLSX, probar persistencia entre sesiones, seguir una orden real, modificar esa orden en Zoho, esperar/ejecutar sync normal, verificar EntityChangeEvent, verificar Notification, verificar unread badge, verificar historial.

**NO marcar estas pruebas como PASSED.** Deben aparecer como: `PENDIENTE DE VALIDACIÓN MANUAL`.

### Datos reales

Si el repo contiene información/documentación de casos reales, puede usarlos únicamente como **EXPECTED ACCEPTANCE VALUES**, pero NO afirmar que los consultó en producción.

### Playwright

Solo ejecutar Playwright si: la aplicación arranca localmente, no requiere DB producción, usa fixtures/mocks, no requiere credenciales reales. Si no es posible, reportar: _"Playwright real del módulo queda pendiente de validación manual/integración."_

### Storybook

Storybook sí puede utilizar mock data y fixtures. Nunca production data.

### Notificaciones

Devin puede construir EntityWatch, EntityChangeEvent, Notification, services, UI, polling interno de notifications, tests locales con mocks. PERO NO puede comprobar el flujo real: Zoho change → Scheduler → Snapshot → Normalizer → ChangeEvent → Notification. Ese flujo se prueba MANUALMENTE después del deployment.

### Final report

Nunca decir _"funciona en producción"_ si no tuvo acceso real. Usar: _"implementado"_, _"validación estática completada"_, _"build correcto"_, _"listo para validación manual"_. Separar siempre:

- **IMPLEMENTADO**
- **VALIDADO LOCALMENTE**
- **PENDIENTE PRODUCCIÓN**

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

## Módulo Sales Orders Workspace

- **Documentación**: `docs/modules/sales-orders.md`
- **Ruta**: `/app/sales/orders`
- **Permisos**: `sales_orders.view`, `sales_orders.export`, `sales_orders.watch`, `sales_orders.share_views`
- **Column registry**: `src/modules/sales/sales-orders-columns.ts` (single source of truth)
- **Filter schema**: `src/modules/sales/sales-orders-filters.ts` (Zod-validated)
- **Server actions**: `src/app/app/sales/orders/actions.ts`
- **UI**: `src/components/sales/` (SalesOrdersWorkspace, SalesOrderPreviewDrawer, SalesOrderDetail, NotificationsPage)
- **Patrón**: Workspace con tabla avanzada (DnD, resize, pinning, density), filtros avanzados, vistas guardadas, watch, notificaciones, export CSV/XLSX
- **Persistencia**: UserTablePreference (layout), TableView (vistas), EntityWatch (watch), EntityChangeEvent (diff), Notification (in-app)
- **Regla**: NUNCA definir columnas ad-hoc en componentes. Siempre usar el column registry.

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
