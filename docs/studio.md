# Estudio visual (Entrega 12)

Única fuente de verdad sobre el módulo `/app/studio`: edición de documentos e imágenes por bloques, versiones, plantillas, cambios por selección con IA y exportaciones verificadas.

Criterio de cierre: **artefactos editables y exportados sin perder cifras ni contenido**. Cada archivo exportado se reabre y se comprueba antes de marcarse como listo; si falta una cifra, la exportación falla y no se entrega enlace.

## 1. Arquitectura

```
UI (/app/studio) ──▶ /app/studio/api/* ──▶ studio-service.ts (autorización, versiones, plantillas, aprobación)
                                        ├─▶ studio-ai-edit.ts (chatCompletion → JSON de bloques → applySelectionEdit)
                                        └─▶ studio-export-service.ts ──▶ job studio.export (o inline)
                                                                            ├─ studio-exporters.ts   (pdf/docx/xlsx/csv/pptx/html/md/svg en tmpdir)
                                                                            ├─ studio-verification.ts (reabre el archivo y busca las cifras)
                                                                            └─ saveGeneratedFile(purpose 'document') → StudioExport.status = ready
Asistente IA ──▶ src/modules/ai/tools/studio-tools.ts (registerTool: read / draft / business_write)
Storage     ──▶ studio-storage-access.ts (upload target 'studio_document', access resolver 'document')
```

| Pieza                                                    | Archivo                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| Modelo de bloques, hash, selección, cifras               | `src/modules/studio/studio-content.ts`                               |
| Formato de celdas (isomórfico)                           | `src/modules/studio/studio-format.ts`                                |
| Servicio (documentos, versiones, plantillas, aprobación) | `src/modules/studio/studio-service.ts`                               |
| Exportadores                                             | `src/modules/studio/studio-exporters.ts`                             |
| Verificación de renderizado                              | `src/modules/studio/studio-verification.ts`                          |
| Exportaciones (job + fallback inline)                    | `src/modules/studio/studio-export-service.ts`                        |
| Registro del job                                         | `src/modules/studio/studio-jobs.ts`                                  |
| Integración con storage                                  | `src/modules/studio/studio-storage-access.ts`                        |
| IA: cambios por selección                                | `src/modules/studio/studio-ai-edit.ts`                               |
| Tools del asistente                                      | `src/modules/ai/tools/studio-tools.ts`                               |
| Rutas API                                                | `src/app/app/studio/api/**`                                          |
| UI                                                       | `src/app/app/studio/page.tsx`, `src/components/studio/*`             |
| Permisos                                                 | `studio.use`, `studio.approve` (`src/modules/studio/permissions.ts`) |

Modelos Prisma (ya existentes): `StudioDocument`, `StudioDocumentVersion`, `StudioTemplate`, `StudioExport`.

## 2. Modelo de bloques

Un documento es `{ version: 1, blocks: [...] }`. Cada bloque tiene un `id` estable (`^[A-Za-z0-9_-]{1,64}$`, único en el documento) y un `type`:

| Tipo        | Campos                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `heading`   | `level` 1–3, `text`                                                                                                                              |
| `paragraph` | `text` (hasta 20 000 caracteres, admite saltos de línea)                                                                                         |
| `list`      | `items[]`, `ordered`                                                                                                                             |
| `table`     | `title?`, `columns[{key, header, format?: text\|number\|currency\|percentage\|date, align?}]`, `rows[]` (celdas `string\|number\|boolean\|null`) |
| `kpi`       | `cards[{label, value}]` (1–12)                                                                                                                   |
| `image`     | `storageObjectId`, `alt`, `caption?`, `width?`, `height?`                                                                                        |
| `pageBreak` | —                                                                                                                                                |
| `divider`   | —                                                                                                                                                |

Funciones puras (`studio-content.ts`):

- `parseStudioContent(json)` valida con Zod (ids duplicados y tipos desconocidos se rechazan).
- `hashContent(content)` = sha256 del JSON canónico (claves ordenadas, sin `undefined`): estable ante el orden de claves.
- `applySelectionEdit(content, blockIds, { blocks })` reemplaza la selección **en la posición del primer bloque seleccionado**; `blocks: []` elimina; los ids que colisionan con bloques fuera de la selección se regeneran. Nada fuera de la selección cambia.
- `diffContent(a, b)` → añadidos/eliminados/modificados/reordenados + resumen en español (queda como `changeSummary` de la versión).
- `extractFigures(content)` → todas las cifras (números, montos, porcentajes, fechas) de tablas, KPIs, párrafos, encabezados y listas, con ubicación y las formas normalizadas que pueden adoptar al renderizarse (`1234.5`, `1,234.50`, `$1,234.50`…).
- `contentFromTable({columns, rows, summary})` convierte un artefacto de tabla del asistente en título + KPIs + tabla.

