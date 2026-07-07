import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAppData } from "../context/AppDataContext.jsx";
import { useUi } from "../context/UiContext.jsx";
import { api } from "../lib/api.js";
import Toast from "../components/Toast.jsx";
import CameraViewerModal from "../components/modals/CameraViewerModal.jsx";
import FaceImageViewerModal from "../components/modals/FaceImageViewerModal.jsx";

const NAV_ITEMS = [
  { view: "dashboard", label: "Command Center", path: "/dashboard" },
  { view: "cameras", label: "Cameras", path: "/cameras" },
  { view: "people", label: "Face Enrollment", path: "/people" },
  { view: "rules", label: "Rules", path: "/rules" },
  { view: "events", label: "Alerts", path: "/events" },
  { view: "forensics", label: "Forensics", path: "/forensics" },
  { view: "reports", label: "Reports", path: "/reports" }
];

export default function AppLayout() {
  const { reload } = useAppData();
  const { toast } = useUi();
  const location = useLocation();
  const navigate = useNavigate();

  async function simulateEvent() {
    const data = await api("/api/simulate-event", { method: "POST", body: "{}" });
    toast(`AI event generated: ${data.event.title}`);
    await reload();
  }

  async function refresh() {
    await reload();
    toast("Dashboard refreshed.");
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">VG</div>
          <div>
            <strong>VisionGuard AI</strong>
            <small>Smart Surveillance</small>
          </div>
        </div>
        <nav>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.view}
              className={location.pathname.startsWith(item.path) ? "active" : ""}
              onClick={() => navigate(item.path)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="side-card">
          <span>System mode</span>
          <strong>AI monitoring active</strong>
          <small>Local demo engine with live persistence</small>
        </div>
      </aside>

      <main>
        <section className="hero">
          <div>
            <span className="eyebrow">AI command center</span>
            <h1>Turn existing CCTV into real-time intelligence.</h1>
            <p>Monitor cameras, detect risks, enroll faces, track attendance, inspect vehicles, and generate incident reports from one operational console.</p>
          </div>
          <div className="hero-actions">
            <button onClick={simulateEvent}>Generate AI event</button>
            <button className="ghost" onClick={refresh}>Refresh</button>
          </div>
        </section>

        <Outlet />
      </main>

      <Toast />
      <CameraViewerModal />
      <FaceImageViewerModal />
    </div>
  );
}
