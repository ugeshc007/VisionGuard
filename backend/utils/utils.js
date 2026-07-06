import pg from "pg";
const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL || "postgresql://postgres:everfresh@123@127.0.0.1:5432/visionguard";
const pool = new Pool({ connectionString: databaseUrl });
const jsonHeaders = { "content-type": "application/json; charset=utf-8" };


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