`renderCellText(valor, formato)` (`studio-format.ts`) es la **única** conversión celda → texto que usan todos los exportadores; así la verificación sabe exactamente qué cadena debe encontrar. Moneda `$1,234.50`, número `1,234.5`, porcentaje `41.5%`, fecha `DD/MM/YYYY`, booleano `Sí/No`.

## 3. Documentos, versiones y autorización

- Cada guardado con cambio de contenido crea una **nueva** `StudioDocumentVersion` (`version` incremental por documento, `contentHash`). Nunca se sobrescribe. Si el contenido no cambió (mismo hash) solo se actualiza el título y no se crea versión.
- Restaurar una versión crea una versión nueva con ese contenido (`changeSummary: "Restaurada la versión N"`).
- Autorización (servidor, deny by default):
  - `studio.use` obligatorio para todo.
  - Propietario: ver, editar, archivar.
  - `visibility = team`: cualquier usuario con `studio.use` puede ver y editar (colaboración); `super_admin` ve todo.
  - `studio.approve`: aprobar la versión actual (`status approved`, `approvedVersionId`) y compartir (`status shared`, `visibility team`, solo si la versión actual es la aprobada). También puede archivar y crear plantillas de equipo.
- **Regla preservada (función 2 de las diez):** si el contenido de un documento `approved`/`shared` cambia, vuelve a `draft`, se limpian `approvedVersionId`/`approvedBy`/`approvedAt`/`sharedAt` y se invalidan las `AiProposal` pendientes cuyo `fileIds` contenga el id del documento, de alguna de sus exportaciones o del objeto de esas exportaciones (`status invalidated`, `error "El documento cambió"`). Se registra `studio.document.reverted_to_draft` en auditoría. La visibilidad de equipo se conserva.
- Archivar (`DELETE`) no destruye versiones ni archivos; invalida propuestas pendientes.
- Plantillas (`StudioTemplate`): personales (solo el autor) o de equipo (visibles para todos con `studio.use`; crear/editar/eliminar requiere `studio.approve`). Eliminar = `status archived`.
- Creación: en blanco, desde plantilla o desde un artefacto de tabla del asistente (`artifactId`, el usuario debe ser dueño de la conversación).

## 4. Imágenes

- Subida: `uploadFile(file, { target: { type: 'studio_document', id: documentId } })` (flujo estándar cuarentena → validación → `ready`). Política: purpose `document`, `image/png`, `image/jpeg`, `image/webp`, 20 MB; retención `protected` si el documento está aprobado/compartido. No se crea registro en la subida: la referencia es el bloque `image` (o `StudioDocumentVersion.storageObjectId` en documentos tipo imagen) que el cliente guarda a continuación.
- El servicio solo acepta objetos `ready` de purpose `document` subidos por el propio usuario o que ya estaban en la versión anterior (`assertImageObjectsAllowed`): no se puede adjuntar un archivo ajeno adivinando su id.
- Acceso (`registerFileAccessResolver('document')`): se concede si el usuario puede ver un documento cuya versión (binario o bloque `image`) o exportación referencia el objeto; el propio subidor siempre ve lo que subió.
- Edición básica en el navegador (`StudioImageEditor`): recorte por arrastre, rotación 90° y anotaciones de texto sobre `<canvas>`; el resultado se sube como PNG **nuevo** (nueva versión del documento). La imagen original se conserva en las versiones anteriores. El lienzo se carga por el streaming autenticado del mismo origen (`/app/files/api/objects/:id/content`) para no contaminar el canvas.
- Los objetos subidos y nunca colocados no se limpian automáticamente (pendiente: job de limpieza por edad).

## 5. Exportaciones

`POST /app/studio/api/documents/:id/exports { format }` crea `StudioExport (processing)` y encola `studio.export` (`JOB_PRIORITY.interactive`, `dedupeKey studio.export:<exportId>`). Si el worker no termina en 4 s, la petición **cancela** el job (solo si sigue pendiente, de forma atómica) y ejecuta la misma función inline; si otro worker ya lo reclamó, espera hasta 25 s y devuelve el estado (el cliente hace polling con `GET /app/studio/api/exports/:id`).

`runStudioExport` es idempotente: genera en `os.tmpdir()` (mkdtemp, se borra al final), verifica, y **solo después** sube con `saveGeneratedFile({ purpose: 'document', retentionPolicy: aprobado/compartido ? 'protected' : 'default' })` y marca `ready` con `storageObjectId`. La descarga se obtiene con `/app/files/api/objects/:storageObjectId/access?disposition=attachment` (revalida el acceso al documento). HTML y SVG se marcan `downloadOnly`.

