import { useRef, useState } from "react";
import { useAppData } from "../context/AppDataContext.jsx";
import { useUi } from "../context/UiContext.jsx";
import FaceThumb from "../components/FaceThumb.jsx";
import { api } from "../lib/api.js";
import { displayFaceName, formatConfidence, formatDisplayDate, formatDuration, initials, statusClass } from "../lib/format.js";

const CATEGORY_OPTIONS = ["visitor", "customer", "staff", "employee", "unknown", "watchlist"];
const STATUS_OPTIONS = ["untrained", "trained", "review", "blocked"];

export default function PeopleView() {
  const { data, reload, reloadFaces, processPendingFaces } = useAppData();
  const { toast } = useUi();
  const [faceTab, setFaceTab] = useState("current");
  const [activeFaceDay, setActiveFaceDay] = useState("");

  const effectiveActiveDay = activeFaceDay || data.faceDays[0]?.date || "";

  async function handlePersonSubmit(event) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target));
    await api("/api/people", { method: "POST", body: JSON.stringify(body) });
    event.target.reset();
    toast("Face profile enrolled.");
    await reload();
  }

  async function handlePrivacySubmit(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target));
    await api("/api/privacy", {
      method: "PUT",
      body: JSON.stringify({
        retentionDays: Number(values.retentionDays || 30),
        deleteUntrainedAfterDays: Number(values.deleteUntrainedAfterDays || 7),
        blurUnknown: Boolean(values.blurUnknown),
        allowExport: Boolean(values.allowExport),
        consentRequired: Boolean(values.consentRequired)
      })
    });
    toast("Privacy policy saved.");
    await reload();
  }

  async function handleProcessPendingFaces() {
    const result = await processPendingFaces();
    toast(`Processed ${result.processedCount} pending face(s).`);
  }

  async function saveFaceLabel(event, faceId) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target));
    await api(`/api/faces/${encodeURIComponent(faceId)}`, { method: "PATCH", body: JSON.stringify(body) });
    toast("Face training label saved.");
    await reloadFaces();
    await reload();
  }

  async function deleteFace(faceId) {
    const confirmed = window.confirm("Delete this detected face image and related face event references?");
    if (!confirmed) return;
    await api(`/api/faces/${encodeURIComponent(faceId)}`, { method: "DELETE" });
    toast("Detected face image deleted.");
    await reloadFaces();
    await reload();
  }

  async function splitFace(faceId) {
    const label = window.prompt("New visitor label", "");
    if (label === null) return;
    await api("/api/faces/split", { method: "POST", body: JSON.stringify({ faceId, label }) });
    toast("Face split into a separate visitor identity.");
    await reloadFaces();
    await reload();
  }

  async function mergeFace(sourceFaceId, targetFaceId) {
    if (!targetFaceId) {
      toast("Choose an enrolled target face first.");
      return;
    }
    await api("/api/faces/merge", { method: "POST", body: JSON.stringify({ sourceFaceId, targetFaceId }) });
    toast("Duplicate face merged into the selected identity.");
    await reloadFaces();
    await reload();
  }

  const currentFaces = data.faces.filter((face) => !(face.status === "trained" || face.personId || face.matchedPersonId));
  const trainedFaces = data.faces.filter((face) => face.status === "trained" || face.personId || face.matchedPersonId);

  return (
    <section id="people" className="view active">
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Face recognition</span>
            <h2>Enroll person</h2>
          </div>
        </div>
        <form className="form-grid" onSubmit={handlePersonSubmit}>
          <label>Name<input name="name" required placeholder="Employee or visitor name" /></label>
          <label>Category
            <select name="category"><option>employee</option><option>staff</option><option>customer</option><option>visitor</option><option>watchlist</option></select>
          </label>
          <label>Department<input name="department" placeholder="Security / Operations" /></label>
          <label>Access level
            <select name="accessLevel"><option>standard</option><option>restricted</option><option>visitor</option></select>
          </label>
          <button>Enroll face</button>
        </form>
      </section>

      <div className="people-grid">
        {data.people.length ? data.people.map((p) => (
          <article className="person-card" key={p.id}>
            <strong>{p.name}</strong>
            <span className={`status ${statusClass(p.status)}`}>{p.status}</span>
            <small>{p.category} | {p.department} | {p.accessLevel}</small>
            <small>Face: {p.faceStatus} | Last seen: {new Date(p.lastSeen).toLocaleString()}</small>
          </article>
        )) : <div className="empty-state">No enrolled people yet. Add staff, visitor, or customer profiles here.</div>}
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Privacy controls</span>
            <h2>Retention, consent, and exports</h2>
          </div>
        </div>
        {data.privacy ? (
          <form className="form-grid" onSubmit={handlePrivacySubmit}>
            <label>Face retention days<input name="retentionDays" type="number" min="1" max="365" defaultValue={Number(data.privacy.retentionDays || 30)} /></label>
            <label>Delete untrained after days<input name="deleteUntrainedAfterDays" type="number" min="1" max="90" defaultValue={Number(data.privacy.deleteUntrainedAfterDays || 7)} /></label>
            <label className="inline-check"><input name="blurUnknown" type="checkbox" defaultChecked={Boolean(data.privacy.blurUnknown)} /> Blur unknown visitors on export</label>
            <label className="inline-check"><input name="allowExport" type="checkbox" defaultChecked={data.privacy.allowExport !== false} /> Allow evidence export</label>
            <label className="inline-check"><input name="consentRequired" type="checkbox" defaultChecked={Boolean(data.privacy.consentRequired)} /> Require consent flag for enrolled people</label>
            <button>Save privacy policy</button>
          </form>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Detected faces</span>
            <h2>Classify, match, and train faces</h2>
          </div>
          <button type="button" onClick={handleProcessPendingFaces}>Process pending faces</button>
        </div>
        <div className="tab-row" role="tablist" aria-label="Face enrollment tabs">
          <button type="button" className={`tab-button ${faceTab === "current" ? "active" : ""}`} onClick={() => setFaceTab("current")}>Current detections</button>
          <button type="button" className={`tab-button ${faceTab === "enrolled" ? "active" : ""}`} onClick={() => setFaceTab("enrolled")}>Enrolled faces</button>
          <button type="button" className={`tab-button ${faceTab === "history" ? "active" : ""}`} onClick={() => setFaceTab("history")}>Daily history</button>
        </div>

        {faceTab === "history" ? (
          <div>
            {data.faceDays.length ? (
              <div className="day-card-grid">
                {data.faceDays.map((day) => (
                  <button
                    type="button"
                    key={day.date}
                    className={`day-card ${effectiveActiveDay === day.date ? "active" : ""}`}
                    onClick={() => setActiveFaceDay(day.date)}
                  >
                    <strong>{formatDisplayDate(day.date)}</strong>
                    <small>{Number(day.peopleCount || 0)} people | {Number(day.areaCount || 0)} area(s)</small>
                    <small>{Number(day.detectionCount || 0)} detections | {formatDuration(day.totalSeconds || 0)}</small>
                  </button>
                ))}
              </div>
            ) : <div className="empty-state">No daily face history yet. Start all cameras to build daily movement records.</div>}
          </div>
        ) : null}

        {faceTab === "current" ? (
          <div className="face-grid">
            {currentFaces.length ? currentFaces.map((face) => (
              <CurrentFaceCard
                key={face.id}
                face={face}
                allFaces={data.faces}
                onSave={saveFaceLabel}
                onSplit={splitFace}
                onDelete={deleteFace}
                onMerge={mergeFace}
              />
            )) : <div className="empty-state">No current detections. Start the laptop camera, capture faces, then classify them here.</div>}
          </div>
        ) : null}

        {faceTab === "enrolled" ? (
          <div className="face-grid">
            <EnrolledFaceGrid people={data.people} trainedFaces={trainedFaces} onSave={saveFaceLabel} onDelete={deleteFace} />
          </div>
        ) : null}

        {faceTab === "history" ? (
          <div className="face-grid">
            <FaceHistoryGrid faceDays={data.faceDays} activeDay={effectiveActiveDay} />
          </div>
        ) : null}
      </section>
    </section>
  );
}

function CurrentFaceCard({ face, allFaces, onSave, onSplit, onDelete, onMerge }) {
  const mergeCandidates = allFaces.filter((candidate) => candidate.id !== face.id && (candidate.status === "trained" || candidate.personId || candidate.matchedPersonId));
  const mergeTargetRef = useRef("");
  return (
    <article className="face-card">
      <FaceThumb imageUrl={face.imageUrl} title={`Detected face ${face.id}`} alt={`Detected face ${face.id}`} />
      <form onSubmit={(event) => onSave(event, face.id)}>
        <strong>{face.matchedPersonName || face.personName || face.label || "Untrained face"}</strong>
        <small>{face.cameraName || "Local camera"} | {new Date(face.createdAt).toLocaleString()}</small>
        <small>Identity: <b>{face.identityResult || "pending"}</b> | Quality: {face.qualityStatus || "unchecked"} {Number(face.qualityScore || 0)}%</small>
        <small>Match: {face.matchedPersonName || "No match"} | Confidence: {formatConfidence(face.matchScore)}</small>
        <small>Track: {face.trackId || "not assigned"} | {face.saveReason || "review"}</small>
        <label>Person / staff name
          <input name="label" placeholder="Example: John Staff or Visitor name" defaultValue={face.matchedPersonName || face.personName || face.label || ""} />
        </label>
        <select name="category" defaultValue={face.category}>
          {CATEGORY_OPTIONS.map((category) => <option key={category}>{category}</option>)}
        </select>
        <select name="status" defaultValue={face.status}>
          {STATUS_OPTIONS.map((status) => <option key={status}>{status}</option>)}
        </select>
        <div className="face-actions">
          <button>Save training label</button>
          <button type="button" className="ghost" onClick={() => onSplit(face.id)}>Split as new visitor</button>
          <button type="button" className="danger" onClick={() => onDelete(face.id)}>Delete detected image</button>
        </div>
        <label>Merge duplicate into
          <select onChange={(event) => { mergeTargetRef.current = event.target.value; }} defaultValue="">
            <option value="">Choose enrolled face/person</option>
            {mergeCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{displayFaceName(candidate)}</option>)}
          </select>
        </label>
        <button type="button" className="ghost" onClick={() => onMerge(face.id, mergeTargetRef.current)}>Merge duplicate</button>
      </form>
    </article>
  );
}

