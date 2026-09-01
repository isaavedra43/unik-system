# UNIK Design System

Guía visual y de componentes para todos los módulos futuros de UNIK.

## 1. Tokens CSS

Los tokens viven en `src/app/globals.css` bajo el selector `:root`.

### 1.1 Colores

| Token            | Variable                               | Uso                                     |
| ---------------- | -------------------------------------- | --------------------------------------- |
| Fondo            | `--unik-bg`                            | Fondo general de la aplicación          |
| Superficie       | `--unik-surface`                       | Cards, paneles, topbar, sidebar         |
| Superficie hover | `--unik-surface-hover`                 | Fila hover, hover de links              |
| Borde            | `--unik-border`                        | Bordes de tarjetas, inputs, separadores |
| Borde sutil      | `--unik-border-subtle`                 | Líneas internas de tablas               |
| Texto            | `--unik-text`                          | Texto principal                         |
| Texto secundario | `--unik-text-secondary`                | Subtítulos, metadatos                   |
| Texto atenuado   | `--unik-text-muted`                    | Placeholders, breadcrumbs               |
| Marca            | `--unik-brand`                         | Botones primarios, focus, links         |
| Éxito            | `--unik-success` / `--unik-success-bg` | Badges y alertas de éxito               |
| Peligro          | `--unik-danger` / `--unik-danger-bg`   | Badges y alertas destructivas           |
| Advertencia      | `--unik-warning` / `--unik-warning-bg` | Alertas de advertencia                  |

### 1.2 Tipografía

- Fuente: pila del sistema (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial`)
- Escala: `--unik-text-xs` (0.75rem) a `--unik-text-2xl` (2rem)
- Pesos: 400, 500, 600, 700

### 1.3 Espaciado

Escala base 4: `--unik-space-1` (0.25rem) a `--unik-space-16` (4rem).

### 1.4 Radios y sombras

- Radios: `--unik-radius-sm` (6px) a `--unik-radius-full`
- Sombras: `--unik-shadow-sm`, `--unik-shadow-md`, `--unik-shadow-lg`

### 1.5 Layout

- Sidebar ancho: `--unik-sidebar-width` (256px)
- Topbar alto: `--unik-topbar-height` (60px)
- Contenido máximo: `--unik-content-max` (1440px)

## 2. Componentes UI

Ubicados en `src/components/ui/`. No agregar dependencias externas de UI.

### 2.1 Primitivos (`src/components/ui/primitives.tsx`)

- `Button` — `primary`, `secondary`, `ghost`, `danger`; tamaños `sm`, `md`, `lg`
- `Input`, `Select`, `Textarea` — form inputs con estados unificados
- `FormField` — label + help + error
- `Checkbox` — checkbox con descripción
- `Badge` — variantes `default`, `success`, `danger`, `warning`, `info`, `weak`
- `Avatar` — iniciales del nombre
- `Alert` — error, success, warning, info
- `Spinner`

### 2.2 Iconos (`src/components/ui/icons.tsx`)

SVG inline propios. Uso:

```tsx
import { Icon } from '@/components/ui/icons';
<Icon name="users" size={20} />;
```

### 2.3 Compuestos (`src/components/ui/composite.tsx`)

- `Modal` — confirmaciones, pequeño
- `Drawer` — paneles laterales de creación/edición (md: 520px, lg: 640px)
- `DropdownMenu` — menú contextual
- `TabNav` — tabs basados en URL
- `PageHeader` — título + descripción + acciones
- `Breadcrumbs` — migajas simples
- `EmptyState` — estado vacío profesional
- `Toast` — feedback temporizado

### 2.4 Layout (`src/components/layout/AppShell.tsx`)

`AppShell` provee sidebar, topbar, account menu y breadcrumbs. Recibe el usuario autenticado.

## 3. Layout

- Desktop: sidebar fijo izquierdo + topbar
- Tablet/Móvil: sidebar colapsa a drawer
- Contenido centrado con `app-content`

## 4. Navegación

- Sidebar agrupada por secciones: General, Administración, Cuenta
- Futuras: Ventas, Inventario, Logística, Reportes
- "Usuarios y permisos" visible si `users.view` o `roles.view`
- Active state con fondo `--unik-brand-subtle`

## 5. Tablas

- `.table` dentro de `.table-wrap`
- Headers en mayúsculas, filas con hover, densidad ajustada
- Acciones al final, preferentemente en menú contextual

## 6. Formularios

- Siempre `FormField` con `label` y `htmlFor`
- Errores inline debajo del input
- Footer sticky en drawers
- Primary action a la derecha

## 7. Badges

| Variante  | Uso                          |
| --------- | ---------------------------- |
| `success` | Activo, pagado, entregado    |
| `danger`  | Inactivo, cancelado, errores |
| `warning` | Pendiente, cambio requerido  |
| `info`    | Sistema, metadatos           |
| `weak`    | Roles, etiquetas secundarias |

## 8. Modals y Drawers

- Modal: confirmaciones destructivas
- Drawer: crear, editar, configurar
- ESC cierra si no hay acción irreversible en progreso
- Focus visible en botones primarios

## 9. Responsive

- Desktop principal: 1440–1920px
- Tablet: 1024px, sidebar colapsa
- Móvil: 640px, drawers y stacks

## 10. Accesibilidad

- `aria-label` en icon buttons
- `aria-current="page"` en navegación activa
- Focus visible y contraste adecuado
- Labels asociados a inputs

## 11. Extensiones futuras

Para nuevos módulos:

1. Reutilizar `.card`, `.table`, `.form-field`, `.btn`
2. Usar `PageHeader` con breadcrumbs
3. Extender `src/components/ui/icons.tsx` con SVGs del módulo
4. No hardcodear colores; usar variables CSS
