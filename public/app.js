const state = {
  dashboard: null,
  events: [],
  people: [],
  cameras: [],
  sites: [],
  rules: [],
  vehicles: [],
  attendance: [],
  faces: [],
  visits: [],
  tracks: [],
  privacy: null,
  localStream: null,
  autoCaptureTimer: null,
  autoCaptureBusy: false,
  activeCaptureCameraId: "",
  captureSessionStats: { attempts: 0, saved: 0, skipped: 0 },
  trackingFrame: null,
  blazeFaceModel: null,
  faceDetectorMode: "idle",
  liveFaces: [],
  faceTab: "current",
  cameraWallSize: 4,
  lastTrackedBoxes: [],
  visitorSerial: 0,
  trackingBusy: false,
  lastDetectionAt: 0,
  hlsPlayers: new Map()
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const els = {
  kpiGrid: $("#kpiGrid"),
  pipelineGrid: $("#pipelineGrid"),
  cameraGrid: $("#cameraGrid"),
  cameraManagerGrid: $("#cameraManagerGrid"),
  latestEvents: $("#latestEvents"),
  eventQueue: $("#eventQueue"),
  peopleGrid: $("#peopleGrid"),
  ruleGrid: $("#ruleGrid"),
  faceTrainingGrid: $("#faceTrainingGrid"),
  analyticsGrid: $("#analyticsGrid"),
  attendanceTable: $("#attendanceTable"),
  vehicleTable: $("#vehicleTable"),
  areaTrafficDate: $("#areaTrafficDate"),
  flowSummaryGrid: $("#flowSummaryGrid"),
  areaDwellTable: $("#areaDwellTable"),
  forensicFaceGallery: $("#forensicFaceGallery"),
  forensicFaceUpload: $("#forensicFaceUpload"),
  faceEvidenceResult: $("#faceEvidenceResult"),
  cameraSiteSelect: $("#cameraSiteSelect"),
  ruleCameraSelect: $("#ruleCameraSelect"),
  privacyForm: $("#privacyForm"),
  localCameraSelect: $("#localCameraSelect"),
  localCameraVideo: $("#localCameraVideo"),
  localCameraCanvas: $("#localCameraCanvas"),
  faceDetectorStatus: $("#faceDetectorStatus"),
  startLocalCameraButton: $("#startLocalCameraButton"),
  autoCaptureButton: $("#autoCaptureButton"),
  runFaceRetentionButton: $("#runFaceRetentionButton"),
  cameraViewer: $("#cameraViewer"),
  cameraViewerTitle: $("#cameraViewerTitle"),
  cameraViewerFeed: $("#cameraViewerFeed"),
  cameraViewerMeta: $("#cameraViewerMeta"),
  closeCameraViewer: $("#closeCameraViewer"),
  streamGatewayStatus: $("#streamGatewayStatus"),
  toast: $("#toast")
};

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  setTimeout(() => els.toast.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Request failed");
  return data;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function statusClass(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "-");
}

function localizeGatewayUrl(value = "") {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.hostname === "stream-gateway") {
      url.hostname = location.hostname;
    }
    if (["127.0.0.1", "localhost"].includes(url.hostname) && !["127.0.0.1", "localhost"].includes(location.hostname)) {
      url.hostname = location.hostname;
    }
    return url.toString();
  } catch {
    return value;
  }
}

async function loadAll() {
  const [data, tracksData, privacyData] = await Promise.all([
    api("/api/dashboard"),
    api("/api/person-tracks").catch(() => ({ tracks: [] })),
    api("/api/privacy").catch(() => ({ policy: null }))
  ]);
  Object.assign(state, data, {
    events: data.events || [],
    cameras: data.cameras || [],
    sites: data.sites || [],
    people: data.people || [],
    faces: data.faces || [],
    rules: data.rules || [],
    vehicles: data.vehicles || [],
    attendance: data.attendance || [],
    visits: data.visits || [],
    tracks: tracksData.tracks || [],
    privacy: privacyData.policy || null
  });
  renderDashboard();
  renderForms();
  renderManagementViews();
  await loadFaces();
  await renderReports();
}

