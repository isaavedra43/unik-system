# Almacenamiento de objetos (Cloudflare R2)

Única fuente de verdad sobre cómo UNIK guarda, valida, entrega, migra y respalda archivos.

## 1. Arquitectura

```
Navegador ──(1) POST /app/files/api/uploads──▶ Next.js ──▶ PostgreSQL (StorageObject + UploadSession)
   │                                              │
   │◀─(2) autorizaciones por parte (URL firmada)──┘
   │
   ├──(3) PUT parte(s) ──────────────▶ R2 bucket "quarantine" (o emulador local en disco)
   │
   └──(4) POST /uploads/:id/complete ─▶ Next.js verifica tamaño ─▶ job storage.validate_object
                                                                        │
                    worker: sha256 + firma real del formato + límites ZIP + SVG
                                                                        │
                                   rechaza (borra cuarentena) ◀────────┴────────▶ promueve a bucket final, status "ready"
```

| Pieza                                        | Archivo                                            |
| -------------------------------------------- | -------------------------------------------------- |
| Configuración (env)                          | `src/modules/storage/storage-config.ts`            |
| Ajustes en BD (cuotas, retención, multipart) | `src/modules/storage/storage-settings-service.ts`  |
| Claves de objeto                             | `src/modules/storage/storage-keys.ts`              |
| Drivers R2 / disco                           | `src/modules/storage/drivers/`                     |
| Servicio principal                           | `src/modules/storage/storage-service.ts`           |
| Autorización por recurso                     | `src/modules/storage/storage-access.ts`            |
| Validación de contenido                      | `src/modules/storage/file-validation.ts`           |
| Lector ZIP acotado                           | `src/modules/storage/zip-reader.ts`                |
| Jobs (validación, limpieza, respaldo)        | `src/modules/storage/storage-jobs.ts`              |
| Migración heredada                           | `src/modules/storage/storage-migration-service.ts` |
| Respaldo y restauración                      | `src/modules/storage/storage-backup-service.ts`    |
| Cola de trabajos durable (PostgreSQL)        | `src/modules/jobs/job-queue.ts`                    |
| Eventos en tiempo real con cursor            | `src/modules/realtime/realtime-service.ts`         |
| Cliente de subida del navegador              | `src/lib/upload-client.ts`                         |
| Panel de administración                      | `/app/admin/files` (permiso `files.admin`)         |

PostgreSQL guarda nombres, tamaños, propietarios, permisos, relaciones, versiones y referencias.
Los binarios (audio, video, imágenes, documentos) van a R2.

### Claves

Generadas siempre por el servidor. Nunca contienen nombres de clientes, teléfonos, correos ni credenciales:

```
chat/{objectId}/{versionId}
assistant/{objectId}/{versionId}
documents/{objectId}/{versionId}
recordings/{callId}/{recordingId}
quarantine/{objectId}/{versionId}
```

Una nueva versión de un documento es un `StorageObject` nuevo con `parentObjectId`; nunca se sobrescribe un objeto.

### Estados de `StorageObject`

`initiated → uploading → validating → ready`, terminales: `rejected`, `aborted`, `missing`, `deleted`.

Un objeto que no está `ready` no se descarga, no se envía a un cliente ni se entrega a la IA.

### Autorización

Conocer un `StorageObject.id` no concede acceso. Cada ruta vuelve a resolver actor, ámbito y recurso:

- Subida: el **destino** (`ai_conversation`, `chat_channel`, …) decide permiso, propiedad y política (tamaño y tipos). Cada módulo conserva sus límites actuales.
- Descarga: los **registros** que referencian el objeto (adjunto de IA → dueño de la conversación; adjunto de chat → miembro activo del canal; artefacto → dueño de la conversación).
- Los módulos registran sus reglas con `registerUploadTargetResolver` / `registerFileAccessResolver`.

### Descarga y reproducción

- `GET /app/files/api/objects/:id/access` → URL firmada de 5 min (archivos ordinarios en R2) o la URL de streaming autenticado.
- `GET /app/files/api/objects/:id/content` → streaming autenticado con `Range` (audio/video adelantan y reanudan sin descargar todo).
- Grabaciones, transcripciones y documentos protegidos **siempre** por streaming autenticado.
- SVG, HTML y paquetes Office con macros se entregan solo como descarga (`Content-Disposition: attachment` + CSP `sandbox`).
- Las URLs firmadas son credenciales temporales: nunca se guardan en PostgreSQL ni se registran en logs.

