import { useAppData } from "../../context/AppDataContext.jsx";
import { useUi } from "../../context/UiContext.jsx";
import { localizeGatewayUrl, cameraRoleLabel } from "../../lib/format.js";

export default function CameraViewerModal() {
  const { data } = useAppData();
  const { cameraViewerCameraId, closeCameraViewer } = useUi();
  const camera = data.cameras.find((item) => item.id === cameraViewerCameraId);
  const open = Boolean(camera);
  const viewerUrl = camera ? localizeGatewayUrl(camera.webrtcPageUrl || camera.hlsUrl) : "";

  return (
    <div
      id="cameraViewer"
      className={`camera-viewer ${open ? "show" : ""}`}
      aria-hidden={!open}
      onClick={(event) => { if (event.target.id === "cameraViewer") closeCameraViewer(); }}
    >
      <div className="camera-viewer-card">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Camera focus</span>
            <h2>{camera?.name || "Camera"}</h2>
          </div>
          <button className="ghost" type="button" onClick={closeCameraViewer}>Close</button>
        </div>
        <div className="viewer-feed">
          {camera ? (
            camera.playable ? (
              <iframe className="viewer-frame" src={viewerUrl} title={`${camera.name} live stream`} />
            ) : (
              <>
                <strong>{camera.name}</strong>
                <small>{camera.streamStatus || "No browser-playable stream configured"}</small>
              </>
            )
          ) : null}
        </div>
        <div className="viewer-meta">
          {camera ? [
            ["Area", camera.zone || "Unassigned"],
            ["Role", cameraRoleLabel(camera.cameraRole)],
            ["Status", camera.status || "unknown"],
            ["Health", `${camera.health || 0}%`],
            ["Stream", camera.streamStatus || "not configured"],
            ["Mode", camera.playable ? "WebRTC / HLS" : "local preview"]
          ].map(([label, value]) => (
            <span key={label}><small>{label}</small><b>{value}</b></span>
          )) : null}
        </div>
      </div>
    </div>
  );
}