function renderDashboard() {
  const s = state.summary || {};
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
  els.kpiGrid.innerHTML = kpis.map(([label, value]) => `<article class="kpi"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
  renderPipeline();
  renderCameraWall();
  els.latestEvents.innerHTML = state.events.slice(0, 5).map(eventCard).join("");
}

function renderPipeline() {
  if (!els.pipelineGrid) return;
  const s = state.summary || {};
  const trainedFaces = state.faces.filter((face) => face.status === "trained").length;
  const currentFaces = state.faces.filter((face) => face.status !== "trained").length;
  const pendingFaces = state.faces.filter((face) => face.identityResult === "pending" || face.status === "untrained").length;
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
  els.pipelineGrid.innerHTML = stages.map((stage, index) => `
    <article class="pipeline-card">
      <span class="status online">${String(index + 1).padStart(2, "0")}</span>
      <strong>${escapeHtml(stage.name)}</strong>
      <b>${escapeHtml(stage.value)}</b>
      <small>${escapeHtml(stage.detail)}</small>
    </article>
  `).join("");
}

function renderForms() {
  els.cameraSiteSelect.innerHTML = state.sites.length
    ? state.sites.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("")
    : `<option value="">Create a site first</option>`;
  els.ruleCameraSelect.innerHTML = state.cameras.length
    ? state.cameras.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")
    : `<option value="">Add a camera first</option>`;
  els.localCameraSelect.innerHTML = state.cameras.length
    ? state.cameras.map((c) => `<option value="${c.id}">${escapeHtml(c.name)} - ${isRemoteFrameCamera(c) ? "RTSP/HTTP snapshot" : "Local browser camera"}</option>`).join("")
    : `<option value="">Add RTSP or Local Camera first</option>`;
}

function selectedCaptureCamera() {
  const selectedId = els.localCameraSelect.value || state.cameras[0]?.id || "";
  return state.cameras.find((camera) => camera.id === selectedId) || state.cameras[0] || null;
}

function isBrowserLocalCamera(camera = {}) {
  return String(camera.streamUrl || "").startsWith("local://");
}

function isRemoteFrameCamera(camera = {}) {
  return /^(rtsp|rtsps|http|https):\/\//i.test(String(camera.streamUrl || ""));
}

function renderManagementViews() {
  els.cameraManagerGrid.innerHTML = state.cameras.length ? state.cameras.map((camera) => cameraCard(camera, true)).join("") : `<div class="empty-state">No cameras yet. Create a site, then add Local Camera or RTSP camera.</div>`;
  els.peopleGrid.innerHTML = state.people.length ? state.people.map((p) => `
    <article class="person-card">
      <strong>${escapeHtml(p.name)}</strong>
      <span class="status ${statusClass(p.status)}">${escapeHtml(p.status)}</span>
      <small>${escapeHtml(p.category)} | ${escapeHtml(p.department)} | ${escapeHtml(p.accessLevel)}</small>
      <small>Face: ${escapeHtml(p.faceStatus)} | Last seen: ${new Date(p.lastSeen).toLocaleString()}</small>
    </article>
  `).join("") : `<div class="empty-state">No enrolled people yet. Add staff, visitor, or customer profiles here.</div>`;
  els.ruleGrid.innerHTML = state.rules.length ? state.rules.map((r) => `
    <article class="rule-card">
      <strong>${escapeHtml(r.name)}</strong>
      <span class="status ${statusClass(r.severity)}">${escapeHtml(r.severity)}</span>
      <small>${escapeHtml(r.type)} | ${cameraName(r.cameraId)} | ${escapeHtml(r.schedule)}</small>
      <small>Action: ${escapeHtml(r.action)} | ${r.enabled ? "Enabled" : "Disabled"}</small>
    </article>
  `).join("") : `<div class="empty-state">No AI rules yet. Create rules after adding at least one camera.</div>`;
  els.eventQueue.innerHTML = state.events.length ? state.events.map(eventCard).join("") : `<div class="empty-state">No alerts yet. Capture from the laptop camera or generate an AI event after adding a camera.</div>`;
  renderPrivacyForm();
  renderFaceTrainingGrid();
}

function renderPrivacyForm() {
  if (!els.privacyForm || !state.privacy) return;
  els.privacyForm.retentionDays.value = Number(state.privacy.retentionDays || 30);
  els.privacyForm.deleteUntrainedAfterDays.value = Number(state.privacy.deleteUntrainedAfterDays || 7);
  els.privacyForm.blurUnknown.checked = Boolean(state.privacy.blurUnknown);
  els.privacyForm.allowExport.checked = state.privacy.allowExport !== false;
  els.privacyForm.consentRequired.checked = Boolean(state.privacy.consentRequired);
}

function renderCameraWall() {
  if (!els.cameraGrid) return;
  destroyCameraWallPlayers();
  els.cameraGrid.className = `camera-wall wall-${state.cameraWallSize}`;
  const visible = state.cameras.slice(0, state.cameraWallSize);
  els.cameraGrid.innerHTML = visible.length
    ? visible.map((camera) => cameraCard(camera, false)).join("")
    : `<div class="empty-state">No cameras yet. Add Local Camera or RTSP streams to build the DVR wall.</div>`;
  requestAnimationFrame(initCameraWallPlayers);
}

function cameraCard(camera, manager = false) {
  const hlsUrl = localizeGatewayUrl(camera.hlsUrl);
  const webrtcUrl = localizeGatewayUrl(camera.webrtcPageUrl);
  const playable = camera.playable && hlsUrl;
  const tuning = manager ? `
    <form class="camera-tuning" data-camera-tuning="${camera.id}">
      <label>Camera name<input name="name" value="${escapeHtml(camera.name || "")}" placeholder="Main gate camera" /></label>
      <label>Role
        <select name="cameraRole">
          ${["area", "entry", "exit"].map((role) => `<option value="${role}" ${camera.cameraRole === role ? "selected" : ""}>${cameraRoleLabel(role)}</option>`).join("")}
        </select>
      </label>
      <label>Area name<input name="zone" value="${escapeHtml(camera.zone || "")}" placeholder="Lobby / Entrance" /></label>
      <label class="full-row">Camera link / RTSP URL<input name="streamUrl" value="${escapeHtml(camera.streamUrl || "")}" placeholder="rtsp://user:pass@ip/Streaming/Channels/402" /></label>
      <label>Min face px<input name="minFaceSize" type="number" min="32" max="320" value="${Number(camera.minFaceSize || 48)}" /></label>
      <label>Quality %<input name="qualityThreshold" type="number" min="25" max="95" value="${Number(camera.qualityThreshold || 45)}" /></label>
      <label>Interval ms<input name="detectionIntervalMs" type="number" min="250" max="5000" value="${Number(camera.detectionIntervalMs || 650)}" /></label>
      <label>Match %<input name="recognitionThreshold" type="number" min="0.70" max="0.99" step="0.01" value="${Number(camera.recognitionThreshold || .82)}" /></label>
      <label>Retention days<input name="retentionDays" type="number" min="1" max="365" value="${Number(camera.retentionDays || 30)}" /></label>
      <label class="inline-check"><input name="blurUntrusted" type="checkbox" ${camera.blurUntrusted ? "checked" : ""} /> Blur untrusted exports</label>
      <button type="submit">Save camera tuning</button>
      <button type="button" class="danger-button" data-delete-camera="${camera.id}" data-camera-name="${escapeHtml(camera.name)}">Delete camera</button>
    </form>
  ` : "";
  return `
    <article class="camera-card ${manager ? "manager-card" : ""}" ${manager ? "" : `data-open-camera="${camera.id}"`}>
      <div class="camera-feed ${playable ? "has-stream" : ""}">
        <span class="scan-line"></span>
        ${playable
          ? `<video data-hls-url="${escapeHtml(hlsUrl)}" muted autoplay playsinline></video>`
          : `<b>${escapeHtml(camera.name)}</b>`}
        <span class="camera-overlay-name">${escapeHtml(camera.name)}</span>
        <span class="stream-pill ${statusClass(camera.streamStatus)}">${escapeHtml(camera.streamStatus || "offline")}</span>
      </div>
      <div class="camera-meta">
        <span class="status ${statusClass(camera.status)}">${escapeHtml(camera.status)}</span>
        <strong>${escapeHtml(camera.zone || camera.name)}</strong>
        <small>${siteName(camera.siteId)} | ${cameraRoleLabel(camera.cameraRole)} | ${camera.fps} FPS | Health ${camera.health}%</small>
        <small title="${escapeHtml(camera.streamUrl || "")}">Link: ${escapeHtml(camera.streamUrl ? camera.streamUrl : "No stream URL configured")}</small>
        ${webrtcUrl ? `<small><a href="${escapeHtml(webrtcUrl)}" target="_blank" rel="noreferrer">Open low-latency WebRTC preview</a></small>` : ""}
        <small>AI: min ${Number(camera.minFaceSize || 48)}px | quality ${Number(camera.qualityThreshold || 45)}% | ${Number(camera.detectionIntervalMs || 650)}ms</small>
        <div class="bar"><span style="width:${Math.max(6, Number(camera.health || 0))}%"></span></div>
      </div>
      ${tuning}
    </article>
  `;
}

function destroyCameraWallPlayers() {
  state.hlsPlayers.forEach((player) => {
    try { player.destroy(); } catch {}
  });
  state.hlsPlayers.clear();
}

function initCameraWallPlayers() {
  $$("video[data-hls-url]").forEach((video, index) => attachHls(video, video.dataset.hlsUrl, `wall-${index}`));
}

function attachHls(video, url, key) {
  if (!video || !url) return;
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
    video.play().catch(() => {});
    return;
  }
  if (!window.Hls?.isSupported?.()) return;
  const player = new window.Hls({
    lowLatencyMode: true,
    liveSyncDurationCount: 2,
    maxLiveSyncPlaybackRate: 1.5
  });
  player.loadSource(url);
  player.attachMedia(video);
  player.on(window.Hls.Events.ERROR, (_event, data) => {
    if (data?.fatal) {
      video.closest(".camera-feed")?.classList.add("stream-error");
    }
  });
  state.hlsPlayers.set(key, player);
}

async function checkStreamGateway() {
  const result = await api("/api/streams/health");
  if (els.streamGatewayStatus) {
    els.streamGatewayStatus.textContent = result.ok
      ? `Gateway online at ${result.gatewayUrl}. Browser playback is ready.`
      : `Gateway offline at ${result.gatewayUrl}: ${result.message || "not responding"}`;
  }
  toast(result.ok ? "Stream gateway online." : "Stream gateway needs attention.");
}

async function syncStreamGateway() {
  const result = await api("/api/streams/sync", { method: "POST", body: "{}" });
  if (els.streamGatewayStatus) {
    els.streamGatewayStatus.textContent = `Synced ${result.synced}/${result.total} camera stream(s). Skipped ${result.skipped}. Failed ${result.failed}.`;
  }
  await loadAll();
  toast(result.ok ? "Camera streams synced." : "Some camera streams need checking.");
}

function eventCard(event) {
  return `
    <article class="event-card">
      <img src="${event.snapshot}" alt="AI snapshot for ${escapeHtml(event.id)}" />
      <div>
        <span class="status ${statusClass(event.severity)}">${escapeHtml(event.severity)}</span>
        <h3>${escapeHtml(event.title)}</h3>
        <p>${cameraName(event.cameraId)} | ${event.person?.name || event.vehicle?.plate || "No identity"} | Confidence ${event.confidence}%</p>
        <p>${new Date(event.createdAt).toLocaleString()} | Status: ${escapeHtml(event.status)}</p>
      </div>
      <div class="event-actions">
        <button data-action="ack" data-id="${event.id}">Acknowledge</button>
        <button class="ghost" data-action="report" data-id="${event.id}">Report</button>
      </div>
    </article>
  `;
}

async function loadFaces() {
  const data = await api("/api/faces");
  state.faces = data.faces || [];
  renderFaceTrainingGrid();
  renderForensicFaceGallery();
}

function renderFaceTrainingGrid() {
  if (!els.faceTrainingGrid) return;
  const faces = state.faceTab === "enrolled"
    ? state.faces.filter((face) => face.status === "trained" || face.personId || face.matchedPersonId)
    : state.faces.filter((face) => !(face.status === "trained" || face.personId || face.matchedPersonId));
  if (!faces.length) {
    els.faceTrainingGrid.innerHTML = state.faceTab === "enrolled"
      ? `<div class="empty-state">No enrolled faces yet. Train a detected face with a staff/customer name and it will appear here.</div>`
      : `<div class="empty-state">No current detections. Start the laptop camera, capture faces, then classify them here.</div>`;
    return;
  }
  els.faceTrainingGrid.innerHTML = faces.map((face) => `
    <article class="face-card">
      <img src="${face.imageUrl}" alt="Detected face ${escapeHtml(face.id)}" />
      <form data-face-form="${face.id}">
        <strong>${escapeHtml(face.matchedPersonName || face.personName || face.label || "Untrained face")}</strong>
        <small>${escapeHtml(face.cameraName || "Local camera")} | ${new Date(face.createdAt).toLocaleString()}</small>
        <small>Identity: <b>${escapeHtml(face.identityResult || "pending")}</b> | Quality: ${escapeHtml(face.qualityStatus || "unchecked")} ${Number(face.qualityScore || 0)}%</small>
        <small>Match: ${escapeHtml(face.matchedPersonName || "No match")} | Confidence: ${formatConfidence(face.matchScore)}</small>
        <small>Track: ${escapeHtml(face.trackId || "not assigned")} | ${escapeHtml(face.saveReason || "review")}</small>
        <label>Person / staff name
          <input name="label" placeholder="Example: John Staff or Visitor name" value="${escapeHtml(face.matchedPersonName || face.personName || face.label || "")}" />
        </label>
        <select name="category">
          ${["visitor", "customer", "staff", "employee", "unknown", "watchlist"].map((category) => `<option ${face.category === category ? "selected" : ""}>${category}</option>`).join("")}
        </select>
        <select name="status">
          ${["untrained", "trained", "review", "blocked"].map((status) => `<option ${face.status === status ? "selected" : ""}>${status}</option>`).join("")}
        </select>
        <div class="face-actions">
          <button>Save training label</button>
          <button type="button" class="ghost" data-split-face="${face.id}">Split as new visitor</button>
          <button type="button" class="danger" data-delete-face="${face.id}">Delete detected image</button>
        </div>
        <label>Merge duplicate into
          <select name="mergeTarget">
            <option value="">Choose enrolled face/person</option>
            ${state.faces
              .filter((candidate) => candidate.id !== face.id && (candidate.status === "trained" || candidate.personId || candidate.matchedPersonId))
              .map((candidate) => `<option value="${candidate.id}">${escapeHtml(displayFaceName(candidate))}</option>`)
              .join("")}
          </select>
        </label>
        <button type="button" class="ghost" data-merge-face="${face.id}">Merge duplicate</button>
      </form>
    </article>
  `).join("");
}

function formatConfidence(score) {
  const value = Number(score || 0);
  if (!value) return "0%";
  return `${Math.round(value * 100)}%`;
}

function siteName(id) {
  return state.sites.find((s) => s.id === id)?.name || id || "";
}

function cameraName(id) {
  return state.cameras.find((c) => c.id === id)?.name || id || "";
}

function cameraRoleLabel(role = "area") {
  return {
    area: "Area monitor",
    entry: "Entry camera",
    exit: "Exit camera"
  }[role] || "Area monitor";
}

function renderForensicFaceGallery() {
  if (!els.forensicFaceGallery) return;
  const faces = state.faces.slice(0, 24);
  els.forensicFaceGallery.innerHTML = faces.length ? faces.map((face) => `
    <button type="button" class="gallery-face" data-search-face="${face.id}">
      <img src="${face.imageUrl}" alt="${escapeHtml(face.label || "Detected face")}" />
      <span>${escapeHtml(face.matchedPersonName || face.personName || face.label || "Unknown")}</span>
      <small>${escapeHtml(face.identityResult || face.status || "pending")}</small>
    </button>
  `).join("") : `<div class="empty-state">No detected faces yet. Capture faces from the camera first, or upload a photo.</div>`;
}

async function searchFaceEvidence(payload) {
  const result = await api("/api/forensics/face-search", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  renderFaceEvidence(result);
  return result;
}

function renderFaceEvidence(result) {
  if (!els.faceEvidenceResult) return;
  const movement = result.movement || {};
  const primary = result.primary || {};
  els.faceEvidenceResult.innerHTML = `
    <article class="evidence-summary">
      <div>
        <span class="eyebrow">Best match</span>
        <h3>${escapeHtml(primary.displayName || result.source?.label || "No strong match")}</h3>
        <p>${escapeHtml(primary.personCategory || primary.category || "unknown")} | Similarity ${Number(primary.similarity || 0)}</p>
      </div>
      <div class="flow-stats">
        <span><b>${movement.firstEntry ? new Date(movement.firstEntry.createdAt).toLocaleString() : "-"}</b><small>First entry</small></span>
        <span><b>${movement.lastExit ? new Date(movement.lastExit.createdAt).toLocaleString() : "-"}</b><small>Last exit</small></span>
        <span><b>${formatDuration(movement.totalSeconds || 0)}</b><small>Total area time</small></span>
        <span><b>${movement.dwell?.length || 0}</b><small>Areas visited</small></span>
      </div>
    </article>
    <div class="two-col compact">
      <section class="mini-panel">
        <strong>Matched images</strong>
        <div class="face-gallery compact-gallery">
          ${(result.matches || []).slice(0, 8).map((match) => `
            <button type="button" class="gallery-face" data-search-face="${match.id}">
              <img src="${match.imageUrl}" alt="${escapeHtml(match.displayName || match.label || "Match")}" />
              <span>${escapeHtml(match.displayName || match.label || "Unknown")}</span>
              <small>${Number(match.similarity || 0)}</small>
            </button>
          `).join("")}
        </div>
      </section>
      <section class="mini-panel">
        <strong>Area timeline</strong>
        <div class="table">
          ${(movement.dwell || []).length ? movement.dwell.map((row) => `
            <div class="table-row">
              <strong>${escapeHtml(row.areaName || row.cameraName || "Area")}</strong>
              <span>${formatDuration(row.secondsSpent)}</span>
              <small>${new Date(row.firstSeen).toLocaleString()} - ${new Date(row.lastSeen).toLocaleString()}</small>
            </div>
          `).join("") : `<div class="empty-state">No area dwell records found for this person yet.</div>`}
        </div>
      </section>
    </div>
  `;
}

async function renderReports() {
  if (els.areaTrafficDate && !els.areaTrafficDate.value) {
    els.areaTrafficDate.value = new Date().toISOString().slice(0, 10);
  }
  const attendance = await api("/api/attendance");
  els.attendanceTable.innerHTML = attendance.attendance.map((row) => {
    const person = attendance.people.find((p) => p.id === row.personId);
    return `<div class="table-row"><strong>${escapeHtml(person?.name || row.personId)}</strong><span class="status ${statusClass(row.status)}">${escapeHtml(row.status)}</span><small>${row.date} | ${row.checkIn || "-"} - ${row.checkOut || "In site"}</small></div>`;
  }).join("");
  const vehicles = await api("/api/vehicles");
  els.vehicleTable.innerHTML = vehicles.vehicles.map((v) => `<div class="table-row"><strong>${escapeHtml(v.plate)}</strong><span class="status ${statusClass(v.status)}">${escapeHtml(v.status)}</span><small>${escapeHtml(v.owner)} | ${escapeHtml(v.type)} | ${new Date(v.lastSeen).toLocaleString()}</small></div>`).join("");
  const traffic = await api(`/api/area-traffic?date=${encodeURIComponent(els.areaTrafficDate?.value || new Date().toISOString().slice(0, 10))}`);
  renderAreaTraffic(traffic);
  const analytics = await api("/api/analytics");
  els.analyticsGrid.innerHTML = [
    metricCard("Alerts by type", analytics.byType),
    metricCard("Severity split", analytics.bySeverity),
    metricCard("Camera load", analytics.byCamera),
    trendCard(analytics.trends)
  ].join("");
}

function renderAreaTraffic(traffic) {
  if (!els.flowSummaryGrid || !els.areaDwellTable) return;
  els.flowSummaryGrid.innerHTML = traffic.flowSummary.length ? traffic.flowSummary.map((area) => `
    <article class="flow-card">
      <strong>${escapeHtml(area.areaName)}</strong>
      <div class="flow-stats">
        <span><b>${area.totalIn}</b><small>Total in</small></span>
        <span><b>${area.totalOut}</b><small>Total out</small></span>
        <span><b>${area.staffIn}/${area.staffOut}</b><small>Staff in/out</small></span>
        <span><b>${area.visitorIn}/${area.visitorOut}</b><small>Visitor in/out</small></span>
      </div>
    </article>
  `).join("") : `<div class="empty-state">No entry/exit movement for this date. Configure cameras as Entry or Exit and process face detections.</div>`;

  els.areaDwellTable.innerHTML = traffic.dwell.length ? traffic.dwell.map((row) => `
    <div class="table-row">
      <strong>${escapeHtml(row.displayName || row.visitorLabel || "Unknown visitor")}</strong>
      <span class="status ${statusClass(row.category)}">${escapeHtml(row.category)}</span>
      <small>${escapeHtml(row.areaName)} | ${formatDuration(row.secondsSpent)} | ${row.detectionCount} detection(s)</small>
      <small>${new Date(row.firstSeen).toLocaleString()} - ${new Date(row.lastSeen).toLocaleString()}</small>
    </div>
  `).join("") : `<div class="empty-state">No dwell-time records yet for this date.</div>`;
}

function formatDuration(seconds = 0) {
  const value = Number(seconds || 0);
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  const remaining = value % 60;
  if (minutes < 60) return `${minutes}m ${remaining}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function metricCard(title, values) {
  const max = Math.max(1, ...Object.values(values || {}));
  return `<article class="analytics-card"><strong>${escapeHtml(title)}</strong>${Object.entries(values || {}).map(([key, value]) => `<small>${escapeHtml(key)}: ${value}</small><div class="bar"><span style="width:${Math.round((value / max) * 100)}%"></span></div>`).join("")}</article>`;
}

function trendCard(trends) {
  return `<article class="analytics-card"><strong>7-day alert trend</strong>${(trends || []).map((t) => `<small>${t.day}: ${t.alerts} alerts | PPE ${t.ppe}%</small><div class="bar"><span style="width:${Math.min(100, t.alerts * 8)}%"></span></div>`).join("")}</article>`;
}

function bindNavigation() {
  $$("nav button").forEach((button) => {
    button.addEventListener("click", () => {
      $$("nav button").forEach((item) => item.classList.remove("active"));
      $$(".view").forEach((view) => view.classList.remove("active"));
      button.classList.add("active");
      $(`#${button.dataset.view}`)?.classList.add("active");
    });
  });
}

function bindForms() {
  $("#siteForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target));
    await api("/api/sites", { method: "POST", body: JSON.stringify(body) });
    event.target.reset();
    toast("Site created.");
    await loadAll();
  });
  $("#cameraForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target));
    await api("/api/cameras", { method: "POST", body: JSON.stringify(body) });
    event.target.reset();
    toast("Camera added and AI health monitoring started.");
    await loadAll();
  });
  $("#personForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target));
    await api("/api/people", { method: "POST", body: JSON.stringify(body) });
    event.target.reset();
    toast("Face profile enrolled.");
    await loadAll();
  });
  $("#ruleForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target));
    await api("/api/rules", { method: "POST", body: JSON.stringify(body) });
    event.target.reset();
    toast("AI rule created.");
    await loadAll();
  });
  $("#forensicForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const q = new FormData(event.target).get("q") || "";
    const data = await api(`/api/forensics?q=${encodeURIComponent(q)}`);
    $("#forensicResults").innerHTML = data.results.length ? data.results.map(eventCard).join("") : `<article class="event-card"><div><h3>No evidence found</h3><p>Try face, camera, event type, plate, or zone keywords.</p></div></article>`;
  });
  els.forensicFaceUpload?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const imageData = await readFileAsDataUrl(file);
    await searchFaceEvidence({ imageData });
    toast("Uploaded photo searched against face database.");
  });
  document.addEventListener("submit", async (event) => {
    const cameraTuningForm = event.target.closest("[data-camera-tuning]");
    if (cameraTuningForm) {
      event.preventDefault();
      const cameraId = cameraTuningForm.dataset.cameraTuning;
      const values = Object.fromEntries(new FormData(cameraTuningForm));
      await api(`/api/cameras/${encodeURIComponent(cameraId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...values,
          minFaceSize: Number(values.minFaceSize || 80),
          qualityThreshold: Number(values.qualityThreshold || 62),
          detectionIntervalMs: Number(values.detectionIntervalMs || 650),
          recognitionThreshold: Number(values.recognitionThreshold || .82),
          retentionDays: Number(values.retentionDays || 30),
          blurUntrusted: Boolean(values.blurUntrusted)
        })
      });
      toast("Camera tuning saved.");
      await loadAll();
      return;
    }
    if (event.target === els.privacyForm) {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(els.privacyForm));
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
      await loadAll();
      return;
    }
    const form = event.target.closest("[data-face-form]");
    if (!form) return;
    event.preventDefault();
    const faceId = form.dataset.faceForm;
    const body = Object.fromEntries(new FormData(form));
    await api(`/api/faces/${encodeURIComponent(faceId)}`, { method: "PATCH", body: JSON.stringify(body) });
    toast("Face training label saved.");
    await loadFaces();
    await loadAll();
  });
}

function bindActions() {
  $("#refreshButton").addEventListener("click", () => loadAll().then(() => toast("Dashboard refreshed.")));
  $("#simulateEventButton").addEventListener("click", simulateEvent);
  $("#simulateFromAlerts").addEventListener("click", simulateEvent);
  $("#addLocalCameraButton").addEventListener("click", addLocalCamera);
  $("#startLocalCameraButton").addEventListener("click", startSelectedCamera);
  $("#captureFacesButton").addEventListener("click", () => captureFacesToDb());
  $("#autoCaptureButton").addEventListener("click", toggleAutoCapture);
  $("#processFacesButton").addEventListener("click", processPendingFaces);
  $("#checkStreamGatewayButton")?.addEventListener("click", checkStreamGateway);
  $("#syncStreamGatewayButton")?.addEventListener("click", syncStreamGateway);
  els.runFaceRetentionButton?.addEventListener("click", runFaceRetention);
  els.areaTrafficDate?.addEventListener("change", renderReports);
  $$("[data-camera-layout]").forEach((button) => {
    button.addEventListener("click", () => {
      state.cameraWallSize = Number(button.dataset.cameraLayout || 4);
      $$("[data-camera-layout]").forEach((item) => item.classList.toggle("active", item === button));
      renderCameraWall();
    });
  });
  els.closeCameraViewer?.addEventListener("click", closeCameraViewer);
  els.cameraViewer?.addEventListener("click", (event) => {
    if (event.target === els.cameraViewer) closeCameraViewer();
  });
  $$("[data-face-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.faceTab = button.dataset.faceTab;
      $$("[data-face-tab]").forEach((item) => item.classList.toggle("active", item === button));
      renderFaceTrainingGrid();
    });
  });
  els.localCameraSelect?.addEventListener("change", () => {
    if (state.autoCaptureTimer) {
      stopAutoCapture("Camera selection changed. Detection stopped.");
    }
  });
  document.addEventListener("click", async (event) => {
    const openCameraButton = event.target.closest("[data-open-camera]");
    if (openCameraButton) {
      openCameraViewer(openCameraButton.dataset.openCamera);
      return;
    }
    const searchFaceButton = event.target.closest("[data-search-face]");
    if (searchFaceButton) {
      await searchFaceEvidence({ faceId: searchFaceButton.dataset.searchFace });
      toast("Face evidence loaded.");
      return;
    }
    const deleteFaceButton = event.target.closest("[data-delete-face]");
    if (deleteFaceButton) {
      const faceId = deleteFaceButton.dataset.deleteFace;
      const confirmed = window.confirm("Delete this detected face image and related face event references?");
      if (!confirmed) return;
      await api(`/api/faces/${encodeURIComponent(faceId)}`, { method: "DELETE" });
      toast("Detected face image deleted.");
      await loadFaces();
      await loadAll();
      return;
    }
    const deleteCameraButton = event.target.closest("[data-delete-camera]");
    if (deleteCameraButton) {
      const cameraId = deleteCameraButton.dataset.deleteCamera;
      const cameraName = deleteCameraButton.dataset.cameraName || "this camera";
      const confirmed = window.confirm(`Delete ${cameraName}? Existing captures and events remain for audit, but the camera will be removed from live monitoring.`);
      if (!confirmed) return;
      await api(`/api/cameras/${encodeURIComponent(cameraId)}`, { method: "DELETE" });
      toast("Camera deleted.");
      await loadAll();
      return;
    }
    const splitFaceButton = event.target.closest("[data-split-face]");
    if (splitFaceButton) {
      const faceId = splitFaceButton.dataset.splitFace;
      const label = prompt("New visitor label", makeVisitorCode(0));
      if (label === null) return;
      await api("/api/faces/split", { method: "POST", body: JSON.stringify({ faceId, label }) });
      toast("Face split into a separate visitor identity.");
      await loadFaces();
      await loadAll();
      return;
    }
    const mergeFaceButton = event.target.closest("[data-merge-face]");
    if (mergeFaceButton) {
      const form = mergeFaceButton.closest("[data-face-form]");
      const targetFaceId = form?.querySelector("[name='mergeTarget']")?.value;
      if (!targetFaceId) {
        toast("Choose an enrolled target face first.");
        return;
      }
      await api("/api/faces/merge", { method: "POST", body: JSON.stringify({ sourceFaceId: mergeFaceButton.dataset.mergeFace, targetFaceId }) });
      toast("Duplicate face merged into the selected identity.");
      await loadFaces();
      await loadAll();
      return;
    }
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const id = button.dataset.id;
    if (button.dataset.action === "ack") {
      await api(`/api/events/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status: "acknowledged", acknowledgedBy: "Security Admin" }) });
      toast("Alert acknowledged.");
      await loadAll();
    }
    if (button.dataset.action === "report") {
      const report = await api("/api/reports/incident", { method: "POST", body: JSON.stringify({ eventId: id }) });
      toast(`Incident report created: ${report.fileName}`);
    }
  });
}

