# Icon Rules — UNIK

## Fuente oficial

`lucide-react`.

## Tamaños

- 16px: compact, dense, inline.
- 18/20px: normal, botones, menús.
- 24px: prominent, navegación principal.

## Uso

```tsx
import { Users } from 'lucide-react';
<Users className="h-4 w-4" />;
```

## Reglas

- NO emojis como iconos de UI.
- NO mezclar librerías.
- NO SVG random de diferentes estilos.
- Iconos de marca/logos son excepción.

## Icon buttons

Siempre `aria-label`:

```tsx
<button aria-label="Cerrar">
  <X className="h-4 w-4" />
</button>
```

Si el significado no es obvio, usar tooltip.

## Stroke

Mantener `stroke-width` consistente (default `lucide-react`).
