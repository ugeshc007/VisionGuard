import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL || "postgres://visionguard:visionguard_dev_password@127.0.0.1:5438/visionguard";
const apiBase = process.env.VISIONGUARD_API_BASE || "http://127.0.0.1:7070";
const intervalMs = Number(process.env.WORKER_INTERVAL_MS || 10000);
const pool = new Pool({ connectionString: databaseUrl });

async function hasPendingFaces() {
  const result = await pool.query("SELECT count(*)::int AS count FROM detected_faces WHERE identity_result = 'pending'");
  return Number(result.rows[0]?.count || 0) > 0;
}

async function processFaces() {
  if (!(await hasPendingFaces())) return;
  const response = await fetch(`${apiBase}/api/faces/process`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  const data = await response.json();
  console.log(`[VisionGuard worker] processed=${data.processedCount || 0} at ${new Date().toISOString()}`);
}

async function loop() {
  try {
    await processFaces();
  } catch (error) {
    console.error(`[VisionGuard worker] ${error.message}`);
  } finally {
    setTimeout(loop, intervalMs);
  }
}

console.log(`[VisionGuard worker] started. Polling pending face identities every ${intervalMs}ms.`);
loop();