async function runFaceRetention() {
  const date = els.areaTrafficDate?.value || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const result = await api("/api/faces/retention/run", {
    method: "POST",
    body: JSON.stringify({ date })
  });
  toast(`${result.message} Deleted ${result.deletedFaces} duplicate image(s).`);
  await loadAll();
}

function openCameraViewer(cameraId) {
  const camera = state.cameras.find((item) => item.id === cameraId);
  if (!camera || !els.cameraViewer) return;
  const viewerUrl = localizeGatewayUrl(camera.webrtcPageUrl || camera.hlsUrl);
  els.cameraViewerTitle.textContent = camera.name;
  els.cameraViewerFeed.innerHTML = camera.playable
    ? `<iframe class="viewer-frame" src="${escapeHtml(viewerUrl)}" title="${escapeHtml(camera.name)} live stream"></iframe>`
    : `<strong>${escapeHtml(camera.name)}</strong><small>${escapeHtml(camera.streamStatus || "No browser-playable stream configured")}</small>`;
  els.cameraViewerMeta.innerHTML = [
    ["Area", camera.zone || "Unassigned"],
    ["Role", cameraRoleLabel(camera.cameraRole)],
    ["Status", camera.status || "unknown"],
    ["Health", `${camera.health || 0}%`],
    ["Stream", camera.streamStatus || "not configured"],
    ["Mode", camera.playable ? "WebRTC / HLS" : "local preview"]
  ].map(([label, value]) => `<span><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b></span>`).join("");
  els.cameraViewer.classList.add("show");
  els.cameraViewer.setAttribute("aria-hidden", "false");
}

