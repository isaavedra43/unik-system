# Paquetes (Zoho Inventory)

Ruta `/app/packages`. Zoho es la fuente de verdad: UNIK sincroniza, normaliza y muestra, y además escribe
en Zoho unas pocas operaciones (asignar transportista / orden de envío, editar el envío, marcar entregado,
cancelar el envío y editar fecha/notas del paquete) con el flujo **escribir → releer → parche local** de
`src/modules/packages/packages-shipping-service.ts` (permisos `packages.ship` y `packages.edit`). El detalle de
esas escrituras está en `docs/integrations/zoho.md` → "Escrituras hacia Zoho → Paquetes y órdenes de envío".

## Piezas

| Pieza | Archivo |
| --- | --- |
| Lectura tolerante del payload de Zoho (lista y detalle) | `src/modules/packages/packages-payload.ts` |
| Normalizador snapshot → `Package` + `PackageItem` | `src/modules/packages/packages-normalizer.ts` |
| Adaptador de sync (lista + detalle por paquete) | `src/modules/integrations/zoho/packages-sync.ts` |
| Botón "Actualizar" (sync `quick`, 25 s de espera, luego 202) | `src/app/app/packages/sync/route.ts` |
| PDF oficial de Zoho (`GET /packages/{id}?accept=pdf`) | `src/app/app/packages/[id]/pdf/route.ts` |
| UI: workspace, detalle, cajón de vista previa | `src/components/packages/*` |

## Datos que se guardan

Además de los campos del paquete, el normalizador lee el objeto `shipment_order` de Zoho (la "orden de
envío", p. ej. `NE-28815`): **transportista**, número de envío, fecha de envío, fecha de entrega, guía y
notas. Cuando el paquete ya se envió, Zoho deja vacío el `carrier` del paquete y lo pone en la orden de
envío; por eso antes UNIK mostraba "—".

El detalle de Zoho trae `shipping_address` como objeto y los artículos en `line_items`; la lista trae la
dirección plana y no trae artículos. Ambas formas se aceptan.

Columnas nuevas (migración `20260914170000_package_shipment_fields`, aditiva): `zohoShipmentId`,
`shipmentNumber`, `deliveryDate`, `trackingUrl`, `notes`.

## Sincronización

- **Actualizar** ejecuta un `quick` sync: páginas recientes ordenadas por `last_modified_time` y descarga de
  hasta 30 detalles. El escaneo completo lo hace el scheduler.
- Si la sincronización falla, la ruta responde 500 con `error` legible y `error_code`; el toast lo muestra.
- El motor reintenta una página de lista cuando el presupuesto compartido de llamadas por minuto se agota
  (varias entidades sincronizan a la vez) en lugar de fallar toda la corrida.
- El bucle de normalización se detiene cuando un lote no avanza (snapshots que fallan) en vez de repetir
  200 veces.
- `CURRENT_PACKAGE_NORMALIZER_VERSION = 4`: en la siguiente sincronización se re-normalizan todos los
  snapshots guardados, así los paquetes existentes obtienen transportista, envío y artículos.

## Barrido de envíos (transportista siempre vinculado)

Zoho guarda el transportista en la orden de envío y **no actualiza `last_modified_time` del paquete** al
crearla, así que el sync normal no vuelve a leer un paquete que se envió después de sincronizarlo.
`packages-shipment-sweep.ts` corrige eso: tras cada sincronización (manual: 40 paquetes; scheduler: 120)
vuelve a pedir el detalle a Zoho y lo normaliza al momento, en este orden:

1. Paquetes nunca releídos (`Package.lastDetailFetchedAt` nulo), sin transportista primero y luego los más
   recientes: así se rellena el histórico completo poco a poco (25 mil ≈ unos días con la cuota diaria).
2. Después, solo los que aún pueden cambiar (no entregados ni devueltos), como máximo cada 6 horas.

Respeta el presupuesto compartido de llamadas a Zoho (`withZohoRateBudget`) y se detiene si se agota la
cuota diaria. Un paquete borrado en Zoho (404) se marca como leído para no reintentarlo cada corrida.

## Refresco al abrir (la vista siempre coincide con Zoho)

Al abrir un paquete (cajón o detalle), `getPackageForDisplay` hace **una** lectura del detalle en Zoho
antes de mostrarlo si la fila puede estar atrasada: nunca releída, no entregada, sin transportista o sin
artículos, y con más de 15 minutos desde la última lectura. Si Zoho está ocupado o falla, se muestra lo
guardado con un aviso ("Mostrando datos guardados: …"). El botón **Actualizar desde Zoho**
(`POST /app/packages/{id}/refresh`) fuerza la lectura. La nota "Verificado con Zoho …" indica cuándo se leyó.

La corrida manual (`quick`) procesa como máximo 4 lotes de re-normalización (2 000 snapshots) para no
exceder su límite de 3 minutos; el resto se drena en corridas siguientes, y el barrido de envíos arranca en
paralelo, sin esperar a esa re-normalización.

## Pendiente de validación manual (producción)

- Aplicar la migración (`npx prisma migrate deploy` en el Pre-deploy de Railway).
- Pulsar **Actualizar** en `/app/packages`: debe responder "completada" o "en curso", nunca el error rojo.
- Abrir un paquete enviado (p. ej. `PKG-27622`): transportista, orden de envío `NE-…`, artículos y dirección.
- Botón **PDF de Zoho**: debe abrir la "Orden de salida" idéntica a la de Zoho. Si Zoho responde con
  error, la ruta devuelve JSON con el mensaje de Zoho.
