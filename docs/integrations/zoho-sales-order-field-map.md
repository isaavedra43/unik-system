# Zoho Sales Order Field Map

## Forma del payload guardado en IntegrationSnapshot

`IntegrationSnapshot.payload` guarda la respuesta HTTP COMPLETA de Zoho Inventory. La forma real es:

```json
{
  "code": 0,
  "message": "success",
  "salesorder": {
    ...
  }
}
```

`src/modules/integrations/zoho/client.ts` no desempaqueta `salesorder`; `getSalesOrder` devuelve el JSON completo. `src/modules/integrations/zoho/sales-orders-sync.ts` persiste ese objeto completo en `IntegrationSnapshot.payload`.

El normalizador extrae `salesorder` internamente mediante `extractSalesOrderPayload`. Para compatibilidad con snapshots históricos/directos, también acepta la forma directa `{ salesorder_id, ... }`, pero la forma canonica es el wrapper Zoho.

En las tablas siguientes:

- **Zoho response** = ruta dentro de `IntegrationSnapshot.payload`.
- **Normalizer input** = ruta dentro del objeto `salesorder` ya extraído.

## Mapeo de campos

| UNIK field               | Zoho response (RAW)                                                       | Normalizer input                                               | Tipo     | Requerido | Confianza               | Notas                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------- | -------- | --------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `zohoSalesOrderId`       | `salesorder.salesorder_id`                                                | `salesorder_id`                                                | String   | Sí        | OBSERVED                | Identificador técnico. Si falta, el snapshot no se normaliza.                                           |
| `salesOrderNumber`       | `salesorder.salesorder_number`                                            | `salesorder_number`                                            | String   | No        | OBSERVED                | Ejemplo real: `OV-23115`.                                                                               |
| `referenceNumber`        | `salesorder.reference_number`                                             | `reference_number`                                             | String   | No        | OBSERVED                | Referencia externa si Zoho la trae.                                                                     |
| `orderDate`              | `salesorder.date`                                                         | `date`                                                         | Date     | No        | OBSERVED                | Fecha comercial. Parse estricto `YYYY-MM-DD`.                                                           |
| `createdTime`            | `salesorder.created_time`                                                 | `created_time`                                                 | DateTime | No        | OBSERVED                | Timestamp técnico de creación en Zoho.                                                                  |
| `sourceRemoteModifiedAt` | `IntegrationSnapshot.remoteModifiedAt`                                    | —                                                              | DateTime | Sí        | OBSERVED                | Usado para stale check.                                                                                 |
| `status`                 | `salesorder.order_status`                                                 | `order_status`                                                 | String   | No        | OBSERVED                | Ejemplo real: estado principal de la orden.                                                             |
| `subStatus`              | `salesorder.current_sub_status`                                           | `current_sub_status`                                           | String   | No        | OBSERVED                | Sub-estado actual.                                                                                      |
| `paidStatus`             | `salesorder.paid_status`                                                  | `paid_status`                                                  | String   | No        | OBSERVED                | Ejemplo real: `paid`.                                                                                   |
| `invoicedStatus`         | `salesorder.invoiced_status`                                              | `invoiced_status`                                              | String   | No        | OBSERVED                | Ejemplo real: `invoiced`.                                                                               |
| `shippedStatus`          | `salesorder.shipped_status`                                               | `shipped_status`                                               | String   | No        | OBSERVED                | Ejemplo real: `pending`.                                                                                |
| `zohoCustomerId`         | `salesorder.customer_id`                                                  | `customer_id`                                                  | String   | No        | OBSERVED                | ID técnico del cliente.                                                                                 |
| `customerName`           | `salesorder.customer_name`                                                | `customer_name`                                                | String   | No        | OBSERVED                | Denominación del cliente.                                                                               |
| `customerEmail`          | `salesorder.contact_person_details[].email`                               | `contact_person_details[].email`                               | String   | No        | OBSERVED                | Primer contacto con email no vacío. No fallback a shipping.                                             |
| `customerPhone`          | `salesorder.contact_person_details[].phone` o `.mobile`                   | `contact_person_details[].phone`                               | String   | No        | OBSERVED                | Primer contacto con phone/mobile no vacío. No fallback a shipping.                                      |
| `zohoSalespersonId`      | `salesorder.salesperson_id`                                               | `salesperson_id`                                               | String   | No        | OBSERVED                | ID del vendedor.                                                                                        |
| `salespersonName`        | `salesorder.salesperson_name`                                             | `salesperson_name`                                             | String   | No        | OBSERVED                | Ejemplo real: `Laura Martinez`.                                                                         |
| `paymentMethod`          | `salesorder.payment_terms_label`                                          | `payment_terms_label`                                          | String   | No        | OBSERVED                | Ejemplo real: `EFECTIVO`. Coincide con PDF.                                                             |
| `deliveryMethod`         | `salesorder.delivery_method` o `salesorder.shipping_address.address`      | `delivery_method` (fallback a `shipping_address.address`)      | String   | No        | OBSERVED                | Ejemplo real: `RECOGE EN BODEGA`. Si `delivery_method` viene vacío, se toma `shipping_address.address`. |
| `deliveryMethodId`       | `salesorder.delivery_method_id`                                           | `delivery_method_id`                                           | String   | No        | OBSERVED                | ID técnico del método de entrega.                                                                       |
| `locationId`             | `salesorder.location_id`                                                  | `location_id`                                                  | String   | No        | OBSERVED                | Sustituye a `warehouse_id`.                                                                             |
| `locationName`           | `salesorder.location_name`                                                | `location_name`                                                | String   | No        | OBSERVED                | Ejemplo real: `Patio Unik`.                                                                             |
| `branchId`               | `salesorder.branch_id`                                                    | `branch_id`                                                    | String   | No        | OBSERVED                | ID de la sucursal.                                                                                      |
| `branchName`             | `salesorder.branch_name`                                                  | `branch_name`                                                  | String   | No        | OBSERVED                | Nombre de la sucursal.                                                                                  |
| `shippingAttention`      | `salesorder.shipping_address.attention`                                   | `shipping_address.attention`                                   | String   | No        | DOCUMENTED_NOT_OBSERVED | No presente en OV-23115.                                                                                |
| `shippingAddressLine1`   | `salesorder.shipping_address.address`                                     | `shipping_address.address`                                     | String   | No        | OBSERVED                | Ejemplo real: `RECOGE EN BODEGA`.                                                                       |
| `shippingAddressLine2`   | `salesorder.shipping_address.street2`                                     | `shipping_address.street2`                                     | String   | No        | DOCUMENTED_NOT_OBSERVED | No presente en OV-23115.                                                                                |
| `shippingCity`           | `salesorder.shipping_address.city`                                        | `shipping_address.city`                                        | String   | No        | DOCUMENTED_NOT_OBSERVED | No presente en OV-23115.                                                                                |
| `shippingState`          | `salesorder.shipping_address.state`                                       | `shipping_address.state`                                       | String   | No        | DOCUMENTED_NOT_OBSERVED | No presente en OV-23115.                                                                                |
| `shippingPostalCode`     | `salesorder.shipping_address.zip`                                         | `shipping_address.zip`                                         | String   | No        | DOCUMENTED_NOT_OBSERVED | No presente en OV-23115.                                                                                |
| `shippingCountry`        | `salesorder.shipping_address.country`                                     | `shipping_address.country`                                     | String   | No        | DOCUMENTED_NOT_OBSERVED | No presente en OV-23115.                                                                                |
| `shippingPhone`          | `salesorder.shipping_address.phone`                                       | `shipping_address.phone`                                       | String   | No        | DOCUMENTED_NOT_OBSERVED | Solo shipping. No es customerPhone.                                                                     |
| `currencyCode`           | `salesorder.currency_code`                                                | `currency_code`                                                | String   | No        | OBSERVED                | Código de moneda.                                                                                       |
| `subtotal`               | `salesorder.sub_total`                                                    | `sub_total`                                                    | Decimal  | No        | OBSERVED                | Ejemplo real: `2396.00`.                                                                                |
| `discountTotal`          | `salesorder.discount_total`                                               | `discount_total`                                               | Decimal  | No        | OBSERVED                | No descuento en OV-23115.                                                                               |
| `taxTotal`               | `salesorder.tax_total`                                                    | `tax_total`                                                    | Decimal  | No        | OBSERVED                | `0` en OV-23115.                                                                                        |
| `shippingCharge`         | `salesorder.shipping_charge`                                              | `shipping_charge`                                              | Decimal  | No        | OBSERVED                | No cargo en OV-23115.                                                                                   |
| `adjustment`             | `salesorder.adjustment`                                                   | `adjustment`                                                   | Decimal  | No        | OBSERVED                | No ajuste en OV-23115.                                                                                  |
| `total`                  | `salesorder.total`                                                        | `total`                                                        | Decimal  | No        | OBSERVED                | Ejemplo real: `2396.00`.                                                                                |
| `balance`                | `salesorder.balance`                                                      | `balance`                                                      | Decimal  | No        | OBSERVED                | Saldo.                                                                                                  |
| `notes`                  | `salesorder.notes`                                                        | `notes`                                                        | String   | No        | DOCUMENTED_NOT_OBSERVED | No presente en OV-23115.                                                                                |
| `saleMadeInWarehouse`    | `salesorder.custom_field_hash.cf_la_venta_se_realizo_en_alma_unformatted` | `custom_field_hash.cf_la_venta_se_realizo_en_alma_unformatted` | Boolean  | No        | OBSERVED                | Custom field operacional.                                                                               |
| `sourceSnapshotId`       | `IntegrationSnapshot.id`                                                  | —                                                              | String   | Sí        | OBSERVED                | Referencia al snapshot RAW que generó el registro.                                                      |