function closeCameraViewer() {
  if (els.cameraViewerFeed) els.cameraViewerFeed.innerHTML = "";
  els.cameraViewer?.classList.remove("show");
  els.cameraViewer?.setAttribute("aria-hidden", "true");
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

async function simulateEvent() {
  const data = await api("/api/simulate-event", { method: "POST", body: "{}" });
  toast(`AI event generated: ${data.event.title}`);
  await loadAll();
}

async function addLocalCamera() {
  if (!state.sites.length) {
    const site = await api("/api/sites", {
      method: "POST",
      body: JSON.stringify({ name: "Development Site", address: "Local laptop", status: "active" })
    });
    state.sites.unshift(site.site);
  }
  const existing = state.cameras.find((camera) => camera.streamUrl === "local://laptop-camera");
  if (existing) {
    toast("Local Laptop Camera already exists.");
    return;
  }
  await api("/api/cameras", {
    method: "POST",
    body: JSON.stringify({
      name: "Local Laptop Camera",
      siteId: state.sites[0]?.id || "",
      zone: "Development",
      streamUrl: "local://laptop-camera"
    })
  });
  toast("Local Laptop Camera added.");
  await loadAll();
}

async function startLocalCamera() {
  const selectedCamera = selectedCaptureCamera();
  if (selectedCamera && !isBrowserLocalCamera(selectedCamera)) {
    els.faceDetectorStatus.textContent = `${selectedCamera.name} is an RTSP/HTTP camera. Use Detect faces or Start AI auto capture; VisionGuard will capture snapshots through server-side FFmpeg.`;
    toast("Selected camera uses RTSP snapshot capture.");
    return false;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("This browser does not support camera capture.");
    return false;
  }
  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
  }
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
  } catch (error) {
    const message = error?.name === "NotFoundError"
      ? "No laptop webcam was found on this browser/device. Select an RTSP camera and use AI auto capture, or connect a webcam."
      : `Could not start laptop camera: ${error.message || error.name || "permission/device error"}`;
    els.faceDetectorStatus.textContent = message;
    toast(message);
    return false;
  }
  els.localCameraVideo.srcObject = state.localStream;
  await waitForVideoReady(els.localCameraVideo);
  startFaceTracking();
  els.faceDetectorStatus.textContent = "Camera started. Tracking face boxes from the camera feed.";
  toast("Laptop camera started.");
  return true;
}

