import { isBrowserLocalCamera, isRemoteFrameCamera } from "../../lib/format.js";
import { saveCaptureSession, clearCaptureSession, loadCaptureSession, formatCaptureSessionStatus } from "./captureSession.js";

export function useAutoCaptureSession({
  m,
  faceTracker,
  videoRef,
  toast,
  setStatusText,
  setCaptureMode,
  setSelectedCameraId,
  selectedCaptureCamera,
  startLocalCamera,
  captureFacesToDb,
  startRotation,
  stopRotation
}) {
  function updateCaptureSessionStatus(camera, latest = "") {
    setStatusText(formatCaptureSessionStatus(m.captureSessionStats, m.autoCaptureMode, m.activeCaptureCameraIds, camera, latest));
  }

  function stopAutoCapture(message = "AI auto capture stopped.") {
    if (m.autoCaptureTimer) clearInterval(m.autoCaptureTimer);
    stopRotation();
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
    faceTracker.clearTrackedBoxes();
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
    startRotation(() => m.activeCaptureCameraIds);
  }

  async function resumeCaptureSession() {
    if (m.autoCaptureTimer) return;
    const saved = loadCaptureSession();
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
    if (cameraId) setSelectedCameraId(cameraId);
    m.selectedCameraId = cameraId || m.selectedCameraId;
    const camera = selectedCaptureCamera();
    if (!camera) {
      clearCaptureSession();
      return;
    }
    setStatusText("Resuming selected-camera AI capture after refresh...");
    await toggleAutoCapture();
  }

  return {
    toggleAutoCapture,
    startSelectedCamera,
    startAllCameras,
    stopAutoCapture,
    resumeCaptureSession,
    getActiveRemoteCameraIds
  };
}
