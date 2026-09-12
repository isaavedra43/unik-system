# Piloto: manual de configuración, activación gradual y checklist

Este documento cierra la Entrega 16 del plan. Nada de lo aquí descrito se ha ejecutado contra servicios reales: cada bloque termina con lo que **el usuario** verifica antes de ampliar.

## 0. Orden recomendado de activación

1. Migraciones y almacenamiento R2 (Entregas 1–6).
2. Secretos y ejecutor común (7), luego una extensión de prueba (8–10).
3. Copiloto y biblioteca (11): no requieren servicios externos.
4. Un número de WhatsApp o un bot de Telegram en la bandeja (13-A).
5. Voz con LiveKit + Twilio en una sola cuenta (14).
7. Una campaña de ensayo con 10 destinatarios, después lotes reales (15).

Cada paso se activa por variables de entorno y permisos: sin variables, la funcionalidad queda visible pero inactiva (modo mock o error claro), nunca escribe en proveedores reales.

## 1. Migraciones (Railway Pre-deploy)

```bash
npx prisma migrate deploy
```

Migraciones nuevas (todas aditivas, sin DROP):

| Migración                                         | Contenido                                                                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260912100000_add_object_storage_jobs_realtime` | StorageObject, UploadSession, StorageConfig, BackgroundJob, RealtimeEvent; columnas opcionales en adjuntos/artefactos                                               |
| `20260912110000_add_extensions_skills_proposals`  | Extension*, ExtensionConnection, OAuthState, AiProposal, ExtensionExecution, Skill, SkillRun, UsageMeter                                                            |
| `20260912120000_add_copilot_studio_comms_voice`   | AiUserPreference, AiMemory, Knowledge*, Comm*, Responsible, Commitment, ConsentRecord, Campaign*, Voice* + índice GIN de búsqueda (Studio*, InternalRequest* y Quote se eliminan en la siguiente) |
| `20260912130000_drop_studio_requests_quotes`      | Elimina las tablas del estudio visual, solicitudes internas y cotizaciones locales (módulos retirados)                                                              |

Después de aplicar: `GET /api/health` debe seguir respondiendo `database: connected`.

## 2. Permisos nuevos (asignar desde /app/admin/access → Roles)

`files.admin` · `extensions.view` · `extensions.manage` · `extensions.connect` · `skills.manage` · `knowledge.manage` · `inbox.use` · `inbox.assign` · `inbox.admin` · `campaigns.view` · `campaigns.manage` · `campaigns.approve` · `calls.use` · `calls.supervise` · `calls.admin`.

`super_admin` los tiene todos automáticamente.

## 3. Variables de entorno por bloque

Ver `.env.example` (comentado). Resumen mínimo:

| Bloque                  | Variables                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Almacenamiento          | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_FILES`, `R2_BUCKET_RECORDINGS`, `R2_BUCKET_QUARANTINE`, opcional `R2_BACKUP_*` |
| Secretos de extensiones | `UNIK_SECRETS_MASTER_KEY` (openssl rand -base64 32), `UNIK_SECRETS_KEY_ID`, `APP_URL`                                                                  |
| Comunicaciones          | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WEBHOOK_BASE_URL`, `TELEGRAM_BOT_TOKEN` (o conexiones cifradas desde /app/admin/comms)              |
| Books                   | `ZOHO_BOOKS_ORGANIZATION_ID`, `ZOHO_BOOKS_MOCK=false` cuando esté validado                                                                             |
| Voz                     | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_SIP_TRUNK_ID`                                                                         |
| Jobs                    | `UNIK_JOB_WORKER_ENABLED` (default true; una sola réplica ejecuta schedulers Zoho; los jobs sí soportan varias réplicas)                               |

## 4. Almacenamiento R2 — activación

Sigue `docs/storage.md` §3 (buckets privados, token, CORS con `ExposeHeaders: ETag`, lifecycle de cuarentena) y §10 (checklist). Verificación del usuario:

