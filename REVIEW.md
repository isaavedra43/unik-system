# REVIEW.md — UI Review Checklist

Cada PR/tarea UI debe pasar esta revisión antes de considerarse terminada.

## Checklist

- [ ] No hay componente duplicado.
- [ ] No hay hardcoded colors.
- [ ] Responsive en 1366, 1024, 768, 390.
- [ ] No hay overflow horizontal no intencional.
- [ ] Keyboard navegable (Tab, Enter, Escape).
- [ ] Focus visible en elementos interactivos.
- [ ] Accesibilidad: labels, roles, contrast básico.
- [ ] Estados loading incluidos.
- [ ] Estados error incluidos.
- [ ] Estados empty incluidos.
- [ ] Dark mode considerado (tokens semánticos).
- [ ] Motion discreta y con reduced-motion.
- [ ] Permisos server-side correctos.
- [ ] Server/client boundary correcto.
- [ ] Visual regression actualizado si aplica.
- [ ] Storybook actualizado si es shared component.
- [ ] Build, lint, typecheck y format pasan.
- [ ] No datos fake de negocio en producción.
