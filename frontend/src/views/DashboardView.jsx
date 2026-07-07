import { useState } from "react";
import { useAppData } from "../context/AppDataContext.jsx";
import { useUi } from "../context/UiContext.jsx";
import CameraCard from "../components/CameraCard.jsx";
import EventCard from "../components/EventCard.jsx";
import { api } from "../lib/api.js";

export default function DashboardView() {
  const { data, reload, cameraName, siteName } = useAppData();
  const { toast, openCameraViewer } = useUi();
  const [cameraWallSize, setCameraWallSize] = useState(4);

  const s = data.summary || {};
  const kpis = [
    ["Cameras online", `${s.camerasOnline || 0}/${s.camerasTotal || 0}`],
    ["Open alerts", s.openAlerts || 0],
    ["Critical alerts", s.criticalAlerts || 0],
    ["Enrolled faces", s.enrolledFaces || 0],
    ["Current detections", s.currentDetections || 0],
    ["People today", s.uniqueVisitsToday || 0],
    ["Staff today", s.staffVisitsToday || 0],
    ["Visitors today", s.visitorVisitsToday || 0],
    ["Movement events", s.movementEventsToday || 0],
    ["PPE compliance", `${s.ppeCompliance || 0}%`],
    ["Unknown faces", s.unknownFaces || 0]
  ];

  const trainedFaces = data.faces.filter((face) => face.status === "trained").length;
  const currentFaces = data.faces.filter((face) => face.status !== "trained").length;
  const pendingFaces = data.faces.filter((face) => face.identityResult === "pending" || face.status === "untrained").length;
  const stages = [
    { name: "Cameras online", value: `${s.camerasOnline || 0}/${s.camerasTotal || 0}`, detail: "Live sources" },
    { name: "Current detections", value: currentFaces, detail: "Need review" },
    { name: "Enrolled faces", value: trainedFaces, detail: "Known identities" },
    { name: "Pending training", value: pendingFaces, detail: "Action needed" },
    { name: "Face AI", value: "Ready", detail: "InsightFace active" },
    { name: "Matching", value: "pgvector", detail: "Identity search" },
    { name: "People today", value: s.uniqueVisitsToday || 0, detail: "Unique identities" },
    { name: "Movement events", value: s.movementEventsToday || 0, detail: "Raw camera hits" },
    { name: "Open alerts", value: s.openAlerts || 0, detail: "Needs attention" }
  ];

  const visibleCameras = data.cameras.slice(0, cameraWallSize);

  async function ackEvent(id) {
    await api(`/api/events/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status: "acknowledged", acknowledgedBy: "Security Admin" }) });
    toast("Alert acknowledged.");
    await reload();
  }

  async function reportEvent(id) {
    const report = await api("/api/reports/incident", { method: "POST", body: JSON.stringify({ eventId: id }) });
    toast(`Incident report created: ${report.fileName}`);
  }

  return (
    <section id="dashboard" className="view active">
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Camera AI pipeline</span>
            <h2>Detection and identity logic</h2>
          </div>
        </div>
        <div className="pipeline-grid">
          {stages.map((stage, index) => (
            <article className="pipeline-card" key={stage.name}>
              <span className="status online">{String(index + 1).padStart(2, "0")}</span>
              <strong>{stage.name}</strong>
              <b>{stage.value}</b>
              <small>{stage.detail}</small>
            </article>
          ))}
        </div>
      </section>

      <div className="kpi-grid">
        {kpis.map(([label, value]) => (
          <article className="kpi" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </article>
        ))}
      </div>

      <div className="two-col">
        <section className="panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Live camera grid</span>
              <h2>AI-enabled cameras</h2>
            </div>
            <div className="layout-toggle" aria-label="Camera grid layout">
              {[4, 8, 16].map((size) => (
                <button
                  key={size}
                  type="button"
                  className={cameraWallSize === size ? "active" : ""}
                  onClick={() => setCameraWallSize(size)}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>
          <div className={`camera-wall wall-${cameraWallSize}`}>
            {visibleCameras.length ? (
              visibleCameras.map((camera) => (
                <CameraCard
                  key={camera.id}
                  camera={camera}
                  manager={false}
                  siteName={siteName}
                  onOpen={() => openCameraViewer(camera.id)}
                />
              ))
            ) : (
              <div className="empty-state">No cameras yet. Add Local Camera or RTSP streams to build the DVR wall.</div>
            )}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Priority queue</span>
              <h2>Latest alerts</h2>
            </div>
          </div>
          <div className="event-list">
            {data.events.slice(0, 5).map((event) => (
              <EventCard key={event.id} event={event} cameraName={cameraName} onAck={ackEvent} onReport={reportEvent} />
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}