Las rutas existentes `/app/chat/api/attachments/:id` y `/app/assistant/api/artifacts/:id/download` siguen funcionando y ahora hacen streaming (ya no cargan el archivo completo en memoria).

## 2. Variables de entorno

Ver `.env.example`. Resumen:

| Variable                                                          | Uso                                                                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `STORAGE_DRIVER`                                                  | `r2` o `disk`. Vacío = `r2` si hay credenciales R2, si no `disk`.                   |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`       | Token de API de R2 con Object Read & Write en los tres buckets.                     |
| `R2_ENDPOINT`                                                     | Opcional. Por defecto `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.              |
| `R2_BUCKET_FILES`, `R2_BUCKET_RECORDINGS`, `R2_BUCKET_QUARANTINE` | Nombres reales de los buckets por entorno.                                          |
| `R2_BACKUP_*`                                                     | Cuenta/token **separados** para el respaldo. Solo escritura.                        |
| `STORAGE_DISK_ROOT`                                               | Carpeta del driver de disco (desarrollo).                                           |
| `STORAGE_SIGNING_SECRET`                                          | HMAC para las autorizaciones locales de subida (fallback: `UNIK_INTERNAL_API_KEY`). |
| `UNIK_JOB_WORKER_ENABLED`                                         | `false` desactiva el worker de jobs en ese proceso.                                 |

El driver se fija al arrancar. Si R2 falla en producción la operación devuelve error: **nunca** se escribe silenciosamente un archivo permanente en el disco local.

## 3. Configuración manual en Cloudflare (pendiente del usuario)

1. Crear buckets **privados** (sin dominio público ni acceso `r2.dev`), uno por función y entorno:
   `unik-files-prod`, `unik-recordings-prod`, `unik-quarantine-prod` (y `-dev`).