async function startSelectedCamera() {
  const selectedCamera = selectedCaptureCamera();
  if (!selectedCamera) {
    els.faceDetectorStatus.textContent = "Add or select a camera first.";
    return;
  }
  if (state.autoCaptureTimer) {
    els.faceDetectorStatus.textContent = `Detection is already running for ${selectedCamera.name}. Use Stop detection to stop it.`;
    return;
  }
  await toggleAutoCapture();
}

async function captureFacesToDb(options = {}) {
  const selectedCamera = options.camera || selectedCaptureCamera();
  if (selectedCamera && isRemoteFrameCamera(selectedCamera) && !isBrowserLocalCamera(selectedCamera)) {
    return captureFacesFromRemoteCamera(selectedCamera, options);
  }
  if (!els.localCameraVideo.srcObject) {
    const started = await startLocalCamera();
    if (!started) return { detected: 0, saved: 0, skipped: 0 };
  }
  const video = els.localCameraVideo;
  await waitForVideoReady(video);
  const canvas = els.localCameraCanvas;
  const width = video.videoWidth || 1280;
  const height = video.videoHeight || 720;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(video, 0, 0, width, height);
  const detectedBoxes = await detectFaceBoxes(video, width, height);
  const boxes = stabilizeFaceBoxes(context, detectedBoxes);
  drawFaceBoxes(context, boxes);
  if (!boxes.length) {
    els.faceDetectorStatus.textContent = `No face detected. Nothing saved. Detector: ${state.faceDetectorMode}.`;
    if (!options.silent) toast("No face detected.");
    return { detected: 0, saved: 0, skipped: 0 };
  }
  const candidates = boxes.map((box, index) => buildFacePayload(context, box, index));
  const faces = options.skipClientDuplicateFilter ? candidates : filterNewFaceCandidates(candidates);
  if (!faces.length) {
    const tracked = candidates.filter((candidate) => candidate.trackId && isTrackRecentlyCaptured(candidate.trackId)).length;
    els.faceDetectorStatus.textContent = `Detected ${boxes.length} face(s), but ${tracked || "all"} matched existing tracked/known faces. New person not saved.`;
    if (!options.silent) toast("Known/recent face skipped.");
    return { detected: boxes.length, saved: 0, skipped: candidates.length };
  }
  const imageData = canvas.toDataURL("image/jpeg", .86);
  const result = await api("/api/captures", {
    method: "POST",
    body: JSON.stringify({
      cameraId: selectedCamera?.id || "",
      source: "local-camera",
      imageData,
      width,
      height,
      faces
    })
  });
  markTracksCaptured(faces.map((face) => face.trackId));
  const skipped = (candidates.length - faces.length) + Number(result.skippedFaces?.length || 0);
  const reason = summarizeSkippedFaces(result.skippedFaces);
  els.faceDetectorStatus.textContent = `Detected ${boxes.length}. Saved ${result.faces.length} new face(s). Skipped ${skipped}.${reason ? ` ${reason}` : ""}`;
  if (!options.silent) toast(result.faces.length ? `Saved ${result.faces.length} new face(s) to PostgreSQL.` : (reason || "Face already tracked. No duplicate image saved."));
  await processPendingFaces(false);
  await loadAll();
  return { detected: boxes.length, saved: result.faces.length, skipped };
}

