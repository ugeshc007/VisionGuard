import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.js";
import { isBrowserLocalCamera, isRemoteFrameCamera, localizeGatewayUrl } from "../../lib/format.js";
import { attachWebRTC } from "../../lib/webrtc.js";
import { createFaceDetector } from "./faceDetector.js";
import { buildFacePayload } from "./faceEmbedding.js";
import { createFaceTracker } from "./faceTracking.js";
import { drawFaceBoxes } from "./faceOverlay.js";
import { useCameraRotation } from "./useCameraRotation.js";
import { useAutoCaptureSession } from "./useAutoCaptureSession.js";

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
    captureSessionStats: { attempts: 0, saved: 0, skipped: 0 },
    trackingFrame: null,
    faceOverlayEnabled: true,
    trackingBusy: false,
    lastDetectionAt: 0,
    cameras: [],
    faces: [],
    selectedCameraId: ""
  }).current;

  // Each factory owns its internal state and exposes one bound API object,
  // so callers never see (or need to pass around) the raw detector/tracking state.
  const faceDetector = useRef(createFaceDetector()).current;
  const faceTracker = useRef(createFaceTracker()).current;
  const visitorSerial = useRef(0);

  useEffect(() => { m.cameras = cameras; }, [cameras]);
  useEffect(() => { m.faces = faces; }, [faces]);
  useEffect(() => { m.selectedCameraId = selectedCameraId; }, [selectedCameraId]);

  const selectedCamera = cameras.find((camera) => camera.id === selectedCameraId) || cameras[0] || null;

  const { startRotation, stopRotation } = useCameraRotation({
    getCameras: () => m.cameras,
    onSelect: setSelectedCameraIdState
  });

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
    stopRotation();
    setSelectedCameraIdState(cameraId);
  }

  function waitForVideoReady(video) {
    if (video.readyState >= 2 && video.videoWidth) return Promise.resolve();
    return new Promise((resolve) => {
      video.onloadedmetadata = () => resolve();
      setTimeout(resolve, 1200);
    });
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
        const boxes = faceTracker.stabilize(m.faces, visitorSerial, context, []);
        drawFaceBoxes(context, boxes);
        if (boxes.length) {
          setStatusText(`Tracking ${boxes.length} face(s). Detector: ${faceDetector.mode}.`);
        }
        const now = Date.now();
        const wideFrame = canvas.width >= 960 || canvas.height >= 960;
        const detectionThrottleMs = wideFrame ? 1600 : 280;
        if (!m.trackingBusy && now - m.lastDetectionAt > detectionThrottleMs) {
          m.trackingBusy = true;
          m.lastDetectionAt = now;
          faceDetector.detect(video, canvas.width, canvas.height)
            .then((detectedBoxes) => {
              const stableBoxes = faceTracker.stabilize(m.faces, visitorSerial, context, detectedBoxes);
              // Always report, even at 0 faces - otherwise there's no way to tell
              // whether the detector is running (and finding nothing) or silently
              // never firing at all.
              setStatusText(stableBoxes.length
                ? `Tracking ${stableBoxes.length} face(s). Detector: ${faceDetector.mode}. Frame ${canvas.width}x${canvas.height}.`
                : `No face found in ${canvas.width}x${canvas.height} frame. Detector: ${faceDetector.mode}.`);
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
    const detectedBoxes = await faceDetector.detect(video, width, height);
    const boxes = faceTracker.stabilize(m.faces, visitorSerial, context, detectedBoxes);
    if (!boxes.length) {
      drawFaceBoxes(context, boxes);
      setStatusText(`No face detected. Nothing saved. Detector: ${faceDetector.mode}.`);
      if (!options.silent) toast("No face detected.");
      return { detected: 0, saved: 0, skipped: 0 };
    }
    // Crop face payloads from the clean frame before drawFaceBoxes overlays boxes/labels onto
    // it - cropping after would bake that overlay into the exact pixels sent for embedding,
    // confusing the server-side face detector on crops tight enough for the overlay to cover
    // real facial landmarks.
    const candidates = boxes.map((box, index) => buildFacePayload(context, box, visitorSerial, index));
    drawFaceBoxes(context, boxes);
    const facesToSave = options.skipClientDuplicateFilter ? candidates : faceTracker.filterNewCandidates(m.faces, candidates);
    if (!facesToSave.length) {
      const tracked = candidates.filter((candidate) => candidate.trackId && faceTracker.isRecentlyCaptured(candidate.trackId)).length;
      setStatusText(`Detected ${boxes.length} face(s), but ${tracked || "all"} matched existing tracked/known faces. New person not saved.`);
      if (!options.silent) toast("Known/recent face skipped.");
      return { detected: boxes.length, saved: 0, skipped: candidates.length };
    }
    const imageData = canvas.toDataURL("image/jpeg", 0.86);
    const result = await api("/api/captures", {
      method: "POST",
      body: JSON.stringify({ cameraId: selected?.id || "", source: "local-camera", imageData, width, height, faces: facesToSave })
    });
    faceTracker.markCaptured(facesToSave.map((face) => face.trackId));
    const skipped = (candidates.length - facesToSave.length) + Number(result.skippedFaces?.length || 0);
    const reason = faceTracker.summarizeSkipped(result.skippedFaces);
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
    const detectedBoxes = await faceDetector.detect(canvas, width, height);
    const boxes = faceTracker.stabilize(m.faces, visitorSerial, context, detectedBoxes);
    if (!boxes.length) {
      drawFaceBoxes(context, boxes);
      setStatusText(`No face detected from ${camera.name}. Detector: ${faceDetector.mode}.`);
      if (!options.silent) toast("No face detected.");
      return { detected: 0, saved: 0, skipped: 0 };
    }
    // Crop face payloads from the clean frame before drawFaceBoxes overlays boxes/labels onto
    // it - see captureFacesToDb for why (server-side re-detection chokes on the overlay).
    const candidates = boxes.map((box, index) => buildFacePayload(context, box, visitorSerial, index));
    drawFaceBoxes(context, boxes);
    const facesToSave = options.skipClientDuplicateFilter ? candidates : faceTracker.filterNewCandidates(m.faces, candidates);
    if (!facesToSave.length) {
      const tracked = candidates.filter((candidate) => candidate.trackId && faceTracker.isRecentlyCaptured(candidate.trackId)).length;
      setStatusText(`Detected ${boxes.length} face(s) from ${camera.name}, but ${tracked || "all"} matched existing tracked/known faces.`);
      if (!options.silent) toast("Known/recent face skipped.");
      return { detected: boxes.length, saved: 0, skipped: candidates.length };
    }
    const imageData = canvas.toDataURL("image/jpeg", 0.86);
    const result = await api("/api/captures", {
      method: "POST",
      body: JSON.stringify({ cameraId: camera.id, source: "rtsp-frame", imageData, width, height, faces: facesToSave })
    });
    faceTracker.markCaptured(facesToSave.map((face) => face.trackId));
    const skipped = (candidates.length - facesToSave.length) + Number(result.skippedFaces?.length || 0);
    const reason = faceTracker.summarizeSkipped(result.skippedFaces);
    setStatusText(`RTSP ${camera.name}: detected ${boxes.length}. Saved ${result.faces.length} new face(s). Skipped ${skipped}.${reason ? ` ${reason}` : ""}`);
    if (!options.silent) toast(result.faces.length ? `Saved ${result.faces.length} RTSP face(s).` : (reason || "Face already tracked. No duplicate image saved."));
    await processPendingFaces();
    await reload();
    return { detected: boxes.length, saved: result.faces.length, skipped };
  }

  const {
    toggleAutoCapture,
    startSelectedCamera,
    startAllCameras,
    stopAutoCapture,
    resumeCaptureSession,
    getActiveRemoteCameraIds
  } = useAutoCaptureSession({
    m,
    faceTracker,
    videoRef,
    toast,
    setStatusText,
    setCaptureMode,
    setSelectedCameraId: setSelectedCameraIdState,
    selectedCaptureCamera,
    startLocalCamera,
    captureFacesToDb,
    startRotation,
    stopRotation
  });

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
  // manual camera pick from the dropdown - see selectCamera above, which pauses
  // this). Detection itself never starts on its own; it's still only ever
  // triggered by the explicit start buttons.
  useEffect(() => {
    if (captureMode !== "idle") return undefined;
    startRotation(getActiveRemoteCameraIds);
    return () => stopRotation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureMode]);

  useEffect(() => () => {
    if (m.autoCaptureTimer) clearInterval(m.autoCaptureTimer);
    stopRotation();
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
