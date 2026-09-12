# Cotizaciones (Entrega 13-B)

Cotizaciones en borrador con totales exactos, simulación de escenarios, paquete comercial completo y creación de la cotización **oficial** en Zoho Books únicamente tras aprobación humana.

## 1. Piezas

| Pieza                                                           | Archivo                                                  |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| Contrato (Zod, Decimal, hash canónico)                          | `src/modules/quotes/quotes-contract.ts`                  |
| Servicio (borrador, versiones, aprobación, paquete, escenarios) | `src/modules/quotes/quotes-service.ts`                   |
| Adaptador Zoho Books (estimates)                                | `src/modules/quotes/zoho-books-adapter.ts`               |
| Autorización de descarga del paquete                            | `src/modules/quotes/quotes-access.ts`                    |
| Tools del asistente                                             | `src/modules/ai/tools/quotes-tools.ts`                   |
| API                                                             | `src/app/app/quotes/api/**`                              |
| UI                                                              | `src/app/app/quotes/page.tsx`, `src/components/quotes/*` |
| Pruebas                                                         | `src/modules/quotes/*.test.ts`                           |

Permisos: `quotes.use` (preparar, editar, simular, paquete, solicitar aprobación) y `quotes.approve` (aprobar/rechazar, condiciones comerciales). Todo se valida en servidor; los ids no conceden acceso.

## 2. Flujo

```
draft ──solicitar──▶ pending_approval ──aprobar (hash OK)──▶ approved ──Books OK──▶ synced
  ▲                        │                                    │
  └──── editar (versión+1, "Contenido modificado") ◀────────────┘   Books rechaza → approved + nota (reintentable)
                           └── rechazar ──▶ rejected             Books timeout → pending_approval + "Pendiente de revisión: verificar en Books"
```

- **Totales**: `Prisma.Decimal` a 4 decimales (`computeTotals`), nunca `float`. La UI muestra un estimado en pantalla; el servidor es la fuente de verdad.
- **contentHash**: SHA-256 de cliente, moneda, notas y partidas normalizadas (`computeQuoteContentHash`). Aprobar exige `expectedContentHash === contentHash` actual; cualquier edición material incrementa `version`, vuelve a `draft`, guarda `invalidationReason = "Contenido modificado"` e **invalida propuestas IA pendientes** cuyo `fileIds` o `args.quoteId` referencian la cotización.
- **Reclamo atómico** al aprobar (`updateMany` por id + estado + hash + versión): dos aprobadores o un doble clic nunca crean dos estimates.
- **Resultado incierto**: un timeout tras el POST deja la cotización en `pending_approval` con la nota "Pendiente de revisión: verificar en Books". El operador debe comprobar en Books antes de reintentar; UNIK no afirma ejecución única en ese caso.
- **Auditoría** (`AuditLog`): `quotes.created`, `quotes.approval_requested`, `quotes.approval_invalidated`, `quotes.approved` (con `mock`), `quotes.approval_uncertain`, `quotes.books_error`, `quotes.rejected`, `quotes.package_built`, `quotes.settings_updated`.

## 3. Zoho Books: mock vs real

| Variable                     | Efecto                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `ZOHO_BOOKS_MOCK=true`       | Modo simulado: ids `mock-…`, nada sale del proceso. **Mock ≠ validado en Books.**        |
| `ZOHO_BOOKS_MOCK` vacío      | Simulado si falta `ZOHO_BOOKS_ORGANIZATION_ID`; real si existe.                          |
| `ZOHO_BOOKS_MOCK=false`      | Real; requiere `ZOHO_BOOKS_ORGANIZATION_ID` y las variables `ZOHO_*` (OAuth compartido). |
| `ZOHO_BOOKS_ORGANIZATION_ID` | Organización de Books (puede diferir de la de Inventory).                                |

Modo real: `POST {ZOHO_API_BASE_URL}/books/v3/estimates?organization_id=…` con `Authorization: Zoho-oauthtoken` (`getZohoAccessToken`), vía `safeFetch` (host permitido = host de `ZOHO_API_BASE_URL`, timeout 30 s). El refresh token debe incluir el scope **`ZohoBooks.estimates.CREATE`** (además de los scopes de Inventory ya usados). Cada llamada se registra en `IntegrationApiCall` con `source = zoho_books`. La UI muestra el modo vigente y marca cada cotización como "Books simulado" o "Books real".

