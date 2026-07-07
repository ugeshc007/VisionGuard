import { useAppData } from "../context/AppDataContext.jsx";
import { useUi } from "../context/UiContext.jsx";
import EventCard from "../components/EventCard.jsx";
import { api } from "../lib/api.js";

export default function EventsView() {
  const { data, reload, cameraName } = useAppData();
  const { toast } = useUi();

  async function simulateEvent() {
    const result = await api("/api/simulate-event", { method: "POST", body: "{}" });
    toast(`AI event generated: ${result.event.title}`);
    await reload();
  }

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
    <section id="events" className="view active">
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Alert center</span>
            <h2>Security event queue</h2>
          </div>
          <button onClick={simulateEvent}>Generate event</button>
        </div>
        <div className="event-list tall">
          {data.events.length ? data.events.map((event) => (
            <EventCard key={event.id} event={event} cameraName={cameraName} onAck={ackEvent} onReport={reportEvent} />
          )) : <div className="empty-state">No alerts yet. Capture from the laptop camera or generate an AI event after adding a camera.</div>}
        </div>
      </section>
    </section>
  );
}
