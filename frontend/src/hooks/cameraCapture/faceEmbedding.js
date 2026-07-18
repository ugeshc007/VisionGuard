import { clamp, makeVisitorCode } from "../../lib/format.js";

export function padFaceBox(box, frameWidth, frameHeight) {
  // MediaPipe's box is tight around eyes/nose/mouth, not the full head - left
  // as-is, saved crops routinely cut off the chin and forehead. Pad it out
  // (more on top, since hairline/forehead needs more room than the chin does)
  // so the saved image actually shows a complete face. Only used for cropping/
  // embedding - the on-screen tracking box stays true to what MediaPipe found.
  const padX = box.width * 0.3;
  const padTop = box.height * 0.45;
  const padBottom = box.height * 0.25;
  const x = clamp(box.x - padX, 0, frameWidth);
  const y = clamp(box.y - padTop, 0, frameHeight);
  return {
    x,
    y,
    width: clamp(box.width + (padX * 2), 1, frameWidth - x),
    height: clamp(box.height + padTop + padBottom, 1, frameHeight - y)
  };
}

export function cropFace(context, box) {
  const padded = padFaceBox(box, context.canvas.width, context.canvas.height);
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 160;
  const cropContext = canvas.getContext("2d", { willReadFrequently: true });
  cropContext.drawImage(context.canvas, padded.x, padded.y, padded.width, padded.height, 0, 0, canvas.width, canvas.height);
  return { canvas, context: cropContext, width: canvas.width, height: canvas.height };
}

export function computeImageEmbedding(context, width, height) {
  const cells = 8;
  const image = context.getImageData(0, 0, width, height).data;
  const vector = [];
  for (let cy = 0; cy < cells; cy += 1) {
    for (let cx = 0; cx < cells; cx += 1) {
      let total = 0;
      let count = 0;
      const startX = Math.floor((cx / cells) * width);
      const endX = Math.floor(((cx + 1) / cells) * width);
      const startY = Math.floor((cy / cells) * height);
      const endY = Math.floor(((cy + 1) / cells) * height);
      for (let y = startY; y < endY; y += 4) {
        for (let x = startX; x < endX; x += 4) {
          const index = (y * width + x) * 4;
          total += (image[index] + image[index + 1] + image[index + 2]) / 3;
          count += 1;
        }
      }
      vector.push(Number(((total / Math.max(1, count)) / 255).toFixed(4)));
    }
  }
  return vector;
}

export function estimateSharpness(context, width, height) {
  const image = context.getImageData(0, 0, width, height).data;
  let previous = 0;
  let totalDiff = 0;
  let samples = 0;
  for (let y = 1; y < height - 1; y += 4) {
    for (let x = 1; x < width - 1; x += 4) {
      const index = (y * width + x) * 4;
      const luminance = (image[index] * 0.299) + (image[index + 1] * 0.587) + (image[index + 2] * 0.114);
      if (samples) totalDiff += Math.abs(luminance - previous);
      previous = luminance;
      samples += 1;
    }
  }
  return Math.max(0, Math.min(100, Math.round(totalDiff / Math.max(1, samples))));
}

export function blendEmbedding(previous = [], next = []) {
  if (!Array.isArray(previous) || !previous.length) return next;
  if (!Array.isArray(next) || previous.length !== next.length) return previous;
  return previous.map((value, index) => (Number(value || 0) * 0.72) + (Number(next[index] || 0) * 0.28));
}

export function buildFacePayload(context, box, visitorSerial, index = 0) {
  const crop = cropFace(context, box);
  const embedding = computeImageEmbedding(crop.context, crop.width, crop.height);
  const sharpness = estimateSharpness(crop.context, crop.width, crop.height);
  return {
    box,
    trackId: box.trackId || "",
    confidence: box.confidence || 0,
    imageData: crop.canvas.toDataURL("image/jpeg", 0.88),
    embedding,
    sharpness,
    label: box.label || makeVisitorCode(visitorSerial, index),
    category: "visitor",
    status: "untrained"
  };
}
