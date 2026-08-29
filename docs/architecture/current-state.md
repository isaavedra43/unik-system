# UNIK System - Current State

## Architecture

- **Modular Monolith**
- Un solo repositorio.
- Frontend y backend coexisten dentro de Next.js.

## Infrastructure

- **GitHub**: fuente del repositorio y del deployment.
- **Railway**: entorno de deployment actual.
- **PostgreSQL**: base de datos conectada y operativa.

## Currently Working

- Deployment automático GitHub → Railway.
- Aplicación Next.js ejecutándose en Railway.
- Dominio público asignado por Railway.
- Prisma Client generado y operativo.
- Conexión PostgreSQL verificada.
- `GET /api/health` responde correctamente.
- Health check devuelve `database: connected` cuando la conexión es exitosa.

## External Zoho Verification

Fuera del código de UNIK se han probado manualmente:

- Zoho Self Client.
- OAuth authorization.
- Refresh token.
- Access token.
- Alcance `ZohoInventory.salesorders.READ`.
- GET de Sales Orders.
- GET de Sales Order por ID.

## Not Implemented Yet

- Cliente de Zoho dentro de UNIK.
- Refresh automático de tokens dentro de UNIK.
- Webhooks de Zoho.
- Persistencia de datos Zoho en PostgreSQL.
- Tablas de negocio.
- Módulos de ventas, compras, inventario, logística, finanzas, reportes, usuarios e IA.
- Frontend funcional.
- Autenticación.

## Current Endpoint

### `GET /api/health`

Verifica que el servicio responda y que Prisma pueda ejecutar `SELECT 1` contra PostgreSQL.

- Responde `200` con `database: connected` cuando la conexión es exitosa.
- Responde `503` con `database: disconnected` si la conexión falla.

No requiere autenticación.

## Database

- PostgreSQL está conectado.
- Prisma todavía no contiene modelos.
- No existen migraciones.
- No existen tablas de negocio.
- No se persisten todavía datos empresariales.

## Next Planned Phase

**Zoho Read Integration**

Esta fase NO se implementa en la tarea actual.
