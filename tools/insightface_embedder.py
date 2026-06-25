import base64
import io
import json
import sys


def fail(message, code=2):
    sys.stderr.write(message)
    sys.exit(code)


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        image_bytes = base64.b64decode(payload.get("imageBase64") or "")
    except Exception as exc:
        fail(f"Invalid embedder payload: {exc}")

    try:
        import numpy as np
        from PIL import Image
        from insightface.app import FaceAnalysis
    except Exception as exc:
        fail(f"InsightFace dependencies are not installed: {exc}", 3)

    try:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        frame = np.array(image)[:, :, ::-1]
        app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
        app.prepare(ctx_id=-1, det_size=(320, 320))
        faces = app.get(frame)
        if not faces:
            fail("InsightFace found no face in crop.", 4)
        face = max(faces, key=lambda item: (item.bbox[2] - item.bbox[0]) * (item.bbox[3] - item.bbox[1]))
        embedding = face.normed_embedding.astype(float).tolist()
        print(json.dumps({
            "ok": True,
            "model": "insightface-buffalo_l-arcface",
            "dimensions": len(embedding),
            "embedding": [round(value, 8) for value in embedding],
        }))
    except Exception as exc:
        fail(f"InsightFace embedding failed: {exc}", 5)


if __name__ == "__main__":
    main()
