# Responsive Rules — UNIK

## Viewports de referencia

| Viewport  | Uso principal     |
| --------- | ----------------- |
| 2560x1440 | Monitores grandes |
| 1920x1080 | Desktop estándar  |
| 1440x900  | Laptop alta       |
| 1366x768  | Laptop común      |
| 1024x768  | Tablet horizontal |
| 768x1024  | Tablet vertical   |
| 390x844   | Mobile            |

## Mobile-first con densidad desktop

- Mobile first en estructura.
- Desktop debe aprovechar ancho sin estirar absurdamente.
- Tablas operativas sí pueden expandirse horizontalmente en ultra-wide.
- Contenido admin usa `max-w-7xl` o similar.

## Layouts

- **Sidebar**: fija en desktop, drawer en mobile/tablet.
- **Topbar**: siempre visible, altura fija.
- **PageHeader**: título, descripción, acciones a la derecha.
- **ContentContainer**: centrado con padding, no ancho fijo rígido.

## Tables

- **Desktop**: tabla completa.
- **Tablet**: scroll horizontal con columnas prioritarias.
- **Mobile**: decidir por módulo: scroll horizontal, card rows o master-detail.
- No comprimir 10 columnas en 390px.

## Modals / Drawers

- Desktop: drawer lateral.
- Mobile: drawer full o modal full.
- Evitar nested scroll.

## Forms

- Desktop: 2-3 columnas cuando tenga sentido.
- Mobile: una columna siempre.
- Labels arriba para densidad.

## Touch targets

- Mínimo 40x40 en mobile/tablet.
- Icon buttons no minúsculos.

## Data density

- UNIK es ERP/operación.
- Más información, menos desperdicio.
- Sin perder legibilidad.

## Container queries

Usar cuando un componente dependa del espacio de su contenedor:

- cards
- master-detail
- dashboard widgets
- side panels