function EnrolledFaceGrid({ people, trainedFaces, onSave, onDelete }) {
  const usedFaceIds = new Set();
  const personCards = people.map((person) => {
    const face = trainedFaces.find((item) => item.personId === person.id || item.matchedPersonId === person.id);
    if (face) usedFaceIds.add(face.id);
    return (
      <article className="face-card enrolled-identity-card" key={person.id}>
        {face
          ? <FaceThumb imageUrl={face.imageUrl} title={`${person.name} enrolled face`} alt={`${person.name} enrolled face`} />
          : <div className="face-placeholder">{initials(person.name)}</div>}
        <div className="enrolled-identity-body">
          <strong>{person.name}</strong>
          <small>{person.category || "person"} | {person.department || "No department"} | {person.accessLevel || "standard"}</small>
          <small>Face status: <b>{person.faceStatus || "enrolled"}</b> | Person record kept permanently</small>
          <small>Last seen: {person.lastSeen ? new Date(person.lastSeen).toLocaleString() : "Not seen yet"}</small>
          {face
            ? <small>Reference image: {face.id} | Quality {Number(face.qualityScore || 0)}%</small>
            : <small>No reference image currently attached. Existing staff record is still saved.</small>}
        </div>
      </article>
    );
  });
  const faceOnlyCards = trainedFaces.filter((face) => !usedFaceIds.has(face.id)).map((face) => (
    <article className="face-card" key={face.id}>
      <FaceThumb imageUrl={face.imageUrl} title={`${displayFaceName(face)} enrolled face`} alt={`${displayFaceName(face)} enrolled face`} />
      <form onSubmit={(event) => onSave(event, face.id)}>
        <strong>{displayFaceName(face)}</strong>
        <small>{face.cameraName || "Camera"} | {new Date(face.createdAt).toLocaleString()}</small>
        <small>Identity: <b>{face.identityResult || "known"}</b> | Quality: {face.qualityStatus || "usable"} {Number(face.qualityScore || 0)}%</small>
        <label>Person / staff name<input name="label" defaultValue={displayFaceName(face)} /></label>
        <select name="category" defaultValue={face.category}>
          {CATEGORY_OPTIONS.map((category) => <option key={category}>{category}</option>)}
        </select>
        <select name="status" defaultValue={face.status}>
          {STATUS_OPTIONS.map((status) => <option key={status}>{status}</option>)}
        </select>
        <div className="face-actions">
          <button>Save training label</button>
          <button type="button" className="danger" onClick={() => onDelete(face.id)}>Delete detected image</button>
        </div>
      </form>
    </article>
  ));
  const cards = [...personCards, ...faceOnlyCards];
  return cards.length ? cards : <div className="empty-state">No enrolled faces yet. Train a detected face with a staff/customer name and it will appear here.</div>;
}