- [ ] `/app/admin/files` muestra **Cloudflare R2** y jobs activos.
- [ ] Subir imagen en chat y asistente → `ready`; reproducir audio/video con adelanto.
- [ ] Archivo con extensión falsa → rechazado con motivo.
- [ ] Migración `inventory → dry-run → copy → verify → reconcile` con reporte sin fallos.
- [ ] Respaldo + restauración de un objeto; anotar tiempo real.
- [ ] Medir subida/descarga desde México contra Railway (no afirmar rapidez sin medir).

## 5. Extensiones — activación

Sigue `docs/extensions.md`. Verificación:

- [ ] Configurar `UNIK_SECRETS_MASTER_KEY`; guardar una conexión y comprobar que nunca vuelve al navegador.
- [ ] Crear extensión MCP de prueba → descubrir → clasificar → aprobar → habilitar para un rol → verla en el asistente solo con ese rol.
- [ ] Invocar directamente una capacidad deshabilitada por API → denegada.
- [ ] Cambiar el esquema en el servidor MCP → herramienta bloqueada y propuestas invalidadas.
- [ ] Importar OpenAPI con `$ref` remoto → aviso, no se descarga.
- [ ] Propuesta aprobada se ejecuta una sola vez; segundo clic → 409.
- [ ] Suspender extensión con jobs pendientes → jobs cancelados.

## 6. Copiloto y biblioteca

- [ ] Cambiar modo a **Pausada** y comprobar que el asistente no ofrece envíos ni cambios comerciales.
- [ ] Corrección propuesta por el asistente aparece como pendiente y solo cuenta al confirmarla.
- [ ] Subir un PDF a la biblioteca, aprobar y verificar que `searchKnowledgeLibrary` lo cita con versión; contenido interno no aparece con `visibility=publishable`.

## 7. Comunicaciones (ver `docs/communications.md`, `docs/campaigns.md`)

- [ ] Registrar un número de WhatsApp (Twilio) con webhook `https://APP/api/webhooks/twilio/messaging?accountId=...` y verificar firma.
- [ ] Bot de Telegram con `setWebhook` + `secret_token`.
- [ ] Mensaje entrante duplicado (reintento de webhook) → una sola fila.
- [ ] Respuesta desde la bandeja; reenvío tras BAJA → bloqueado.
- [ ] Compromiso vencido genera aviso.
- [ ] Campaña: audiencia y contenido congelados, ensayo con muestras, vista exacta por destinatario, presupuesto, baja durante la campaña evita siguientes envíos, pausa/reanudación sin duplicados.

## 8. Voz (ver `docs/voice.md`)

- [ ] SIP trunk Twilio ↔ LiveKit y webhooks configurados; llamada interna entre dos usuarios.
- [ ] "Pausar IA" detiene transcripción y descarta resultados tardíos; grabación con control separado visible.
- [ ] Egress a bucket `recordings` con token de solo escritura; grabación reproducible por streaming autenticado; retención 30/90 días.
- [ ] Supervisor sin permiso no obtiene token; con permiso puede escuchar/intervenir.
- [ ] Petición oral de cotización oficial → propuesta, nunca creación directa.

## 9. Capacidad y observabilidad

- Dimensionar por separado: instancia web (100 operadores, SSE ≈ 1 conexión por pestaña; PostgreSQL pool) y LiveKit/Twilio (50 llamadas concurrentes según plan del proveedor). Los jobs masivos corren con prioridad `bulk` (500) por debajo de la atención humana (`interactive` 10).
- Consumo: `/app/admin/extensions` → Consumo (por extensión) y `UsageMeter` (storage por usuario/entorno/propósito, campañas, proveedor, llamadas).
- Eventos con cursor: `/app/realtime/api/stream` (reconexión sin pérdida).

## 10. Qué NO se ha validado (honestidad operativa)

- Ninguna llamada real a R2, Twilio, Telegram, LiveKit, Zoho Books ni servidores MCP: solo emuladores, mocks y fixtures locales.
- CORS, firmas presignadas y multipart contra R2 real; latencia desde México.
- Agente de voz en tiempo real dentro de LiveKit (Agents) y cliente WebRTC de navegador (`livekit-client`) — documentados como pendientes por el módulo de voz.
- Rasterización PNG de exportaciones (sin rasterizador instalado).
