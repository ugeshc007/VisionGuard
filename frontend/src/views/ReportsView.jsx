import { useEffect, useRef, useState } from "react";
import { useAppData } from "../context/AppDataContext.jsx";
import { useUi } from "../context/UiContext.jsx";
import { api } from "../lib/api.js";
import { formatDuration, statusClass } from "../lib/format.js";

function MetricCard({ title, values }) {
  const max = Math.max(1, ...Object.values(values || {}));
  return (
    <article className="analytics-card">
      <strong>{title}</strong>
      {Object.entries(values || {}).map(([key, value]) => (
        <div key={key}>
          <small>{key}: {value}</small>
          <div className="bar"><span style={{ width: `${Math.round((value / max) * 100)}%` }} /></div>
        </div>
      ))}
    </article>
  );
}

function TrendCard({ trends }) {
  return (
    <article className="analytics-card">
      <strong>7-day alert trend</strong>
      {(trends || []).map((t) => (
        <div key={t.day}>
          <small>{t.day}: {t.alerts} alerts | PPE {t.ppe}%</small>
          <div className="bar"><span style={{ width: `${Math.min(100, t.alerts * 8)}%` }} /></div>
        </div>
      ))}
    </article>
  );
}

export default function ReportsView() {
  const { data, reload, reloadReports } = useAppData();
  const { toast } = useUi();
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [filter, setFilter] = useState("all");
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      return;
    }
    reloadReports(date, filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, filter]);

  async function runFaceRetention() {
    const targetDate = date || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const result = await api("/api/faces/retention/run", { method: "POST", body: JSON.stringify({ date: targetDate }) });
    toast(`${result.message} Deleted ${result.deletedFaces} duplicate image(s).`);
    await reload();
  }

  const { attendance, attendancePeople, vehicles, traffic, analytics } = data.reportsData;

  const people = (traffic.people || []).filter((person) => {
    if (filter === "all") return true;
    const category = String(person.category || "").toLowerCase();
    if (filter === "staff") return category === "staff" || category === "employee";
    if (filter === "unknown") return category === "unknown" || String(person.displayName || "").toLowerCase().includes("unknown");
    return category === filter;
  });

  return (
    <section id="reports" className="view active">
      <div className="two-col">
        <section className="panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Attendance</span>
              <h2>Face attendance</h2>
            </div>
          </div>
          <div className="table">
            {attendance.map((row) => {
              const person = attendancePeople.find((p) => p.id === row.personId);
              return (
                <div className="table-row" key={row.id}>
                  <strong>{person?.name || row.personId}</strong>
                  <span className={`status ${statusClass(row.status)}`}>{row.status}</span>
                  <small>{row.date} | {row.checkIn || "-"} - {row.checkOut || "In site"}</small>
                </div>
              );
            })}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Vehicles</span>
              <h2>Gate records</h2>
            </div>
          </div>
          <div className="table">
            {vehicles.map((v) => (
              <div className="table-row" key={v.id}>
                <strong>{v.plate}</strong>
                <span className={`status ${statusClass(v.status)}`}>{v.status}</span>
                <small>{v.owner} | {v.type} | {new Date(v.lastSeen).toLocaleString()}</small>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Area movement</span>
            <h2>Daily entry, exit, and dwell time</h2>
          </div>
          <div className="panel-actions">
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            <select aria-label="Filter movement by person type" value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="all">All people</option>
              <option value="visitor">Visitors</option>
              <option value="staff">Staff / employees</option>
              <option value="customer">Customers</option>
              <option value="unknown">Unknown</option>
              <option value="watchlist">Watchlist</option>
            </select>
            <button type="button" className="ghost" onClick={runFaceRetention}>Clean duplicate faces</button>
          </div>
        </div>
        <div className="flow-grid">
          {(traffic.flowSummary || []).length ? traffic.flowSummary.map((area) => (
            <article className="flow-card" key={area.areaName}>
              <strong>{area.areaName}</strong>
              <div className="flow-stats">
                <span><b>{area.totalIn}</b><small>Total in</small></span>
                <span><b>{area.totalOut}</b><small>Total out</small></span>
                <span><b>{area.staffIn}/{area.staffOut}</b><small>Staff in/out</small></span>
                <span><b>{area.visitorIn}/{area.visitorOut}</b><small>Visitor in/out</small></span>
              </div>
            </article>
          )) : <div className="empty-state">No entry/exit movement for this date. Configure cameras as Entry or Exit and process face detections.</div>}
        </div>
        <div className="table">
          {people.length ? (
            <div className="movement-person-grid">
              {people.map((person) => (
                <article className="movement-person-card" key={person.identityKey}>
                  <div className="movement-person-head">
                    <div>
                      <strong>{person.displayName || person.visitorLabel || "Unknown visitor"}</strong>
                      <small>{person.visitorLabel || person.personId || "No identity id"}</small>
                    </div>
                    <span className={`status ${statusClass(person.category)}`}>{person.category || "visitor"}</span>
                  </div>
                  <div className="flow-stats movement-stats">
                    <span><b>{formatDuration(person.totalSeconds || 0)}</b><small>Total stay</small></span>
                    <span><b>{Number(person.areaCount || 0)}</b><small>Areas</small></span>
                    <span><b>{Number(person.detectionCount || 0)}</b><small>Detections</small></span>
                  </div>
                  <small>First seen: {new Date(person.firstSeen).toLocaleString()}</small>
                  <small>Last seen: {new Date(person.lastSeen).toLocaleString()}</small>
                  <div className="movement-area-list">
                    {(person.areas || []).map((area, index) => (
                      <div className="movement-area-row" key={index}>
                        <div>
                          <strong>{area.areaName || "Unassigned area"}</strong>
                          <small>{area.cameraName || area.cameraId || "Camera"}</small>
                        </div>
                        <span>{formatDuration(area.secondsSpent || 0)}</span>
                        <small>{new Date(area.firstSeen).toLocaleTimeString()} - {new Date(area.lastSeen).toLocaleTimeString()} | {Number(area.detectionCount || 0)} hit(s)</small>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          ) : <div className="empty-state">No {filter === "all" ? "people" : filter} dwell records for this date.</div>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Analytics</span>
            <h2>Security performance</h2>
          </div>
        </div>
        <div className="analytics-grid">
          <MetricCard title="Alerts by type" values={analytics.byType} />
          <MetricCard title="Severity split" values={analytics.bySeverity} />
          <MetricCard title="Camera load" values={analytics.byCamera} />
          <TrendCard trends={analytics.trends} />
        </div>
      </section>
    </section>
  );
}
