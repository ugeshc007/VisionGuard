import { createServer } from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import pg from "pg";

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = __dirname;
const publicDir = join(rootDir, "public");
const reportsDir = join(rootDir, "reports");
const schemaPath = join(rootDir, "db", "schema.sql");
const embedderPath = join(rootDir, "tools", "insightface_embedder.py");
const port = Number(process.env.PORT || 7070);
const databaseUrl = process.env.DATABASE_URL || "postgres://visionguard:visionguard_dev_password@127.0.0.1:5438/visionguard";
const faceEmbeddingProvider = process.env.FACE_EMBEDDING_PROVIDER || "hybrid";
const faceEmbeddingUrl = process.env.FACE_EMBEDDING_URL || "http://127.0.0.1:8091/embed";
const streamGatewayUrl = (process.env.STREAM_GATEWAY_URL || "http://127.0.0.1:1984").replace(/\/+$/, "");
const publicStreamGatewayUrl = (process.env.PUBLIC_STREAM_GATEWAY_URL || "http://localhost:1984").replace(/\/+$/, "");
const businessTimezone = process.env.BUSINESS_TIMEZONE || "Asia/Dubai";
const pythonCommand = process.env.PYTHON || "python";
const ffmpegCommand = process.env.FFMPEG_BIN || "ffmpeg";
let lastFaceRetentionRunDate = "";

const pool = new Pool({ connectionString: databaseUrl });
const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8"
};

async function ensureDb() {
  await mkdir(reportsDir, { recursive: true });
  const schema = await readFile(schemaPath, "utf8");
  await pool.query(schema);
  await backfillEmbeddingVectors();
  await normalizeTrainedFaceIdentities();
  await backfillAreaDwellFromVisits();
  await backfillPersonTracks();
}

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: businessTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function yesterday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: businessTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(Date.now() - 86_400_000));
}

function sendJson(res, status, data) {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function notFound(res) {
  sendJson(res, 404, { message: "Endpoint not found" });
}

function id(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function visitorCode(index = 0) {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `VIS-${date}-${Date.now().toString().slice(-5)}${String(index + 1).padStart(2, "0")}`;
}

function parseDataUrl(dataUrl = "") {
  const match = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Expected a base64 data URL image.");
  return { mime: match[1], buffer: Buffer.from(match[2], "base64") };
}

async function buildFaceEmbedding(face, faceImage) {
  const sourceEmbedding = Array.isArray(face.embedding) ? face.embedding.map(Number) : [];
  if (faceEmbeddingProvider !== "browser" && faceImage?.buffer) {
    const service = await runFaceServiceEmbedder(faceImage).catch(() => null);
    if (service?.embedding?.length) {
      return {
        sourceEmbedding: service.embedding,
        vector: normalizeVector(service.embedding, 512),
        model: service.model || "insightface-service"
      };
    }
    const insight = await runInsightFaceEmbedder(faceImage).catch(() => null);
    if (insight?.embedding?.length) {
      return {
        sourceEmbedding: insight.embedding,
        vector: normalizeVector(insight.embedding, 512),
        model: insight.model || "insightface"
      };
    }
  }
  return {
    sourceEmbedding,
    vector: normalizeVector(sourceEmbedding, 512),
    model: faceEmbeddingProvider === "browser" ? "browser-lightweight" : "browser-lightweight-fallback"
  };
}

async function runFaceServiceEmbedder(faceImage) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.FACE_EMBEDDING_TIMEOUT_MS || 4500));
  try {
    const response = await fetch(faceEmbeddingUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mime: faceImage.mime,
        imageBase64: faceImage.buffer.toString("base64")
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Face service ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function runInsightFaceEmbedder(faceImage) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonCommand, [embedderPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("InsightFace embedder timeout"));
    }, Number(process.env.FACE_EMBEDDING_TIMEOUT_MS || 4500));
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr || `InsightFace embedder exited ${code}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify({
      mime: faceImage.mime,
      imageBase64: faceImage.buffer.toString("base64")
    }));
  });
}

function normalizeVector(values = [], dimensions = 512) {
  const clean = values.map((value) => Number(value || 0)).filter((value) => Number.isFinite(value));
  const vector = Array.from({ length: dimensions }, (_, index) => clean.length ? clean[index % clean.length] : 0);
  const magnitude = Math.sqrt(vector.reduce((total, value) => total + (value * value), 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

function vectorLiteral(values = []) {
  return `[${normalizeVector(values, 512).join(",")}]`;
}

async function resolveTrainingPerson({ label, category, status, personId }) {
  if (personId) return personId;
  if (status !== "trained" || !label) return null;
  const existing = await one("SELECT id FROM people WHERE lower(name) = lower($1) LIMIT 1", [label]);
  if (existing?.id) return existing.id;
  const personCategory = ["staff", "employee", "customer", "visitor", "watchlist"].includes(category) ? category : "visitor";
  const personStatus = personCategory === "watchlist" ? "watch" : "authorized";
  const person = await one(
    `INSERT INTO people (id, name, category, department, access_level, status, face_status, last_seen)
     VALUES ($1, $2, $3, $4, $5, $6, 'enrolled', now()) RETURNING id`,
    [id("p"), label, personCategory, personCategory === "staff" || personCategory === "employee" ? "Operations" : "", personCategory === "visitor" ? "visitor" : "standard", personStatus]
  );
  await audit("person_auto_created", label);
  return person.id;
}

function identityResultForCategory(category = "visitor") {
  if (category === "staff" || category === "employee") return "employee";
  if (category === "customer") return "customer";
  if (category === "watchlist") return "watchlist";
  if (category === "unknown") return "unknown";
  return "known";
}

function isReliableFaceMatch(match = {}) {
  if (!match) return false;
  const score = Number(match.score || 0);
  const model = String(match.embeddingModel || "").toLowerCase();
  if (model.includes("browser")) return score >= 0.985;
  return score >= 0.82;
}

function matchThresholdForModel(model = "") {
  return String(model).toLowerCase().includes("browser") ? 0.985 : 0.82;
}

function duplicateThresholdForModel(model = "") {
  return String(model).toLowerCase().includes("browser") ? 0.985 : 0.92;
}

function scoreFaceQualityDetailed(face = {}, camera = {}) {
  const box = face.box || {};
  const width = Number(box.width || 0);
  const height = Number(box.height || 0);
  const faceArea = Math.round(width * height);
  const minSize = Number(camera.minFaceSize || 48);
  const qualityThreshold = Number(camera.qualityThreshold || 45);
  const confidence = Number(face.confidence || 0);
  const sharpness = Number(face.sharpness || 0);
  const areaScore = Math.min(45, Math.round(faceArea / 1200));
  const sizeScore = Math.min(25, Math.round((Math.min(width, height) / Math.max(minSize, 1)) * 25));
  const sharpnessScore = sharpness ? Math.min(25, Math.round(sharpness / 4)) : 12;
  const qualityScore = Math.max(0, Math.min(100, Math.round((confidence * .35) + areaScore + sizeScore + sharpnessScore)));
  const reasons = [];
  if (Math.min(width, height) < minSize) reasons.push(`face smaller than ${minSize}px`);
  if (confidence < 55) reasons.push("low detector confidence");
  if (sharpness && sharpness < 28) reasons.push("blurred face crop");
  if (qualityScore < qualityThreshold) reasons.push(`quality ${qualityScore}% below ${qualityThreshold}%`);
  return {
    accepted: reasons.length === 0,
    qualityScore,
    faceArea,
    blurScore: sharpness ? Math.max(0, Math.min(100, 100 - Math.round(sharpness))) : 0,
    status: reasons.length ? "low-quality" : "usable",
    reason: reasons.join("; ")
  };
}

function camel(row = {}) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()),
    value instanceof Date ? value.toISOString() : value
  ]));
}

async function rows(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows.map(camel);
}

async function one(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] ? camel(result.rows[0]) : null;
}

async function audit(action, detail, actor = "Security Admin") {
  await pool.query(
    "INSERT INTO audit_logs (id, action, detail, actor) VALUES ($1, $2, $3, $4)",
    [id("log"), action, detail || "", actor]
  );
}

async function backfillEmbeddingVectors() {
  const result = await pool.query("SELECT id, embedding FROM detected_faces WHERE embedding_vector IS NULL AND jsonb_array_length(embedding) > 0 LIMIT 500");
  for (const row of result.rows) {
    const embedding = Array.isArray(row.embedding) ? row.embedding : [];
    await pool.query(
      "UPDATE detected_faces SET embedding_vector = $2::vector, embedding_dim = 512 WHERE id = $1",
      [row.id, vectorLiteral(embedding)]
    );
  }
}

async function normalizeTrainedFaceIdentities() {
  await pool.query(`
    UPDATE detected_faces f
    SET matched_person_id = COALESCE(f.matched_person_id, f.person_id),
        match_score = GREATEST(COALESCE(f.match_score, 0), 1),
        identity_result = CASE
          WHEN f.category IN ('staff', 'employee') THEN 'employee'
          WHEN f.category = 'customer' THEN 'customer'
          WHEN f.category = 'watchlist' THEN 'watchlist'
          WHEN f.category = 'unknown' THEN 'unknown'
          ELSE 'known'
        END,
        quality_status = 'usable',
        quality_score = GREATEST(COALESCE(f.quality_score, 0), 100),
        updated_at = now()
    WHERE f.status = 'trained'
      AND f.person_id IS NOT NULL
      AND (f.identity_result IN ('pending', 'unknown') OR f.matched_person_id IS NULL OR COALESCE(f.match_score, 0) < 1)
  `);
}

async function backfillAreaDwellFromVisits() {
  await pool.query(`
    INSERT INTO area_dwell_sessions (id, person_id, visitor_label, camera_id, site_id, area_name, category, first_seen, last_seen, detection_count)
    SELECT
      'dwell-backfill-' || md5(COALESCE(v.person_id, '') || COALESCE(v.camera_id, '') || v.created_at::date::text),
      v.person_id,
      COALESCE(p.name, f.label, v.note, 'Unknown visitor'),
      v.camera_id,
      v.site_id,
      COALESCE(cam.zone, cam.name, 'Unassigned area'),
      COALESCE(v.category, f.category, 'visitor'),
      min(v.created_at),
      max(v.created_at),
      count(*)::integer
    FROM identity_visits v
    LEFT JOIN detected_faces f ON f.id = v.face_id
    LEFT JOIN people p ON p.id = v.person_id
    LEFT JOIN cameras cam ON cam.id = v.camera_id
    WHERE v.camera_id IS NOT NULL
    GROUP BY v.person_id, COALESCE(p.name, f.label, v.note, 'Unknown visitor'), v.camera_id, v.site_id,
             COALESCE(cam.zone, cam.name, 'Unassigned area'), COALESCE(v.category, f.category, 'visitor'), v.created_at::date
    ON CONFLICT (id) DO NOTHING
  `);
}

async function backfillPersonTracks() {
  await pool.query(`
    INSERT INTO person_tracks (
      id, person_id, visitor_label, cluster_id, camera_id, site_id, category, identity_result,
      status, first_seen, last_seen, best_face_id, best_score, detection_count, match_score
    )
    SELECT
      'trk-backfill-' || f.id,
      COALESCE(f.person_id, f.matched_person_id),
      COALESCE(p.name, mp.name, f.label, 'Unknown visitor'),
      COALESCE(COALESCE(f.person_id, f.matched_person_id), 'cluster-backfill-' || f.id),
      f.camera_id,
      cam.site_id,
      COALESCE(f.category, 'visitor'),
      COALESCE(NULLIF(f.identity_result, 'pending'), 'unknown'),
      'active',
      f.created_at,
      COALESCE(f.updated_at, f.created_at),
      f.id,
      COALESCE(f.quality_score, 0),
      1,
      COALESCE(f.match_score, 0)
    FROM detected_faces f
    LEFT JOIN people p ON p.id = f.person_id
    LEFT JOIN people mp ON mp.id = f.matched_person_id
    LEFT JOIN cameras cam ON cam.id = f.camera_id
    WHERE f.face_image IS NOT NULL
      AND f.track_id IS NULL
    ON CONFLICT (id) DO NOTHING
  `);
  await pool.query(`
    UPDATE detected_faces
    SET track_id = 'trk-backfill-' || id,
        cluster_id = COALESCE(COALESCE(person_id, matched_person_id), 'cluster-backfill-' || id),
        face_area = GREATEST(face_area, ((COALESCE((box->>'width')::numeric, 0) * COALESCE((box->>'height')::numeric, 0)))::integer),
        save_reason = COALESCE(NULLIF(save_reason, ''), 'backfilled-best-face'),
        updated_at = now()
    WHERE track_id IS NULL
      AND face_image IS NOT NULL
  `);
}

async function readDashboardData() {
  const [sites, cameras, people, vehicles, rules, events, attendance, visits] = await Promise.all([
    rows("SELECT * FROM sites ORDER BY created_at DESC"),
    rows("SELECT * FROM cameras ORDER BY created_at DESC"),
    rows("SELECT * FROM people ORDER BY created_at DESC"),
    rows("SELECT * FROM vehicles ORDER BY created_at DESC"),
    rows("SELECT * FROM rules ORDER BY created_at DESC"),
    rows("SELECT * FROM events ORDER BY created_at DESC LIMIT 200"),
    rows("SELECT * FROM attendance ORDER BY attendance_date DESC, created_at DESC"),
    rows("SELECT * FROM identity_visits ORDER BY created_at DESC LIMIT 200")
  ]);
  return { sites, cameras: cameras.map(enrichCameraStream), people, vehicles, rules, events, attendance, visits };
}

function cameraAlias(camera = {}) {
  const raw = String(camera.streamAlias || "").trim();
  if (raw) return raw;
  return `cam-${String(camera.id || camera.name || "stream").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function isGatewayPlayable(streamUrl = "") {
  return /^(rtsp|rtsps|http|https):\/\//i.test(String(streamUrl || ""));
}

function cameraStatusFromSource(camera = {}) {
  const streamUrl = String(camera.streamUrl || "").trim();
  if (String(camera.status || "").toLowerCase() === "disabled") return "disabled";
  if (isGatewayPlayable(streamUrl)) return "online";
  if (streamUrl.startsWith("local://")) return "local-only";
  return "offline";
}

function captureCameraFrame(camera = {}) {
  const streamUrl = String(camera.streamUrl || "").trim();
  if (!isGatewayPlayable(streamUrl)) throw new Error("Selected camera does not have an RTSP/HTTP stream URL.");
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-rtsp_transport", "tcp",
      "-i", streamUrl,
      "-frames:v", "1",
      "-q:v", "3",
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "pipe:1"
    ];
    const child = spawn(ffmpegCommand, args, { windowsHide: true });
    const chunks = [];
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out while capturing RTSP frame. Check stream URL, network, and camera credentials."));
    }, Number(process.env.RTSP_FRAME_TIMEOUT_MS || 12000));
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not run ffmpeg for RTSP capture: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const buffer = Buffer.concat(chunks);
      if (code !== 0 || !buffer.length) {
        reject(new Error(stderr.trim() || `ffmpeg exited ${code} without a frame.`));
        return;
      }
      resolve(buffer);
    });
  });
}

