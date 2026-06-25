import base64
import io
import os
from functools import lru_cache

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image
from insightface.app import FaceAnalysis


class EmbedRequest(BaseModel):
    imageBase64: str
    mime: str | None = None


app = FastAPI(title="VisionGuard Face AI", version="1.0.0")


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
      image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
      frame = np.array(image)[:, :, ::-1]
    except Exception as exc:
      raise HTTPException(status_code=400, detail=f"Invalid image: {exc}") from exc

    faces = face_app().get(frame)
    if not faces:
      raise HTTPException(status_code=422, detail="No face found in crop")

    face = max(faces, key=lambda item: (item.bbox[2] - item.bbox[0]) * (item.bbox[3] - item.bbox[1]))
    embedding = face.normed_embedding.astype(float).tolist()
    return {
      "ok": True,
      "model": "insightface-buffalo_l-arcface",
      "dimensions": len(embedding),
      "embedding": [round(value, 8) for value in embedding],
    }