2. Crear un token de API con permiso _Object Read & Write_ limitado a esos tres buckets.
3. Crear una **segunda cuenta o token** para `unik-backup-prod` con permiso de escritura; el token de producción no debe poder borrar ese bucket.
4. Configurar CORS en `unik-quarantine-*` (el navegador sube directo ahí):

   ```json
   [
     {
       "AllowedOrigins": ["https://TU-DOMINIO-RAILWAY"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["Content-Type", "Content-Length"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   `ExposeHeaders: ["ETag"]` es obligatorio: el cliente devuelve el ETag de cada parte al completar.

5. Reglas de ciclo de vida:
   - `unik-quarantine-*`: abortar multipart incompletos y borrar objetos a las 24 h (UNIK también lo hace desde el job `storage.cleanup`).
   - `unik-backup-*`: retención según política; UNIK no borra respaldos.
6. Región/preferencia geográfica al crear buckets (no es garantía de residencia en México). Región S3 = `auto`.
7. Poner las variables en Railway y verificar con `/app/admin/files` que el proveedor muestra **Cloudflare R2**.

## 4. Ajustes en base de datos (`/app/admin/files` → Cuotas y retención)

| Ajuste                         | Valor inicial            |
| ------------------------------ | ------------------------ |
| Parte multipart                | 8 MiB (mínimo 5)         |
| Umbral multipart               | 8 MiB                    |
| Cargas incompletas             | 24 h                     |
| URL de subida                  | 15 min                   |
| URL firmada de descarga        | 5 min                    |
| Cuota diaria por usuario       | 2 GiB                    |
| Expansión máxima ZIP           | 512 MiB, ratio 100       |
| Retención grabaciones          | 30 días                  |
| Retención transcripciones      | 90 días                  |
| Archivos comerciales y de chat | Sin caducidad automática |

Documentos aprobados o compartidos (`meta.protected = true` / `retentionPolicy = protected`) nunca los borra la limpieza genérica.

## 5. Migración de archivos heredados

Los archivos que hoy viven en `data/chat-attachments`, `data/ai-attachments` y `data/ai-artifacts` se migran con la utilidad reanudable (UI en `/app/admin/files` → Migración, o `scripts/storage-migrate.mjs` contra el endpoint interno `/api/internal/storage/migrate`).

Modos, en orden: `inventory → dry-run → copy → verify → reconcile`.

1. **inventory**: lee las referencias de la BD (nunca un listado de carpeta), valida que cada ruta esté dentro de los directorios permitidos, detecta presentes/ausentes/compartidas.
2. **dry-run**: calcula `sha256` sin escribir en R2.
3. **copy**: sube por lotes, verifica tamaño y crea el `StorageObject` (varias referencias al mismo archivo → un solo objeto).
4. **verify**: relee la copia, compara checksum y vincula `storageObjectId` en los registros originales.
5. **reconcile**: compara BD y almacenamiento en ambos sentidos; marca `missing`, cuenta huérfanos. Solo reporta.

Nunca se borran originales. La lectura dual (objeto o ruta heredada) se mantiene durante la transición. La copia de datos reales y la limpieza definitiva son operaciones posteriores del usuario.

```bash
UNIK_BASE_URL=https://tu-app.up.railway.app UNIK_INTERNAL_API_KEY=... node scripts/storage-migrate.mjs inventory
```

## 6. Respaldo y recuperación

- Job `storage.backup_incremental` (diario cuando `backupEnabled = true`): copia objetos `ready` nuevos/modificados a la cuenta de respaldo y escribe un manifiesto `manifests/<fecha>.json` (objetos, referencias, checksums, vencimientos).
- Respeta `expiresAt`: grabaciones y transcripciones vencidas no se respaldan; restaurarlas no extiende su retención.
- Restauración: `/app/admin/files` → Respaldo → _Restaurar_ con el id del objeto; se verifica el checksum antes de marcarlo `ready`.
- Objetivo inicial de recuperación: hasta 24 h de cambios. **Medir el tiempo de restauración con una prueba real antes de comprometer un SLA.**

## 7. Trabajos de segundo plano

`src/modules/jobs/job-queue.ts`: cola durable en PostgreSQL (`BackgroundJob`) con `FOR UPDATE SKIP LOCKED`, reintentos con backoff, prioridad (interactivo < mantenimiento < masivo) y reclamo de bloqueos huérfanos. Un worker por instancia arranca en `src/instrumentation.ts`. Redis + BullMQ puede sustituir el ejecutor sin tocar productores ni handlers; hoy no se añadió esa dependencia porque no hay Redis aprovisionado y la cola en PostgreSQL cubre los requisitos (no perder trabajos al cerrar pestaña o reiniciar).

## 8. Eventos en tiempo real

`RealtimeEvent` persiste cada evento; `GET /app/realtime/api/stream?channels=upload:<id>,user:<id>&cursor=<lastId>` reproduce lo perdido desde el cursor (o `Last-Event-ID`) y luego emite en vivo. Canales: `user:`, `upload:`, `job:`, `inbox:`, `call:`, `campaign:`; cada uno se autoriza por separado.

## 9. Pruebas

- `src/modules/storage/*.test.ts`: MIME falso, tamaño superior, ejecutables, ZIP bomba/traversal, SVG activo, contenedores de audio/video, claves seguras, rutas heredadas manipuladas, tokens de subida, `Range`.
- `storage-service.test.ts` recorre el contrato completo contra el emulador local (driver de disco): subida simple y multipart, partes fuera de orden, reintento de parte, finalización repetida, URL reutilizada tras publicar, abortar, cargas abandonadas, borrado por referencias, objetos protegidos, descargas de contenido restringido.

El emulador valida los contratos locales pero **no** sustituye comprobar CORS, firmas, multipart y compatibilidad real con R2 desde Railway.

## 10. Checklist de validación manual (usuario)

- [ ] Crear buckets, token y CORS (sección 3) y cargar variables en Railway.
- [ ] Aplicar la migración `20260912100000_add_object_storage_jobs_realtime` (`npx prisma migrate deploy` vía Pre-deploy).
- [ ] Abrir `/app/admin/files`: proveedor = Cloudflare R2, worker de jobs activo.
- [ ] Subir una imagen en el chat y en el asistente; ver estado `ready`; reproducir un audio/video con adelanto.
- [ ] Subir un archivo con extensión falsa: debe rechazarse con motivo.
- [ ] Ejecutar `inventory → dry-run → copy → verify → reconcile` y revisar el reporte.
- [ ] Ejecutar un respaldo y restaurar un objeto; anotar el tiempo de restauración.
- [ ] Medir subida/descarga desde México contra Railway antes de afirmar rapidez.