| Formato | Motor       | Notas                                                                                                                                                                                                                                                |
| ------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pdf     | pdfkit      | Documentos "tipo reporte" (título + KPIs + tablas) reutilizan `generatePdfReport` (marca UNIK); el resto usa el renderizador por bloques (A4, paginación de tablas con cabecera repetida, sin elipsis). Imágenes PNG/JPEG; WebP → texto alternativo. |
| docx    | docx@9      | Title/Heading1-3, listas con viñetas/numeración, tablas con cabecera, KPIs como tabla, imágenes, saltos de página.                                                                                                                                   |
| xlsx    | exceljs     | Hoja `Resumen` (título, indicadores, índice) + una hoja por tabla (`sheetNameForTable`: ≤31 caracteres, única). Celdas numéricas como números con `numFmt`.                                                                                          |
| csv     | propio      | BOM + `# título`; secciones `## Indicadores` y `## <tabla>` concatenadas.                                                                                                                                                                            |
| pptx    | pptxgenjs@4 | Portada; una diapositiva por encabezado (párrafos/listas se acumulan), por tabla (12 filas por diapositiva), por KPI y por imagen.                                                                                                                   |
| html    | propio      | Autocontenido (CSS inline, imágenes como data URI, todo escapado).                                                                                                                                                                                   |
| md      | propio      | Markdown con tablas GFM, KPIs como tabla, imágenes como data URI.                                                                                                                                                                                    |
| svg     | propio      | Imagen del documento siguiendo el patrón de `image-report-generator` (sin recortes: el lienzo se ensancha si una tabla lo necesita).                                                                                                                 |
| png     | —           | **Pendiente**: no hay rasterizador en el servidor (sin canvas/headless). Usar SVG o PDF.                                                                                                                                                             |

## 6. Verificación de renderizado

`verifyStudioExport(format, filePath, { title, content })` se ejecuta **antes** de almacenar. Resultado guardado en `StudioExport.verification = { ok, checks: [{ name, ok, detail }] }`:

| Formato  | Cómo se reabre                                    | Checks                                                                                                                                 |
| -------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| pdf      | `unpdf` (pdf.js) → texto de todas las páginas     | `file`, `pages > 0`, `title`, `figures`                                                                                                |
| xlsx     | `exceljs` relee el libro                          | `file`, `summary_sheet`, `kpis` (etiqueta/valor), `cells` (cada celda de cada tabla comparada con `xlsxCellValue`), `title`, `figures` |
| docx     | `zip-reader` → `word/document.xml`                | `file`, `structure`, `title`, `figures`                                                                                                |
| pptx     | `zip-reader` → `ppt/slides/slide*.xml`            | `file`, `structure` (≥1 diapositiva), `title`, `figures`                                                                               |
| html/svg | texto sin etiquetas y con entidades decodificadas | `file`, `title`, `figures`                                                                                                             |
| md/csv   | texto                                             | `file`, `title`, `figures`                                                                                                             |

`figures`: cada cifra de `extractFigures` debe aparecer en el texto normalizado (sin espacios, `$`, `,`, `%`, `MXN`). CSV y XLSX solo exigen las cifras de tablas/KPIs (no llevan prosa). Si falla, `status = failed`, `error = "La verificación del renderizado falló — ..."` y **no hay enlace**. La UI muestra el detalle de cada check.

Notas: `pdf-parse` 1.1.1 se evita porque al importarse desde ESM intenta leer un PDF de prueba (`module.parent` indefinido); `unpdf` cubre la extracción. Las cifras en encabezados de columna no se exigen (se muestran en mayúsculas y pueden recortarse).

## 7. IA: cambios por selección

- UI: seleccionar bloques → "Pedir cambio a la IA" → `POST /documents/:id/ai-edit { blockIds, instruction }`. El servidor envía a `chatCompletion` el título, una vista de texto del documento (contexto), los bloques seleccionados en JSON y la instrucción; exige **solo JSON** `{"blocks":[...]}`, lo valida con Zod, reintenta **una vez** si es inválido, aplica `applySelectionEdit` y guarda una versión (`changeSummary: "IA: <instrucción>"`). El botón se deshabilita con cambios sin guardar (la IA edita la versión guardada).
- Tools del asistente (`studio-tools.ts`, permiso `studio.use`): `listStudioDocuments` (read), `getStudioDocument` (read), `createStudioDocument` (draft), `editStudioDocumentSelection` (draft: el modelo ya envía los bloques redactados), `exportStudioDocument` (draft), `approveStudioDocument` (**business_write** → propuesta con aprobación humana; además requiere `studio.approve`, deshabilitada por defecto).

## 8. API

Todas con `getCurrentSession()` + `hasPermission`, Zod en el cuerpo, errores `{ error, code }`, `runtime nodejs`, `dynamic force-dynamic`.

