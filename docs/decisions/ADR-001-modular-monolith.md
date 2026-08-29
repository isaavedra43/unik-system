# ADR-001: Modular Monolith

## Estado

Aceptado

## Contexto

UNIK System es una aplicación empresarial full-stack que requiere frontend y backend compartiendo un mismo dominio y desplegándose juntos.

## Decisión

UNIK System utilizará un **Modular Monolith**.

## Razones

- Un solo repositorio simplifica el control de versiones.
- Frontend y backend viven en el mismo proyecto y se despliegan juntos.
- Menor complejidad operativa en la etapa inicial.
- Desarrollo incremental: los módulos internos pueden crecer de forma organizada.
- Los módulos están claramente separados por dominio en `src/modules/`.
- Es posible extraer servicios posteriormente si realmente fuera necesario.

## Consecuencias

- No utilizaremos microservicios inicialmente.
- La separación de responsabilidades se mantiene mediante límites claros entre módulos.
- El despliegue es único, lo que reduce sobrecarga de infraestructura.
