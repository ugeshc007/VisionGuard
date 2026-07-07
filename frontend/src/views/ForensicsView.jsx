import { useState } from "react";
import { useAppData } from "../context/AppDataContext.jsx";
import { useUi } from "../context/UiContext.jsx";
import EventCard from "../components/EventCard.jsx";
import { api } from "../lib/api.js";
import { formatDuration } from "../lib/format.js";

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

export default function ForensicsView() {
  const { data, reload, cameraName } = useAppData();
  const { toast } = useUi();
  const [evidence, setEvidence] = useState(null);
  const [textResults, setTextResults] = useState(null);

  async function searchFaceEvidence(payload) {
    const result = await api("/api/forensics/face-search", { method: "POST", body: JSON.stringify(payload) });
    setEvidence(result);
    return result;
  }

  async function handleUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const imageData = await readFileAsDataUrl(file);
    await searchFaceEvidence({ imageData });
    toast("Uploaded photo searched against face database.");
  }

  async function handleSearchSubmit(event) {
    event.preventDefault();
    const q = new FormData(event.target).get("q") || "";
    const result = await api(`/api/forensics?q=${encodeURIComponent(q)}`);
    setTextResults(result.results);
  }

  async function reportEvent(id) {
    const report = await api("/api/reports/incident", { method: "POST", body: JSON.stringify({ eventId: id }) });
    toast(`Incident report created: ${report.fileName}`);
  }

  async function ackEvent(id) {
    await api(`/api/events/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status: "acknowledged", acknowledgedBy: "Security Admin" }) });
    toast("Alert acknowledged.");
    await reload();
  }

  const galleryFaces = data.faces.slice(0, 24);
  const movement = evidence?.movement || {};
  const primary = evidence?.primary || {};

  return (
    <section id="forensics" className="view active">
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Forensic search</span>
            <h2>Find by face, plate, camera, event, or zone</h2>
          </div>
        </div>
        <div className="forensic-face-box">
          <div>
            <span className="eyebrow">Face gallery search</span>
            <h3>Select detected face or upload photo</h3>
            <p>Search the face database, then review entry camera, exit camera, and area dwell time.</p>
          </div>
          <label className="upload-box">
            Upload face photo
            <input type="file" accept="image/*" onChange={handleUpload} />
          </label>
        </div>
        <div className="face-gallery">
          {galleryFaces.length ? galleryFaces.map((face) => (
            <button type="button" className="gallery-face" key={face.id} onClick={() => searchFaceEvidence({ faceId: face.id })}>
              <img src={face.imageUrl} alt={face.label || "Detected face"} />
              <span>{face.matchedPersonName || face.personName || face.label || "Unknown"}</span>
              <small>{face.identityResult || face.status || "pending"}</small>
            </button>
          )) : <div className="empty-state">No detected faces yet. Capture faces from the camera first, or upload a photo.</div>}
        </div>

        {evidence ? (
          <div id="faceEvidenceResult" className="face-evidence-result">
            <article className="evidence-summary">
              <div>
                <span className="eyebrow">Best match</span>
                <h3>{primary.displayName || evidence.source?.label || "No strong match"}</h3>
                <p>{primary.personCategory || primary.category || "unknown"} | Similarity {Number(primary.similarity || 0)}</p>
              </div>
              <div className="flow-stats">
                <span><b>{movement.firstEntry ? new Date(movement.firstEntry.createdAt).toLocaleString() : "-"}</b><small>First entry</small></span>
                <span><b>{movement.lastExit ? new Date(movement.lastExit.createdAt).toLocaleString() : "-"}</b><small>Last exit</small></span>
                <span><b>{formatDuration(movement.totalSeconds || 0)}</b><small>Total area time</small></span>
                <span><b>{movement.dwell?.length || 0}</b><small>Areas visited</small></span>
              </div>
            </article>
            <div className="two-col compact">
              <section className="mini-panel">
                <strong>Matched images</strong>
                <div className="face-gallery compact-gallery">
                  {(evidence.matches || []).slice(0, 8).map((match) => (
                    <button type="button" className="gallery-face" key={match.id} onClick={() => searchFaceEvidence({ faceId: match.id })}>
                      <img src={match.imageUrl} alt={match.displayName || match.label || "Match"} />
                      <span>{match.displayName || match.label || "Unknown"}</span>
                      <small>{Number(match.similarity || 0)}</small>
                    </button>
                  ))}
                </div>
              </section>
              <section className="mini-panel">
                <strong>Area timeline</strong>
                <div className="table">
                  {(movement.dwell || []).length ? movement.dwell.map((row, index) => (
                    <div className="table-row" key={index}>
                      <strong>{row.areaName || row.cameraName || "Area"}</strong>
                      <span>{formatDuration(row.secondsSpent)}</span>
                      <small>{new Date(row.firstSeen).toLocaleString()} - {new Date(row.lastSeen).toLocaleString()}</small>
                    </div>
                  )) : <div className="empty-state">No area dwell records found for this person yet.</div>}
                </div>
              </section>
            </div>
          </div>
        ) : null}

        <form className="search-row" onSubmit={handleSearchSubmit}>
          <input name="q" placeholder="Example: unknown, helmet, DXB, Lobby, restricted" />
          <button>Search evidence</button>
        </form>
        <div className="event-list tall">
          {textResults ? (
            textResults.length
              ? textResults.map((event) => <EventCard key={event.id} event={event} cameraName={cameraName} onAck={ackEvent} onReport={reportEvent} />)
              : <article className="event-card"><div><h3>No evidence found</h3><p>Try face, camera, event type, plate, or zone keywords.</p></div></article>
          ) : null}
        </div>
      </section>
    </section>
  );
}
