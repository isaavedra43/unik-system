# UNIK System

UNIK System es una aplicación empresarial full-stack diseñada como un **Modular Monolith**. El frontend y el backend coexisten dentro del mismo proyecto y repositorio, y se despliegan juntos.

## Arquitectura

- **Tipo:** Modular Monolith
- **Repositorio:** único
- **Proyecto:** único (no hay carpetas `frontend` y `backend` separadas)

## Stack tecnológico

- Next.js
- React
- TypeScript (strict mode)
- Node.js
- PostgreSQL
- Prisma ORM
- Zod
- Docker
- GitHub
- Railway

## Infraestructura actual

- **GitHub** es el origen del repositorio y fuente del deployment.
- **Railway** es el entorno de deployment actual.
- **PostgreSQL** está conectado y operativo.
- **Next.js** se ejecuta en Railway con dominio público.

## Estado actual

La infraestructura base ya está funcionando:

```
Next.js → Prisma → PostgreSQL
```

Esto se comprueba con el endpoint:

```bash
GET /api/health
```

que devuelve `database: connected` cuando la conexión es exitosa.

## Zoho Inventory

- Zoho Inventory será una fuente externa de información.
- Fuera del código se han probado manualmente: Zoho Self Client, OAuth authorization, refresh token, access token, permiso `ZohoInventory.salesorders.READ`, GET de Sales Orders y GET de Sales Order por ID.
- **La integración Zoho dentro del código aún no está implementada.**
- Los webhooks aún no están implementados.

## Lo que aún no existe

- Modelos de datos y migraciones de Prisma.
- Tablas de negocio.
- Módulos de ventas, compras, inventario, logística, finanzas, reportes, usuarios e IA.
- Frontend funcional.
- Autenticación.
- Integración Zoho automatizada.
- Webhooks.

## Requisitos

- Node.js `>= 22.0.0`
- npm `>= 10.0.0`

## Comandos

```bash
npm install
npm run dev
npm run build
npm run start
npm run typecheck
npm run lint
npm run format:check
npm run prisma:generate
npm run prisma:validate
```

## Nota

Este repositorio contiene la **estructura inicial y foundation** del proyecto. Ver `docs/architecture/current-state.md` para el checkpoint completo.
