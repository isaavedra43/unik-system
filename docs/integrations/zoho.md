# Zoho Inventory - Integración

## Qué está implementado

Capa interna de lectura (READ) hacia Zoho Inventory, ubicada en:

```
src/modules/integrations/zoho/
├── config.ts        # Configuración validada con Zod (carga lazy)
├── auth.ts          # OAuth: access token vía refresh token, con cache en memoria
├── client.ts        # Cliente HTTP genérico (solo GET) para Zoho Inventory
└── sales-orders.ts  # listSalesOrders() y getSalesOrder(salesOrderId)
```

## OAuth

- El access token se obtiene con `POST {ZOHO_ACCOUNTS_BASE_URL}/oauth/v2/token` usando el refresh token (`grant_type=refresh_token`).
- El token se cachea en memoria y se reutiliza mientras siga vigente (margen de 60 segundos antes de expirar).
- Se renueva automáticamente al expirar; las peticiones concurrentes comparten una sola renovación en curso.
- Ningún token ni secreto se loguea ni se expone en errores.

## Operaciones disponibles

- `listSalesOrders()` → `GET /inventory/v1/salesorders` (respuesta RAW de Zoho).
- `getSalesOrder(salesOrderId)` → `GET /inventory/v1/salesorders/{id}` (respuesta RAW de Zoho). El id se valida como string numérico.

Todas las peticiones agregan automáticamente `organization_id` y el header `Authorization: Zoho-oauthtoken ...`.

## Variables de entorno requeridas

- `ZOHO_CLIENT_ID`
- `ZOHO_CLIENT_SECRET`
- `ZOHO_REFRESH_TOKEN`
- `ZOHO_ORGANIZATION_ID`
- `ZOHO_API_BASE_URL`
- `ZOHO_ACCOUNTS_BASE_URL`

La validación es lazy: solo ocurre cuando una operación Zoho la necesita, para no romper builds donde la integración no se usa.

## Lo que todavía NO existe

- Webhooks de Zoho.
- Persistencia de datos Zoho en PostgreSQL.
- Endpoints HTTP de UNIK para esta integración.
- Escritura hacia Zoho (POST/PUT/PATCH/DELETE).
- Normalización o modelos de dominio de los datos de Zoho.
