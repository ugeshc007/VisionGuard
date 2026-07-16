import { useEffect, useRef } from "react";
import { useAppData } from "../context/AppDataContext.jsx";
import { useUi } from "../context/UiContext.jsx";
import { useCameraCapture } from "../hooks/useCameraCapture.js";
import { isRemoteFrameCamera } from "../lib/format.js";
import { SiteSetupPanel, CameraOnboardingPanel, StreamGatewayPanel, CameraGridPanel } from "../components/CameraManagementPanels.jsx";

export default function CamerasView() {
  const { data, reload, siteName, processPendingFaces } = useAppData();
  const { toast, openCameraViewer } = useUi();

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

  return (
    <section id="cameras" className="view active">
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Development camera</span>
            <h2>Local laptop camera capture</h2>
          </div>
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
            <button
              type="button"
              className={capture.captureMode === "selected" ? "is-active" : ""}
              disabled={capture.captureMode === "all"}
              onClick={capture.startSelectedCamera}
            >
              {capture.captureMode === "all" ? "Selected disabled" : capture.captureMode === "selected" ? "Detection running" : "Start selected camera"}
            </button>
            <button
              type="button"
              className={capture.captureMode === "all" ? "is-active" : ""}
              disabled={capture.captureMode === "selected"}
              onClick={capture.startAllCameras}
            >
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

      <SiteSetupPanel reload={reload} toast={toast} />
      <CameraOnboardingPanel data={data} reload={reload} toast={toast} />
      <StreamGatewayPanel reload={reload} toast={toast} />
      <CameraGridPanel data={data} siteName={siteName} openCameraViewer={openCameraViewer} reload={reload} toast={toast} />
    </section>
  );
}
