import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { clamp, cosineSimilarity, displayFaceName, isBrowserLocalCamera, isRemoteFrameCamera, makeVisitorCode } from "../lib/format.js";

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
    autoCaptureTimer: null,
    autoCaptureBusy: false,
    autoCaptureMode: "selected",
    activeCaptureCameraId: "",
    activeCaptureCameraIds: [],
    captureSessionStats: { attempts: 0, saved: 0, skipped: 0 },
    trackingFrame: null,
    blazeFaceModel: null,
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

  function selectedCaptureCamera() {
    const selectedId = m.selectedCameraId || m.cameras[0]?.id || "";
    return m.cameras.find((camera) => camera.id === selectedId) || m.cameras[0] || null;
  }

  function selectCamera(cameraId) {
    if (m.autoCaptureTimer && m.autoCaptureMode === "selected") {
      stopAutoCapture("Camera selection changed. Detection stopped.");
    }
    setSelectedCameraIdState(cameraId);
  }

  function waitForVideoReady(video) {
    if (video.readyState >= 2 && video.videoWidth) return Promise.resolve();
    return new Promise((resolve) => {
      video.onloadedmetadata = () => resolve();
      setTimeout(resolve, 1200);
    });
  }

  async function loadBlazeFaceModel() {
    if (m.blazeFaceModel) return m.blazeFaceModel;
    if (!window.blazeface) return null;
    try {
      m.blazeFaceModel = await window.blazeface.load();
      return m.blazeFaceModel;
    } catch (error) {
      m.faceDetectorMode = `BlazeFace unavailable: ${error.message}`;
      return null;
    }
  }

  async function detectFaceBoxes(video, width, height) {
    if ("FaceDetector" in window) {
      try {
        const detector = new window.FaceDetector({ fastMode: false, maxDetectedFaces: 12 });
        const detected = await detector.detect(video);
        if (detected.length) {
          m.faceDetectorMode = "native FaceDetector";
          return detected.map((face) => ({
            x: clamp(face.boundingBox.x, 0, width),
            y: clamp(face.boundingBox.y, 0, height),
            width: clamp(face.boundingBox.width, 1, width - face.boundingBox.x),
            height: clamp(face.boundingBox.height, 1, height - face.boundingBox.y),
            confidence: 92
          }));
        }
      } catch (error) {
        m.faceDetectorMode = `native unavailable: ${error.message}`;
      }
    }
    const blazeFace = await loadBlazeFaceModel();
    if (blazeFace) {
      const predictions = await blazeFace.estimateFaces(video, false);
      m.faceDetectorMode = "BlazeFace";
      return predictions.map((prediction) => {
        const [x1, y1] = prediction.topLeft;
        const [x2, y2] = prediction.bottomRight;
        return {
          x: clamp(x1, 0, width),
          y: clamp(y1, 0, height),
          width: clamp(x2 - x1, 1, width - x1),
          height: clamp(y2 - y1, 1, height - y1),
          confidence: Math.round((prediction.probability?.[0] || 0.86) * 100)
        };
      });
    }
    m.faceDetectorMode = "not available";
    return [];
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
          return;
        }
      }
      const label = makeVisitorCode(visitorSerial, index);
      const trackId = `track-${Date.now()}-${index}-${Math.random().toString(16).slice(2, 6)}`;
      m.liveFaces.push({ trackId, label, embedding, box: { ...box }, lastSeen: now, isKnown: false, savedAt: 0 });
      usedTrackIds.add(trackId);
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

  function cropFace(context, box) {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 160;
    const cropContext = canvas.getContext("2d", { willReadFrequently: true });
    cropContext.drawImage(context.canvas, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);
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
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const tick = () => {
      if (!video.srcObject) return;
      if (video.videoWidth && video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const boxes = stabilizeFaceBoxes(context, []);
        drawFaceBoxes(context, boxes);
        if (boxes.length) {
          setStatusText(`Tracking ${boxes.length} face(s). Detector: ${m.faceDetectorMode}.`);
        }
        const now = Date.now();
        if (!m.trackingBusy && now - m.lastDetectionAt > 280) {
          m.trackingBusy = true;
          m.lastDetectionAt = now;
          detectFaceBoxes(video, canvas.width, canvas.height)
            .then((detectedBoxes) => {
              const stableBoxes = stabilizeFaceBoxes(context, detectedBoxes);
              if (stableBoxes.length) {
                setStatusText(`Tracking ${stableBoxes.length} face(s). Detector: ${m.faceDetectorMode}.`);
              }
            })
            .catch((error) => setStatusText(error.message))
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
    const detectedBoxes = await detectFaceBoxes(video, width, height);
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
    const detectedBoxes = await detectFaceBoxes(canvas, width, height);
    const boxes = stabilizeFaceBoxes(context, detectedBoxes);
    drawFaceBoxes(context, boxes);
    if (!boxes.length) {
      setStatusText(`No face detected from ${camera.name}. Detector: ${m.faceDetectorMode}.`);
      if (!options.silent) toast("No face detected.");
      return { detected: 0, saved: 0, skipped: 0 };
    }
    const candidates = boxes.map((box, index) => buildFacePayload(context, box, index));
    const facesToSave = options.skipClientDuplicateFilter === false ? filterNewFaceCandidates(candidates) : candidates;
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

  function stopAutoCapture(message = "AI auto capture stopped.") {
    if (m.autoCaptureTimer) clearInterval(m.autoCaptureTimer);
    clearCaptureSession();
    m.autoCaptureTimer = null;
    m.autoCaptureBusy = false;
    m.autoCaptureMode = "selected";
    m.activeCaptureCameraId = "";
    m.activeCaptureCameraIds = [];
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
    if (m.trackingFrame) cancelAnimationFrame(m.trackingFrame);
    if (m.localStream) m.localStream.getTracks().forEach((track) => track.stop());
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
