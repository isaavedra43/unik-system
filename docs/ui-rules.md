# UI Rules — UNIK Design System

## Stack oficial

- Tailwind CSS v4
- shadcn/ui en `src/components/shadcn/`
- `cn()` en `src/lib/utils.ts`
- `lucide-react` para iconos
- `motion` para animaciones
- `next-themes` para theming
- `sonner` para toast

## Primitives

Usar shadcn primitives siempre que existan. NO duplicar.

- Button → `src/components/shadcn/button.tsx`
- Input → `src/components/shadcn/input.tsx`
- Select → `src/components/shadcn/select.tsx`
- Dialog → `src/components/shadcn/dialog.tsx`
- Drawer → `src/components/shadcn/drawer.tsx`
- Tabs → `src/components/shadcn/tabs.tsx`
- Table → `src/components/shadcn/table.tsx`
- Card → `src/components/shadcn/card.tsx`
- Badge → `src/components/shadcn/badge.tsx`
- Avatar → `src/components/shadcn/avatar.tsx`

## Tokens

Usar tokens CSS de `src/styles/shadcn.css` y `src/app/globals.css`.

NO usar hex random ni valores mágicos:

```css
/* PROHIBIDO */
.bg-[#1e3a5f]
.margin-\[17px\]

/* PERMITIDO */
.bg-primary
.border-border
.text-muted-foreground
```

## Drawer vs Modal vs Full Page

- **Modal**: confirmación corta, eliminar, alerta.
- **Drawer**: crear/editar/configurar extensa.
- **Full Page**: workflow complejo o multi-step.

## Formularios

- `Form` de shadcn + `react-hook-form` para forms complejos.
- Server Actions + Zod para forms simples.
- Mensaje de error cerca del campo.
- Alert para errores de servidor generales.
- Botón submit deshabilitado mientras `pending`.

## Estados

Toda vista de datos debe considerar:

- loading
- empty
- error
- success

## Empty / Error / Loading

```tsx
import { EmptyState, ErrorState, LoadingState } from '@/components/patterns';
```

## Feedback

- Idle, hover, focus, loading, success, error, disabled.
- No double submit.

## Iconos

- `lucide-react` por defecto.
- 16px compact, 18/20 normal, 24 prominent.
- Icon buttons con `aria-label`.
- Tooltip si el significado no es obvio.

## PROHIBIDO

- Emojis como iconos de UI.
- SVG random de diferentes estilos.
- Gradientes por todos lados.
- Glassmorphism gratuito.
- Cards redondas gigantes sin razón.
- Hero sections dentro de ERP.
- Excesivo whitespace.
- Random purple gradients / 3D blobs.
- Fake metrics.
- Enorme typography.
- Excessive animations.
