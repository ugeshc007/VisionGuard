import { useAppData } from "../context/AppDataContext.jsx";
import { useUi } from "../context/UiContext.jsx";
import { api } from "../lib/api.js";
import { statusClass } from "../lib/format.js";

export default function RulesView() {
  const { data, reload, cameraName } = useAppData();
  const { toast } = useUi();

  async function handleRuleSubmit(event) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target));
    await api("/api/rules", { method: "POST", body: JSON.stringify(body) });
    event.target.reset();
    toast("AI rule created.");
    await reload();
  }

  return (
    <section id="rules" className="view active">
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Rule builder</span>
            <h2>Define AI alert rule</h2>
          </div>
        </div>
        <form className="form-grid" onSubmit={handleRuleSubmit}>
          <label>Rule name<input name="name" required placeholder="Helmet missing in warehouse" /></label>
          <label>Detection type
            <select name="type">
              <option value="unknown-face">Unknown face</option>
              <option value="restricted-zone">Restricted zone</option>
              <option value="ppe-helmet">Helmet missing</option>
              <option value="vehicle-plate">Vehicle plate</option>
              <option value="fire-smoke">Fire / smoke</option>
              <option value="crowd">Crowd density</option>
              <option value="tamper">Camera tamper</option>
            </select>
          </label>
          <label>Camera
            <select name="cameraId">
              {data.cameras.length ? data.cameras.map((c) => <option key={c.id} value={c.id}>{c.name}</option>) : <option value="">Add a camera first</option>}
            </select>
          </label>
          <label>Severity<select name="severity"><option>medium</option><option>high</option><option>critical</option></select></label>
          <label>Schedule<select name="schedule"><option>always</option><option>work-hours</option><option>after-hours</option></select></label>
          <label>Action<select name="action"><option>notify</option><option>notify-escalate</option><option>report-only</option></select></label>
          <button>Create rule</button>
        </form>
      </section>
      <div className="rule-grid">
        {data.rules.length ? data.rules.map((r) => (
          <article className="rule-card" key={r.id}>
            <strong>{r.name}</strong>
            <span className={`status ${statusClass(r.severity)}`}>{r.severity}</span>
            <small>{r.type} | {cameraName(r.cameraId)} | {r.schedule}</small>
            <small>Action: {r.action} | {r.enabled ? "Enabled" : "Disabled"}</small>
          </article>
        )) : <div className="empty-state">No AI rules yet. Create rules after adding at least one camera.</div>}
      </div>
    </section>
  );
}
