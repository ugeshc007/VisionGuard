import { useEffect, useRef, useState } from "react";
import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import { api } from "../lib/api.js";
import { clamp, cosineSimilarity, displayFaceName, isBrowserLocalCamera, isRemoteFrameCamera, localizeGatewayUrl, makeVisitorCode } from "../lib/format.js";
import { attachWebRTC } from "../lib/webrtc.js";

const MEDIAPIPE_WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
// full_range (not short_range) - trained for faces further from the camera and at
// wider angles, which matches this app's overhead/wide-FOV CCTV footage far better
// than BlazeFace's short-range (webcam/selfie) model.
const MEDIAPIPE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite";

const CAPTURE_RESUME_KEY = "visionguard.captureSession";

export function useCameraCapture({ cameras, faces, toast, reload, processPendingFaces }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [selectedCameraId, setSelectedCameraIdState] = useState("");
  const [statusText, setStatusText] = useState("Start one selected camera for debugging, or start all cameras for CCTV tracking across areas.");
  const [captureMode, setCaptureMode] = useState("idle"); // "idle" | "selected" | "all"

  // Mutable state mirrored via refs so async loops / intervals always see fresh values,
  // matching the original module-level `state` object semantics.
  const m = useRef({
    localStream: null,
    remoteConnection: null,
    autoCaptureTimer: null,
    autoCaptureBusy: false,
    autoCaptureMode: "selected",
    activeCaptureCameraId: "",
    activeCaptureCameraIds: [],
    rotationTimer: null,
    rotationIndex: -1,
    captureSessionStats: { attempts: 0, saved: 0, skipped: 0 },
    trackingFrame: null,
    faceOverlayEnabled: true,
    mediaPipeDetector: null,
    faceDetectorMode: "idle",
    liveFaces: [],
    lastTrackedBoxes: [],
    trackingBusy: false,
    lastDetectionAt: 0,
    cameras: [],
    faces: [],
    selectedCameraId: ""
  }).current;

  const visitorSerial = useRef(0);

  useEffect(() => { m.cameras = cameras; }, [cameras]);
  useEffect(() => { m.faces = faces; }, [faces]);
  useEffect(() => { m.selectedCameraId = selectedCameraId; }, [selectedCameraId]);

  const selectedCamera = cameras.find((camera) => camera.id === selectedCameraId) || cameras[0] || null;

  // Depend on primitive fields (not the `cameras` array reference) so this doesn't
  // tear down and reconnect the WebRTC preview every time reload() refreshes the
  // camera list (e.g. after each auto-capture save).
  useEffect(() => {
    if (m.remoteConnection) {
      try { m.remoteConnection.destroy(); } catch { /* ignore */ }
      m.remoteConnection = null;
    }
    const video = videoRef.current;
    // Clear immediately, before the playable/webrtcUrl check below. Otherwise
    // switching to a camera that isn't WebRTC-playable (not gateway-synced yet,
    // or a placeholder with no stream) leaves the previous camera's last frame
    // frozen on screen - closing its connection stops new frames arriving, but
    // doesn't blank the <video> element on its own.
    if (video) video.srcObject = null;
    if (!selectedCamera || isBrowserLocalCamera(selectedCamera) || !selectedCamera.playable || !selectedCamera.webrtcUrl) return undefined;
    if (!video) return undefined;
    if (m.localStream) {
      m.localStream.getTracks().forEach((track) => track.stop());
      m.localStream = null;
    }
    m.remoteConnection = attachWebRTC(video, localizeGatewayUrl(selectedCamera.webrtcUrl));
    startFaceTracking();
    setStatusText(`Previewing ${selectedCamera.name} live over WebRTC. Start detection to save new faces.`);
    return () => {
      if (m.remoteConnection) {
        try { m.remoteConnection.destroy(); } catch { /* ignore */ }
        m.remoteConnection = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCamera?.id, selectedCamera?.playable, selectedCamera?.webrtcUrl]);

  // Default behavior: rotate the preview through every WebRTC-playable camera
  // whenever nothing else is driving what's shown (no detection running, and no
  // manual camera pick from the dropdown - see selectCamera below, which pauses
  // this). Detection itself never starts on its own; it's still only ever
  // triggered by the explicit start buttons.
  useEffect(() => {
    if (captureMode !== "idle") return undefined;
    startCameraRotation(getActiveRemoteCameraIds);
    return () => stopCameraRotation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureMode]);

  function selectedCaptureCamera() {
    const selectedId = m.selectedCameraId || m.cameras[0]?.id || "";
    return m.cameras.find((camera) => camera.id === selectedId) || m.cameras[0] || null;
  }

  function selectCamera(cameraId) {
    if (m.autoCaptureTimer && m.autoCaptureMode === "selected") {
      stopAutoCapture("Camera selection changed. Detection stopped.");
    }
    // Manually picking a camera overrides the default rotation - otherwise the
    // next rotation tick (up to 6s later) would yank the preview away from what
    // was just explicitly chosen.
    stopCameraRotation();
    setSelectedCameraIdState(cameraId);
  }

  function waitForVideoReady(video) {
    if (video.readyState >= 2 && video.videoWidth) return Promise.resolve();
    return new Promise((resolve) => {
      video.onloadedmetadata = () => resolve();
      setTimeout(resolve, 1200);
    });
  }

  async function loadMediaPipeDetector() {
    if (m.mediaPipeDetector) return m.mediaPipeDetector;
    if (m.mediaPipeDetector === false) return null;
    try {
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);
      m.mediaPipeDetector = await FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MEDIAPIPE_MODEL_URL, delegate: "GPU" },
        runningMode: "IMAGE",
        // 0.4 was too permissive - it let round, high-contrast non-face shapes
        // (an RGB PC case fan, glass reflections) through as "faces," which then
        // got sent off for a name lookup and wrongly tagged as a real person.
        minDetectionConfidence: 0.6
      });
      return m.mediaPipeDetector;
    } catch (error) {
      m.mediaPipeDetector = false;
      m.faceDetectorMode = `MediaPipe unavailable: ${error.message}`;
      return null;
    }
  }

  async function detectFaceBoxes(source, width, height) {
    const detector = await loadMediaPipeDetector();
    if (!detector) {
      if (!m.faceDetectorMode.startsWith("MediaPipe unavailable")) m.faceDetectorMode = "not available";
      return [];
    }
    const result = detector.detect(source);
    m.faceDetectorMode = "MediaPipe (full-range)";
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

  async function detectFacesInRegion(source, region) {
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
    const boxes = await detectFaceBoxes(tileCanvas, destWidth, destHeight);
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

  async function detectFaceBoxesWide(source, width, height) {
    const wholeFrameBoxes = await detectFaceBoxes(source, width, height);
    if (width < 960 && height < 960) return wholeFrameBoxes;
    const regions = tileRegions(width, height);
    const tileBoxes = await Promise.all(regions.map((region) => detectFacesInRegion(source, region)));
    return mergeOverlappingBoxes([...wholeFrameBoxes, ...tileBoxes.flat()]);
  }

  function drawFaceBoxes(context, boxes) {
    context.lineWidth = 4;
    context.font = "700 18px system-ui, sans-serif";
    context.textBaseline = "top";
    boxes.forEach((box) => {
      const colors = box.state === "known"
        ? { stroke: "#1ce187", fill: "rgba(28, 225, 135, .16)", pill: "rgba(28, 225, 135, .94)" }
        : box.state === "low-confidence"
          ? { stroke: "#ff6b6b", fill: "rgba(255, 107, 107, .12)", pill: "rgba(255, 107, 107, .92)" }
          : box.state === "tracking"
            ? { stroke: "#ffd166", fill: "rgba(255, 209, 102, .14)", pill: "rgba(255, 209, 102, .95)" }
            : { stroke: "#37e7d4", fill: "rgba(55, 231, 212, .16)", pill: "rgba(55, 231, 212, .95)" };
      context.globalAlpha = Number(box.opacity || 1);
      context.strokeStyle = colors.stroke;
      context.fillStyle = colors.fill;
      context.fillRect(box.x, box.y, box.width, box.height);
      context.strokeRect(box.x, box.y, box.width, box.height);
      const label = `${box.label || "Face detected"}${box.confidenceLabel ? ` ${box.confidenceLabel}` : ""}`;
      const textWidth = context.measureText(label).width + 18;
      const labelY = Math.max(0, box.y - 30);
      context.fillStyle = colors.pill;
      context.fillRect(box.x, labelY, textWidth, 26);
      context.fillStyle = "#071019";
      context.fillText(label, box.x + 9, labelY + 4);
      context.globalAlpha = 1;
    });
    context.globalAlpha = 1;
  }

  function boxIou(a = {}, b = {}) {
    const x1 = Math.max(a.x || 0, b.x || 0);
    const y1 = Math.max(a.y || 0, b.y || 0);
    const x2 = Math.min((a.x || 0) + (a.width || 0), (b.x || 0) + (b.width || 0));
    const y2 = Math.min((a.y || 0) + (a.height || 0), (b.y || 0) + (b.height || 0));
    const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const areaA = Math.max(0, a.width || 0) * Math.max(0, a.height || 0);
    const areaB = Math.max(0, b.width || 0) * Math.max(0, b.height || 0);
    return intersection / (areaA + areaB - intersection || 1);
  }

  function boxTrackingScore(nextBox = {}, previousBox = {}) {
    const overlap = boxIou(nextBox, previousBox);
    const nextCenter = { x: nextBox.x + nextBox.width / 2, y: nextBox.y + nextBox.height / 2 };
    const previousCenter = { x: previousBox.x + previousBox.width / 2, y: previousBox.y + previousBox.height / 2 };
    const distance = Math.hypot(nextCenter.x - previousCenter.x, nextCenter.y - previousCenter.y);
    const size = Math.max(nextBox.width, nextBox.height, previousBox.width, previousBox.height, 1);
    const centerScore = Math.max(0, 1 - (distance / (size * 1.8)));
    return Math.max(overlap, centerScore * 0.72);
  }

  function blendEmbedding(previous = [], next = []) {
    if (!Array.isArray(previous) || !previous.length) return next;
    if (!Array.isArray(next) || previous.length !== next.length) return previous;
    return previous.map((value, index) => (Number(value || 0) * 0.72) + (Number(next[index] || 0) * 0.28));
  }

  function findBestKnownFace(embedding) {
    let best = null;
    m.faces.forEach((face) => {
      const isKnown = face.status === "trained" || ["employee", "customer", "known", "watchlist", "blocked"].includes(face.identityResult || "");
      if (!isKnown) return;
      const candidate = Array.isArray(face.embedding) ? face.embedding : [];
      const score = cosineSimilarity(embedding, candidate);
      if (!best || score > best.score) {
        best = { score, personId: face.personId || face.matchedPersonId, label: displayFaceName(face) };
      }
    });
    return best;
  }

  async function identifyFaceOnServer(imageData) {
    // The client-side embedding (computeImageEmbedding) is a crude 8x8
    // average-luminance grid - nowhere near good enough to recognize a real
    // face reliably. The backend's /api/forensics/face-search route runs the
    // crop through the real embedding pipeline (InsightFace/embedding
    // service) and compares it against trained people with pgvector cosine
    // similarity, so that's what decides actual identity, not the local grid
    // descriptor above (which only drives fast, latency-free box tracking).
    try {
      const result = await api("/api/forensics/face-search", {
        method: "POST",
        body: JSON.stringify({ imageData })
      });
      const best = (result.matches || [])[0];
      if (!best || !best.personId) return null;
      // The backend's own "reliable match" bar for its capture pipeline is 0.82,
      // but that pipeline only ever feeds it pre-vetted face crops. Live tracking
      // crops aren't vetted at all - a false detection (e.g. a PC case or a
      // reflection) can still embed to *something*, so require a higher bar here
      // to avoid confidently mislabeling non-face objects with a real person's name.
      if (Number(best.similarity) < 0.9) return null;
      return { personId: best.personId, name: best.displayName || best.label };
    } catch {
      return null;
    }
  }

  function requestServerIdentity(track, crop, detectionConfidence = 0) {
    if (!track || track.isKnown) return;
    // Don't bother identifying low-confidence detections - these are the ones
    // most likely to be false positives (round/high-contrast non-face shapes)
    // rather than a real face worth a name lookup.
    if (detectionConfidence < 55) return;
    const now = Date.now();
    if (now - Number(track.serverCheckAt || 0) < 6000) return;
    track.serverCheckAt = now;
    const imageData = crop.canvas.toDataURL("image/jpeg", 0.85);
    identifyFaceOnServer(imageData).then((match) => {
      const current = m.liveFaces.find((face) => face.trackId === track.trackId);
      if (!current || current.isKnown) return;
      if (!match) {
        current.pendingMatch = null;
        return;
      }
      // Require the same person to come back on two separate lookups before
      // trusting it - a single lookup on a borderline/non-face crop can land
      // above the similarity bar by chance, which is exactly what mislabeled
      // a PC case as a person earlier.
      if (current.pendingMatch?.personId === match.personId) {
        current.isKnown = true;
        current.personId = match.personId;
        current.label = match.name;
      } else {
        current.pendingMatch = match;
      }
    });
  }

  function findBestLiveTrack(box, embedding, usedTrackIds = new Set()) {
    let best = null;
    m.liveFaces.forEach((face) => {
      if (usedTrackIds.has(face.trackId)) return;
      const embedScore = cosineSimilarity(embedding, face.embedding);
      const boxScore = face.box ? boxTrackingScore(box, face.box) : 0;
      const sameAppearance = embedScore >= 0.94;
      const sameMovingFace = boxScore >= 0.68 && embedScore >= 0.82;
      if (!sameAppearance && !sameMovingFace) return;
      const score = (embedScore * 0.7) + (boxScore * 0.3);
      if (!best || score > best.score) best = { ...face, score, embedScore, boxScore };
    });
    return best;
  }

  function resolveLiveFaceLabels(context, boxes) {
    const now = Date.now();
    m.liveFaces = m.liveFaces.filter((face) => now - face.lastSeen < 120000);
    const usedTrackIds = new Set();
    boxes.forEach((box, index) => {
      const crop = cropFace(context, box);
      const embedding = computeImageEmbedding(crop.context, crop.width, crop.height);
      const known = findBestKnownFace(embedding);
      if (known && known.score >= 0.985) {
        box.label = known.label;
        box.isKnown = true;
        box.state = "known";
        box.confidenceLabel = `${Math.round(known.score * 100)}%`;
        box.trackId = known.personId || known.label;
        const existingKnownTrack = m.liveFaces.find((face) => face.personId && face.personId === known.personId);
        if (existingKnownTrack) {
          Object.assign(existingKnownTrack, { label: known.label, embedding, box: { ...box }, lastSeen: now, isKnown: true, personId: known.personId });
          usedTrackIds.add(existingKnownTrack.trackId);
        } else {
          const trackId = known.personId || `known-${known.label}`;
          m.liveFaces.push({ trackId, personId: known.personId, label: known.label, embedding, box: { ...box }, lastSeen: now, isKnown: true, savedAt: now });
          usedTrackIds.add(trackId);
        }
        return;
      }
      const recent = findBestLiveTrack(box, embedding, usedTrackIds);
      if (recent && recent.score >= 0.78) {
        const track = m.liveFaces.find((face) => face.trackId === recent.trackId);
        if (track) {
          track.lastSeen = now;
          track.embedding = blendEmbedding(track.embedding, embedding);
          track.box = { ...box };
          usedTrackIds.add(track.trackId);
          box.label = track.label;
          box.trackId = track.trackId;
          box.isKnown = Boolean(track.isKnown);
          box.state = track.isKnown ? "known" : "tracking";
          box.confidenceLabel = recent.score ? `${Math.round(recent.score * 100)}%` : "";
          requestServerIdentity(track, crop, box.confidence);
          return;
        }
      }
      const label = makeVisitorCode(visitorSerial, index);
      const trackId = `track-${Date.now()}-${index}-${Math.random().toString(16).slice(2, 6)}`;
      const newTrack = { trackId, label, embedding, box: { ...box }, lastSeen: now, isKnown: false, savedAt: 0 };
      m.liveFaces.push(newTrack);
      usedTrackIds.add(trackId);
      requestServerIdentity(newTrack, crop, box.confidence);
      box.label = label;
      box.trackId = trackId;
      box.isKnown = false;
      box.state = "new";
      box.confidenceLabel = "new";
    });
  }

  function stabilizeFaceBoxes(context, boxes = []) {
    const now = Date.now();
    if (boxes.length) {
      resolveLiveFaceLabels(context, boxes);
      m.lastTrackedBoxes = boxes.map((box) => {
        const previous = m.lastTrackedBoxes.find((item) => item.trackId && item.trackId === box.trackId);
        if (!previous) return { ...box, lastSeen: now };
        return {
          ...box,
          x: (previous.x * 0.45) + (box.x * 0.55),
          y: (previous.y * 0.45) + (box.y * 0.55),
          width: (previous.width * 0.35) + (box.width * 0.65),
          height: (previous.height * 0.35) + (box.height * 0.65),
          lastSeen: now
        };
      });
      return boxes;
    }
    m.lastTrackedBoxes = m.lastTrackedBoxes.filter((box) => now - Number(box.lastSeen || 0) < 4200);
    return m.lastTrackedBoxes.map((box) => ({
      ...box,
      confidence: Math.max(40, Number(box.confidence || 0) - 10),
      opacity: Math.max(0.35, 1 - ((now - Number(box.lastSeen || 0)) / 4200)),
      isKnown: box.isKnown,
      state: box.state || (box.isKnown ? "known" : "tracking"),
      confidenceLabel: box.confidenceLabel || "",
      label: box.label || "Tracking"
    }));
  }

  function padFaceBox(box, frameWidth, frameHeight) {
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

  function cropFace(context, box) {
    const padded = padFaceBox(box, context.canvas.width, context.canvas.height);
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 160;
    const cropContext = canvas.getContext("2d", { willReadFrequently: true });
    cropContext.drawImage(context.canvas, padded.x, padded.y, padded.width, padded.height, 0, 0, canvas.width, canvas.height);
    return { canvas, context: cropContext, width: canvas.width, height: canvas.height };
  }

  function computeImageEmbedding(context, width, height) {
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

  function estimateSharpness(context, width, height) {
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

  function buildFacePayload(context, box, index = 0) {
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

  function findTrack(trackId) {
    return m.liveFaces.find((face) => face.trackId === trackId);
  }

  function isTrackRecentlyCaptured(trackId) {
    const track = findTrack(trackId);
    return Boolean(track?.savedAt && Date.now() - track.savedAt < 30 * 60 * 1000);
  }

  function markTracksCaptured(trackIds = []) {
    const now = Date.now();
    const ids = new Set(trackIds.filter(Boolean));
    m.liveFaces.forEach((face) => {
      if (ids.has(face.trackId)) face.savedAt = now;
    });
  }

  function filterNewFaceCandidates(candidates) {
    const knownEmbeddings = m.faces
      .map((face) => Array.isArray(face.embedding) ? face.embedding : [])
      .filter((embedding) => embedding.length);
    const accepted = [];
    return candidates.filter((candidate) => {
      if (candidate.trackId && isTrackRecentlyCaptured(candidate.trackId)) return false;
      const bestStored = Math.max(0, ...knownEmbeddings.map((embedding) => cosineSimilarity(candidate.embedding, embedding)));
      if (bestStored >= 0.94) return false;
      const bestCurrentFrame = Math.max(0, ...accepted.map((embedding) => cosineSimilarity(candidate.embedding, embedding)));
      if (bestCurrentFrame >= 0.985) return false;
      accepted.push(candidate.embedding);
      return true;
    });
  }

  function summarizeSkippedFaces(skippedFaces = []) {
    if (!Array.isArray(skippedFaces) || !skippedFaces.length) return "";
    const first = skippedFaces[0] || {};
    const reason = [first.reason, first.detail].filter(Boolean).join(": ");
    return reason ? `First skipped reason: ${reason}.` : "";
  }

  function startFaceTracking() {
    if (m.trackingFrame) cancelAnimationFrame(m.trackingFrame);
    m.faceOverlayEnabled = true;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const tick = () => {
      if (video.srcObject && video.videoWidth && video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        // Detection was stopped - keep mirroring the live feed onto the canvas
        // (so the picture doesn't freeze) but skip detection/box drawing so no
        // stale or new boxes appear on top of it.
        if (!m.faceOverlayEnabled) {
          m.trackingFrame = requestAnimationFrame(tick);
          return;
        }
        const boxes = stabilizeFaceBoxes(context, []);
        drawFaceBoxes(context, boxes);
        if (boxes.length) {
          setStatusText(`Tracking ${boxes.length} face(s). Detector: ${m.faceDetectorMode}.`);
        }
        const now = Date.now();
        const wideFrame = canvas.width >= 960 || canvas.height >= 960;
        const detectionThrottleMs = wideFrame ? 1600 : 280;
        if (!m.trackingBusy && now - m.lastDetectionAt > detectionThrottleMs) {
          m.trackingBusy = true;
          m.lastDetectionAt = now;
          detectFaceBoxesWide(video, canvas.width, canvas.height)
            .then((detectedBoxes) => {
              const stableBoxes = stabilizeFaceBoxes(context, detectedBoxes);
              // Always report, even at 0 faces - otherwise there's no way to tell
              // whether the detector is running (and finding nothing) or silently
              // never firing at all.
              setStatusText(stableBoxes.length
                ? `Tracking ${stableBoxes.length} face(s). Detector: ${m.faceDetectorMode}. Frame ${canvas.width}x${canvas.height}.`
                : `No face found in ${canvas.width}x${canvas.height} frame. Detector: ${m.faceDetectorMode}.`);
            })
            .catch((error) => setStatusText(`Detection error: ${error.message}`))
            .finally(() => { m.trackingBusy = false; });
        }
      }
      m.trackingFrame = requestAnimationFrame(tick);
    };
    m.trackingFrame = requestAnimationFrame(tick);
  }

  async function startLocalCamera() {
    const selected = selectedCaptureCamera();
    if (selected && !isBrowserLocalCamera(selected)) {
      setStatusText(`${selected.name} is an RTSP/HTTP camera. Use Detect faces or Start AI auto capture; VisionGuard will capture snapshots through server-side FFmpeg.`);
      toast("Selected camera uses RTSP snapshot capture.");
      return false;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast("This browser does not support camera capture.");
      return false;
    }
    if (m.localStream) {
      m.localStream.getTracks().forEach((track) => track.stop());
    }
    try {
      m.localStream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
    } catch (error) {
      const message = error?.name === "NotFoundError"
        ? "No laptop webcam was found on this browser/device. Select an RTSP camera and use AI auto capture, or connect a webcam."
        : `Could not start laptop camera: ${error.message || error.name || "permission/device error"}`;
      setStatusText(message);
      toast(message);
      return false;
    }
    videoRef.current.srcObject = m.localStream;
    await waitForVideoReady(videoRef.current);
    startFaceTracking();
    setStatusText("Camera started. Tracking face boxes from the camera feed.");
    toast("Laptop camera started.");
    return true;
  }

  async function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not load camera snapshot."));
      image.src = url;
    });
  }

  async function captureFacesToDb(options = {}) {
    const selected = options.camera || selectedCaptureCamera();
    if (selected && isRemoteFrameCamera(selected) && !isBrowserLocalCamera(selected)) {
      return captureFacesFromRemoteCamera(selected, options);
    }
    if (!videoRef.current.srcObject) {
      const started = await startLocalCamera();
      if (!started) return { detected: 0, saved: 0, skipped: 0 };
    }
    const video = videoRef.current;
    await waitForVideoReady(video);
    const canvas = canvasRef.current;
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(video, 0, 0, width, height);
    const detectedBoxes = await detectFaceBoxesWide(video, width, height);
    const boxes = stabilizeFaceBoxes(context, detectedBoxes);
    drawFaceBoxes(context, boxes);
    if (!boxes.length) {
      setStatusText(`No face detected. Nothing saved. Detector: ${m.faceDetectorMode}.`);
      if (!options.silent) toast("No face detected.");
      return { detected: 0, saved: 0, skipped: 0 };
    }
    const candidates = boxes.map((box, index) => buildFacePayload(context, box, index));
    const facesToSave = options.skipClientDuplicateFilter ? candidates : filterNewFaceCandidates(candidates);
    if (!facesToSave.length) {
      const tracked = candidates.filter((candidate) => candidate.trackId && isTrackRecentlyCaptured(candidate.trackId)).length;
      setStatusText(`Detected ${boxes.length} face(s), but ${tracked || "all"} matched existing tracked/known faces. New person not saved.`);
      if (!options.silent) toast("Known/recent face skipped.");
      return { detected: boxes.length, saved: 0, skipped: candidates.length };
    }
    const imageData = canvas.toDataURL("image/jpeg", 0.86);
    const result = await api("/api/captures", {
      method: "POST",
      body: JSON.stringify({ cameraId: selected?.id || "", source: "local-camera", imageData, width, height, faces: facesToSave })
    });
    markTracksCaptured(facesToSave.map((face) => face.trackId));
    const skipped = (candidates.length - facesToSave.length) + Number(result.skippedFaces?.length || 0);
    const reason = summarizeSkippedFaces(result.skippedFaces);
    setStatusText(`Detected ${boxes.length}. Saved ${result.faces.length} new face(s). Skipped ${skipped}.${reason ? ` ${reason}` : ""}`);
    if (!options.silent) toast(result.faces.length ? `Saved ${result.faces.length} new face(s) to PostgreSQL.` : (reason || "Face already tracked. No duplicate image saved."));
    await processPendingFaces();
    await reload();
    return { detected: boxes.length, saved: result.faces.length, skipped };
  }

  async function captureFacesFromRemoteCamera(camera, options = {}) {
    if (!camera?.id) throw new Error("Select a camera first.");
    const image = await loadImage(`/api/cameras/${encodeURIComponent(camera.id)}/frame?t=${Date.now()}`);
    const canvas = canvasRef.current;
    const width = image.naturalWidth || image.width || 1280;
    const height = image.naturalHeight || image.height || 720;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0, width, height);
    const detectedBoxes = await detectFaceBoxesWide(canvas, width, height);
    const boxes = stabilizeFaceBoxes(context, detectedBoxes);
    drawFaceBoxes(context, boxes);
    if (!boxes.length) {
      setStatusText(`No face detected from ${camera.name}. Detector: ${m.faceDetectorMode}.`);
      if (!options.silent) toast("No face detected.");
      return { detected: 0, saved: 0, skipped: 0 };
    }
    const candidates = boxes.map((box, index) => buildFacePayload(context, box, index));
    const facesToSave = options.skipClientDuplicateFilter ? candidates : filterNewFaceCandidates(candidates);
    if (!facesToSave.length) {
      const tracked = candidates.filter((candidate) => candidate.trackId && isTrackRecentlyCaptured(candidate.trackId)).length;
      setStatusText(`Detected ${boxes.length} face(s) from ${camera.name}, but ${tracked || "all"} matched existing tracked/known faces.`);
      if (!options.silent) toast("Known/recent face skipped.");
      return { detected: boxes.length, saved: 0, skipped: candidates.length };
    }
    const imageData = canvas.toDataURL("image/jpeg", 0.86);
    const result = await api("/api/captures", {
      method: "POST",
      body: JSON.stringify({ cameraId: camera.id, source: "rtsp-frame", imageData, width, height, faces: facesToSave })
    });
    markTracksCaptured(facesToSave.map((face) => face.trackId));
    const skipped = (candidates.length - facesToSave.length) + Number(result.skippedFaces?.length || 0);
    const reason = summarizeSkippedFaces(result.skippedFaces);
    setStatusText(`RTSP ${camera.name}: detected ${boxes.length}. Saved ${result.faces.length} new face(s). Skipped ${skipped}.${reason ? ` ${reason}` : ""}`);
    if (!options.silent) toast(result.faces.length ? `Saved ${result.faces.length} RTSP face(s).` : (reason || "Face already tracked. No duplicate image saved."));
    await processPendingFaces();
    await reload();
    return { detected: boxes.length, saved: result.faces.length, skipped };
  }

  function updateCaptureSessionStatus(camera, latest = "") {
    const stats = m.captureSessionStats;
    const last = latest ? ` Last: ${latest}` : "";
    const target = m.autoCaptureMode === "all"
      ? `${m.activeCaptureCameraIds.length} camera(s)`
      : (camera?.name || "selected camera");
    setStatusText(`Detection running for ${target} | attempts ${stats.attempts} | saved ${stats.saved} | skipped ${stats.skipped}.${last}`);
  }

  function saveCaptureSession(mode, cameraIds = []) {
    try {
      localStorage.setItem(CAPTURE_RESUME_KEY, JSON.stringify({ active: true, mode, cameraIds, updatedAt: new Date().toISOString() }));
    } catch { /* storage disabled */ }
  }

  function clearCaptureSession() {
    try { localStorage.removeItem(CAPTURE_RESUME_KEY); } catch { /* ignore */ }
  }

  function startCameraRotation(getCandidateIds, intervalMs = 6000) {
    stopCameraRotation();
    const rotate = () => {
      // Re-derive candidates fresh every tick (rather than a fixed list captured
      // at start time) so a camera that becomes playable mid-rotation (gateway
      // sync finishes, a new camera is added) gets picked up without needing to
      // restart rotation.
      const playableIds = getCandidateIds().filter((cameraId) => {
        const camera = m.cameras.find((item) => item.id === cameraId);
        return camera?.playable && camera?.webrtcUrl;
      });
      if (!playableIds.length) return;
      m.rotationIndex = (m.rotationIndex + 1) % playableIds.length;
      setSelectedCameraIdState(playableIds[m.rotationIndex]);
    };
    m.rotationIndex = -1;
    rotate();
    m.rotationTimer = setInterval(rotate, intervalMs);
  }

  function stopCameraRotation() {
    if (m.rotationTimer) clearInterval(m.rotationTimer);
    m.rotationTimer = null;
    m.rotationIndex = -1;
  }

  function stopAutoCapture(message = "AI auto capture stopped.") {
    if (m.autoCaptureTimer) clearInterval(m.autoCaptureTimer);
    stopCameraRotation();
    clearCaptureSession();
    m.autoCaptureTimer = null;
    m.autoCaptureBusy = false;
    m.autoCaptureMode = "selected";
    m.activeCaptureCameraId = "";
    m.activeCaptureCameraIds = [];
    // Stop drawing the tracking overlay too - the tick loop keeps running
    // independently (to keep mirroring the live feed) but skips detection/boxes
    // while this is false. Clearing lastTrackedBoxes drops any still-fading boxes
    // immediately instead of waiting out their decay window.
    m.faceOverlayEnabled = false;
    m.lastTrackedBoxes = [];
    setCaptureMode("idle");
    setStatusText(message);
  }

  async function toggleAutoCapture() {
    if (m.autoCaptureTimer) {
      stopAutoCapture("Detection stopped.");
      return;
    }
    const selected = selectedCaptureCamera();
    if (!selected) {
      setStatusText("Add or select a camera first.");
      return;
    }
    if (isBrowserLocalCamera(selected) && !videoRef.current.srcObject) {
      const started = await startLocalCamera();
      if (!started) return;
    }
    m.faceOverlayEnabled = true;
    m.autoCaptureMode = "selected";
    m.activeCaptureCameraId = selected.id;
    m.activeCaptureCameraIds = [selected.id];
    saveCaptureSession("selected", m.activeCaptureCameraIds);
    m.captureSessionStats = { attempts: 0, saved: 0, skipped: 0 };
    setCaptureMode("selected");
    updateCaptureSessionStatus(selected, "starting");
    const runCaptureTick = async () => {
      if (m.autoCaptureBusy) return;
      m.autoCaptureBusy = true;
      try {
        const camera = m.cameras.find((item) => item.id === m.activeCaptureCameraId) || selected;
        const result = await captureFacesToDb({ camera, skipClientDuplicateFilter: true, silent: true });
        m.captureSessionStats.attempts += 1;
        m.captureSessionStats.saved += Number(result?.saved || 0);
        m.captureSessionStats.skipped += Number(result?.skipped || 0);
        updateCaptureSessionStatus(camera, result?.detected ? `${result.detected} face(s) detected` : "no face");
      } catch (error) {
        setStatusText(error.message);
      } finally {
        m.autoCaptureBusy = false;
      }
    };
    await runCaptureTick();
    const interval = Math.max(2500, Number(selected.detectionIntervalMs || 4500));
    m.autoCaptureTimer = setInterval(runCaptureTick, interval);
  }

  async function startSelectedCamera() {
    const selected = selectedCaptureCamera();
    if (!selected) {
      setStatusText("Add or select a camera first.");
      return;
    }
    if (m.autoCaptureTimer) {
      setStatusText("Detection is already running. Use Stop detection before starting another mode.");
      return;
    }
    await toggleAutoCapture();
  }

  function getActiveRemoteCameraIds() {
    return m.cameras
      .filter((camera) => String(camera.status || "").toLowerCase() !== "disabled" && isRemoteFrameCamera(camera) && !isBrowserLocalCamera(camera))
      .map((camera) => camera.id);
  }

  async function startAllCameras() {
    if (m.autoCaptureTimer) {
      setStatusText("Detection is already running. Use Stop detection before starting all cameras.");
      return;
    }
    const activeCameras = m.cameras.filter((camera) => {
      const status = String(camera.status || "").toLowerCase();
      return status !== "disabled" && isRemoteFrameCamera(camera) && !isBrowserLocalCamera(camera);
    });
    if (!activeCameras.length) {
      setStatusText("No active RTSP/HTTP cameras found. Add camera stream URLs first.");
      toast("No active RTSP/HTTP cameras to start.");
      return;
    }
    m.faceOverlayEnabled = true;
    m.autoCaptureMode = "all";
    m.activeCaptureCameraIds = activeCameras.map((camera) => camera.id);
    m.activeCaptureCameraId = "";
    saveCaptureSession("all", m.activeCaptureCameraIds);
    m.captureSessionStats = { attempts: 0, saved: 0, skipped: 0 };
    setCaptureMode("all");
    updateCaptureSessionStatus(null, `starting ${activeCameras.length} camera(s)`);
    const runAllCaptureRound = async () => {
      if (m.autoCaptureBusy) return;
      m.autoCaptureBusy = true;
      try {
        const cams = m.activeCaptureCameraIds.map((cameraId) => m.cameras.find((camera) => camera.id === cameraId)).filter(Boolean);
        let roundDetected = 0;
        for (const camera of cams) {
          const result = await captureFacesToDb({ camera, skipClientDuplicateFilter: true, silent: true });
          m.captureSessionStats.attempts += 1;
          m.captureSessionStats.saved += Number(result?.saved || 0);
          m.captureSessionStats.skipped += Number(result?.skipped || 0);
          roundDetected += Number(result?.detected || 0);
        }
        updateCaptureSessionStatus(null, `${cams.length} camera(s), ${roundDetected} face(s) this round`);
      } catch (error) {
        setStatusText(error.message);
      } finally {
        m.autoCaptureBusy = false;
      }
    };
    await runAllCaptureRound();
    const interval = Math.max(5000, Math.min(15000, Number(activeCameras[0]?.detectionIntervalMs || 650) * activeCameras.length));
    m.autoCaptureTimer = setInterval(runAllCaptureRound, interval);
    // Detection above runs against all active cameras in the background via
    // periodic snapshots - it never touched the visible video box. Rotate the
    // single preview through each WebRTC-playable camera so "all cameras" mode
    // actually shows more than just whatever was selected beforehand.
    startCameraRotation(() => m.activeCaptureCameraIds);
  }

  async function resumeCaptureSession() {
    if (m.autoCaptureTimer) return;
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(CAPTURE_RESUME_KEY) || "null");
    } catch {
      saved = null;
    }
    if (!saved?.active) return;
    const cameraIds = Array.isArray(saved.cameraIds) ? saved.cameraIds : [];
    if (saved.mode === "all") {
      const available = m.cameras.filter((camera) => cameraIds.includes(camera.id) && isRemoteFrameCamera(camera) && !isBrowserLocalCamera(camera));
      if (!available.length) {
        clearCaptureSession();
        setStatusText("Saved AI capture session could not resume because no matching RTSP/HTTP camera is available.");
        return;
      }
      setStatusText("Resuming all-camera AI capture after refresh...");
      await startAllCameras();
      return;
    }
    const cameraId = cameraIds[0];
    if (cameraId) setSelectedCameraIdState(cameraId);
    m.selectedCameraId = cameraId || m.selectedCameraId;
    const camera = selectedCaptureCamera();
    if (!camera) {
      clearCaptureSession();
      return;
    }
    setStatusText("Resuming selected-camera AI capture after refresh...");
    await toggleAutoCapture();
  }

  useEffect(() => () => {
    if (m.autoCaptureTimer) clearInterval(m.autoCaptureTimer);
    if (m.rotationTimer) clearInterval(m.rotationTimer);
    if (m.trackingFrame) cancelAnimationFrame(m.trackingFrame);
    if (m.localStream) m.localStream.getTracks().forEach((track) => track.stop());
    if (m.remoteConnection) { try { m.remoteConnection.destroy(); } catch { /* ignore */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    videoRef,
    canvasRef,
    selectedCameraId,
    selectCamera,
    statusText,
    captureMode,
    startSelectedCamera,
    startAllCameras,
    toggleAutoCapture,
    captureFacesToDb,
    resumeCaptureSession
  };
}
