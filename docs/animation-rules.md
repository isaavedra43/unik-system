# Animation Rules — UNIK

## Permitido

- Modal entrance.
- Drawer slide.
- Popover scale/fade.
- Hover state transitions.
- Navigation indicator.
- List insert/remove.
- Skeleton transition.
- Small state transitions.

## Prohibido

- Constant floating.
- Background animation.
- Giant hero animation.
- Bounce everywhere.
- Long transitions (>500ms).
- Layout-heavy animations.

## Tokens

```ts
import { duration, ease } from '@/lib/motion';
```

- fast: 0.15s
- normal: 0.22s
- slow: 0.32s

## Reduced motion

Toda animación importante debe respetar `prefers-reduced-motion`.

`motion` lo soporta nativamente con `transition={{ duration: 0.01 }}` o `reducedMotion`.

## Performance

- Preferir `transform` y `opacity`.
- No animar `width`, `height`, `top`, `left` si se puede evitar.
- No convertir Server Component a client solo para animar.

## Presets

```ts
import { fadeIn, fadeUp, scaleIn, slideInRight, listItem } from '@/lib/motion';
```

## Focus

Focus rings visibles y consistentes. No `outline: none` sin replacement.
