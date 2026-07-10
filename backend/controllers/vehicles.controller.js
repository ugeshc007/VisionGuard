const { rows, one, audit, id, isGatewayPlayable, sendJson } = require("../utils/utils.js");
const streamGatewayUrl = (process.env.STREAM_GATEWAY_URL || "http://127.0.0.1:1984").replace(/\/+$/, "");
const publicStreamGatewayUrl = (process.env.PUBLIC_STREAM_GATEWAY_URL || "http://localhost:1984").replace(/\/+$/, "");

function enrichEvents(data, source = data.events) {
    return source.map((event) => ({
        ...event,
        camera: data.cameras.find((camera) => camera.id === event.cameraId) || null,
        person: data.people.find((person) => person.id === event.personId) || null,
        vehicle: data.vehicles.find((vehicle) => vehicle.id === event.vehicleId) || null,
        snapshot: event.snapshot || `/api/snapshot/${event.id}`
    }));
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

exports.getAll = async (req, res, next) => {
    try {
        const data = await readDashboardData();
        return sendJson(res, 200, { vehicles: data.vehicles, events: enrichEvents(data).filter((event) => event.vehicleId) });
    } catch (error) {
        next(error);
    }
};

exports.create = async (req, res, next) => {
    try {
        const { plate, owner, type, status } = req.body;

        const vehicle = await one(
            "INSERT INTO vehicles (id, plate, owner, type, status, last_seen) VALUES ($1, $2, $3, $4, $5, now()) RETURNING *",
            [id("v"), plate, owner || "", type || "", status || "registered"]
        );
        await audit("vehicle_created", vehicle.plate);
        return sendJson(res, 201, { vehicle });
    } catch (error) {
        next(error);
    }
};