| Ruta                                                           | Métodos                                                                                              |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/app/studio/api/documents?scope=mine\|team&includeArchived=1` | GET, POST (`title, kind, content?, templateId?, artifactId?`)                                        |
| `/app/studio/api/documents/:id`                                | GET, PATCH (`title?, content?, changeSummary?, storageObjectId?` → nueva versión), DELETE (archivar) |
| `/app/studio/api/documents/:id/versions`                       | GET                                                                                                  |
| `/app/studio/api/documents/:id/versions/:versionId`            | GET (contenido)                                                                                      |
| `/app/studio/api/documents/:id/versions/:versionId/restore`    | POST                                                                                                 |
| `/app/studio/api/documents/:id/approve`                        | POST (`studio.approve`)                                                                              |
| `/app/studio/api/documents/:id/share`                          | POST (`studio.approve`)                                                                              |
| `/app/studio/api/documents/:id/exports`                        | GET, POST `{ format }`                                                                               |
| `/app/studio/api/documents/:id/ai-edit`                        | POST `{ blockIds, instruction }`                                                                     |
| `/app/studio/api/exports/:id`                                  | GET (estado + verificación)                                                                          |
| `/app/studio/api/templates`                                    | GET, POST                                                                                            |
| `/app/studio/api/templates/:id`                                | GET, PATCH, DELETE                                                                                   |

## 9. Límites conocidos

- Sin PNG (rasterizador pendiente). Sin edición WYSIWYG: el editor es por bloques.
- pdfkit/docx no decodifican WebP: en PDF/DOCX una imagen WebP se sustituye por su texto alternativo (HTML/MD/SVG/PPTX la incrustan).
- El editor de tablas muestra las primeras 300 filas para edición celda a celda; el resto se conserva y exporta.
- La verificación busca cifras por subcadena normalizada: detecta cifras perdidas, no cifras cambiadas por otras que ya existían en el documento.
- Objetos de imagen subidos y no colocados no se limpian automáticamente.

## 10. Pruebas locales

```
npx vitest run --project unit src/modules/studio
```

- `studio-content.test.ts`: formato de celdas, `extractFigures`, hash estable, `applySelectionEdit`, diff, importación de tablas.
- `studio-exporters.test.ts`: los 8 formatos con un documento de montos (con y sin imagen) pasan la verificación; XLSX/HTML/CSV manipulados fallan; PDF paginado (120 filas) no pierde filas.
- `studio-export-service.test.ts`: pipeline completo con `MemoryStorageRepository` + `DiskObjectStorageDriver`: job encolado → fallback inline → `ready` con objeto almacenado; retención `protected` en aprobados; verificación fallida → `failed` sin objeto ni enlace.
- `studio-service.test.ts`: versiones incrementales, restaurar, visibilidad, imágenes ajenas, archivar, aprobar/compartir, regla de vuelta a borrador + invalidación de propuestas, plantillas, parseo/reintento de la respuesta de la IA.

## 11. Checklist de validación manual (usuario)

- [ ] Añadir los imports pendientes (`register-handlers.ts`, `tools/index.ts`, `files/api/_shared.ts`) y la entrada de navegación a `/app/studio`.
- [ ] Con un usuario con `studio.use`: crear documento en blanco, agregar encabezado, párrafo con montos, tabla con columnas moneda/porcentaje, KPIs; guardar → versión 1; editar → versión 2; restaurar 1 → versión 3.
- [ ] Subir una imagen PNG en un bloque; editar (recortar, rotar, anotar) → nueva versión con PNG nuevo; verificar que la imagen anterior sigue visible en la versión previa.
- [ ] Exportar a los 8 formatos: todos `Listo` con "Verificado · N/N cifras"; abrir PDF/XLSX/DOCX/PPTX y confirmar montos; descargar HTML/SVG (attachment).
- [ ] Documento con imagen WebP: PDF/DOCX muestran el texto alternativo.
- [ ] Seleccionar dos bloques → "Pedir cambio a la IA" (proveedor configurado) → nueva versión con solo esos bloques modificados; probar una instrucción que provoque JSON inválido y comprobar el reintento/mensaje.
- [ ] Con `studio.approve`: aprobar → compartir; desde otro usuario con `studio.use` ver el documento en "Equipo"; crear una propuesta del asistente ligada al documento (fileIds) y luego editar el contenido: el documento vuelve a borrador y la propuesta queda `invalidated` ("El documento cambió").
- [ ] Exportar un documento aprobado: el objeto queda con retención `protected` en `/app/admin/files`.
- [ ] Con el worker de jobs desactivado (`UNIK_JOB_WORKER_ENABLED=false`): exportar sigue funcionando (fallback inline).
- [ ] Desde el asistente: `createStudioDocument` a partir de un reporte, `exportStudioDocument` y `approveStudioDocument` (debe pedir aprobación en el chat).
- [ ] Responsive: editor y paneles en móvil/tablet sin desplazamiento horizontal.
