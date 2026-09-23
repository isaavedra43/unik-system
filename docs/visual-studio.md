# UNIK Visual Studio

Módulo integrado en UNIK para transformar fotografías reales de espacios
(cocinas, baños, salas, fachadas) con los materiales del catálogo. No es una
app separada: vive en `/app/visual-studio`, usa la autenticación, permisos,
storage, cola de trabajos y orquestador de IA existentes.

## Arquitectura

```
┌─ Next.js (Railway) ─────────────────────────────────────────────┐
│ /app/visual-studio            UI: biblioteca, lienzo, catálogo  │
│ /app/visual-studio/api/*      Rutas autenticadas                │
│ modules/visual-studio/        Servicio, contratos, adaptadores  │
│ modules/ai/tools/visual-*     Tools del orquestador             │
│ job-queue: visual.generate    Generación en background          │
└──────┬──────────────────────────────┬───────────────────────────┘
       │ HTTP (VISUAL_SAM_URL)        │ MCP oauth2 (extensión)
       ▼                              ▼
 services/sam2-worker          Higgsfield MCP
 FastAPI + SAM 2 (local/GPU)   https://mcp.higgsfield.ai/mcp
 solo produce MÁSCARAS         nano_banana_2 (mask), flux_kontext…
```

## Flujo

1. El empleado crea un proyecto y sube la foto del cliente
   (`/app/files/api/uploads` con target `visual_project:<id>` — pipeline de
   subida firmada existente, propósito `visual`).
2. En el lienzo marca la superficie (clic +/−, caja) → `POST api/surfaces` →
   el servidor envía la foto al worker SAM → máscara PNG guardada en storage
   + `maskHistory` en `VisualSurface`.
3. Corrección: más clics contra la máscara previa, o pincel/borrador que sube
   la máscara editada (`PATCH api/surfaces/[id]`). Cada versión queda en el
   historial.
4. Catálogo: `api/products` busca en `Product` (sync real de Zoho Inventory);
   las referencias visuales son `ProductMedia` (target `product_media`).
5. `POST api/proposals` crea `VisualProposal` y encola `visual.generate`
   (dedupe por propuesta). El handler sube foto+máscara+referencias a
   Higgsfield (`media_upload`→`media_confirm`), somete `generate_image`,
   hace polling de `job_status`, descarga el resultado y lo guarda como
   objeto `visual` restringido. Fallos → status `failed` con el error.
6. Comparador antes/después en la UI; `POST api/proposals/[id]/select`
   registra la elección del cliente.

## Permisos (`visual_studio.*`)

| Permiso | Uso |
|---|---|
| `view` | Abrir proyectos, ver propuestas, descargar objetos `visual` |
| `edit` | Proyectos, fotos, superficies, corrección de máscaras |
| `generate` | Solicitar generaciones (consume créditos; `business_write` → aprobación) |
| `select` | Marcar la propuesta elegida por el cliente |
| `media` | Gestionar imágenes de referencia de productos |

## Modelos de datos (migración `visual_studio`)

- `VisualProject` — nombre, notas, vínculos a `Contact`/`Quote`/`SalesOrder`.
- `VisualAsset` — fotos del proyecto (original/máscara/resultado/referencia).
- `VisualSurface` — máscara actual + `promptSpec` + `maskHistory` completo.
- `VisualProposal` — modo, prompt, provider/model/jobId, costo, resultado,
  versión, `selectedAt` (elección del cliente).
- `ProductMedia` — imágenes de referencia de productos del catálogo.

## Configuración

| Variable | Descripción |
|---|---|
| `VISUAL_SAM_URL` | URL del worker SAM 2 (`http://127.0.0.1:8765` en dev). |
| `VISUAL_SAM_TOKEN` | Bearer compartido con el worker. |
| `VISUAL_HF_MODEL_FAITHFUL` | Modelo para modo fiel (default `nano_banana_2`). |
| `VISUAL_HF_MODEL_CREATIVE` | Modelo para modo creativo (default `flux_kontext`). |

Worker local:

```bash
cd services/sam2-worker
uv venv --python 3.12 .venv && uv pip install -r requirements.txt
VISUAL_SAM_TOKEN=<token> .venv/bin/python -m uvicorn app.main:app --port 8765
```

Higgsfield: Admin → Extensiones → MCP `https://mcp.higgsfield.ai/mcp`,
namespace `higgsfield`, conexión OAuth2. Aprobar capabilities:
`media_upload`, `media_confirm`, `generate_image`, `job_status`, `balance`.
Sin extensión/capabilities el adaptador falla con `unconfigured`/`capability`
y la propuesta queda en `failed` — nunca se reporta éxito ficticio.

## Límites conocidos

- El modo `faithful` depende de que el modelo respete el role `mask`; la
  tolerancia visual se valida por revisión, no hay métrica automática aún.
- Las cantidades/dimensiones NUNCA se deducen de la foto: la cotización
  exige captura explícita (flujo de ventas existente).
- SAM 2.1 tiny es el default local (MPS); small/base+ están soportados por
  `SAM_MODEL` pero requieren más VRAM — evaluar con fotos reales.