function FaceHistoryGrid({ faceDays, activeDay }) {
  const selectedDay = faceDays.find((day) => day.date === activeDay) || faceDays[0];
  if (!selectedDay) return <div className="empty-state">No daily history to show yet.</div>;
  if (!selectedDay.people.length) return <div className="empty-state">No people tracked on {formatDisplayDate(selectedDay.date)}.</div>;
  return selectedDay.people.map((person, index) => (
    <article className="face-card person-day-card" key={`${person.identityKey}-${index}`}>
      {person.imageUrl
        ? <FaceThumb imageUrl={person.imageUrl} title={`${person.displayName || "Person"} daily reference`} alt={`${person.displayName || "Person"} daily reference`} />
        : <div className="face-placeholder">?</div>}
      <div>
        <strong>{person.displayName || person.visitorLabel || "Unknown visitor"}</strong>
        <small>{person.category || "visitor"} | {Number(person.areaCount || 0)} area(s) | {Number(person.detectionCount || 0)} detection(s)</small>
        <small>First seen: {new Date(person.firstSeen).toLocaleString()} | Last seen: {new Date(person.lastSeen).toLocaleString()}</small>
        <small>Total stay: {formatDuration(person.totalSeconds || 0)}</small>
        <div className="mini-chip-row">
          {(person.areas || []).map((area, areaIndex) => (
            <span className="mini-chip" key={areaIndex}>{area.areaName} - {formatDuration(area.secondsSpent || 0)} ({Number(area.detectionCount || 0)})</span>
          ))}
        </div>
      </div>
    </article>
  ));
}
