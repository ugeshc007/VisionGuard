import { useEffect, useRef, useState } from "react";
import { useAppData } from "../context/AppDataContext.jsx";
import { useUi } from "../context/UiContext.jsx";
import CameraCard from "../components/CameraCard.jsx";
import { useCameraCapture } from "../hooks/useCameraCapture.js";
import { api } from "../lib/api.js";
import { isRemoteFrameCamera } from "../lib/format.js";

export default function CamerasView() {
  const { data, reload, siteName, processPendingFaces } = useAppData();
  const { toast, openCameraViewer } = useUi();
  const [streamGatewayStatus, setStreamGatewayStatus] = useState("go2rtc converts RTSP/DVR streams into browser-friendly HLS/WebRTC previews.");

  const capture = useCameraCapture({
    cameras: data.cameras,
    faces: data.faces,
    toast,
    reload,
    processPendingFaces
  });

  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current) return;
    if (!data.cameras.length) return;
    resumedRef.current = true;
    capture.resumeCaptureSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.cameras.length]);

  async function handleSiteSubmit(event) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target));
    await api("/api/sites", { method: "POST", body: JSON.stringify(body) });
    event.target.reset();
    toast("Site created.");
    await reload();
  }

  async function handleCameraSubmit(event) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target));
    await api("/api/cameras", { method: "POST", body: JSON.stringify(body) });
    event.target.reset();
    toast("Camera added and AI health monitoring started.");
    await reload();
  }

  async function addLocalCamera() {
    let sites = data.sites;
    if (!sites.length) {
      const site = await api("/api/sites", { method: "POST", body: JSON.stringify({ name: "Development Site", address: "Local laptop", status: "active" }) });
      sites = [site.site, ...sites];
    }
    const existing = data.cameras.find((camera) => camera.streamUrl === "local://laptop-camera");
    if (existing) {
      toast("Local Laptop Camera already exists.");
      return;
    }
    await api("/api/cameras", {
      method: "POST",
      body: JSON.stringify({ name: "Local Laptop Camera", siteId: sites[0]?.id || "", zone: "Development", streamUrl: "local://laptop-camera" })
    });
    toast("Local Laptop Camera added.");
    await reload();
  }

  async function checkStreamGateway() {
    const result = await api("/api/streams/health");
    setStreamGatewayStatus(result.ok
      ? `Gateway online at ${result.gatewayUrl}. Browser playback is ready.`
      : `Gateway offline at ${result.gatewayUrl}: ${result.message || "not responding"}`);
    toast(result.ok ? "Stream gateway online." : "Stream gateway needs attention.");
  }

  async function syncStreamGateway() {
    const result = await api("/api/streams/sync", { method: "POST", body: "{}" });
    setStreamGatewayStatus(`Synced ${result.synced}/${result.total} camera stream(s). Skipped ${result.skipped}. Failed ${result.failed}.`);
    await reload();
    toast(result.ok ? "Camera streams synced." : "Some camera streams need checking.");
  }

  async function saveCameraTuning(cameraId, values) {
    await api(`/api/cameras/${encodeURIComponent(cameraId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...values,
        minFaceSize: Number(values.minFaceSize || 80),
        qualityThreshold: Number(values.qualityThreshold || 62),
        detectionIntervalMs: Number(values.detectionIntervalMs || 650),
        recognitionThreshold: Number(values.recognitionThreshold || 0.82),
        retentionDays: Number(values.retentionDays || 30),
        blurUntrusted: Boolean(values.blurUntrusted)
      })
    });
    toast("Camera tuning saved.");
    await reload();
  }

  async function deleteCamera(cameraId, cameraName) {
    const confirmed = window.confirm(`Delete ${cameraName || "this camera"}? Existing captures and events remain for audit, but the camera will be removed from live monitoring.`);
    if (!confirmed) return;
    await api(`/api/cameras/${encodeURIComponent(cameraId)}`, { method: "DELETE" });
    toast("Camera deleted.");
    await reload();
  }

  return (
    <section id="cameras" className="view active">
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Development camera</span>
            <h2>Local laptop camera capture</h2>
          </div>
          <button type="button" onClick={addLocalCamera}>Add Local Camera</button>
        </div>
        <div className="local-camera-layout">
          <div className="video-box">
            <video ref={capture.videoRef} autoPlay muted playsInline />
            <canvas ref={capture.canvasRef} />
          </div>
          <div className="local-camera-controls">
            <label>Capture camera source
              <select value={capture.selectedCameraId} onChange={(event) => capture.selectCamera(event.target.value)}>
                {data.cameras.length ? data.cameras.map((camera) => (
                  <option key={camera.id} value={camera.id}>
                    {camera.name} - {isRemoteFrameCamera(camera) ? "RTSP/HTTP snapshot" : "Local browser camera"}
                  </option>
                )) : <option value="">Add RTSP or Local Camera first</option>}
              </select>
            </label>
            <button type="button" onClick={capture.startSelectedCamera}>
              {capture.captureMode === "all" ? "Selected disabled" : capture.captureMode === "selected" ? "Detection running" : "Start selected camera"}
            </button>
            <button type="button" onClick={capture.startAllCameras}>
              {capture.captureMode === "all" ? "All cameras running" : "Start all cameras"}
            </button>
            <button type="button" onClick={() => capture.captureFacesToDb()}>Detect faces &amp; save capture</button>
            <button type="button" className="ghost" onClick={capture.toggleAutoCapture}>
              {capture.captureMode === "idle" ? "Start AI auto capture" : "Stop detection"}
            </button>
            <p>{capture.statusText}</p>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Site setup</span>
            <h2>Create first site</h2>
          </div>
        </div>
        <form className="form-grid" onSubmit={handleSiteSubmit}>
          <label>Site name<input name="name" required placeholder="Head Office" /></label>
          <label>Address<input name="address" placeholder="Dubai / Warehouse / Branch" /></label>
          <label>Status<select name="status"><option>active</option><option>inactive</option></select></label>
          <button>Create site</button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Camera onboarding</span>
            <h2>Add camera / RTSP stream</h2>
          </div>
        </div>
        <form className="form-grid" onSubmit={handleCameraSubmit}>
          <label>Camera name<input name="name" required placeholder="Main gate camera" /></label>
          <label>Site
            <select name="siteId">
              {data.sites.length ? data.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>) : <option value="">Create a site first</option>}
            </select>
          </label>
          <label>Zone<input name="zone" required placeholder="Gate / Lobby / PPE Zone" /></label>
          <label>Camera role
            <select name="cameraRole">
              <option value="area">Area monitor</option>
              <option value="entry">Entry camera</option>
              <option value="exit">Exit camera</option>
            </select>
          </label>
          <label>Stream URL<input name="streamUrl" required placeholder="rtsp://user:pass@ip/stream" /></label>
          <button>Add camera</button>
        </form>
      </section>

      <section className="panel compact-panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Stream gateway</span>
            <h2>RTSP/DVR browser playback</h2>
          </div>
          <div className="panel-actions">
            <button type="button" className="ghost" onClick={checkStreamGateway}>Check gateway</button>
            <button type="button" onClick={syncStreamGateway}>Sync streams</button>
          </div>
        </div>
        <p className="muted-copy">{streamGatewayStatus}</p>
      </section>

      <div className="camera-grid">
        {data.cameras.length ? data.cameras.map((camera) => (
          <CameraCard
            key={camera.id}
            camera={camera}
            manager
            siteName={siteName}
            onOpen={() => openCameraViewer(camera.id)}
            onSaveTuning={saveCameraTuning}
            onDelete={deleteCamera}
          />
        )) : <div className="empty-state">No cameras yet. Create a site, then add Local Camera or RTSP camera.</div>}
      </div>
    </section>
  );
}
