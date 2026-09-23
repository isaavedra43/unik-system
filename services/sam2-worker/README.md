# SAM 2 worker — UNIK Visual Studio

Servicio FastAPI que produce máscaras de segmentación con SAM 2.1 para el
módulo Visual Studio. **No exponer a Internet**: la API de UNIK lo llama por
red privada (`VISUAL_SAM_URL`) con `Authorization: Bearer $VISUAL_SAM_TOKEN`.

## Desarrollo local (este Mac)

```bash
cd services/sam2-worker
uv venv --python 3.12 .venv
VIRTUAL_ENV=.venv uv pip install --python .venv/bin/python -r requirements.txt
VISUAL_SAM_TOKEN=dev .venv/bin/python -m uvicorn app.main:app --port 8123
```

El primer arranque descarga el checkpoint `sam2.1_hiera_tiny.pt` (~149 MB) a
`checkpoints/`. En Apple Silicon usa `mps`; si no, CPU.

## API

- `GET /health` → `{ ok, model, device }`
- `POST /segment` → `{ image_b64 | image_url, points: [{x,y,positive}], box?, mask_b64? }`
  → `{ mask_png_b64, score, width, height, model, device }`

`mask_b64` permite refinar una máscara previa con clics adicionales. La edición
manual con pincel/borrador ocurre en el cliente sobre el bitmap; el worker solo
re-sintetiza cuando hay nuevos prompts.

## Modelos

`SAM_MODEL` acepta `sam2.1_hiera_tiny` (default), `sam2.1_hiera_small`,
`sam2.1_hiera_base_plus`, `sam2.1_hiera_large`. Tiny es suficiente para
superficies arquitectónicas en interactivo; los mayores mejoran bordes finos a
costa de VRAM/latencia.
