const { rows, one, isGatewayPlayable } = require("../utils/utils.js");
const { sendSnapshot } = require("../utils/faceEngine.js");
const pg = require("pg");

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL || "postgres://visionguard:visionguard_dev_password@127.0.0.1:5438/visionguard";
const businessTimezone = process.env.BUSINESS_TIMEZONE || "Asia/Dubai";
const streamGatewayUrl = (process.env.STREAM_GATEWAY_URL || "http://127.0.0.1:1984").replace(/\/+$/, "");
const publicStreamGatewayUrl = (process.env.PUBLIC_STREAM_GATEWAY_URL || "http://localhost:1984").replace(/\/+$/, "");
const pool = new Pool({ connectionString: databaseUrl });

function today() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: businessTimezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(new Date());
}
function cameraStatusFromSource(camera = {}) {
    const streamUrl = String(camera.streamUrl || "").trim();
    if (String(camera.status || "").toLowerCase() === "disabled") return "disabled";
    if (isGatewayPlayable(streamUrl)) return "online";
    if (streamUrl.startsWith("local://")) return "local-only";
    return "offline";
}
function cameraAlias(camera = {}) {
    const raw = String(camera.streamAlias || "").trim();
    if (raw) return raw;
    return `cam-${String(camera.id || camera.name || "stream").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}
function enrichCameraStream(camera = {}) {
    const alias = cameraAlias(camera);
    const streamUrl = String(camera.streamUrl || "");
    const playable = isGatewayPlayable(streamUrl) && camera.gatewayEnabled !== false;
    // Point browser playback at the dedicated "-web" stream (ffmpeg-transcoded to H.264),
    // not the raw camera alias — most NVRs here encode H.265, which hls.js/MSE can't decode.
    const src = encodeURIComponent(`${alias}-web`);
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
        webrtcUrl: playable ? `/api/streams/webrtc?src=${src}` : "",
        webrtcPageUrl: playable ? `${publicStreamGatewayUrl}/stream.html?src=${src}` : "",
        mjpegUrl: playable ? `${publicStreamGatewayUrl}/api/frame.jpeg?src=${src}` : "",
        streamStatus: playable ? "gateway-ready" : streamUrl ? "local-or-unsupported" : "no-stream"
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
async function readDashboardData() {
    const [sites, cameras, people, vehicles, rulesList, events, attendance, visits] = await Promise.all([
        rows("SELECT * FROM sites ORDER BY created_at DESC"),
        rows("SELECT * FROM cameras ORDER BY created_at DESC"),
        rows("SELECT * FROM people ORDER BY created_at DESC"),
        rows("SELECT * FROM vehicles ORDER BY created_at DESC"),
        rows("SELECT * FROM rules ORDER BY created_at DESC"),
        rows("SELECT * FROM events ORDER BY created_at DESC LIMIT 200"),
        rows("SELECT * FROM attendance ORDER BY attendance_date DESC, created_at DESC"),
        rows("SELECT * FROM identity_visits ORDER BY created_at DESC LIMIT 200")
    ]);
    return { sites, cameras: cameras.map(enrichCameraStream), people, vehicles, rules: rulesList, events, attendance, visits };
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
    const row = result.rows[0] || {};
    return {
        camerasOnline: Number(row.cameras_online || 0),
        camerasTotal: Number(row.cameras_total || 0),
        openAlerts: Number(row.open_alerts || 0),
        criticalAlerts: Number(row.critical_alerts || 0),
        enrolledFaces: Number(row.enrolled_faces || 0),
        attendanceToday: Number(row.attendance_today || 0),
        vehicleEvents: Number(row.vehicle_events || 0),
        identityVisits: Number(row.identity_visits || 0),
        uniqueVisitsToday: Number(row.unique_visits_today || 0),
        staffVisitsToday: Number(row.staff_visits_today || 0),
        visitorVisitsToday: Number(row.visitor_visits_today || 0),
        movementEventsToday: Number(row.movement_events_today || 0),
        unknownFaces: Number(row.unknown_faces || 0),
        detectedFaces: Number(row.detected_faces || 0),
        currentDetections: Number(row.current_detections || 0),
        ppeCompliance: Number(row.open_ppe_alerts || 0) ? Math.max(0, 100 - Number(row.open_ppe_alerts || 0) * 9) : 100
    };
}

exports.getHealth = async (req, res) => {
    const health = {
        ok: true,
        at: new Date().toISOString(),
        database: { type: "postgresql", connected: false }
    };
    try {
        await pool.query("SELECT 1");
        health.database.connected = true;
    } catch (error) {
        health.ok = false;
        health.database.error = error.message;
    }
    res.status(health.ok ? 200 : 503).json(health);
};

exports.getDashboard = async (req, res, next) => {
    try {
        const [data, summary] = await Promise.all([readDashboardData(), readLiveSummary()]);
        res.status(200).json({
            summary,
            ...data,
            events: enrichEvents(data).slice(0, 20)
        });
    } catch (error) {
        next(error);
    }
};

exports.getPipeline = async (req, res, next) => {
    try {
        res.status(200).json({
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
    } catch (error) {
        next(error);
    }
};

exports.getSnapshot = async (req, res, next) => {
    try {
        sendSnapshot(res, req.params.id);
    } catch (error) {
        next(error);
    }
};