async function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load camera snapshot."));
    image.src = url;
  });
}

async function captureFacesFromRemoteCamera(camera, options = {}) {
  if (!camera?.id) throw new Error("Select a camera first.");
  const image = await loadImage(`/api/cameras/${encodeURIComponent(camera.id)}/frame?t=${Date.now()}`);
  const canvas = els.localCameraCanvas;
  const width = image.naturalWidth || image.width || 1280;
  const height = image.naturalHeight || image.height || 720;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  const detectedBoxes = await detectFaceBoxes(canvas, width, height);
  const boxes = stabilizeFaceBoxes(context, detectedBoxes);
  drawFaceBoxes(context, boxes);
  if (!boxes.length) {
    els.faceDetectorStatus.textContent = `No face detected from ${camera.name}. Detector: ${state.faceDetectorMode}.`;
    if (!options.silent) toast("No face detected.");
    return { detected: 0, saved: 0, skipped: 0 };
  }
  const candidates = boxes.map((box, index) => buildFacePayload(context, box, index));
  const faces = options.skipClientDuplicateFilter === false ? filterNewFaceCandidates(candidates) : candidates;
  if (!faces.length) {
    const tracked = candidates.filter((candidate) => candidate.trackId && isTrackRecentlyCaptured(candidate.trackId)).length;
    els.faceDetectorStatus.textContent = `Detected ${boxes.length} face(s) from ${camera.name}, but ${tracked || "all"} matched existing tracked/known faces.`;
    if (!options.silent) toast("Known/recent face skipped.");
    return { detected: boxes.length, saved: 0, skipped: candidates.length };
  }
  const imageData = canvas.toDataURL("image/jpeg", .86);
  const result = await api("/api/captures", {
    method: "POST",
    body: JSON.stringify({
      cameraId: camera.id,
      source: "rtsp-frame",
      imageData,
      width,
      height,
      faces
    })
  });
  markTracksCaptured(faces.map((face) => face.trackId));
  const skipped = (candidates.length - faces.length) + Number(result.skippedFaces?.length || 0);
  const reason = summarizeSkippedFaces(result.skippedFaces);
  els.faceDetectorStatus.textContent = `RTSP ${camera.name}: detected ${boxes.length}. Saved ${result.faces.length} new face(s). Skipped ${skipped}.${reason ? ` ${reason}` : ""}`;
  if (!options.silent) toast(result.faces.length ? `Saved ${result.faces.length} RTSP face(s).` : (reason || "Face already tracked. No duplicate image saved."));
  await processPendingFaces(false);
  await loadAll();
  return { detected: boxes.length, saved: result.faces.length, skipped };
}

function summarizeSkippedFaces(skippedFaces = []) {
  if (!Array.isArray(skippedFaces) || !skippedFaces.length) return "";
  const first = skippedFaces[0] || {};
  const reason = [first.reason, first.detail].filter(Boolean).join(": ");
  return reason ? `First skipped reason: ${reason}.` : "";
}

function updateCaptureSessionStatus(camera, latest = "") {
  const stats = state.captureSessionStats;
  const last = latest ? ` Last: ${latest}` : "";
  els.faceDetectorStatus.textContent = `Detection running for ${camera?.name || "selected camera"} | attempts ${stats.attempts} | saved ${stats.saved} | skipped ${stats.skipped}.${last}`;
}

function stopAutoCapture(message = "AI auto capture stopped.") {
  if (state.autoCaptureTimer) clearInterval(state.autoCaptureTimer);
  state.autoCaptureTimer = null;
  state.autoCaptureBusy = false;
  state.activeCaptureCameraId = "";
  els.autoCaptureButton.textContent = "Start AI auto capture";
  els.startLocalCameraButton.textContent = "Start selected camera";
  els.faceDetectorStatus.textContent = message;
}

async function toggleAutoCapture() {
  if (state.autoCaptureTimer) {
    stopAutoCapture("Detection stopped.");
    return;
  }
  const selectedCamera = selectedCaptureCamera();
  if (!selectedCamera) {
    els.faceDetectorStatus.textContent = "Add or select a camera first.";
    return;
  }
  if (isBrowserLocalCamera(selectedCamera) && !els.localCameraVideo.srcObject) {
    const started = await startLocalCamera();
    if (!started) return;
  }
  state.activeCaptureCameraId = selectedCamera.id;
  state.captureSessionStats = { attempts: 0, saved: 0, skipped: 0 };
  els.autoCaptureButton.textContent = "Stop detection";
  els.startLocalCameraButton.textContent = "Detection running";
  updateCaptureSessionStatus(selectedCamera, "starting");
  const runCaptureTick = async () => {
    if (state.autoCaptureBusy) return;
    state.autoCaptureBusy = true;
    try {
      const camera = state.cameras.find((item) => item.id === state.activeCaptureCameraId) || selectedCamera;
      const result = await captureFacesToDb({ camera, skipClientDuplicateFilter: true, silent: true });
      state.captureSessionStats.attempts += 1;
      state.captureSessionStats.saved += Number(result?.saved || 0);
      state.captureSessionStats.skipped += Number(result?.skipped || 0);
      updateCaptureSessionStatus(camera, result?.detected ? `${result.detected} face(s) detected` : "no face");
    } catch (error) {
      els.faceDetectorStatus.textContent = error.message;
    } finally {
      state.autoCaptureBusy = false;
    }
  };
  await runCaptureTick();
  const interval = Math.max(2500, Number(selectedCamera.detectionIntervalMs || 4500));
  state.autoCaptureTimer = setInterval(runCaptureTick, interval);
}

