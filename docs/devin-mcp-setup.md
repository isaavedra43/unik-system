# Devin MCP Setup — UNIK

## shadcn MCP

### Qué aporta

Permite a Devin consultar el registro oficial de shadcn para componentes, estilos y ejemplos.

### Cómo conectar

1. Abrir Devin Settings > Integrations.
2. Seleccionar shadcn MCP si está disponible.
3. No requiere token.

### Uso

- Para componentes nuevos, consultar shadcn primero.
- Adaptar a UNIK Design System, no copiar ciegamente.

## 21st.dev

### Qué aporta

Referencias y componentes de terceros. Solo inspiración/input.

### Cómo conectar

1. Crear API key en 21st.dev.
2. Configurar en Devin Settings > Integrations.
3. Key nunca guardada en repo.

### Reglas

- 21st es INSPIRACIÓN.
- Antes de incorporar: revisar dependencias, a11y, bundle, license.
- Adaptar a UNIK tokens y no copiar hardcodes.

## Figma MCP

### Qué aporta

Lee diseños Figma proporcionados por el usuario.

### Cómo conectar

1. Obtener token Figma personal.
2. Configurar en Devin Settings.
3. Key nunca guardada en repo. No `.env.example` con valores reales.

### Uso

- Si usuario proporciona Figma: Figma tiene prioridad visual.
- Implementar usando componentes UNIK/shadcn.
- No copiar píxeles/hardcodes indiscriminadamente.

## Seguridad

- NUNCA guardar secrets en repo.
- NUNCA hardcodear tokens.
- Secrets solo en Devin Settings o secret manager aprobado.