Mapeo: `customer_name` (o `customer_id` si hay `zohoCustomerId`), `currency_code`, `reference_number` (id/número interno), `notes`, `line_items[{name, description, quantity, rate}]`. Los impuestos se envían como parte del precio/notas; asignar `tax_id` por partida queda para una fase posterior si Books lo exige por organización.

## 4. Paquete comercial completo

`buildCommercialPackage` genera un PDF (`generatePdfReport`, en `os.tmpdir()` y borrado al terminar) con: resumen (cliente, total, vigencia, estado), tabla de partidas, totales, **fichas de producto** (tabla `Product` por SKU o nombre: marca, unidad, categoría, clave/unidad SAT, descripción) y **condiciones comerciales** configurables (`StorageConfig` key `quotes:settings`: `conditions`, `validityDays`, `companyName`; `PUT /app/quotes/api/settings` con `quotes.approve`). Se guarda con `saveGeneratedFile({ purpose: 'document', restricted: true, retentionPolicy: 'protected' si aprobada/sincronizada })`; la descarga pasa por `/app/files/api/objects/:id/access` y el resolver de `quotes-access.ts` (requiere permiso de cotizaciones y que la cotización exista).

## 5. Simulación de escenarios

`simulateScenarios(quoteId, [{ name, discountPct?, quantityMultiplier?, taxRate? }])` devuelve base + escenarios con subtotal/impuestos/total, diferencia absoluta y porcentual. Nunca persiste.

## 6. Asistente IA

| Tool                     | Efecto           | Nota                                                                                                                             |
| ------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `prepareQuote`           | `draft`          | Crea borrador; no toca Books.                                                                                                    |
| `simulateQuoteScenarios` | `read`           |                                                                                                                                  |
| `buildCommercialPackage` | `draft`          | Devuelve `documentId` y `downloadPath`.                                                                                          |
| `requestQuoteApproval`   | `internal_task`  | Pasa a pendiente de aprobación.                                                                                                  |
| `approveOfficialQuote`   | `business_write` | **Siempre** propuesta (`AiProposal`) con cliente y total; al aprobarla ejecuta `approveQuote` verificando hash, cliente y total. |

Una petición oral o escrita de "cotización oficial" nunca crea nada en Books sin la aprobación de una persona con `quotes.approve`.

## 7. API

`/app/quotes/api/quotes` (GET lista + modo Books, POST crear) · `/quotes/:id` (GET, PATCH) · `/quotes/:id/request-approval` · `/quotes/:id/approve` `{ expectedContentHash }` (quotes.approve) · `/quotes/:id/reject` `{ reason? }` · `/quotes/:id/package` · `/quotes/:id/simulate` `{ scenarios }` · `/app/quotes/api/settings` (GET, PUT).

## 8. Pruebas locales

`npx vitest run --project unit src/modules/quotes`: totales Decimal, hash canónico, edición que invalida aprobación y propuestas, aprobación con hash distinto falla, aprobación mock → `synced`, resultado incierto → nota de revisión, rechazo de Books reintentable, escenarios, paquete con fichas y retención protegida, adaptador (mock/real/timeout/host no permitido) y tools (propuesta obligatoria, ejecución única con propuesta aprobada).

## 9. Checklist de validación manual (pendiente del usuario)

- [ ] Configurar `ZOHO_BOOKS_ORGANIZATION_ID` y regenerar el refresh token con scope `ZohoBooks.estimates.CREATE`; poner `ZOHO_BOOKS_MOCK=false`.
- [ ] Crear un borrador en `/app/quotes`, solicitar aprobación, aprobar con un usuario `quotes.approve` y comprobar el estimate en Books (número y URL).
- [ ] Editar una cotización pendiente y verificar que vuelve a borrador con "Contenido modificado" y que la propuesta IA pendiente aparece invalidada en el chat.
- [ ] Generar el paquete comercial y descargarlo desde la UI (streaming autenticado).
- [ ] Pedir al asistente "crea la cotización oficial de X" y confirmar que solo aparece una tarjeta de propuesta.
- [ ] Simular un timeout (red) y verificar la nota "Pendiente de revisión: verificar en Books" y el registro en `/app/admin/integrations` (`zoho_books`).