async function startFaceTracking() {
  if (state.trackingFrame) cancelAnimationFrame(state.trackingFrame);
  const video = els.localCameraVideo;
  const canvas = els.localCameraCanvas;
  const tick = () => {
    if (!video.srcObject) return;
    if (video.videoWidth && video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const boxes = stabilizeFaceBoxes(context, []);
      drawFaceBoxes(context, boxes);
      if (boxes.length) {
        els.faceDetectorStatus.textContent = `Tracking ${boxes.length} face(s). Detector: ${state.faceDetectorMode}.`;
      }
      const now = Date.now();
      if (!state.trackingBusy && now - state.lastDetectionAt > 280) {
        state.trackingBusy = true;
        state.lastDetectionAt = now;
        detectFaceBoxes(video, canvas.width, canvas.height)
          .then((detectedBoxes) => {
            const stableBoxes = stabilizeFaceBoxes(context, detectedBoxes);
            if (stableBoxes.length) {
              els.faceDetectorStatus.textContent = `Tracking ${stableBoxes.length} face(s). Detector: ${state.faceDetectorMode}.`;
            }
          })
          .catch((error) => {
            els.faceDetectorStatus.textContent = error.message;
          })
          .finally(() => {
            state.trackingBusy = false;
          });
      }
    }
    state.trackingFrame = requestAnimationFrame(tick);
  };
  state.trackingFrame = requestAnimationFrame(tick);
}

async function processPendingFaces(showToast = true) {
  const result = await api("/api/faces/process", { method: "POST", body: "{}" });
  if (showToast) toast(`Processed ${result.processedCount} pending face(s).`);
  await loadAll();
}

function waitForVideoReady(video) {
  if (video.readyState >= 2 && video.videoWidth) return Promise.resolve();
  return new Promise((resolve) => {
    video.onloadedmetadata = () => resolve();
    setTimeout(resolve, 1200);
  });
}

async function detectFaceBoxes(video, width, height) {
  if ("FaceDetector" in window) {
    try {
      const detector = new FaceDetector({ fastMode: false, maxDetectedFaces: 12 });
      const faces = await detector.detect(video);
      if (faces.length) {
        state.faceDetectorMode = "native FaceDetector";
        return faces.map((face) => ({
          x: clamp(face.boundingBox.x, 0, width),
          y: clamp(face.boundingBox.y, 0, height),
          width: clamp(face.boundingBox.width, 1, width - face.boundingBox.x),
          height: clamp(face.boundingBox.height, 1, height - face.boundingBox.y),
          confidence: 92
        }));
      }
    } catch (error) {
      state.faceDetectorMode = `native unavailable: ${error.message}`;
    }
  }
  const blazeFace = await loadBlazeFaceModel();
  if (blazeFace) {
    const predictions = await blazeFace.estimateFaces(video, false);
    state.faceDetectorMode = "BlazeFace";
    return predictions.map((prediction) => {
      const [x1, y1] = prediction.topLeft;
      const [x2, y2] = prediction.bottomRight;
      return {
        x: clamp(x1, 0, width),
        y: clamp(y1, 0, height),
        width: clamp(x2 - x1, 1, width - x1),
        height: clamp(y2 - y1, 1, height - y1),
        confidence: Math.round((prediction.probability?.[0] || .86) * 100)
      };
    });
  }
  state.faceDetectorMode = "not available";
  return [];
}