## Mapeo de `SalesOrderItem`

| UNIK field       | Zoho response (RAW)                                         | Normalizer input                    | Tipo    | Requerido | Confianza               | Notas                                      |
| ---------------- | ----------------------------------------------------------- | ----------------------------------- | ------- | --------- | ----------------------- | ------------------------------------------ |
| `zohoLineItemId` | `salesorder.line_items[].line_item_id`                      | `line_item_id`                      | String  | No        | OBSERVED                | Identificador de línea.                    |
| `zohoItemId`     | `salesorder.line_items[].item_id`                           | `item_id`                           | String  | No        | OBSERVED                | ID del ítem maestro.                       |
| `sku`            | `salesorder.line_items[].sku`                               | `sku`                               | String  | No        | OBSERVED                | Código del producto.                       |
| `name`           | `salesorder.line_items[].name`                              | `name` / `item_name`                | String  | No        | OBSERVED                | Nombre del producto.                       |
| `description`    | `salesorder.line_items[].description`                       | `description`                       | String  | No        | DOCUMENTED_NOT_OBSERVED | No presente en OV-23115.                   |
| `quantity`       | `salesorder.line_items[].quantity`                          | `quantity`                          | Decimal | No        | OBSERVED                | Cantidad ordenada. Ejemplo real: `4`.      |
| `unit`           | `salesorder.line_items[].unit`                              | `unit`                              | String  | No        | OBSERVED                | Ejemplo real: `m2`.                        |
| `rate`           | `salesorder.line_items[].rate`                              | `rate`                              | Decimal | No        | OBSERVED                | Ejemplo real: `599.00`.                    |
| `discountAmount` | `salesorder.line_items[].discount_amount`                   | `discount_amount`                   | Decimal | No        | OBSERVED                | Monto de descuento. `0` si no aplica.      |
| `taxName`        | `salesorder.line_items[].tax_name`                          | `tax_name`                          | String  | No        | OBSERVED                | Nombre del impuesto.                       |
| `taxPercentage`  | `salesorder.line_items[].tax_percentage`                    | `tax_percentage`                    | Decimal | No        | OBSERVED                | Guardado exactamente como Zoho lo entrega. |
| `taxAmount`      | `SUM(salesorder.line_items[].line_item_taxes[].tax_amount)` | `SUM(line_item_taxes[].tax_amount)` | Decimal | No        | OBSERVED                | Si `line_item_taxes` vacío, `0` o `null`.  |
| `lineTotal`      | `salesorder.line_items[].item_total`                        | `item_total`                        | Decimal | No        | OBSERVED                | Ejemplo real: `2396.00`.                   |
| `locationId`     | `salesorder.line_items[].location_id`                       | `location_id`                       | String  | No        | OBSERVED                | Ubicación del producto en la línea.        |
| `locationName`   | `salesorder.line_items[].location_name`                     | `location_name`                     | String  | No        | OBSERVED                | Nombre de la ubicación.                    |
| `sortOrder`      | `salesorder.line_items[].item_order`                        | `item_order` (o índice + 1)         | Int     | No        | OBSERVED                | Orden relativo dentro de la orden.         |

## Notas

- `IntegrationSnapshot.payload` es el JSON completo de Zoho: `{ code, message, salesorder }`.
- El normalizador usa `extractSalesOrderPayload` para obtener `salesorder` sin modificar el RAW.
- Todos los campos financieros se almacenan como `Decimal` con escala `18,4`.
- `customerEmail` y `customerPhone` provienen de `contact_person_details`. No se infieren de `shipping_address`.
- `orderDate` es `Date` de PostgreSQL (`@db.Date`) con parse estricto `YYYY-MM-DD`.
- `taxPercentage` se almacena exactamente como lo entrega Zoho (no se divide por 100).
- `taxAmount` se calcula como `new Prisma.Decimal(0)` más la suma `Prisma.Decimal` de cada `line_item_taxes[].tax_amount`.
- `discount` porcentaje queda ignorado hasta tener ejemplo no-cero; se usa `discount_amount`.
- `warehouseId/warehouseName` fueron renombrados a `locationId/locationName` y se agregaron `branchId/branchName`.
