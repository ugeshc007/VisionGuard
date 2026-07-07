import { statusClass } from "../lib/format.js";

export default function EventCard({ event, cameraName, onAck, onReport }) {
  return (
    <article className="event-card">
      <img src={event.snapshot} alt={`AI snapshot for ${event.id}`} />
      <div>
        <span className={`status ${statusClass(event.severity)}`}>{event.severity}</span>
        <h3>{event.title}</h3>
        <p>{cameraName(event.cameraId)} | {event.person?.name || event.vehicle?.plate || "No identity"} | Confidence {event.confidence}%</p>
        <p>{new Date(event.createdAt).toLocaleString()} | Status: {event.status}</p>
      </div>
      <div className="event-actions">
        <button onClick={() => onAck(event.id)}>Acknowledge</button>
        <button className="ghost" onClick={() => onReport(event.id)}>Report</button>
      </div>
    </article>
  );
}
