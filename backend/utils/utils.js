import pg from "pg";
const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL || "postgres://visionguard:visionguard_dev_password@127.0.0.1:5438/visionguard";
const pool = new Pool({ connectionString: databaseUrl });
const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const streamGatewayUrl = (process.env.STREAM_GATEWAY_URL || "http://127.0.0.1:1984").replace(/\/+$/, "");
const publicStreamGatewayUrl = (process.env.PUBLIC_STREAM_GATEWAY_URL || "http://localhost:1984").replace(/\/+$/, "");

function camel(row = {}) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()),
    value instanceof Date ? value.toISOString() : value
  ]));
}


export function sendJson(res, status, data) {
  if (!res) {
    throw new Error("sendJson(): Response object is undefined.");
  }

  console.log(`Sending JSON response with status ${status}`);

  // Express response
  if (typeof res.status === "function" && typeof res.json === "function") {
    return res.status(status).json(data);
  }

  // Native Node HTTP response
  res.writeHead(status, jsonHeaders);
  return res.end(JSON.stringify(data));
}
export async function one(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] ? camel(result.rows[0]) : null;
}
export async function rows(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows.map(camel);
}
export function isGatewayPlayable(streamUrl = "") {
  return /^(rtsp|rtsps|http|https):\/\//i.test(String(streamUrl || ""));
}
export async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
export function id(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}
export async function audit(action, detail, actor = "Security Admin") {
  await pool.query(
    "INSERT INTO audit_logs (id, action, detail, actor) VALUES ($1, $2, $3, $4)",
    [id("log"), action, detail || "", actor]
  );
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
    // WHEP-style endpoint: POST an SDP offer, get an SDP answer back. Preferred over hlsUrl
    // for browser playback — go2rtc's live HLS remux of the transcoded stream reliably
    // throws a fatal hls.js fragParsingError, whereas WebRTC uses the browser's native
    // RTP/H.264 decode path and actually renders frames. Routed through our own backend
    // (not go2rtc directly) because go2rtc's /api/webrtc doesn't send CORS headers on its
    // OPTIONS preflight, which browsers require for a cross-port POST.
    webrtcUrl: playable ? `/api/streams/webrtc?src=${src}` : "",
    webrtcPageUrl: playable ? `${publicStreamGatewayUrl}/stream.html?src=${src}` : "",
    mjpegUrl: playable ? `${publicStreamGatewayUrl}/api/frame.jpeg?src=${src}` : "",
    streamStatus: playable ? "gateway-ready" : streamUrl ? "local-or-unsupported" : "no-stream"
  };
}
export async function readDashboardData() {
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

// export async function syncAllGatewayStreams() {
//   const cameras = await rows("SELECT * FROM cameras ORDER BY created_at DESC");
//   const results = [];
//   for (const camera of cameras) {
//     try {
//       results.push(await syncGatewayStream(camera));
//     } catch (error) {
//       results.push({ cameraId: camera.id, alias: cameraAlias(camera), ok: false, message: error.message });
//     }
//   }
//   return results;
// }