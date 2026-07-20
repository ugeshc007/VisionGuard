import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import { clamp } from "../../lib/format.js";
import { boxIou } from "./boxGeometry.js";

const MEDIAPIPE_WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
// full_range (not short_range) - trained for faces further from the camera and at
// wider angles, which matches this app's overhead/wide-FOV CCTV footage far better
// than BlazeFace's short-range (webcam/selfie) model.
const MEDIAPIPE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite";

function createDetectorState() {
  return { detector: null, mode: "idle" };
}

async function loadMediaPipeDetector(state) {
  if (state.detector) return state.detector;
  if (state.detector === false) return null;
  try {
    const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);
    state.detector = await FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MEDIAPIPE_MODEL_URL, delegate: "GPU" },
      runningMode: "IMAGE",
      // 0.4 was too permissive - it let round, high-contrast non-face shapes
      // (an RGB PC case fan, glass reflections) through as "faces," which then
      // got sent off for a name lookup and wrongly tagged as a real person.
      // 0.6 still wasn't enough for a particularly bright/symmetric RGB fan in
      // one deployment's IT cabin camera (confirmed via saved rejected crops in
      // reports/debug-faces) - raised further, though this trades off some real
      // faces at extreme angles/distance in wide-FOV CCTV shots.
      minDetectionConfidence: 0.7
    });
    return state.detector;
  } catch (error) {
    state.detector = false;
    state.mode = `MediaPipe unavailable: ${error.message}`;
    return null;
  }
}

async function detectFaceBoxes(state, source, width, height) {
  const detector = await loadMediaPipeDetector(state);
  if (!detector) {
    if (!state.mode.startsWith("MediaPipe unavailable")) state.mode = "not available";
    return [];
  }
  const result = detector.detect(source);
  state.mode = "MediaPipe (full-range)";
  return (result.detections || []).map((detection) => {
    const box = detection.boundingBox || {};
    const score = detection.categories?.[0]?.score ?? 0;
    return {
      x: clamp(box.originX, 0, width),
      y: clamp(box.originY, 0, height),
      width: clamp(box.width, 1, width - box.originX),
      height: clamp(box.height, 1, height - box.originY),
      confidence: Math.round(score * 100)
    };
  });
}

function tileRegions(width, height) {
  // Overhead/wide-angle CCTV frames put faces at a small fraction of the full
  // frame, which the detector misses when run on the whole image at once.
  // Scan overlapping tiles so each face fills a much larger share of what
  // the detector actually sees.
  //
  // The model resizes whatever crop it's given down to its own small fixed
  // input internally, so what matters isn't the tile's pixel size but how
  // much of the tile's *area* the face occupies. A denser grid shrinks each
  // tile's real-world coverage so the same face fills a much larger share
  // of it before that internal resize.
  const cols = 5;
  const rows = 4;
  const tileWidth = Math.min(width, Math.ceil((width / cols) * 1.3));
  const tileHeight = Math.min(height, Math.ceil((height / rows) * 1.3));
  const stepX = cols > 1 ? (width - tileWidth) / (cols - 1) : 0;
  const stepY = rows > 1 ? (height - tileHeight) / (rows - 1) : 0;
  const regions = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      regions.push({
        x: Math.round(clamp(col * stepX, 0, width - tileWidth)),
        y: Math.round(clamp(row * stepY, 0, height - tileHeight)),
        width: tileWidth,
        height: tileHeight
      });
    }
  }
  return regions;
}

async function detectFacesInRegion(state, source, region) {
  // Preserve the tile's aspect ratio when resizing into the detection canvas -
  // stretching it to a fixed square would distort faces and hurt accuracy.
  const maxTileDim = 640;
  const scale = maxTileDim / Math.max(region.width, region.height);
  const destWidth = Math.round(region.width * scale);
  const destHeight = Math.round(region.height * scale);
  const tileCanvas = document.createElement("canvas");
  tileCanvas.width = destWidth;
  tileCanvas.height = destHeight;
  const tileContext = tileCanvas.getContext("2d", { willReadFrequently: true });
  tileContext.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, destWidth, destHeight);
  const boxes = await detectFaceBoxes(state, tileCanvas, destWidth, destHeight);
  const scaleX = region.width / destWidth;
  const scaleY = region.height / destHeight;
  return boxes.map((box) => ({
    ...box,
    x: region.x + (box.x * scaleX),
    y: region.y + (box.y * scaleY),
    width: box.width * scaleX,
    height: box.height * scaleY
  }));
}

function mergeOverlappingBoxes(boxes, iouThreshold = 0.3) {
  const sorted = [...boxes].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const kept = [];
  sorted.forEach((box) => {
    if (!kept.some((existing) => boxIou(box, existing) > iouThreshold)) kept.push(box);
  });
  return kept;
}

async function detectFaceBoxesWide(state, source, width, height) {
  const wholeFrameBoxes = await detectFaceBoxes(state, source, width, height);
  if (width < 960 && height < 960) return wholeFrameBoxes;
  const regions = tileRegions(width, height);
  const tileBoxes = await Promise.all(regions.map((region) => detectFacesInRegion(state, source, region)));
  return mergeOverlappingBoxes([...wholeFrameBoxes, ...tileBoxes.flat()]);
}

// Single entry point for this module: callers get a detector bound to its own
// internal MediaPipe/tiling state, without needing to know about (or juggle)
// any of the pieces above.
export function createFaceDetector() {
  const state = createDetectorState();
  return {
    detect: (source, width, height) => detectFaceBoxesWide(state, source, width, height),
    get mode() { return state.mode; }
  };
}
