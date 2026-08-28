# UNIK System

UNIK System es una aplicación empresarial full-stack diseñada como un **Modular Monolith**. El frontend y el backend coexisten dentro del mismo proyecto y repositorio.

## Arquitectura

- **Tipo:** Modular Monolith
- **Repositorio:** único
- **Proyecto:** único (no hay carpetas `frontend` y `backend` separadas)

## Stack tecnológico

- Next.js
- React
- TypeScript (strict mode)
- Node.js
- PostgreSQL (futura base de datos principal)
- Prisma ORM
- Zod
- Tailwind CSS (pendiente de configuración visual)
- shadcn/ui (pendiente)
- Railway (futuro entorno de deployment)
- GitHub (control de versiones)
- Docker (preparado para futuro deployment)

## Notas importantes

- **Frontend y backend** viven en el mismo proyecto y se desplegarán juntos.
- **Zoho Inventory** será inicialmente una fuente externa de información.
- La **integración con Zoho** se realizará posteriormente mediante API y Webhooks.
- **PostgreSQL** será la base de datos principal, pero aún no está conectada.
- **Railway** será el entorno de deployment, pero aún no está configurado.
- Esta etapa solo contiene la **estructura inicial** del proyecto.

## Estado actual

Este repositorio contiene únicamente:

- Estructura de carpetas preparada para crecer de forma modular.
- Dependencias base instaladas.
- Configuración de TypeScript, ESLint, Prettier y Prisma.
- Dockerfile básico para futuro deployment.
- Archivo `.env.example` con placeholders.

No se ha desarrollado frontend, backend funcional, modelos de datos, migraciones, conexiones externas ni autenticación.

## Requisitos

- Node.js `>= 22.0.0`
- npm `>= 10.0.0`

## Comandos

```bash
npm install
npm run dev
npm run build
npm run typecheck
npm run lint
npm run format:check
```
