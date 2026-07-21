const { rows, one, audit, id, isGatewayPlayable, sendJson } = require("../utils/utils.js");
const streamGatewayUrl = process.env.STREAM_GATEWAY_URL.replace(/\/+$/, "");
const publicStreamGatewayUrl = process.env.PUBLIC_STREAM_GATEWAY_URL.replace(/\/+$/, "");
const businessTimezone = process.env.BUSINESS_TIMEZONE;

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
function enrichEvents(data, source = data.events) {
    return source.map((event) => ({
        ...event,
        camera: data.cameras.find((camera) => camera.id === event.cameraId) || null,
        person: data.people.find((person) => person.id === event.personId) || null,
        vehicle: data.vehicles.find((vehicle) => vehicle.id === event.vehicleId) || null,
        snapshot: event.snapshot || `/api/snapshot/${event.id}`
    }));
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
    const peopleMap = new Map();
    for (const row of dwell) {
        const identityKey = row.personId || row.visitorLabel || row.displayName || row.id;
        if (!peopleMap.has(identityKey)) {
            peopleMap.set(identityKey, {
                identityKey,
                personId: row.personId,
                displayName: row.displayName || row.visitorLabel || "Unknown visitor",
                visitorLabel: row.visitorLabel,
                category: row.category || "visitor",
                firstSeen: row.firstSeen,
                lastSeen: row.lastSeen,
                totalSeconds: 0,
                detectionCount: 0,
                areaCount: 0,
                areas: []
            });
        }
        const person = peopleMap.get(identityKey);
        person.firstSeen = new Date(row.firstSeen) < new Date(person.firstSeen) ? row.firstSeen : person.firstSeen;
        person.lastSeen = new Date(row.lastSeen) > new Date(person.lastSeen) ? row.lastSeen : person.lastSeen;
        person.totalSeconds += Number(row.secondsSpent || 0);
        person.detectionCount += Number(row.detectionCount || 0);
        person.areas.push({
            areaName: row.areaName || row.cameraName || "Unassigned area",
            cameraName: row.cameraName || row.areaName || "Camera",
            cameraId: row.cameraId,
            firstSeen: row.firstSeen,
            lastSeen: row.lastSeen,
            secondsSpent: Number(row.secondsSpent || 0),
            detectionCount: Number(row.detectionCount || 0)
        });
    }
    const people = [...peopleMap.values()].map((person) => {
        person.areas.sort((a, b) => Number(b.secondsSpent || 0) - Number(a.secondsSpent || 0));
        person.areaCount = new Set(person.areas.map((area) => area.areaName)).size;
        return person;
    }).sort((a, b) => Number(b.totalSeconds || 0) - Number(a.totalSeconds || 0));
    return { date: targetDate, dwell, people, flow, flowSummary: Object.values(byArea) };
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

exports.getEvents = async (req, res, next) => {
    try {
        const data = await readDashboardData();
        return sendJson(res, 200, { events: enrichEvents(data) });
    } catch (error) {
        next(error);
    }
};

exports.updateEvent = async (req, res, next) => {
    try {
        const eventId = req.params.id;
        const { status, acknowledgedBy, note } = req.body;
        const updated = await one(
            `UPDATE events SET status = COALESCE($2, status), acknowledged_by = COALESCE($3, acknowledged_by),
       note = COALESCE($4, note), updated_at = now() WHERE id = $1 RETURNING *`,
            [eventId, status || null, acknowledgedBy || null, note || null]
        );
        if (!updated) return sendJson(res, 404, { message: "Event not found" });
        await audit("event_updated", `${updated.title} -> ${updated.status}`);
        return sendJson(res, 200, { event: updated });
    } catch (error) {
        next(error);
    }
};

exports.simulateEvent = async (req, res, next) => {
    try {
        const data = await readDashboardData();
        if (!data.cameras.length) return sendJson(res, 400, { message: "Add at least one real camera before generating AI events." });
        const generated = await createAiEvent(data, req.query);
        await audit("ai_event_generated", generated.title);
        const fresh = await readDashboardData();
        return sendJson(res, 201, { event: enrichEvents(fresh, [generated])[0] });
    } catch (error) {
        next(error);
    }
};

exports.getAttendance = async (req, res, next) => {
    try {
        const [attendance, people, sites] = await Promise.all([
            rows("SELECT * FROM attendance ORDER BY attendance_date DESC, created_at DESC"),
            rows("SELECT * FROM people ORDER BY created_at DESC"),
            rows("SELECT * FROM sites ORDER BY created_at DESC")
        ]);
        return sendJson(res, 200, { attendance, people, sites });
    } catch (error) {
        next(error);
    }
};

exports.getVisits = async (req, res, next) => {
    try {
        return sendJson(res, 200, { visits: await readIdentityVisits() });
    } catch (error) {
        next(error);
    }
};

exports.getAnalytics = async (req, res, next) => {
    try {
        return sendJson(res, 200, buildAnalytics(await readDashboardData()));
    } catch (error) {
        next(error);
    }
};

exports.getAreaTraffic = async (req, res, next) => {
    try {
        return sendJson(res, 200, await readAreaTraffic(req.query.date || today()));
    } catch (error) {
        next(error);
    }
};
