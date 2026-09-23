"""UNIK Visual Studio — SAM 2 segmentation worker.

Servicio FastAPI local/privado: recibe una imagen + prompts (clics
positivos/negativos y/o caja) y devuelve una máscara binaria PNG. No expone
generación de imágenes; su única responsabilidad es producir máscaras precisas.

Auth: Authorization: Bearer $VISUAL_SAM_TOKEN (requerido si la variable está
definida). No publicar este servicio a Internet.
"""

from __future__ import annotations

import base64
import io
import os
import threading
import urllib.request

import numpy as np
import torch
from fastapi import FastAPI, Header, HTTPException
from PIL import Image
from pydantic import BaseModel, Field

SAM_MODEL = os.environ.get("SAM_MODEL", "sam2.1_hiera_tiny")
CHECKPOINT_DIR = os.environ.get("SAM_CHECKPOINT_DIR", os.path.join(os.path.dirname(__file__), "..", "checkpoints"))
CHECKPOINT_URLS = {
    "sam2.1_hiera_tiny": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt",
    "sam2.1_hiera_small": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt",
    "sam2.1_hiera_base_plus": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_base_plus.pt",
    "sam2.1_hiera_large": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt",
}
CONFIG_NAMES = {
    "sam2.1_hiera_tiny": "configs/sam2.1/sam2.1_hiera_t.yaml",
    "sam2.1_hiera_small": "configs/sam2.1/sam2.1_hiera_s.yaml",
    "sam2.1_hiera_base_plus": "configs/sam2.1/sam2.1_hiera_b+.yaml",
    "sam2.1_hiera_large": "configs/sam2.1/sam2.1_hiera_l.yaml",
}
MAX_IMAGE_PIXELS = int(os.environ.get("SAM_MAX_IMAGE_PIXELS", "4096000"))  # 2048x2000 aprox.
AUTH_TOKEN = os.environ.get("VISUAL_SAM_TOKEN")

app = FastAPI(title="unik-sam2-worker", version="1.0.0")
_predictor = None
_lock = threading.Lock()


def _device() -> str:
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _checkpoint_path() -> str:
    os.makedirs(CHECKPOINT_DIR, exist_ok=True)
    path = os.path.join(CHECKPOINT_DIR, f"{SAM_MODEL}.pt")
    if not os.path.exists(path):
        url = CHECKPOINT_URLS.get(SAM_MODEL)
        if not url:
            raise RuntimeError(f"Modelo desconocido: {SAM_MODEL}")
        urllib.request.urlretrieve(url, path)
    return path


def _load() -> None:
    global _predictor
    if _predictor is not None:
        return
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    model = build_sam2(CONFIG_NAMES[SAM_MODEL], _checkpoint_path(), device=_device())
    _predictor = SAM2ImagePredictor(model)


def _check_auth(authorization: str | None) -> None:
    if not AUTH_TOKEN:
        return
    if authorization != f"Bearer {AUTH_TOKEN}":
        raise HTTPException(status_code=401, detail="token inválido")


def _load_image(body: "SegmentRequest") -> Image.Image:
    if body.image_b64:
        raw = base64.b64decode(body.image_b64)
    elif body.image_url:
        req = urllib.request.Request(body.image_url, headers={"User-Agent": "unik-sam2-worker"})
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read(64 * 1024 * 1024)
    else:
        raise HTTPException(status_code=400, detail="image_b64 o image_url requerido")
    image = Image.open(io.BytesIO(raw)).convert("RGB")
    if image.width * image.height > MAX_IMAGE_PIXELS:
        raise HTTPException(status_code=413, detail="imagen demasiado grande")
    return image


class Point(BaseModel):
    x: float
    y: float
    positive: bool = True


class Box(BaseModel):
    x: float
    y: float
    w: float
    h: float


class SegmentRequest(BaseModel):
    image_b64: str | None = None
    image_url: str | None = None
    points: list[Point] = Field(default_factory=list)
    box: Box | None = None
    mask_b64: str | None = Field(
        default=None,
        description="Máscara previa (PNG base64) para refinar con nuevos clics.",
    )


class SegmentResponse(BaseModel):
    mask_png_b64: str
    score: float
    width: int
    height: int
    model: str
    device: str


@app.on_event("startup")
def startup() -> None:
    _load()


@app.get("/health")
def health() -> dict:
    return {
        "ok": _predictor is not None,
        "model": SAM_MODEL,
        "device": _device(),
    }


@app.post("/segment", response_model=SegmentResponse)
def segment(body: SegmentRequest, authorization: str | None = Header(default=None)):
    _check_auth(authorization)
    if not body.points and body.box is None and not body.mask_b64:
        raise HTTPException(status_code=400, detail="Se requiere al menos un punto, una caja o una máscara previa")
    image = _load_image(body)

    coords = np.array([[p.x, p.y] for p in body.points], dtype=np.float32) if body.points else None
    labels = np.array([1 if p.positive else 0 for p in body.points], dtype=np.int32) if body.points else None
    box = np.array([body.box.x, body.box.y, body.box.x + body.box.w, body.box.y + body.box.h], dtype=np.float32) if body.box else None

    mask_input = None
    if body.mask_b64:
        prior = Image.open(io.BytesIO(base64.b64decode(body.mask_b64))).convert("L")
        # SAM espera la máscara previa a baja resolución (256x256), no full-res.
        prior = prior.resize((256, 256), Image.NEAREST)
        mask_input = (np.array(prior) > 127).astype(np.float32)[None, :, :]

    with _lock:
        _predictor.set_image(np.array(image))
        masks, scores, _ = _predictor.predict(
            point_coords=coords,
            point_labels=labels,
            box=box,
            mask_input=mask_input,
            multimask_output=mask_input is None,
        )
    best = int(np.argmax(scores))
    mask = (masks[best] > 0).astype(np.uint8) * 255

    out = io.BytesIO()
    Image.fromarray(mask, mode="L").save(out, format="PNG")
    return SegmentResponse(
        mask_png_b64=base64.b64encode(out.getvalue()).decode("ascii"),
        score=float(scores[best]),
        width=image.width,
        height=image.height,
        model=SAM_MODEL,
        device=_device(),
    )
