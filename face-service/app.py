import base64
import io
import os
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image
from insightface.app import FaceAnalysis


class EmbedRequest(BaseModel):
    imageBase64: str
    mime: str | None = None


app = FastAPI(title="VisionGuard Face AI", version="1.0.0")

# Same convention as the Node backend's saveDebugFaceCrop (backend/utils/faceEngine.js) -
# split into two folders so a genuine "not a face" verdict doesn't get mixed in with
# the service/payload actually breaking:
#   - debug-faces: MediaPipe upstream thought this was a face, InsightFace disagreed.
#   - debug-backend-errors: the payload itself was bad (undecodable image, etc).
REPORTS_DIR = Path(__file__).resolve().parent.parent / "reports"
DEBUG_FACES_DIR = REPORTS_DIR / "debug-faces"
DEBUG_BACKEND_ERRORS_DIR = REPORTS_DIR / "debug-backend-errors"


def save_debug_crop(image_bytes: bytes, mime: str | None, status: int, target_dir: Path = DEBUG_FACES_DIR) -> None:
    try:
        extension = (mime or "image/jpeg").split("/")[-1].split("+")[0] or "jpg"
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%f")
        target_dir.mkdir(parents=True, exist_ok=True)
        (target_dir / f"{stamp}_{status}.{extension}").write_bytes(image_bytes)
    except Exception:
        pass


@lru_cache(maxsize=1)
def face_app():
    providers = ["CPUExecutionProvider"]
    model = FaceAnalysis(name=os.getenv("INSIGHTFACE_MODEL", "buffalo_l"), providers=providers)
    model.prepare(ctx_id=-1, det_size=(320, 320))
    return model


@app.get("/health")
def health():
    return {"ok": True, "model": os.getenv("INSIGHTFACE_MODEL", "buffalo_l")}


@app.post("/embed")
def embed(payload: EmbedRequest):
    try:
      image_bytes = base64.b64decode(payload.imageBase64)
    except Exception as exc:
      raise HTTPException(status_code=400, detail=f"Invalid image: {exc}") from exc

    try:
      image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
      frame = np.array(image)[:, :, ::-1]
    except Exception as exc:
      save_debug_crop(image_bytes, payload.mime, 400, DEBUG_BACKEND_ERRORS_DIR)
      raise HTTPException(status_code=400, detail=f"Invalid image: {exc}") from exc

    faces = face_app().get(frame)
    if not faces:
      save_debug_crop(image_bytes, payload.mime, 422, DEBUG_FACES_DIR)
      raise HTTPException(status_code=422, detail="No face found in crop")

    face = max(faces, key=lambda item: (item.bbox[2] - item.bbox[0]) * (item.bbox[3] - item.bbox[1]))
    embedding = face.normed_embedding.astype(float).tolist()
    return {
      "ok": True,
      "model": "insightface-buffalo_l-arcface",
      "dimensions": len(embedding),
      "embedding": [round(value, 8) for value in embedding],
    }
