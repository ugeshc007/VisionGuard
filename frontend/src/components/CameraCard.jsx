import { useEffect, useRef, useState } from "react";
import { isRemoteFrameCamera, localizeGatewayUrl, statusClass, cameraRoleLabel } from "../lib/format.js";
// import { attachWebRTC } from "../lib/webrtc.js";

export default function CameraCard({ camera, manager = false, siteName, onOpen, onSaveTuning, onDelete }) {
  const videoRef = useRef(null);
  const webrtcUrl = localizeGatewayUrl(camera.webrtcUrl);
  const webrtcPageUrl = localizeGatewayUrl(camera.webrtcPageUrl);
  const playable = camera.playable && webrtcUrl;
  // The snapshot endpoint grabs a frame directly via ffmpeg off streamUrl - it
  // doesn't need the camera to be synced to the go2rtc/WebRTC gateway the way
  // the (currently disabled) live preview did, so gate it on the stream URL
  // itself rather than `playable`.
  const hasSnapshot = isRemoteFrameCamera(camera);
  const [snapshotUrl, setSnapshotUrl] = useState("");

  // Live WebRTC preview - swapped for a single static snapshot below (many
  // simultaneous live decodes across the Command Center camera wall was
  // expensive). Re-enable this effect and swap the <img> back to
  // <video ref={videoRef}> below if a live wall view is wanted again.
  // useEffect(() => {
  //   if (!playable || !videoRef.current) return undefined;
  //   const connection = attachWebRTC(videoRef.current, webrtcUrl);
  //   return () => {
  //     try { connection?.destroy(); } catch { /* ignore */ }
  //   };
  // }, [playable, webrtcUrl]);

  useEffect(() => {
    if (!hasSnapshot || !camera.id) {
      setSnapshotUrl("");
      return undefined;
    }
    const refresh = () => setSnapshotUrl(`/api/cameras/${encodeURIComponent(camera.id)}/frame?t=${Date.now()}`);
    refresh();
    // A single one-time snapshot goes stale forever the moment the camera's
    // actual feed changes (edited RTSP URL, moved camera, etc). Refreshing
    // periodically keeps it reasonably current while still being far cheaper
    // than a continuous live decode per card.
    const timer = setInterval(refresh, 20000);
    return () => clearInterval(timer);
  }, [hasSnapshot, camera.id]);

  function handleTuningSubmit(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target));
    onSaveTuning(camera.id, values);
  }

  return (
    <article
      className={`camera-card ${manager ? "manager-card" : ""}`}
      onClick={!manager ? onOpen : undefined}
    >
      <div className={`camera-feed ${hasSnapshot ? "has-stream" : ""}`}>
        <span className="scan-line" />
        {hasSnapshot
          ? (snapshotUrl ? <img src={snapshotUrl} alt={`${camera.name} snapshot`} /> : null)
          : <b>{camera.name}</b>}
        {/* Live WebRTC preview - see the commented-out effect above.
        {playable ? <video ref={videoRef} muted autoPlay playsInline /> : <b>{camera.name}</b>} */}
        <span className="camera-overlay-name">{camera.name}</span>
        <span className={`stream-pill ${statusClass(camera.streamStatus)}`}>{camera.streamStatus || "offline"}</span>
      </div>
      <div className="camera-meta">
        <span className={`status ${statusClass(camera.status)}`}>{camera.status}</span>
        <strong>{camera.zone || camera.name}</strong>
        <small>{siteName(camera.siteId)} | {cameraRoleLabel(camera.cameraRole)} | {camera.fps} FPS | Health {camera.health}%</small>
        <small title={camera.streamUrl || ""}>Link: {camera.streamUrl ? camera.streamUrl : "No stream URL configured"}</small>
        {webrtcPageUrl ? <small><a href={webrtcPageUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>Open low-latency WebRTC preview</a></small> : null}
        <small>AI: min {Number(camera.minFaceSize || 48)}px | quality {Number(camera.qualityThreshold || 45)}% | {Number(camera.detectionIntervalMs || 650)}ms</small>
        <div className="bar"><span style={{ width: `${Math.max(6, Number(camera.health || 0))}%` }} /></div>
      </div>
      {manager ? (
        <form className="camera-tuning" onSubmit={handleTuningSubmit} onClick={(event) => event.stopPropagation()}>
          <label>Camera name<input name="name" defaultValue={camera.name || ""} placeholder="Main gate camera" /></label>
          <label>Role
            <select name="cameraRole" defaultValue={camera.cameraRole || "area"}>
              {["area", "entry", "exit"].map((role) => <option key={role} value={role}>{cameraRoleLabel(role)}</option>)}
            </select>
          </label>
          <label>Area name<input name="zone" defaultValue={camera.zone || ""} placeholder="Lobby / Entrance" /></label>
          <label className="full-row">Camera link / RTSP URL<input name="streamUrl" defaultValue={camera.streamUrl || ""} placeholder="rtsp://user:pass@ip/Streaming/Channels/402" /></label>
          <label>Min face px<input name="minFaceSize" type="number" min="32" max="320" defaultValue={Number(camera.minFaceSize || 48)} /></label>
          <label>Quality %<input name="qualityThreshold" type="number" min="25" max="95" defaultValue={Number(camera.qualityThreshold || 45)} /></label>
          <label>Interval ms<input name="detectionIntervalMs" type="number" min="250" max="5000" defaultValue={Number(camera.detectionIntervalMs || 650)} /></label>
          <label>Match %<input name="recognitionThreshold" type="number" min="0.70" max="0.99" step="0.01" defaultValue={Number(camera.recognitionThreshold || 0.82)} /></label>
          <label>Retention days<input name="retentionDays" type="number" min="1" max="365" defaultValue={Number(camera.retentionDays || 30)} /></label>
          <label className="inline-check"><input name="blurUntrusted" type="checkbox" defaultChecked={Boolean(camera.blurUntrusted)} /> Blur untrusted exports</label>
          <button type="submit">Save camera tuning</button>
          <button type="button" className="danger-button" onClick={() => onDelete(camera.id, camera.name)}>Delete camera</button>
        </form>
      ) : null}
    </article>
  );
}