function enrichCameraStream(camera = {}) {
  const alias = cameraAlias(camera);
  const streamUrl = String(camera.streamUrl || "");
  const playable = isGatewayPlayable(streamUrl) && camera.gatewayEnabled !== false;
  const src = encodeURIComponent(alias);
  const status = cameraStatusFromSource(camera);
  return {
    ...camera,
    status,
    health: status === "online" || status === "local-only" ? Number(camera.health || 0) : 0,
    streamAlias: alias,
    gatewayUrl: streamGatewayUrl,
    publicGatewayUrl: publicStreamGatewayUrl,
    playable,
    hlsUrl: playable ? `${publicStreamGatewayUrl}/api/stream.m3u8?src=${src}` : "",
    webrtcPageUrl: playable ? `${publicStreamGatewayUrl}/stream.html?src=${src}` : "",
    mjpegUrl: playable ? `${publicStreamGatewayUrl}/api/frame.jpeg?src=${src}` : "",
    streamStatus: playable ? "gateway-ready" : streamUrl ? "local-or-unsupported" : "no-stream"
  };
}

async function gatewayRequest(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.STREAM_GATEWAY_TIMEOUT_MS || 3500));
  try {
    const response = await fetch(`${streamGatewayUrl}${path}`, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = text;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function syncGatewayStream(camera = {}) {
  const streamUrl = String(camera.streamUrl || "").trim();
  const enabled = camera.gatewayEnabled !== false;
  if (!enabled || !isGatewayPlayable(streamUrl)) {
    return { cameraId: camera.id, alias: cameraAlias(camera), skipped: true, reason: streamUrl ? "unsupported" : "missing stream url" };
  }
  const alias = cameraAlias(camera);
  const params = new URLSearchParams({ name: alias, src: streamUrl });
  const result = await gatewayRequest(`/api/streams?${params.toString()}`, { method: "PUT" });
  return { cameraId: camera.id, alias, streamUrl, ...result };
}

async function syncAllGatewayStreams() {
  const cameras = await rows("SELECT * FROM cameras ORDER BY created_at DESC");
  const results = [];
  for (const camera of cameras) {
    try {
      results.push(await syncGatewayStream(camera));
    } catch (error) {
      results.push({ cameraId: camera.id, alias: cameraAlias(camera), ok: false, message: error.message });
    }
  }
  return results;
}

function summarize(data) {
  const open = data.events.filter((event) => event.status === "open");
  const critical = open.filter((event) => event.severity === "critical").length;
  const online = data.cameras.filter((camera) => camera.status === "online").length;
  const openPpe = open.filter((event) => event.type.startsWith("ppe")).length;
  return {
    camerasOnline: online,
    camerasTotal: data.cameras.length,
    openAlerts: open.length,
    criticalAlerts: critical,
    enrolledFaces: data.people.filter((person) => person.faceStatus === "enrolled").length,
    attendanceToday: data.attendance.filter((item) => String(item.attendanceDate).slice(0, 10) === today()).length,
    ppeCompliance: data.events.length ? Math.max(0, 100 - openPpe * 9) : 0,
    vehicleEvents: data.events.filter((event) => event.type === "vehicle-plate").length,
    identityVisits: data.visits?.length || 0,
    unknownFaces: data.visits?.filter((visit) => visit.identityResult === "unknown").length || 0
  };
}

async function readLiveSummary() {
  const businessDate = today();
  const result = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM cameras WHERE status = 'online') AS cameras_online,
      (SELECT count(*)::int FROM cameras) AS cameras_total,
      (SELECT count(*)::int FROM events WHERE status = 'open') AS open_alerts,
      (SELECT count(*)::int FROM events WHERE status = 'open' AND severity = 'critical') AS critical_alerts,
      (SELECT count(*)::int FROM people WHERE face_status = 'enrolled') AS enrolled_faces,
      (SELECT count(*)::int FROM attendance WHERE attendance_date = $1::date) AS attendance_today,
      (SELECT count(*)::int FROM events WHERE type = 'vehicle-plate') AS vehicle_events,
      (SELECT count(*)::int FROM identity_visits) AS identity_visits,
      (SELECT count(DISTINCT COALESCE(v.person_id, f.label, v.note, v.id))::int
         FROM identity_visits v
         LEFT JOIN detected_faces f ON f.id = v.face_id
         WHERE (v.created_at AT TIME ZONE $2)::date = $1::date) AS unique_visits_today,
      (SELECT count(DISTINCT COALESCE(v.person_id, f.label, v.note, v.id))::int
         FROM identity_visits v
         LEFT JOIN detected_faces f ON f.id = v.face_id
         WHERE (v.created_at AT TIME ZONE $2)::date = $1::date AND v.category IN ('staff', 'employee')) AS staff_visits_today,
      (SELECT count(DISTINCT COALESCE(v.person_id, f.label, v.note, v.id))::int
         FROM identity_visits v
         LEFT JOIN detected_faces f ON f.id = v.face_id
         WHERE (v.created_at AT TIME ZONE $2)::date = $1::date AND COALESCE(v.category, 'visitor') NOT IN ('staff', 'employee')) AS visitor_visits_today,
      (SELECT count(*)::int FROM identity_visits WHERE (created_at AT TIME ZONE $2)::date = $1::date) AS movement_events_today,
      (SELECT count(*)::int FROM identity_visits WHERE identity_result = 'unknown') AS unknown_faces,
      (SELECT count(*)::int FROM detected_faces) AS detected_faces,
      (SELECT count(*)::int FROM detected_faces WHERE status NOT IN ('trained', 'matched') AND COALESCE(person_id, matched_person_id) IS NULL) AS current_detections,
      (SELECT count(*)::int FROM events WHERE status = 'open' AND type LIKE 'ppe%') AS open_ppe_alerts
  `, [businessDate, businessTimezone]);
  const row = camel(result.rows[0] || {});
  return {
    camerasOnline: Number(row.camerasOnline || 0),
    camerasTotal: Number(row.camerasTotal || 0),
    openAlerts: Number(row.openAlerts || 0),
    criticalAlerts: Number(row.criticalAlerts || 0),
    enrolledFaces: Number(row.enrolledFaces || 0),
    attendanceToday: Number(row.attendanceToday || 0),
    vehicleEvents: Number(row.vehicleEvents || 0),
    identityVisits: Number(row.identityVisits || 0),
    uniqueVisitsToday: Number(row.uniqueVisitsToday || 0),
    staffVisitsToday: Number(row.staffVisitsToday || 0),
    visitorVisitsToday: Number(row.visitorVisitsToday || 0),
    movementEventsToday: Number(row.movementEventsToday || 0),
    unknownFaces: Number(row.unknownFaces || 0),
    detectedFaces: Number(row.detectedFaces || 0),
    currentDetections: Number(row.currentDetections || 0),
    ppeCompliance: Number(row.openPpeAlerts || 0) ? Math.max(0, 100 - Number(row.openPpeAlerts || 0) * 9) : 100
  };
}

function enrichEvents(data, source = data.events) {
  return source.map((event) => ({
    ...event,
    camera: data.cameras.find((camera) => camera.id === event.cameraId) || null,
    person: data.people.find((person) => person.id === event.personId) || null,
    vehicle: data.vehicles.find((vehicle) => vehicle.id === event.vehicleId) || null,
    snapshot: event.snapshot || `/api/snapshot/${event.id}`
  }));
}

async function handleApi(req, res, url) {
  const path = url.pathname;
  if (req.method === "GET" && path === "/api/health") {
    await pool.query("SELECT 1");
    return sendJson(res, 200, { ok: true, database: "postgresql", at: new Date().toISOString() });
  }

  if (req.method === "GET" && path === "/api/dashboard") {
    const [data, summary] = await Promise.all([readDashboardData(), readLiveSummary()]);
    return sendJson(res, 200, {
      summary,
      ...data,
      events: enrichEvents(data).slice(0, 20)
    });
  }

  if (req.method === "GET" && path === "/api/pipeline") {
    return sendJson(res, 200, {
      stages: [
        { key: "stream", name: "Camera stream", status: "ready", detail: "Laptop/RTSP/DVR camera frames are accepted." },
        { key: "person", name: "Human detection", status: "ready", detail: "Capture pipeline stores frame candidates; Python worker hook prepared for YOLO." },
        { key: "face", name: "Face detection", status: "ready", detail: "Native FaceDetector or BlazeFace draws real face boxes; no face means no save." },
        { key: "quality", name: "Face quality check", status: "ready", detail: "Quality score is calculated before matching." },
        { key: "embedding", name: "InsightFace embedding", status: "ready", detail: "Docker Face AI returns 512D ArcFace vectors; browser vector is fallback." },
        { key: "match", name: "pgvector identity matching", status: "ready", detail: "Nearest-neighbor vector search across all trained face samples." },
        { key: "classify", name: "Classification", status: "ready", detail: "Employee/customer/visitor/watchlist/blocked routing." },
        { key: "event", name: "Event and visit log", status: "ready", detail: "Creates alerts, visit history, and attendance events." }
      ]
    });
  }

  if (req.method === "GET" && path === "/api/face-ai/status") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(faceEmbeddingUrl.replace(/\/embed$/, "/health"), { signal: controller.signal });
      const status = response.ok ? await response.json() : { ok: false, status: response.status };
      return sendJson(res, 200, { ok: response.ok, provider: "insightface-service", url: faceEmbeddingUrl, status });
    } catch (error) {
      return sendJson(res, 200, { ok: false, provider: "fallback", url: faceEmbeddingUrl, message: error.message });
    } finally {
      clearTimeout(timer);
    }
  }

  if (req.method === "POST" && path === "/api/faces/retention/run") {
    const body = await readBody(req);
    const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? body.date : yesterday();
    return sendJson(res, 200, await runDailyFaceRetention(targetDate));
  }

  if (req.method === "GET" && path === "/api/sites") {
    return sendJson(res, 200, { sites: await rows("SELECT * FROM sites ORDER BY created_at DESC") });
  }
  if (req.method === "POST" && path === "/api/sites") {
    const body = await readBody(req);
    const site = await one(
      "INSERT INTO sites (id, name, address, status) VALUES ($1, $2, $3, $4) RETURNING *",
      [id("site"), body.name, body.address || "", body.status || "active"]
    );
    await audit("site_created", site.name);
    return sendJson(res, 201, { site });
  }

  if (req.method === "GET" && path === "/api/cameras") {
    const [cameras, sites] = await Promise.all([
      rows("SELECT * FROM cameras ORDER BY created_at DESC"),
      rows("SELECT * FROM sites ORDER BY created_at DESC")
    ]);
    return sendJson(res, 200, { cameras: cameras.map(enrichCameraStream), sites });
  }
  if (req.method === "POST" && path === "/api/cameras") {
    const body = await readBody(req);
    const cameraId = id("cam");
    const streamUrl = String(body.streamUrl || "").trim();
    const alias = String(body.streamAlias || "").trim()
      || `cam-${String(body.name || cameraId).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
    const camera = await one(
      `INSERT INTO cameras (id, name, site_id, zone, stream_url, camera_role, stream_alias, gateway_enabled, stream_mode, status, fps, health, ai_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $9, 20, 90, TRUE) RETURNING *`,
      [cameraId, body.name, body.siteId || null, body.zone || "", streamUrl, body.cameraRole || "area", alias, body.streamMode || "hls", isGatewayPlayable(streamUrl) ? "online" : streamUrl.startsWith("local://") ? "local-only" : "offline"]
    );
    await audit("camera_created", camera.name);
    const streamSync = await syncGatewayStream(camera).catch((error) => ({ ok: false, message: error.message }));
    return sendJson(res, 201, { camera: enrichCameraStream(camera), streamSync });
  }

  if (req.method === "PATCH" && path.startsWith("/api/cameras/")) {
    const cameraId = decodeURIComponent(path.split("/").pop());
    const body = await readBody(req);
    const nextStreamUrl = typeof body.streamUrl === "string" ? body.streamUrl.trim() : null;
    const camera = await one(
      `UPDATE cameras
       SET name = COALESCE($2, name),
           site_id = COALESCE($3, site_id),
           zone = COALESCE($4, zone),
           stream_url = COALESCE($5, stream_url),
           stream_alias = COALESCE($6, stream_alias),
           camera_role = COALESCE($7, camera_role),
           min_face_size = COALESCE($8, min_face_size),
           quality_threshold = COALESCE($9, quality_threshold),
           detection_interval_ms = COALESCE($10, detection_interval_ms),
           recognition_threshold = COALESCE($11, recognition_threshold),
           retention_days = COALESCE($12, retention_days),
           blur_untrusted = COALESCE($13, blur_untrusted),
           status = CASE
             WHEN COALESCE($5, stream_url) ~* '^(rtsp|rtsps|http|https)://' THEN 'online'
             WHEN COALESCE($5, stream_url) LIKE 'local://%' THEN 'local-only'
             ELSE 'offline'
           END,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        cameraId,
        body.name || null,
        body.siteId || null,
        body.zone || null,
        nextStreamUrl,
        body.streamAlias || null,
        body.cameraRole || null,
        Number.isFinite(Number(body.minFaceSize)) ? Number(body.minFaceSize) : null,
        Number.isFinite(Number(body.qualityThreshold)) ? Number(body.qualityThreshold) : null,
        Number.isFinite(Number(body.detectionIntervalMs)) ? Number(body.detectionIntervalMs) : null,
        Number.isFinite(Number(body.recognitionThreshold)) ? Number(body.recognitionThreshold) : null,
        Number.isFinite(Number(body.retentionDays)) ? Number(body.retentionDays) : null,
        typeof body.blurUntrusted === "boolean" ? body.blurUntrusted : null
      ]
    );
    if (!camera) return sendJson(res, 404, { message: "Camera not found" });
    await audit("camera_tuning_updated", camera.name);
    const streamSync = await syncGatewayStream(camera).catch((error) => ({ ok: false, message: error.message }));
    return sendJson(res, 200, { camera: enrichCameraStream(camera), streamSync });
  }

  if (req.method === "DELETE" && path.startsWith("/api/cameras/")) {
    const cameraId = decodeURIComponent(path.split("/").pop());
    const camera = await one("DELETE FROM cameras WHERE id = $1 RETURNING *", [cameraId]);
    if (!camera) return sendJson(res, 404, { message: "Camera not found" });
    await audit("camera_deleted", camera.name);
    await syncAllGatewayStreams().catch(() => []);
    return sendJson(res, 200, { cameraId, message: "Camera deleted" });
  }

  if (req.method === "GET" && path === "/api/privacy") {
    const policy = await one("SELECT * FROM privacy_policies WHERE id = 'default' LIMIT 1");
    return sendJson(res, 200, { policy });
  }

  if (req.method === "PUT" && path === "/api/privacy") {
    const body = await readBody(req);
    const policy = await one(
      `UPDATE privacy_policies
       SET retention_days = $1,
           delete_untrained_after_days = $2,
           blur_unknown = $3,
           allow_export = $4,
           consent_required = $5,
           updated_at = now()
       WHERE id = 'default'
       RETURNING *`,
      [
        Math.max(1, Number(body.retentionDays || 30)),
        Math.max(1, Number(body.deleteUntrainedAfterDays || 7)),
        Boolean(body.blurUnknown),
        body.allowExport !== false,
        Boolean(body.consentRequired)
      ]
    );
    await audit("privacy_policy_updated", "Default face privacy policy updated");
    return sendJson(res, 200, { policy });
  }

  if (req.method === "GET" && path === "/api/streams/health") {
    try {
      const result = await gatewayRequest("/api");
      return sendJson(res, 200, { ok: result.ok, gatewayUrl: streamGatewayUrl, status: result.status, api: result.data });
    } catch (error) {
      return sendJson(res, 200, { ok: false, gatewayUrl: streamGatewayUrl, message: error.message });
    }
  }

  if (req.method === "GET" && path === "/api/streams") {
    try {
      const result = await gatewayRequest("/api/streams");
      return sendJson(res, 200, { ok: result.ok, gatewayUrl: streamGatewayUrl, status: result.status, streams: result.data || {} });
    } catch (error) {
      return sendJson(res, 200, { ok: false, gatewayUrl: streamGatewayUrl, message: error.message, streams: {} });
    }
  }

  if (req.method === "POST" && path === "/api/streams/sync") {
    const results = await syncAllGatewayStreams();
    const failed = results.filter((item) => item.ok === false);
    await audit("streams_synced", `${results.length} camera stream(s), ${failed.length} failed`);
    return sendJson(res, 200, {
      ok: failed.length === 0,
      gatewayUrl: streamGatewayUrl,
      total: results.length,
      synced: results.filter((item) => item.ok).length,
      skipped: results.filter((item) => item.skipped).length,
      failed: failed.length,
      results
    });
  }

  if (req.method === "GET" && path === "/api/captures") {
    const captures = await rows(`
      SELECT c.id, c.camera_id, c.source, c.image_mime, c.width, c.height, c.face_count, c.created_at,
             cam.name AS camera_name
      FROM camera_captures c
      LEFT JOIN cameras cam ON cam.id = c.camera_id
      ORDER BY c.created_at DESC
      LIMIT 50
    `);
    return sendJson(res, 200, { captures });
  }

  if (req.method === "GET" && path.startsWith("/api/captures/") && path.endsWith("/image")) {
    const captureId = decodeURIComponent(path.split("/")[3]);
    const result = await pool.query("SELECT image_mime, image_data FROM camera_captures WHERE id = $1", [captureId]);
    if (!result.rows[0]) return sendJson(res, 404, { message: "Capture not found" });
    res.writeHead(200, { "content-type": result.rows[0].image_mime || "image/jpeg" });
    return res.end(result.rows[0].image_data);
  }

  if (req.method === "GET" && path.startsWith("/api/cameras/") && path.endsWith("/frame")) {
    const cameraId = decodeURIComponent(path.split("/")[3]);
    const camera = await one("SELECT * FROM cameras WHERE id = $1", [cameraId]);
    if (!camera) return sendJson(res, 404, { message: "Camera not found" });
    try {
      const frame = await captureCameraFrame(camera);
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "no-store"
      });
      return res.end(frame);
    } catch (error) {
      return sendJson(res, 502, { message: error.message || "Could not capture camera frame" });
    }
  }

  if (req.method === "POST" && path === "/api/captures") {
    const body = await readBody(req);
    const image = parseDataUrl(body.imageData);
    const captureId = id("cap");
    const faces = Array.isArray(body.faces) ? body.faces : [];
    const captureCamera = body.cameraId ? await one("SELECT * FROM cameras WHERE id = $1", [body.cameraId]) : null;
    const capture = await one(
      `INSERT INTO camera_captures (id, camera_id, source, image_mime, image_data, width, height, face_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, camera_id, source, image_mime, width, height, face_count, created_at`,
      [captureId, body.cameraId || null, body.source || "local-camera", image.mime, image.buffer, Number(body.width || 0), Number(body.height || 0), faces.length]
    );
    const savedFaces = [];
    const skippedFaces = [];
    for (const [index, face] of faces.entries()) {
      const faceImage = face.imageData ? parseDataUrl(face.imageData) : null;
      const label = String(face.label || "").trim() || visitorCode(index);
      const quality = scoreFaceQualityDetailed(face, captureCamera || {});
      if (!quality.accepted) {
        const embeddingResult = await buildFaceEmbedding(face, faceImage);
        const trainedMatch = await findBestVectorMatch(null, embeddingResult.vector);
        const matched = isReliableFaceMatch(trainedMatch) ? trainedMatch : null;
        const track = await getOrCreatePersonTrack({
          camera: captureCamera,
          matched,
          embedding: embeddingResult.vector,
          modelName: embeddingResult.model,
          fallbackLabel: label,
          qualityScore: quality.qualityScore
        });
        const reviewLabel = matched?.name || track?.visitorLabel || label;
        const reviewCategory = matched?.category || track?.category || face.category || "visitor";
        const reviewIdentity = matched ? identityResultForCategory(matched.category) : (track?.identityResult || "pending");
        const reviewFace = await one(
          `INSERT INTO detected_faces (
             id, capture_id, camera_id, person_id, matched_person_id, label, category, status, confidence,
             box, embedding, embedding_vector, embedding_model, embedding_dim, face_mime, face_image,
             match_score, identity_result, quality_status, quality_score, track_id, cluster_id, face_area,
             blur_score, save_reason, low_quality_reason
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'review', $8, $9::jsonb, $10::jsonb, $11::vector, $12, $13, $14, $15,
                   $16, $17, $18, $19, $20, $21, $22, $23, 'low-quality-review', $24)
           RETURNING id, capture_id, camera_id, person_id, matched_person_id, label, category, status, confidence,
                     box, embedding, embedding_vector, embedding_model, embedding_dim, face_mime, match_score,
                     identity_result, quality_status, quality_score, track_id, cluster_id, face_area, blur_score,
                     save_reason, low_quality_reason, created_at, updated_at`,
          [
            id("face"),
            captureId,
            body.cameraId || null,
            matched?.personId || null,
            matched?.personId || null,
            reviewLabel,
            reviewCategory,
            Number(face.confidence || 0),
            JSON.stringify(face.box || {}),
            JSON.stringify(embeddingResult.sourceEmbedding),
            vectorLiteral(embeddingResult.vector),
            embeddingResult.model,
            embeddingResult.vector.length,
            faceImage?.mime || "image/jpeg",
            faceImage?.buffer || null,
            matched?.score || track?.matchScore || 0,
            reviewIdentity,
            quality.status,
            quality.qualityScore,
            track?.id || null,
            track?.clusterId || null,
            quality.faceArea,
            quality.blurScore,
            quality.reason || ""
          ]
        );
        skippedFaces.push({
          label,
          reason: "low-quality-face",
          qualityScore: quality.qualityScore,
          detail: quality.reason,
          savedForReview: true,
          faceId: reviewFace.id
        });
        await recordAreaPresence({
          cameraId: body.cameraId || null,
          personId: matched?.personId || null,
          visitorLabel: reviewFace.label,
          category: reviewFace.category || "visitor"
        });
        await one(
          `INSERT INTO identity_visits (id, face_id, person_id, camera_id, site_id, category, identity_result, event_id, match_score, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9) RETURNING *`,
          [
            id("visit"),
            reviewFace.id,
            matched?.personId || null,
            body.cameraId || null,
            captureCamera?.siteId || null,
            reviewFace.category || "visitor",
            reviewIdentity,
            matched?.score || track?.matchScore || 0,
            matched ? `Recognized ${matched.name}; low-quality review: ${quality.reason || "needs camera tuning"}` : `Low quality review: ${quality.reason || "needs camera tuning"}`
          ]
        );
        savedFaces.push({ ...reviewFace, imageUrl: `/api/faces/${reviewFace.id}/image` });
        continue;
      }
      const embeddingResult = await buildFaceEmbedding(face, faceImage);
      const trainedMatch = await findBestVectorMatch(null, embeddingResult.vector);
      const matched = isReliableFaceMatch(trainedMatch) ? trainedMatch : null;
      const track = await getOrCreatePersonTrack({
        camera: captureCamera,
        matched,
        embedding: embeddingResult.vector,
        modelName: embeddingResult.model,
        fallbackLabel: label,
        qualityScore: quality.qualityScore
      });
      if (matched) {
        await recordAreaPresence({
          cameraId: body.cameraId || null,
          personId: matched.personId,
          visitorLabel: matched.name,
          category: matched.category || "visitor"
        });
        const recentKnown = await findRecentFaceForPerson(matched.personId, 45);
        if (recentKnown) {
          skippedFaces.push({
            label: matched.name,
            reason: "trained-person-already-tracked",
            personId: matched.personId,
            trackId: track?.id,
            matchScore: matched.score
          });
          continue;
        }
      }
      const recentDuplicate = await findRecentDuplicateFace(embeddingResult.vector, 15);
      if (recentDuplicate?.score >= duplicateThresholdForModel(embeddingResult.model)) {
        skippedFaces.push({
          label: track?.visitorLabel || recentDuplicate.label || "Recent face",
          reason: "recent-duplicate",
          faceId: recentDuplicate.id,
          trackId: track?.id || recentDuplicate.trackId || null,
          matchScore: recentDuplicate.score
        });
        continue;
      }
      const identityResult = track?.identityResult || (matched ? identityResultForCategory(matched.category) : "unknown");
      const saveCategory = matched?.category || track?.category || face.category || "visitor";
      const saveStatus = matched ? "matched" : (face.status || "untrained");
      const savedFace = await one(
        `INSERT INTO detected_faces (
           id, capture_id, camera_id, person_id, matched_person_id, label, category, status, confidence,
           box, embedding, embedding_vector, embedding_model, embedding_dim, face_mime, face_image,
           match_score, identity_result, quality_status, quality_score, track_id, cluster_id, face_area,
           blur_score, save_reason, low_quality_reason
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::vector, $13, $14, $15, $16,
                 $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
         RETURNING id, capture_id, camera_id, person_id, matched_person_id, label, category, status, confidence,
                   box, embedding, embedding_vector, embedding_model, embedding_dim, face_mime, match_score,
                   identity_result, quality_status, quality_score, track_id, cluster_id, face_area, blur_score,
                   save_reason, low_quality_reason, created_at, updated_at`,
        [
          id("face"),
          captureId,
          body.cameraId || null,
          matched?.personId || null,
          matched?.personId || null,
          matched?.name || track?.visitorLabel || label,
          saveCategory,
          saveStatus,
          Number(face.confidence || 0),
          JSON.stringify(face.box || {}),
          JSON.stringify(embeddingResult.sourceEmbedding),
          vectorLiteral(embeddingResult.vector),
          embeddingResult.model,
          embeddingResult.vector.length,
          faceImage?.mime || "image/jpeg",
          faceImage?.buffer || null,
          matched?.score || track?.matchScore || 0,
          identityResult,
          quality.status,
          quality.qualityScore,
          track?.id || null,
          track?.clusterId || null,
          quality.faceArea,
          quality.blurScore,
          matched ? "matched-known-face" : "best-track-face",
          quality.reason || ""
        ]
      );
      await updateTrackBestFace(track?.id, savedFace);
      await recordAreaPresence({
        cameraId: body.cameraId || null,
        personId: matched?.personId || null,
        visitorLabel: matched?.name || track?.visitorLabel || savedFace.label,
        category: saveCategory
      });
      await one(
        `INSERT INTO identity_visits (id, face_id, person_id, camera_id, site_id, category, identity_result, event_id, match_score, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9) RETURNING *`,
        [
          id("visit"),
          savedFace.id,
          matched?.personId || null,
          body.cameraId || null,
          captureCamera?.siteId || null,
          saveCategory,
          identityResult,
          matched?.score || track?.matchScore || 0,
          identityResult === "unknown" ? `Tracked ${track?.visitorLabel || savedFace.label}` : `Matched ${matched?.name || savedFace.label}`
        ]
      );
      if (identityResult === "employee" && matched?.personId) {
        await upsertAttendance(matched.personId, captureCamera?.siteId || null);
      }
      if (identityResult === "blocked" || identityResult === "watchlist") {
        await one(
          `INSERT INTO events (id, type, title, severity, camera_id, person_id, status, confidence, snapshot)
           VALUES ($1, 'watchlist-face', $2, 'critical', $3, $4, 'open', $5, $6) RETURNING *`,
          [id("e"), `Watchlist match: ${matched?.name || savedFace.label}`, body.cameraId || null, matched?.personId || null, Math.round((matched?.score || 0) * 100), `/api/faces/${savedFace.id}/image`]
        );
      }
      savedFaces.push({ ...savedFace, imageUrl: `/api/faces/${savedFace.id}/image` });
    }
    await audit("camera_capture_saved", `${capture.id} with ${savedFaces.length} face(s), skipped ${skippedFaces.length}`);
    return sendJson(res, 201, { capture, faces: savedFaces, skippedFaces });
  }

  if (req.method === "GET" && path === "/api/people") {
    return sendJson(res, 200, {
      people: await rows("SELECT * FROM people ORDER BY created_at DESC"),
      faces: await readDetectedFaces()
    });
  }
  if (req.method === "POST" && path === "/api/people") {
    const body = await readBody(req);
    const person = await one(
      `INSERT INTO people (id, name, category, department, access_level, status, face_status, last_seen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING *`,
      [id("p"), body.name, body.category || "employee", body.department || "", body.accessLevel || "standard", body.status || "authorized", body.faceStatus || "enrolled"]
    );
    await audit("face_enrolled", person.name);
    return sendJson(res, 201, { person });
  }

  if (req.method === "GET" && path === "/api/faces") {
    return sendJson(res, 200, { faces: await readDetectedFaces() });
  }

  if (req.method === "GET" && path === "/api/face-days") {
    return sendJson(res, 200, { days: await readFaceDays() });
  }

  if (req.method === "GET" && path === "/api/person-tracks") {
    const tracks = await rows(`
      SELECT t.*, p.name AS person_name, p.status AS person_status, p.watchlist_reason,
             cam.name AS camera_name, cam.zone AS area_name, f.label AS best_face_label
      FROM person_tracks t
      LEFT JOIN people p ON p.id = t.person_id
      LEFT JOIN cameras cam ON cam.id = t.camera_id
      LEFT JOIN detected_faces f ON f.id = t.best_face_id
      ORDER BY t.last_seen DESC
      LIMIT 150
    `);
    return sendJson(res, 200, { tracks });
  }

  if (req.method === "POST" && path === "/api/faces/merge") {
    const body = await readBody(req);
    const sourceFace = await one("SELECT * FROM detected_faces WHERE id = $1", [body.sourceFaceId]);
    const targetFace = await one("SELECT * FROM detected_faces WHERE id = $1", [body.targetFaceId]);
    if (!sourceFace || !targetFace) return sendJson(res, 404, { message: "Source or target face not found" });
    const targetPersonId = targetFace.personId || targetFace.matchedPersonId || await resolveTrainingPerson({
      label: targetFace.label,
      category: targetFace.category,
      status: "trained",
      personId: null
    });
    await one(
      `UPDATE detected_faces
       SET person_id = $2,
           matched_person_id = $2,
           label = $3,
           category = $4,
           status = 'trained',
           identity_result = $5,
           match_score = 1,
           quality_status = 'usable',
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [sourceFace.id, targetPersonId, targetFace.label, targetFace.category, identityResultForCategory(targetFace.category)]
    );
    await pool.query("UPDATE person_tracks SET person_id = $2, visitor_label = $3, identity_result = $4, updated_at = now() WHERE best_face_id = $1 OR id = $5", [
      sourceFace.id,
      targetPersonId,
      targetFace.label,
      identityResultForCategory(targetFace.category),
      sourceFace.trackId || ""
    ]);
    await one(
      `INSERT INTO face_merge_audit (id, source_face_id, target_face_id, source_label, target_label, action, note)
       VALUES ($1, $2, $3, $4, $5, 'merge', $6) RETURNING *`,
      [id("merge"), sourceFace.id, targetFace.id, sourceFace.label || "", targetFace.label || "", body.note || ""]
    );
    await audit("face_merged", `${sourceFace.label || sourceFace.id} -> ${targetFace.label || targetFace.id}`);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && path === "/api/faces/split") {
    const body = await readBody(req);
    const face = await one("SELECT * FROM detected_faces WHERE id = $1", [body.faceId]);
    if (!face) return sendJson(res, 404, { message: "Face not found" });
    const newLabel = String(body.label || "").trim() || visitorCode();
    const updated = await one(
      `UPDATE detected_faces
       SET person_id = NULL,
           matched_person_id = NULL,
           label = $2,
           category = 'visitor',
           status = 'untrained',
           identity_result = 'unknown',
           match_score = 0,
           track_id = NULL,
           cluster_id = NULL,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [face.id, newLabel]
    );
    await one(
      `INSERT INTO face_merge_audit (id, source_face_id, source_label, target_label, action, note)
       VALUES ($1, $2, $3, $4, 'split', $5) RETURNING *`,
      [id("merge"), face.id, face.label || "", newLabel, body.note || ""]
    );
    await audit("face_split", `${face.label || face.id} -> ${newLabel}`);
    return sendJson(res, 200, { face: { ...updated, imageUrl: `/api/faces/${updated.id}/image` } });
  }

  if (req.method === "POST" && path === "/api/faces/process") {
    const body = await readBody(req);
    const processed = await processPendingFaces(body.captureId || null);
    return sendJson(res, 200, processed);
  }

  if (req.method === "GET" && path.startsWith("/api/faces/") && path.endsWith("/image")) {
    const faceId = decodeURIComponent(path.split("/")[3]);
    const result = await pool.query("SELECT face_mime, face_image FROM detected_faces WHERE id = $1", [faceId]);
    if (!result.rows[0] || !result.rows[0].face_image) return sendJson(res, 404, { message: "Face image not found" });
    res.writeHead(200, { "content-type": result.rows[0].face_mime || "image/jpeg" });
    return res.end(result.rows[0].face_image);
  }

  if (req.method === "PATCH" && path.startsWith("/api/faces/")) {
    const faceId = decodeURIComponent(path.split("/").pop());
    const body = await readBody(req);
    const label = String(body.label || "").trim();
    const category = body.category || null;
    const status = body.status || null;
    const personId = await resolveTrainingPerson({ label, category, status, personId: body.personId || null });
    const trainedIdentityResult = status === "trained" && personId ? identityResultForCategory(category) : null;
    const updated = await one(
      `UPDATE detected_faces
       SET label = COALESCE($2, label),
           category = COALESCE($3, category),
           status = COALESCE($4, status),
           person_id = COALESCE($5, person_id),
           matched_person_id = CASE WHEN $4 = 'trained' AND $5 IS NOT NULL THEN $5 ELSE matched_person_id END,
           match_score = CASE WHEN $4 = 'trained' AND $5 IS NOT NULL THEN 1 ELSE match_score END,
           identity_result = COALESCE($6, identity_result),
           quality_status = CASE WHEN $4 = 'trained' THEN 'usable' ELSE quality_status END,
           quality_score = CASE WHEN $4 = 'trained' THEN GREATEST(quality_score, 100) ELSE quality_score END,
           updated_at = now()
       WHERE id = $1
       RETURNING id, capture_id, camera_id, person_id, matched_person_id, label, category, status, confidence,
                 box, embedding, embedding_vector, embedding_model, embedding_dim, face_mime, match_score,
                 identity_result, quality_status, quality_score, created_at, updated_at`,
      [faceId, label || null, category, status, personId, trainedIdentityResult]
    );
    if (!updated) return sendJson(res, 404, { message: "Detected face not found" });
    if (personId) {
      await pool.query(`
        UPDATE person_tracks
        SET person_id = $2,
            visitor_label = $3,
            category = $4,
            identity_result = $5,
            status = 'active',
            best_face_id = COALESCE(best_face_id, $1),
            updated_at = now()
        WHERE id = $6 OR best_face_id = $1
      `, [updated.id, personId, updated.label, updated.category, trainedIdentityResult || identityResultForCategory(updated.category), updated.trackId || ""]);
    }
    await audit("face_classified", `${updated.id} -> ${updated.category} / ${updated.status}`);
    return sendJson(res, 200, { face: { ...updated, imageUrl: `/api/faces/${updated.id}/image` } });
  }

  if (req.method === "DELETE" && path.startsWith("/api/faces/")) {
    const faceId = decodeURIComponent(path.split("/").pop());
    const existing = await one("SELECT id, label FROM detected_faces WHERE id = $1", [faceId]);
    if (!existing) return sendJson(res, 404, { message: "Detected face not found" });
    await pool.query("DELETE FROM identity_visits WHERE face_id = $1", [faceId]);
    await pool.query("DELETE FROM events WHERE snapshot = $1", [`/api/faces/${faceId}/image`]);
    await pool.query("DELETE FROM detected_faces WHERE id = $1", [faceId]);
    await audit("face_deleted", existing.label || faceId);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && path === "/api/faces/search") {
    const body = await readBody(req);
    const queryEmbedding = Array.isArray(body.embedding) ? body.embedding : [];
    const faces = await readDetectedFaces(250);
    const results = faces
      .map((face) => ({ ...face, similarity: cosineSimilarity(queryEmbedding, Array.isArray(face.embedding) ? face.embedding : []) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 20);
    return sendJson(res, 200, { results });
  }

  if (req.method === "POST" && path === "/api/forensics/face-search") {
    const body = await readBody(req);
    return sendJson(res, 200, await searchFaceEvidence(body));
  }

  if (req.method === "GET" && path === "/api/visits") {
    return sendJson(res, 200, { visits: await readIdentityVisits() });
  }

  if (req.method === "GET" && path === "/api/vehicles") {
    const data = await readDashboardData();
    return sendJson(res, 200, { vehicles: data.vehicles, events: enrichEvents(data).filter((event) => event.vehicleId) });
  }
  if (req.method === "POST" && path === "/api/vehicles") {
    const body = await readBody(req);
    const vehicle = await one(
      "INSERT INTO vehicles (id, plate, owner, type, status, last_seen) VALUES ($1, $2, $3, $4, $5, now()) RETURNING *",
      [id("v"), body.plate, body.owner || "", body.type || "", body.status || "registered"]
    );
    await audit("vehicle_created", vehicle.plate);
    return sendJson(res, 201, { vehicle });
  }

  if (req.method === "GET" && path === "/api/rules") {
    const [rules, cameras] = await Promise.all([
      rows("SELECT * FROM rules ORDER BY created_at DESC"),
      rows("SELECT * FROM cameras ORDER BY created_at DESC")
    ]);
    return sendJson(res, 200, { rules, cameras });
  }
  if (req.method === "POST" && path === "/api/rules") {
    const body = await readBody(req);
    const rule = await one(
      `INSERT INTO rules (id, name, type, camera_id, severity, schedule, enabled, action)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7) RETURNING *`,
      [id("r"), body.name, body.type, body.cameraId || null, body.severity || "medium", body.schedule || "always", body.action || "notify"]
    );
    await audit("rule_created", rule.name);
    return sendJson(res, 201, { rule });
  }

  if (req.method === "GET" && path === "/api/events") {
    const data = await readDashboardData();
    return sendJson(res, 200, { events: enrichEvents(data) });
  }
  if (req.method === "PATCH" && path.startsWith("/api/events/")) {
    const eventId = decodeURIComponent(path.split("/").pop());
    const body = await readBody(req);
    const updated = await one(
      `UPDATE events SET status = COALESCE($2, status), acknowledged_by = COALESCE($3, acknowledged_by),
       note = COALESCE($4, note), updated_at = now() WHERE id = $1 RETURNING *`,
      [eventId, body.status || null, body.acknowledgedBy || null, body.note || null]
    );
    if (!updated) return sendJson(res, 404, { message: "Event not found" });
    await audit("event_updated", `${updated.title} -> ${updated.status}`);
    return sendJson(res, 200, { event: updated });
  }

  if (req.method === "POST" && path === "/api/simulate-event") {
    const data = await readDashboardData();
    if (!data.cameras.length) return sendJson(res, 400, { message: "Add at least one real camera before generating AI events." });
    const generated = await createAiEvent(data, Object.fromEntries(url.searchParams));
    await audit("ai_event_generated", generated.title);
    const fresh = await readDashboardData();
    return sendJson(res, 201, { event: enrichEvents(fresh, [generated])[0] });
  }

  if (req.method === "GET" && path === "/api/attendance") {
    const [attendance, people, sites] = await Promise.all([
      rows("SELECT * FROM attendance ORDER BY attendance_date DESC, created_at DESC"),
      rows("SELECT * FROM people ORDER BY created_at DESC"),
      rows("SELECT * FROM sites ORDER BY created_at DESC")
    ]);
    return sendJson(res, 200, { attendance, people, sites });
  }

  if (req.method === "GET" && path === "/api/forensics") {
    const q = String(url.searchParams.get("q") || "").toLowerCase();
    const data = await readDashboardData();
    const events = enrichEvents(data).filter((event) => JSON.stringify(event).toLowerCase().includes(q));
    return sendJson(res, 200, { query: q, results: events });
  }

  if (req.method === "GET" && path === "/api/analytics") {
    return sendJson(res, 200, buildAnalytics(await readDashboardData()));
  }

  if (req.method === "GET" && path === "/api/area-traffic") {
    return sendJson(res, 200, await readAreaTraffic(url.searchParams.get("date") || today()));
  }

  if (req.method === "POST" && path === "/api/reports/incident") {
    const body = await readBody(req);
    return sendJson(res, 201, await createIncidentReport(await readDashboardData(), body.eventId));
  }

  if (req.method === "GET" && path === "/api/audit") {
    return sendJson(res, 200, { audit: await rows("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100") });
  }

  if (req.method === "GET" && path.startsWith("/api/snapshot/")) return sendSnapshot(res, decodeURIComponent(path.split("/").pop()));
  return notFound(res);
}

async function readDetectedFaces(limit = 100) {
  const faces = await rows(`
    WITH ranked_faces AS (
      SELECT f.*,
             COALESCE(f.person_id, f.matched_person_id, NULL) AS identity_person_key,
             COALESCE(f.person_id, f.matched_person_id, f.label) AS identity_key,
             row_number() OVER (
               PARTITION BY COALESCE(f.person_id, f.matched_person_id, f.label)
               ORDER BY
                 CASE WHEN f.face_image IS NOT NULL THEN 1 ELSE 0 END DESC,
                 COALESCE(f.quality_score, 0) DESC,
                 COALESCE(f.confidence, 0) DESC,
                 ((COALESCE((f.box->>'width')::numeric, 0) * COALESCE((f.box->>'height')::numeric, 0))) DESC,
                 f.created_at DESC
             ) AS identity_rank
      FROM detected_faces f
      WHERE f.face_image IS NOT NULL
    )
    SELECT f.id, f.capture_id, f.camera_id, f.person_id, f.matched_person_id, f.label, f.category, f.status, f.confidence,
           f.box, f.embedding, f.embedding_model, f.embedding_dim, f.face_mime, f.match_score, f.identity_result, f.quality_status, f.quality_score,
           f.track_id, f.cluster_id, f.face_area, f.blur_score, f.save_reason, f.low_quality_reason,
           f.created_at, f.updated_at, c.source, c.width, c.height, cam.name AS camera_name,
           p.name AS person_name, mp.name AS matched_person_name, mp.category AS matched_person_category
    FROM ranked_faces f
    LEFT JOIN camera_captures c ON c.id = f.capture_id
    LEFT JOIN cameras cam ON cam.id = f.camera_id
    LEFT JOIN people p ON p.id = f.person_id
    LEFT JOIN people mp ON mp.id = f.matched_person_id
    WHERE f.identity_rank = 1
    ORDER BY f.created_at DESC
    LIMIT $1
  `, [limit]);
  return faces.map((face) => ({ ...face, imageUrl: `/api/faces/${face.id}/image` }));
}

async function readFaceDays(limit = 14) {
  const dwell = await rows(`
    WITH best_faces AS (
      SELECT DISTINCT ON (COALESCE(f.person_id, f.matched_person_id, f.label))
        COALESCE(f.person_id, f.matched_person_id, f.label) AS identity_key,
        f.id AS face_id,
        COALESCE(p.name, mp.name, f.label) AS display_name
      FROM detected_faces f
      LEFT JOIN people p ON p.id = f.person_id
      LEFT JOIN people mp ON mp.id = f.matched_person_id
      WHERE f.face_image IS NOT NULL
      ORDER BY COALESCE(f.person_id, f.matched_person_id, f.label),
               COALESCE(f.quality_score, 0) DESC,
               f.created_at DESC
    )
    SELECT
      (d.first_seen AT TIME ZONE $2)::date AS day,
      COALESCE(d.person_id, d.visitor_label) AS identity_key,
      d.person_id,
      d.visitor_label,
      COALESCE(p.name, bf.display_name, d.visitor_label) AS display_name,
      d.category,
      d.area_name,
      d.camera_id,
      cam.name AS camera_name,
      min(d.first_seen) AS first_seen,
      max(d.last_seen) AS last_seen,
      sum(d.detection_count)::integer AS detection_count,
      sum(GREATEST(EXTRACT(EPOCH FROM (d.last_seen - d.first_seen))::integer, d.detection_count * 5))::integer AS seconds_spent,
      max(bf.face_id) AS face_id
    FROM area_dwell_sessions d
    LEFT JOIN people p ON p.id = d.person_id
    LEFT JOIN best_faces bf ON bf.identity_key = COALESCE(d.person_id, d.visitor_label)
    LEFT JOIN cameras cam ON cam.id = d.camera_id
    WHERE (d.first_seen AT TIME ZONE $2)::date >= (now() AT TIME ZONE $2)::date - ($1::text || ' days')::interval
    GROUP BY (d.first_seen AT TIME ZONE $2)::date, COALESCE(d.person_id, d.visitor_label), d.person_id, d.visitor_label,
             COALESCE(p.name, bf.display_name, d.visitor_label), d.category, d.area_name, d.camera_id, cam.name
    ORDER BY day DESC, first_seen ASC
  `, [String(limit), businessTimezone]);
  const byDay = new Map();
  for (const row of dwell) {
    const day = row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, { date: day, people: [] });
    const dayEntry = byDay.get(day);
    let person = dayEntry.people.find((item) => item.identityKey === row.identityKey);
    if (!person) {
      person = {
        identityKey: row.identityKey,
        personId: row.personId,
        visitorLabel: row.visitorLabel,
        displayName: row.displayName,
        category: row.category,
        firstSeen: row.firstSeen,
        lastSeen: row.lastSeen,
        detectionCount: 0,
        totalSeconds: 0,
        imageUrl: row.faceId ? `/api/faces/${row.faceId}/image` : "",
        areas: []
      };
      dayEntry.people.push(person);
    }
    person.firstSeen = new Date(row.firstSeen) < new Date(person.firstSeen) ? row.firstSeen : person.firstSeen;
    person.lastSeen = new Date(row.lastSeen) > new Date(person.lastSeen) ? row.lastSeen : person.lastSeen;
    person.detectionCount += Number(row.detectionCount || 0);
    person.totalSeconds += Number(row.secondsSpent || 0);
    person.areas.push({
      areaName: row.areaName || row.cameraName || "Unassigned area",
      cameraName: row.cameraName,
      cameraId: row.cameraId,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      detectionCount: Number(row.detectionCount || 0),
      secondsSpent: Number(row.secondsSpent || 0)
    });
  }
  return [...byDay.values()].map((day) => {
    day.people.forEach((person) => {
      person.areaCount = new Set(person.areas.map((area) => area.areaName)).size;
      person.areas.sort((a, b) => Number(b.secondsSpent || 0) - Number(a.secondsSpent || 0));
    });
    day.people.sort((a, b) => Number(b.totalSeconds || 0) - Number(a.totalSeconds || 0));
    day.peopleCount = day.people.length;
    day.areaCount = new Set(day.people.flatMap((person) => person.areas.map((area) => area.areaName))).size;
    day.detectionCount = day.people.reduce((total, person) => total + Number(person.detectionCount || 0), 0);
    day.totalSeconds = day.people.reduce((total, person) => total + Number(person.totalSeconds || 0), 0);
    return day;
  });
}

async function readIdentityVisits(limit = 100) {
  return await rows(`
    SELECT v.*, p.name AS person_name, cam.name AS camera_name, s.name AS site_name
    FROM identity_visits v
    LEFT JOIN people p ON p.id = v.person_id
    LEFT JOIN cameras cam ON cam.id = v.camera_id
    LEFT JOIN sites s ON s.id = v.site_id
    ORDER BY v.created_at DESC
    LIMIT $1
  `, [limit]);
}

function cosineSimilarity(a = [], b = []) {
  if (!a.length || !b.length) return 0;
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let index = 0; index < length; index += 1) {
    const av = Number(a[index] || 0);
    const bv = Number(b[index] || 0);
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  return magA && magB ? Number((dot / (Math.sqrt(magA) * Math.sqrt(magB))).toFixed(4)) : 0;
}

async function processPendingFaces(captureId = null) {
  const pending = await rows(`
    SELECT f.*, c.camera_id AS capture_camera_id, cam.site_id
    FROM detected_faces f
    LEFT JOIN camera_captures c ON c.id = f.capture_id
    LEFT JOIN cameras cam ON cam.id = COALESCE(f.camera_id, c.camera_id)
    WHERE ($1::text IS NULL OR f.capture_id = $1)
      AND f.identity_result = 'pending'
    ORDER BY f.created_at ASC
    LIMIT 50
  `, [captureId]);
  const processed = [];
  for (const face of pending) {
    const embedding = Array.isArray(face.embedding) ? face.embedding : [];
    const qualityScore = scoreFaceQuality(face);
    const best = await findBestVectorMatch(face.id, embedding);
    const matched = isReliableFaceMatch(best) ? best : null;
    const category = matched?.category || face.category || "visitor";
    const identityResult = matched
      ? matched.status === "blocked" ? "blocked"
        : matched.status === "watch" || category === "watchlist" ? "watchlist"
        : category === "employee" || category === "staff" ? "employee"
        : category === "customer" ? "customer"
        : "known"
      : "unknown";
    const eventTitle = titleForIdentity(identityResult, matched?.name || face.label || "Unknown person");
    const severity = identityResult === "blocked" || identityResult === "watchlist" ? "critical" : identityResult === "unknown" ? "medium" : "low";
    const eventRecord = await one(
      `INSERT INTO events (id, type, title, severity, camera_id, person_id, status, confidence, snapshot)
       VALUES ($1, 'face-identity', $2, $3, $4, $5, 'open', $6, $7) RETURNING *`,
      [id("e"), eventTitle, severity, face.cameraId || face.captureCameraId || null, matched?.personId || null, Math.round((matched?.score || 0) * 100), `/api/faces/${face.id}/image`]
    );
    const updatedFace = await one(
      `UPDATE detected_faces
       SET matched_person_id = $2, match_score = $3, identity_result = $4,
           quality_status = $5, quality_score = $6, status = CASE WHEN $4 = 'unknown' THEN status ELSE 'matched' END,
           updated_at = now()
       WHERE id = $1
       RETURNING id, capture_id, camera_id, person_id, matched_person_id, label, category, status, confidence,
                 box, embedding, face_mime, match_score, identity_result, quality_status, quality_score, created_at, updated_at`,
      [face.id, matched?.personId || null, matched?.score || 0, identityResult, qualityScore >= 50 ? "usable" : "low-quality", qualityScore]
    );
    const visit = await one(
      `INSERT INTO identity_visits (id, face_id, person_id, camera_id, site_id, category, identity_result, event_id, match_score, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [id("visit"), face.id, matched?.personId || null, face.cameraId || face.captureCameraId || null, face.siteId || null, category, identityResult, eventRecord.id, matched?.score || 0, eventTitle]
    );
    await recordAreaPresence({
      cameraId: face.cameraId || face.captureCameraId || null,
      personId: matched?.personId || null,
      visitorLabel: matched?.name || face.label || "Unknown visitor",
      category
    });
    if (identityResult === "employee" && matched?.personId) {
      await upsertAttendance(matched.personId, face.siteId || null);
    }
    processed.push({ face: { ...updatedFace, imageUrl: `/api/faces/${updatedFace.id}/image` }, event: eventRecord, visit });
  }
  await audit("faces_processed", `${processed.length} face(s) processed`);
  return { processedCount: processed.length, processed };
}

async function findBestVectorMatch(faceId, embedding) {
  const vector = vectorLiteral(embedding);
  return await one(`
    SELECT f.id, f.person_id, p.name, p.category, p.status, f.embedding_model,
           (1 - (f.embedding_vector <=> $2::vector))::numeric(6,4) AS score
    FROM detected_faces f
    JOIN people p ON p.id = COALESCE(f.person_id, f.matched_person_id)
    WHERE f.status = 'trained'
      AND f.embedding_vector IS NOT NULL
      AND COALESCE(f.person_id, f.matched_person_id) IS NOT NULL
      AND ($1::text IS NULL OR f.id <> $1)
    ORDER BY f.embedding_vector <=> $2::vector
    LIMIT 1
  `, [faceId, vector]);
}

async function findRecentFaceForPerson(personId, minutes = 45) {
  if (!personId) return null;
  return await one(`
    SELECT id, label, person_id, created_at
    FROM detected_faces
    WHERE COALESCE(person_id, matched_person_id) = $1
      AND created_at > now() - ($2::text || ' minutes')::interval
    ORDER BY created_at DESC
    LIMIT 1
  `, [personId, String(minutes)]);
}

async function findRecentDuplicateFace(embedding, minutes = 15) {
  const vector = vectorLiteral(embedding);
  return await one(`
    SELECT f.id, f.label, COALESCE(f.person_id, f.matched_person_id) AS person_id,
           f.track_id, f.cluster_id, f.embedding_model,
           (1 - (f.embedding_vector <=> $1::vector))::numeric(6,4) AS score
    FROM detected_faces f
    WHERE f.embedding_vector IS NOT NULL
      AND f.created_at > now() - ($2::text || ' minutes')::interval
    ORDER BY f.embedding_vector <=> $1::vector
    LIMIT 1
  `, [vector, String(minutes)]);
}

async function findDailyUnknownTrack(embedding, modelName = "") {
  const vector = vectorLiteral(embedding);
  const threshold = duplicateThresholdForModel(modelName);
  return await one(`
    SELECT t.*, f.embedding_model,
           (1 - (f.embedding_vector <=> $1::vector))::numeric(6,4) AS score
    FROM person_tracks t
    JOIN detected_faces f ON f.id = t.best_face_id
    WHERE t.person_id IS NULL
      AND t.status = 'active'
      AND f.embedding_vector IS NOT NULL
      AND (t.first_seen AT TIME ZONE $3)::date = $4::date
      AND (1 - (f.embedding_vector <=> $1::vector)) >= $2
    ORDER BY f.embedding_vector <=> $1::vector, t.last_seen DESC
    LIMIT 1
  `, [vector, threshold, businessTimezone, today()]);
}

async function getOrCreatePersonTrack({ camera = null, matched = null, embedding = [], modelName = "", fallbackLabel = "", qualityScore = 0 }) {
  const personId = matched?.personId || null;
  const label = matched?.name || fallbackLabel || visitorCode();
  const category = matched?.category || "visitor";
  const identityResult = matched
    ? matched.status === "blocked" ? "blocked"
      : matched.status === "watch" || category === "watchlist" ? "watchlist"
      : category === "employee" || category === "staff" ? "employee"
      : category === "customer" ? "customer"
      : "known"
    : "unknown";

  if (personId) {
    const existing = await one(`
      SELECT *
      FROM person_tracks
      WHERE person_id = $1
        AND COALESCE(camera_id, '') = COALESCE($2, '')
        AND last_seen > now() - interval '2 hours'
      ORDER BY last_seen DESC
      LIMIT 1
    `, [personId, camera?.id || null]);
    if (existing) {
      return await one(`
        UPDATE person_tracks
        SET last_seen = now(),
            detection_count = detection_count + 1,
            visitor_label = $2,
            category = $3,
            identity_result = $4,
            match_score = GREATEST(match_score, $5),
            best_score = GREATEST(best_score, $6),
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `, [existing.id, label, category, identityResult, Number(matched?.score || 0), qualityScore]);
    }
  } else {
    const dailyTrack = await findDailyUnknownTrack(embedding, modelName);
    if (dailyTrack) {
      return await one(`
        UPDATE person_tracks
        SET last_seen = now(),
            detection_count = detection_count + 1,
            best_score = GREATEST(best_score, $2),
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `, [dailyTrack.id, qualityScore]);
    }
  }

  const trackId = id("trk");
  const clusterId = personId || id("cluster");
  return await one(`
    INSERT INTO person_tracks (id, person_id, visitor_label, cluster_id, camera_id, site_id, category, identity_result, status, best_score, match_score)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10)
    RETURNING *
  `, [
    trackId,
    personId,
    label,
    clusterId,
    camera?.id || null,
    camera?.siteId || null,
    category,
    identityResult,
    qualityScore,
    Number(matched?.score || 0)
  ]);
}

async function updateTrackBestFace(trackId, face) {
  if (!trackId || !face?.id) return null;
  const current = await one("SELECT id, best_score FROM person_tracks WHERE id = $1", [trackId]);
  if (!current) return null;
  const score = Number(face.qualityScore || face.quality_score || 0);
  if (score < Number(current.bestScore || 0) && face.id !== current.bestFaceId) {
    await pool.query("UPDATE person_tracks SET last_seen = now(), updated_at = now() WHERE id = $1", [trackId]);
    return current;
  }
  return await one(`
    UPDATE person_tracks
    SET best_face_id = $2,
        best_score = GREATEST(best_score, $3),
        last_seen = now(),
        updated_at = now()
    WHERE id = $1
    RETURNING *
  `, [trackId, face.id, score]);
}

async function searchFaceEvidence(body = {}) {
  let vector = null;
  let sourceFace = null;
  if (body.faceId) {
    sourceFace = await one(`
      SELECT f.*, COALESCE(p.name, mp.name, f.label) AS display_name
      FROM detected_faces f
      LEFT JOIN people p ON p.id = f.person_id
      LEFT JOIN people mp ON mp.id = f.matched_person_id
      WHERE f.id = $1
      LIMIT 1
    `, [body.faceId]);
    if (!sourceFace) throw new Error("Selected face not found.");
    vector = vectorLiteral(Array.isArray(sourceFace.embedding) ? sourceFace.embedding : []);
  } else if (body.imageData) {
    const faceImage = parseDataUrl(body.imageData);
    const embeddingResult = await buildFaceEmbedding({ embedding: [] }, faceImage);
    vector = vectorLiteral(embeddingResult.vector);
  } else {
    throw new Error("Select a detected face or upload a face photo.");
  }

  const matches = await rows(`
    WITH ranked_matches AS (
      SELECT f.id, f.label, f.category, f.status, f.identity_result, f.match_score,
             f.created_at, f.quality_score, f.confidence, COALESCE(p.id, mp.id) AS person_id,
             COALESCE(p.name, mp.name, f.label) AS display_name,
             COALESCE(p.category, mp.category, f.category) AS person_category,
             cam.name AS camera_name, cam.zone AS area_name,
             (1 - (f.embedding_vector <=> $1::vector))::numeric(6,4) AS similarity,
             row_number() OVER (
               PARTITION BY COALESCE(p.id, mp.id, f.label)
               ORDER BY f.embedding_vector <=> $1::vector,
                        COALESCE(f.quality_score, 0) DESC,
                        COALESCE(f.confidence, 0) DESC,
                        f.created_at DESC
             ) AS identity_rank
      FROM detected_faces f
      LEFT JOIN people p ON p.id = f.person_id
      LEFT JOIN people mp ON mp.id = f.matched_person_id
      LEFT JOIN cameras cam ON cam.id = f.camera_id
      WHERE f.embedding_vector IS NOT NULL
        AND f.face_image IS NOT NULL
    )
    SELECT *
    FROM ranked_matches
    WHERE identity_rank = 1
    ORDER BY similarity DESC, quality_score DESC, confidence DESC
    LIMIT 20
  `, [vector]);

  const primary = matches[0] || sourceFace;
  const personId = primary?.personId || null;
  const visitorLabel = primary?.displayName || primary?.label || sourceFace?.displayName || "";
  const movement = await readPersonMovement({ personId, visitorLabel });
  return {
    source: sourceFace ? { id: sourceFace.id, label: sourceFace.displayName || sourceFace.label, imageUrl: `/api/faces/${sourceFace.id}/image` } : { label: "Uploaded photo" },
    primary,
    matches: matches.map((match) => ({ ...match, imageUrl: `/api/faces/${match.id}/image` })),
    movement
  };
}

async function readPersonMovement({ personId = null, visitorLabel = "" }) {
  const params = [personId, visitorLabel];
  const flow = await rows(`
    SELECT e.*, cam.name AS camera_name, cam.zone AS camera_zone, s.name AS site_name
    FROM person_flow_events e
    LEFT JOIN cameras cam ON cam.id = e.camera_id
    LEFT JOIN sites s ON s.id = e.site_id
    WHERE (($1::text IS NOT NULL AND e.person_id = $1::text)
       OR ($1::text IS NULL AND e.visitor_label = $2))
    ORDER BY e.created_at ASC
    LIMIT 200
  `, params);
  const dwell = await rows(`
    SELECT d.*, cam.name AS camera_name, s.name AS site_name,
           GREATEST(EXTRACT(EPOCH FROM (d.last_seen - d.first_seen))::integer, d.detection_count * 5) AS seconds_spent
    FROM area_dwell_sessions d
    LEFT JOIN cameras cam ON cam.id = d.camera_id
    LEFT JOIN sites s ON s.id = d.site_id
    WHERE (($1::text IS NOT NULL AND d.person_id = $1::text)
       OR ($1::text IS NULL AND d.visitor_label = $2))
    ORDER BY d.first_seen ASC
    LIMIT 200
  `, params);
  const entries = flow.filter((item) => item.flowDirection === "entry");
  const exits = flow.filter((item) => item.flowDirection === "exit");
  const firstEntry = entries[0] || flow[0] || null;
  const lastExit = exits[exits.length - 1] || flow[flow.length - 1] || null;
  const totalSeconds = dwell.reduce((total, item) => total + Number(item.secondsSpent || 0), 0);
  return { firstEntry, lastExit, totalSeconds, flow, dwell };
}

async function recordAreaPresence({ cameraId, personId = null, visitorLabel = "", category = "visitor" }) {
  if (!cameraId) return null;
  const camera = await one("SELECT id, site_id, name, zone, camera_role FROM cameras WHERE id = $1", [cameraId]);
  if (!camera) return null;
  const areaName = camera.zone || camera.name || "Unassigned area";
  const role = camera.cameraRole || "area";
  const safeLabel = String(visitorLabel || "").trim() || "Unknown visitor";
  const safeCategory = category === "employee" ? "staff" : category;

  const session = await one(`
    SELECT *
    FROM area_dwell_sessions
    WHERE camera_id = $1
      AND COALESCE(person_id::text, '') = COALESCE($2::text, '')
      AND visitor_label = $3
      AND last_seen > now() - interval '30 minutes'
    ORDER BY last_seen DESC
    LIMIT 1
  `, [camera.id, personId, safeLabel]);

  if (session) {
    await one(`
      UPDATE area_dwell_sessions
      SET last_seen = now(),
          detection_count = detection_count + 1,
          category = $2,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `, [session.id, safeCategory]);
  } else {
    await one(`
      INSERT INTO area_dwell_sessions (id, person_id, visitor_label, camera_id, site_id, area_name, category)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [id("dwell"), personId, safeLabel, camera.id, camera.siteId || null, areaName, safeCategory]);
  }

  if (role === "entry" || role === "exit") {
    const recentFlow = await one(`
      SELECT id
      FROM person_flow_events
      WHERE camera_id = $1
        AND flow_direction = $2
        AND COALESCE(person_id::text, '') = COALESCE($3::text, '')
        AND visitor_label = $4
        AND created_at > now() - interval '2 minutes'
      LIMIT 1
    `, [camera.id, role, personId, safeLabel]);
    if (!recentFlow) {
      await one(`
        INSERT INTO person_flow_events (id, person_id, visitor_label, camera_id, site_id, area_name, flow_direction, category, event_date)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_DATE)
        RETURNING *
      `, [id("flow"), personId, safeLabel, camera.id, camera.siteId || null, areaName, role, safeCategory]);
    }
  }
  return true;
}

async function readAreaTraffic(date = today()) {
  const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : today();
  const dwell = await rows(`
    SELECT d.id, d.person_id, COALESCE(p.name, d.visitor_label) AS display_name, d.visitor_label,
           d.category, d.area_name, d.camera_id, cam.name AS camera_name,
           d.first_seen, d.last_seen, d.detection_count,
           GREATEST(EXTRACT(EPOCH FROM (d.last_seen - d.first_seen))::integer, d.detection_count * 5) AS seconds_spent
    FROM area_dwell_sessions d
    LEFT JOIN people p ON p.id = d.person_id
    LEFT JOIN cameras cam ON cam.id = d.camera_id
    WHERE d.first_seen::date <= $1::date
      AND d.last_seen::date >= $1::date
    ORDER BY seconds_spent DESC, d.last_seen DESC
    LIMIT 80
  `, [targetDate]);
  const flow = await rows(`
    SELECT area_name, category, flow_direction, count(*)::integer AS count
    FROM person_flow_events
    WHERE event_date = $1::date
    GROUP BY area_name, category, flow_direction
    ORDER BY area_name, category, flow_direction
  `, [targetDate]);
  const byArea = {};
  flow.forEach((item) => {
    const area = item.areaName || "Unassigned area";
    const category = item.category || "visitor";
    byArea[area] ||= { areaName: area, staffIn: 0, staffOut: 0, visitorIn: 0, visitorOut: 0, totalIn: 0, totalOut: 0 };
    const isStaff = category === "staff" || category === "employee";
    const key = `${isStaff ? "staff" : "visitor"}${item.flowDirection === "exit" ? "Out" : "In"}`;
    byArea[area][key] += Number(item.count || 0);
    if (item.flowDirection === "exit") byArea[area].totalOut += Number(item.count || 0);
    else byArea[area].totalIn += Number(item.count || 0);
  });
  return { date: targetDate, dwell, flow, flowSummary: Object.values(byArea) };
}

async function runDailyFaceRetention(targetDate = yesterday()) {
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(targetDate)) ? String(targetDate) : yesterday();
  const faces = await rows(`
    SELECT f.id, f.label, f.category, f.status, f.confidence, f.box, f.embedding, f.quality_score,
           COALESCE(f.person_id, f.matched_person_id) AS identity_person_id,
           COALESCE(p.name, mp.name, f.label) AS display_name,
           f.created_at
    FROM detected_faces f
    LEFT JOIN people p ON p.id = f.person_id
    LEFT JOIN people mp ON mp.id = f.matched_person_id
    WHERE (f.created_at AT TIME ZONE $2)::date = $1::date
      AND f.face_image IS NOT NULL
    ORDER BY f.created_at ASC
  `, [safeDate, businessTimezone]);

  const clusters = [];
  for (const face of faces) {
    const embedding = Array.isArray(face.embedding) ? face.embedding : [];
    const personKey = face.identityPersonId ? `person:${face.identityPersonId}` : "";
    let cluster = personKey ? clusters.find((item) => item.key === personKey) : null;
    if (!cluster && embedding.length) {
      cluster = clusters.find((item) => !item.personKey && item.embedding?.length && cosineSimilarity(embedding, item.embedding) >= 0.9);
    }
    if (!cluster) {
      cluster = {
        key: personKey || `visitor:${clusters.length + 1}`,
        personKey,
        embedding,
        faces: []
      };
      clusters.push(cluster);
    }
    cluster.faces.push(face);
    if (!cluster.embedding?.length && embedding.length) cluster.embedding = embedding;
  }

  let deletedFaces = 0;
  let normalizedVisitorLabels = 0;
  const kept = [];
  for (const cluster of clusters) {
    const sorted = [...cluster.faces].sort((a, b) => faceRetentionScore(b) - faceRetentionScore(a));
    const best = sorted[0];
    if (!best) continue;
    kept.push(best);
    const duplicates = sorted.slice(1);
    for (const duplicate of duplicates) {
      await relinkFaceReferences(duplicate, best, safeDate);
      await pool.query("DELETE FROM detected_faces WHERE id = $1", [duplicate.id]);
      deletedFaces += 1;
      if (!best.identityPersonId && duplicate.label && duplicate.label !== best.label) normalizedVisitorLabels += 1;
    }
  }
  await audit("daily_face_retention", `${safeDate}: kept ${kept.length}, deleted ${deletedFaces}, normalized ${normalizedVisitorLabels}`);
  const privacy = await applyPrivacyRetention();
  return {
    date: safeDate,
    scannedFaces: faces.length,
    clusters: clusters.length,
    keptFaces: kept.length,
    deletedFaces,
    privacyClearedImages: privacy.clearedImages,
    normalizedVisitorLabels,
    message: `Daily face retention complete for ${safeDate}. Kept one best image per visitor/person and preserved movement history.`
  };
}

async function applyPrivacyRetention() {
  const policy = await one("SELECT * FROM privacy_policies WHERE id = 'default' LIMIT 1");
  const deleteAfterDays = Math.max(1, Number(policy?.deleteUntrainedAfterDays || 7));
  const retentionDays = Math.max(deleteAfterDays, Number(policy?.retentionDays || 30));
  const result = await pool.query(`
    UPDATE detected_faces
    SET face_image = NULL,
        save_reason = COALESCE(NULLIF(save_reason, ''), 'privacy-metadata-retained'),
        low_quality_reason = COALESCE(NULLIF(low_quality_reason, ''), 'Face image cleared by privacy retention policy'),
        updated_at = now()
    WHERE face_image IS NOT NULL
      AND (
        (status <> 'trained' AND created_at < now() - ($1::text || ' days')::interval)
        OR created_at < now() - ($2::text || ' days')::interval
      )
  `, [String(deleteAfterDays), String(retentionDays)]);
  if (result.rowCount) await audit("privacy_retention_applied", `${result.rowCount} old face image(s) cleared`);
  return { clearedImages: result.rowCount || 0 };
}

function faceRetentionScore(face = {}) {
  const box = face.box || {};
  const area = Number(box.width || 0) * Number(box.height || 0);
  return (Number(face.qualityScore || 0) * 10000)
    + (Number(face.confidence || 0) * 100)
    + Math.min(area, 9999);
}

async function relinkFaceReferences(duplicate, best, targetDate) {
  await pool.query("UPDATE identity_visits SET face_id = $2 WHERE face_id = $1", [duplicate.id, best.id]);
  await pool.query("UPDATE events SET snapshot = $2 WHERE snapshot = $1", [`/api/faces/${duplicate.id}/image`, `/api/faces/${best.id}/image`]);
  if (!best.identityPersonId && duplicate.label && best.label && duplicate.label !== best.label) {
    await pool.query(`
      UPDATE area_dwell_sessions
      SET visitor_label = $2,
          updated_at = now()
      WHERE visitor_label = $1
        AND first_seen::date <= $3::date
        AND last_seen::date >= $3::date
    `, [duplicate.label, best.label, targetDate]);
    await pool.query(`
      UPDATE person_flow_events
      SET visitor_label = $2
      WHERE visitor_label = $1
        AND event_date = $3::date
    `, [duplicate.label, best.label, targetDate]);
  }
}

function startFaceRetentionScheduler() {
  setInterval(async () => {
    const now = new Date();
    const currentDate = now.toISOString().slice(0, 10);
    if (now.getHours() !== 0 || now.getMinutes() < 5 || lastFaceRetentionRunDate === currentDate) return;
    lastFaceRetentionRunDate = currentDate;
    await runDailyFaceRetention(yesterday()).catch((error) => {
      console.error("Daily face retention failed:", error);
    });
  }, 60_000);
}

function scoreFaceQuality(face) {
  const box = face.box || {};
  const area = Number(box.width || 0) * Number(box.height || 0);
  const confidence = Number(face.confidence || 0);
  const areaScore = Math.min(50, Math.round(area / 1000));
  return Math.max(0, Math.min(100, confidence + areaScore));
}

function titleForIdentity(identityResult, name) {
  const labels = {
    employee: `Employee identified: ${name}`,
    customer: `Customer identified: ${name}`,
    known: `Known person identified: ${name}`,
    unknown: "Unknown person detected",
    watchlist: `Watchlist person detected: ${name}`,
    blocked: `Blocked person detected: ${name}`
  };
  return labels[identityResult] || "Face identity event";
}

async function upsertAttendance(personId, siteId) {
  const businessDate = today();
  const existing = await one("SELECT * FROM attendance WHERE person_id = $1 AND attendance_date = $2::date LIMIT 1", [personId, businessDate]);
  if (existing) return existing;
  return await one(
    "INSERT INTO attendance (id, person_id, site_id, attendance_date, check_in, status) VALUES ($1, $2, $3, $4::date, $5, 'present') RETURNING *",
    [id("a"), personId, siteId, businessDate, new Date().toTimeString().slice(0, 5)]
  );
}

async function createAiEvent(data, params = {}) {
  const types = ["unknown-face", "restricted-zone", "ppe-helmet", "vehicle-plate", "fire-smoke", "crowd", "tamper"];
  const type = params.type && types.includes(params.type) ? params.type : types[Math.floor(Math.random() * types.length)];
  const camera = data.cameras[Math.floor(Math.random() * data.cameras.length)];
  const person = type === "vehicle-plate" || !data.people.length ? null : data.people[Math.floor(Math.random() * data.people.length)];
  const vehicle = type === "vehicle-plate" && data.vehicles.length ? data.vehicles[Math.floor(Math.random() * data.vehicles.length)] : null;
  const titleMap = {
    "unknown-face": "Unknown face detected",
    "restricted-zone": "Restricted zone entry",
    "ppe-helmet": "Helmet missing in PPE zone",
    "vehicle-plate": "Vehicle plate event",
    "fire-smoke": "Possible smoke/fire signal",
    crowd: "Crowd density limit crossed",
    tamper: "Camera tampering suspected"
  };
  const severity = type === "restricted-zone" || type === "fire-smoke" ? "critical" : type === "ppe-helmet" ? "high" : "medium";
  return await one(
    `INSERT INTO events (id, type, title, severity, camera_id, person_id, vehicle_id, status, confidence, snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9) RETURNING *`,
    [id("e"), type, titleMap[type], severity, camera.id, person?.id || null, vehicle?.id || null, Math.floor(78 + Math.random() * 20), ""]
  );
}

function buildAnalytics(data) {
  const byType = {};
  const bySeverity = {};
  const byCamera = {};
  data.events.forEach((event) => {
    byType[event.type] = (byType[event.type] || 0) + 1;
    bySeverity[event.severity] = (bySeverity[event.severity] || 0) + 1;
    byCamera[event.cameraId || "unassigned"] = (byCamera[event.cameraId || "unassigned"] || 0) + 1;
  });
  return {
    summary: summarize(data),
    byType,
    bySeverity,
    byCamera,
    trends: Array.from({ length: 7 }, (_, index) => ({
      day: new Date(Date.now() - (6 - index) * 86_400_000).toISOString().slice(5, 10),
      alerts: Math.max(0, data.events.length ? Math.floor(data.events.length / 2 + Math.random() * 4) : 0),
      attendance: data.attendance.length,
      ppe: data.events.length ? summarize(data).ppeCompliance : 0
    }))
  };
}

async function createIncidentReport(data, eventId) {
  const item = enrichEvents(data).find((event) => event.id === eventId) || enrichEvents(data)[0];
  if (!item) throw new Error("No events available for report.");
  const site = data.sites.find((record) => record.id === item.camera?.siteId);
  const lines = [
    "VisionGuard AI Incident Report",
    `Generated: ${new Date().toISOString()}`,
    `Event ID: ${item.id}`,
    `Title: ${item.title}`,
    `Severity: ${item.severity}`,
    `Status: ${item.status}`,
    `Camera: ${item.camera?.name || item.cameraId || "N/A"}`,
    `Site: ${site?.name || "N/A"}`,
    `Person: ${item.person?.name || "N/A"}`,
    `Vehicle: ${item.vehicle?.plate || "N/A"}`,
    `Confidence: ${item.confidence}%`,
    "",
    "Recommended Action:",
    "- Verify the snapshot and camera timeline.",
    "- Assign owner and acknowledge the alert.",
    "- Escalate critical events to site security and management."
  ];
  const fileName = `${item.id}-incident-report.txt`;
  const path = join(reportsDir, fileName);
  await writeFile(path, lines.join("\n"), "utf8");
  return { fileName, path, content: lines.join("\n") };
}

function sendSnapshot(res, eventId) {
  const label = String(eventId || "event").toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="520"><defs><linearGradient id="g" x1="0" x2="1"><stop stop-color="#05111c"/><stop offset="1" stop-color="#163c43"/></linearGradient></defs><rect width="900" height="520" fill="url(#g)"/><rect x="55" y="55" width="790" height="410" rx="28" fill="#0b1724" stroke="#3be3d0" stroke-opacity=".55"/><circle cx="450" cy="230" r="82" fill="#f6c85f" opacity=".2"/><path d="M350 310 C410 170 500 170 560 310" fill="none" stroke="#3be3d0" stroke-width="16" stroke-linecap="round"/><text x="450" y="430" text-anchor="middle" fill="#eef6ff" font-size="32" font-family="Arial" font-weight="700">AI Evidence Snapshot ${label}</text></svg>`;
  res.writeHead(200, { "content-type": "image/svg+xml" });
  res.end(svg);
}

async function serveStatic(req, res, url) {
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204, { "cache-control": "public, max-age=86400" });
    res.end();
    return;
  }
  const safePath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = join(publicDir, safePath.replace(/^\/+/, ""));
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not file");
    res.writeHead(200, { "content-type": mime[extname(filePath)] || "application/octet-stream" });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, { message: error.message || "Server error" });
  }
});

await ensureDb();
server.listen(port, () => {
  console.log(`VisionGuard AI running at http://127.0.0.1:${port}`);
  startFaceRetentionScheduler();
  syncAllGatewayStreams()
    .then((results) => {
      const synced = results.filter((item) => item.ok).length;
      const failed = results.filter((item) => item.ok === false).length;
      console.log(`Stream gateway sync: ${synced}/${results.length} synced, ${failed} failed`);
    })
    .catch((error) => console.warn(`Stream gateway sync skipped: ${error.message}`));
});
