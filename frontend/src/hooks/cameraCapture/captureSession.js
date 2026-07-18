export const CAPTURE_RESUME_KEY = "visionguard.captureSession";

export function saveCaptureSession(mode, cameraIds = []) {
  try {
    localStorage.setItem(CAPTURE_RESUME_KEY, JSON.stringify({ active: true, mode, cameraIds, updatedAt: new Date().toISOString() }));
  } catch { /* storage disabled */ }
}

export function clearCaptureSession() {
  try { localStorage.removeItem(CAPTURE_RESUME_KEY); } catch { /* ignore */ }
}

export function loadCaptureSession() {
  try {
    return JSON.parse(localStorage.getItem(CAPTURE_RESUME_KEY) || "null");
  } catch {
    return null;
  }
}

export function formatCaptureSessionStatus(stats, mode, activeCameraIds, camera, latest = "") {
  const last = latest ? ` Last: ${latest}` : "";
  const target = mode === "all"
    ? `${activeCameraIds.length} camera(s)`
    : (camera?.name || "selected camera");
  return `Detection running for ${target} | attempts ${stats.attempts} | saved ${stats.saved} | skipped ${stats.skipped}.${last}`;
}