async function loadBlazeFaceModel() {
  if (state.blazeFaceModel) return state.blazeFaceModel;
  if (!window.blazeface) return null;
  try {
    state.blazeFaceModel = await window.blazeface.load();
    return state.blazeFaceModel;
  } catch (error) {
    state.faceDetectorMode = `BlazeFace unavailable: ${error.message}`;
    return null;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function drawFaceBoxes(context, boxes) {
  context.lineWidth = 4;
  context.font = "700 18px system-ui, sans-serif";
  context.textBaseline = "top";
  boxes.forEach((box) => {
    const colors = box.state === "known"
      ? { stroke: "#1ce187", fill: "rgba(28, 225, 135, .16)", pill: "rgba(28, 225, 135, .94)" }
      : box.state === "low-confidence"
        ? { stroke: "#ff6b6b", fill: "rgba(255, 107, 107, .12)", pill: "rgba(255, 107, 107, .92)" }
        : box.state === "tracking"
          ? { stroke: "#ffd166", fill: "rgba(255, 209, 102, .14)", pill: "rgba(255, 209, 102, .95)" }
          : { stroke: "#37e7d4", fill: "rgba(55, 231, 212, .16)", pill: "rgba(55, 231, 212, .95)" };
    context.globalAlpha = Number(box.opacity || 1);
    context.strokeStyle = colors.stroke;
    context.fillStyle = colors.fill;
    context.fillRect(box.x, box.y, box.width, box.height);
    context.strokeRect(box.x, box.y, box.width, box.height);
    const label = `${box.label || "Face detected"}${box.confidenceLabel ? ` ${box.confidenceLabel}` : ""}`;
    const textWidth = context.measureText(label).width + 18;
    const labelY = Math.max(0, box.y - 30);
    context.fillStyle = colors.pill;
    context.fillRect(box.x, labelY, textWidth, 26);
    context.fillStyle = "#071019";
    context.fillText(label, box.x + 9, labelY + 4);
    context.globalAlpha = 1;
  });
  context.globalAlpha = 1;
}

function stabilizeFaceBoxes(context, boxes = []) {
  const now = Date.now();
  if (boxes.length) {
    resolveLiveFaceLabels(context, boxes);
    state.lastTrackedBoxes = boxes.map((box) => {
      const previous = state.lastTrackedBoxes.find((item) => item.trackId && item.trackId === box.trackId);
      if (!previous) return { ...box, lastSeen: now };
      return {
        ...box,
        x: (previous.x * .45) + (box.x * .55),
        y: (previous.y * .45) + (box.y * .55),
        width: (previous.width * .35) + (box.width * .65),
        height: (previous.height * .35) + (box.height * .65),
        lastSeen: now
      };
    });
    return boxes;
  }
  state.lastTrackedBoxes = state.lastTrackedBoxes.filter((box) => now - Number(box.lastSeen || 0) < 4200);
  return state.lastTrackedBoxes.map((box) => ({
    ...box,
    confidence: Math.max(40, Number(box.confidence || 0) - 10),
    opacity: Math.max(.35, 1 - ((now - Number(box.lastSeen || 0)) / 4200)),
    isKnown: box.isKnown,
    state: box.state || (box.isKnown ? "known" : "tracking"),
    confidenceLabel: box.confidenceLabel || "",
    label: box.label || "Tracking"
  }));
}

function resolveLiveFaceLabels(context, boxes) {
  const now = Date.now();
  state.liveFaces = state.liveFaces.filter((face) => now - face.lastSeen < 120000);
  const usedTrackIds = new Set();
  boxes.forEach((box, index) => {
    const crop = cropFace(context, box);
    const embedding = computeImageEmbedding(crop.context, crop.width, crop.height);
    const known = findBestKnownFace(embedding);
    if (known && known.score >= .985) {
      box.label = known.label;
      box.isKnown = true;
      box.state = "known";
      box.confidenceLabel = `${Math.round(known.score * 100)}%`;
      box.trackId = known.personId || known.label;
      const existingKnownTrack = state.liveFaces.find((face) => face.personId && face.personId === known.personId);
      if (existingKnownTrack) {
        Object.assign(existingKnownTrack, { label: known.label, embedding, box: { ...box }, lastSeen: now, isKnown: true, personId: known.personId });
        usedTrackIds.add(existingKnownTrack.trackId);
      } else {
        const trackId = known.personId || `known-${known.label}`;
        state.liveFaces.push({ trackId, personId: known.personId, label: known.label, embedding, box: { ...box }, lastSeen: now, isKnown: true, savedAt: now });
        usedTrackIds.add(trackId);
      }
      return;
    }
    const recent = findBestLiveTrack(box, embedding, usedTrackIds);
    if (recent && recent.score >= .78) {
      const track = state.liveFaces.find((face) => face.trackId === recent.trackId);
      if (track) {
        track.lastSeen = now;
        track.embedding = blendEmbedding(track.embedding, embedding);
        track.box = { ...box };
        usedTrackIds.add(track.trackId);
        box.label = track.label;
        box.trackId = track.trackId;
        box.isKnown = Boolean(track.isKnown);
        box.state = track.isKnown ? "known" : "tracking";
        box.confidenceLabel = recent.score ? `${Math.round(recent.score * 100)}%` : "";
        return;
      }
    }
    const label = makeVisitorCode(index);
    const trackId = `track-${Date.now()}-${index}-${Math.random().toString(16).slice(2, 6)}`;
    state.liveFaces.push({ trackId, label, embedding, box: { ...box }, lastSeen: now, isKnown: false, savedAt: 0 });
    usedTrackIds.add(trackId);
    box.label = label;
    box.trackId = trackId;
    box.isKnown = false;
    box.state = "new";
    box.confidenceLabel = "new";
  });
}

function displayFaceName(face = {}) {
  return face.matchedPersonName || face.personName || face.label || "Known face";
}

function findBestKnownFace(embedding) {
  let best = null;
  state.faces.forEach((face) => {
    const isKnown = face.status === "trained" || ["employee", "customer", "known", "watchlist", "blocked"].includes(face.identityResult || "");
    if (!isKnown) return;
    const candidate = Array.isArray(face.embedding) ? face.embedding : [];
    const score = cosineSimilarity(embedding, candidate);
    if (!best || score > best.score) {
      best = {
        score,
        personId: face.personId || face.matchedPersonId,
        label: displayFaceName(face)
      };
    }
  });
  return best;
}

function findBestLiveTrack(box, embedding, usedTrackIds = new Set()) {
  let best = null;
  state.liveFaces.forEach((face) => {
    if (usedTrackIds.has(face.trackId)) return;
    const embedScore = cosineSimilarity(embedding, face.embedding);
    const boxScore = face.box ? boxTrackingScore(box, face.box) : 0;
    const sameAppearance = embedScore >= .94;
    const sameMovingFace = boxScore >= .68 && embedScore >= .82;
    if (!sameAppearance && !sameMovingFace) return;
    const score = (embedScore * .7) + (boxScore * .3);
    if (!best || score > best.score) best = { ...face, score, embedScore, boxScore };
  });
  return best;
}

function boxTrackingScore(nextBox = {}, previousBox = {}) {
  const overlap = boxIou(nextBox, previousBox);
  const nextCenter = { x: nextBox.x + nextBox.width / 2, y: nextBox.y + nextBox.height / 2 };
  const previousCenter = { x: previousBox.x + previousBox.width / 2, y: previousBox.y + previousBox.height / 2 };
  const distance = Math.hypot(nextCenter.x - previousCenter.x, nextCenter.y - previousCenter.y);
  const size = Math.max(nextBox.width, nextBox.height, previousBox.width, previousBox.height, 1);
  const centerScore = Math.max(0, 1 - (distance / (size * 1.8)));
  return Math.max(overlap, centerScore * .72);
}

function boxIou(a = {}, b = {}) {
  const x1 = Math.max(a.x || 0, b.x || 0);
  const y1 = Math.max(a.y || 0, b.y || 0);
  const x2 = Math.min((a.x || 0) + (a.width || 0), (b.x || 0) + (b.width || 0));
  const y2 = Math.min((a.y || 0) + (a.height || 0), (b.y || 0) + (b.height || 0));
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, a.width || 0) * Math.max(0, a.height || 0);
  const areaB = Math.max(0, b.width || 0) * Math.max(0, b.height || 0);
  return intersection / (areaA + areaB - intersection || 1);
}

function blendEmbedding(previous = [], next = []) {
  if (!Array.isArray(previous) || !previous.length) return next;
  if (!Array.isArray(next) || previous.length !== next.length) return previous;
  return previous.map((value, index) => (Number(value || 0) * .72) + (Number(next[index] || 0) * .28));
}

function buildFacePayload(context, box, index = 0) {
  const crop = cropFace(context, box);
  const embedding = computeImageEmbedding(crop.context, crop.width, crop.height);
  const sharpness = estimateSharpness(crop.context, crop.width, crop.height);
  return {
    box,
    trackId: box.trackId || "",
    confidence: box.confidence || 0,
    imageData: crop.canvas.toDataURL("image/jpeg", .88),
    embedding,
    sharpness,
    label: box.label || makeVisitorCode(index),
    category: "visitor",
    status: "untrained"
  };
}

function cropFace(context, box) {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 160;
  const cropContext = canvas.getContext("2d", { willReadFrequently: true });
  cropContext.drawImage(context.canvas, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);
  return { canvas, context: cropContext, width: canvas.width, height: canvas.height };
}

function makeVisitorCode(index = 0) {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  state.visitorSerial = (Number(state.visitorSerial || 0) % 9999) + 1;
  const serial = String(state.visitorSerial + index).padStart(4, "0");
  return `VIS-${date}-${serial}`;
}

function findTrack(trackId) {
  return state.liveFaces.find((face) => face.trackId === trackId);
}

function isTrackRecentlyCaptured(trackId) {
  const track = findTrack(trackId);
  return Boolean(track?.savedAt && Date.now() - track.savedAt < 30 * 60 * 1000);
}

function markTracksCaptured(trackIds = []) {
  const now = Date.now();
  const ids = new Set(trackIds.filter(Boolean));
  state.liveFaces.forEach((face) => {
    if (ids.has(face.trackId)) face.savedAt = now;
  });
}

function filterNewFaceCandidates(candidates) {
  const knownEmbeddings = state.faces
    .map((face) => Array.isArray(face.embedding) ? face.embedding : [])
    .filter((embedding) => embedding.length);
  const accepted = [];
  return candidates.filter((candidate) => {
    if (candidate.trackId && isTrackRecentlyCaptured(candidate.trackId)) return false;
    const bestStored = Math.max(0, ...knownEmbeddings.map((embedding) => cosineSimilarity(candidate.embedding, embedding)));
    if (bestStored >= .94) return false;

    const bestCurrentFrame = Math.max(0, ...accepted.map((embedding) => cosineSimilarity(candidate.embedding, embedding)));
    if (bestCurrentFrame >= .985) return false;
    accepted.push(candidate.embedding);
    return true;
  });
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += Number(a[index] || 0) * Number(b[index] || 0);
    magA += Number(a[index] || 0) ** 2;
    magB += Number(b[index] || 0) ** 2;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

function computeImageEmbedding(context, width, height) {
  const cells = 8;
  const image = context.getImageData(0, 0, width, height).data;
  const vector = [];
  for (let cy = 0; cy < cells; cy += 1) {
    for (let cx = 0; cx < cells; cx += 1) {
      let total = 0;
      let count = 0;
      const startX = Math.floor((cx / cells) * width);
      const endX = Math.floor(((cx + 1) / cells) * width);
      const startY = Math.floor((cy / cells) * height);
      const endY = Math.floor(((cy + 1) / cells) * height);
      for (let y = startY; y < endY; y += 4) {
        for (let x = startX; x < endX; x += 4) {
          const index = (y * width + x) * 4;
          total += (image[index] + image[index + 1] + image[index + 2]) / 3;
          count += 1;
        }
      }
      vector.push(Number(((total / Math.max(1, count)) / 255).toFixed(4)));
    }
  }
  return vector;
}

function estimateSharpness(context, width, height) {
  const image = context.getImageData(0, 0, width, height).data;
  let previous = 0;
  let totalDiff = 0;
  let samples = 0;
  for (let y = 1; y < height - 1; y += 4) {
    for (let x = 1; x < width - 1; x += 4) {
      const index = (y * width + x) * 4;
      const luminance = (image[index] * .299) + (image[index + 1] * .587) + (image[index + 2] * .114);
      if (samples) totalDiff += Math.abs(luminance - previous);
      previous = luminance;
      samples += 1;
    }
  }
  return Math.max(0, Math.min(100, Math.round(totalDiff / Math.max(1, samples))));
}

bindNavigation();
bindForms();
bindActions();
loadAll().catch((error) => toast(error.message));
