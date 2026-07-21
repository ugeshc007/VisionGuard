import "dotenv/config";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const apiBase = process.env.VISIONGUARD_API_BASE ;
const intervalMs = Number(process.env.WORKER_INTERVAL_MS);
const pool = new Pool({ connectionString: databaseUrl });

async function hasPendingFaces() {
  const result = await pool.query("SELECT count(*)::int AS count FROM detected_faces WHERE identity_result = 'pending'");
  return Number(result.rows[0]?.count || 0) > 0;
}

async function processFaces() {
  console.log(`[VisionGuard worker] checking for pending face identities at ${new Date().toISOString()}`);
  if (!(await hasPendingFaces())){
    console.log(`[VisionGuard worker] no pending face identities found at ${new Date().toISOString()}`);
    return;
  } 
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

console.log(`[VisionGuard worker] started. Polling pending face identities every ${intervalMs} ms.`);
loop();
