import pg from "pg";
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..", "..");
const reportsDir = join(rootDir, "reports");
const debugFacesDir = join(reportsDir, "debug-faces");
const debugBackendErrorsDir = join(reportsDir, "debug-backend-errors");
const embedderPath = join(rootDir, "tools", "insightface_embedder.py");

const databaseUrl = process.env.DATABASE_URL || "postgres://visionguard:visionguard_dev_password@127.0.0.1:5438/visionguard";
const businessTimezone = process.env.BUSINESS_TIMEZONE || "Asia/Dubai";
const faceEmbeddingProvider = process.env.FACE_EMBEDDING_PROVIDER || "hybrid";
const faceEmbeddingUrl = process.env.FACE_EMBEDDING_URL || "http://127.0.0.1:8091/embed";
const pythonCommand = process.env.PYTHON || "python";

const pool = new Pool({ connectionString: databaseUrl });

function camel(row = {}) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()),
    value instanceof Date ? value.toISOString() : value
  ]));
}
export async function rows(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows.map(camel);
}
export async function one(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] ? camel(result.rows[0]) : null;
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

export function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: businessTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}
export function yesterday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: businessTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(Date.now() - 86_400_000));
}

export function visitorCode(index = 0) {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `VIS-${date}-${Date.now().toString().slice(-5)}${String(index + 1).padStart(2, "0")}`;
}

export function parseDataUrl(dataUrl = "") {
  const match = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Expected a base64 data URL image.");
  return { mime: match[1], buffer: Buffer.from(match[2], "base64") };
}

function normalizeVector(values = [], dimensions = 512) {
  const clean = values.map((value) => Number(value || 0)).filter((value) => Number.isFinite(value));
  const vector = Array.from({ length: dimensions }, (_, index) => clean.length ? clean[index % clean.length] : 0);
  const magnitude = Math.sqrt(vector.reduce((total, value) => total + (value * value), 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}
export function vectorLiteral(values = []) {
  return `[${normalizeVector(values, 512).join(",")}]`;
}

async function saveDebugFaceCrop(faceImage, status, dir = debugFacesDir) {
  const extension = String(faceImage.mime || "").split("/")[1]?.split("+")[0] || "jpg";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}_${status}.${extension}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path, faceImage.buffer);
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
    if (!response.ok) {
      // 422 means the model actually looked and found no face - a confident verdict,
      // not a transient failure, so callers should trust it instead of falling back.
      // Anything else (503, 500, etc.) is the service itself breaking, not a verdict
      // on the image - keep those crops separate so the two don't get mixed together
      // when reviewing why matches are failing.
      const isNoFaceVerdict = response.status === 422;
      await saveDebugFaceCrop(faceImage, response.status, isNoFaceVerdict ? debugFacesDir : debugBackendErrorsDir).catch(() => {});
      const error = new Error(`Face service ${response.status}`);
      if (isNoFaceVerdict) error.noFaceDetected = true;
      throw error;
    }
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
      if (code !== 0) {
        // Exit code 4 (tools/insightface_embedder.py) means the model looked and
        // found no face - a confident verdict, not a transient failure. Any other
        // code (bad payload, missing deps, other exception) is the backend/embedder
        // itself breaking, not a verdict on the image - same split as the HTTP
        // service path above, so the two failure classes don't get mixed together.
        const isNoFaceVerdict = code === 4;
        saveDebugFaceCrop(faceImage, code, isNoFaceVerdict ? debugFacesDir : debugBackendErrorsDir).catch(() => {});
        const error = new Error(stderr || `InsightFace embedder exited ${code}`);
        if (isNoFaceVerdict) error.noFaceDetected = true;
        return reject(error);
      }
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

export async function buildFaceEmbedding(face, faceImage) {
  const sourceEmbedding = Array.isArray(face.embedding) ? face.embedding.map(Number) : [];
  if (faceEmbeddingProvider !== "browser" && faceImage?.buffer) {
    try {
      const service = await runFaceServiceEmbedder(faceImage);
      if (service?.embedding?.length) {
        return {
          sourceEmbedding: service.embedding,
          vector: normalizeVector(service.embedding, 512),
          model: service.model || "insightface-service"
        };
      }
    } catch (error) {
      // A real detector confidently saying "not a face" (e.g. a PC case fan that
      // fooled the browser-side detector into drawing a box) is authoritative -
      // don't paper over it with a synthetic fallback embedding, which is how
      // non-face crops ended up saved as visitor captures before.
      if (error?.noFaceDetected) return { rejected: true, reason: "no-face-detected" };
    }
    try {
      const insight = await runInsightFaceEmbedder(faceImage);
      if (insight?.embedding?.length) {
        return {
          sourceEmbedding: insight.embedding,
          vector: normalizeVector(insight.embedding, 512),
          model: insight.model || "insightface"
        };
      }
    } catch (error) {
      if (error?.noFaceDetected) return { rejected: true, reason: "no-face-detected" };
    }
  }
  return {
    sourceEmbedding,
    vector: normalizeVector(sourceEmbedding, 512),
    model: faceEmbeddingProvider === "browser" ? "browser-lightweight" : "browser-lightweight-fallback"
  };
}

export async function resolveTrainingPerson({ label, category, status, personId }) {
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

export function identityResultForCategory(category = "visitor") {
  if (category === "staff" || category === "employee") return "employee";
  if (category === "customer") return "customer";
  if (category === "watchlist") return "watchlist";
  if (category === "unknown") return "unknown";
  return "known";
}

export function isReliableFaceMatch(match = {}) {
  if (!match) return false;
  const score = Number(match.score || 0);
  const model = String(match.embeddingModel || "").toLowerCase();
  if (model.includes("browser")) return score >= 0.985;
  // 0.82 was calibrated for an idealized descriptor - real InsightFace/ArcFace
  // (buffalo_l) cosine similarity on this app's CCTV-angle crops runs genuine
  // same-person pairs around 0.5-0.9 (observed directly against trained faces
  // in this deployment), with cross-person pairs averaging ~0.08. 0.82 rejected
  // most genuine re-matches, so a trained person was almost never recognized.
  return score >= 0.48;
}

export function duplicateThresholdForModel(model = "") {
  return String(model).toLowerCase().includes("browser") ? 0.985 : 0.92;
}

export function scoreFaceQualityDetailed(face = {}, camera = {}) {
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

export function scoreFaceQuality(face) {
  const box = face.box || {};
  const area = Number(box.width || 0) * Number(box.height || 0);
  const confidence = Number(face.confidence || 0);
  const areaScore = Math.min(50, Math.round(area / 1000));
  return Math.max(0, Math.min(100, confidence + areaScore));
}

export function titleForIdentity(identityResult, name) {
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

export function cosineSimilarity(a = [], b = []) {
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

export async function findBestVectorMatch(faceId, embedding) {
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

export async function findRecentFaceForPerson(personId, minutes = 45) {
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

export async function findRecentDuplicateFace(embedding, minutes = 15) {
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

export async function getOrCreatePersonTrack({ camera = null, matched = null, embedding = [], modelName = "", fallbackLabel = "", qualityScore = 0 }) {
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

export async function updateTrackBestFace(trackId, face) {
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

export async function recordAreaPresence({ cameraId, personId = null, visitorLabel = "", category = "visitor" }) {
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

export async function upsertAttendance(personId, siteId) {
  const businessDate = today();
  const existing = await one("SELECT * FROM attendance WHERE person_id = $1 AND attendance_date = $2::date LIMIT 1", [personId, businessDate]);
  if (existing) return existing;
  return await one(
    "INSERT INTO attendance (id, person_id, site_id, attendance_date, check_in, status) VALUES ($1, $2, $3, $4::date, $5, 'present') RETURNING *",
    [id("a"), personId, siteId, businessDate, new Date().toTimeString().slice(0, 5)]
  );
}

export async function readDetectedFaces(limit = 100) {
  const faces = await rows(`
    WITH ranked_faces AS (
      SELECT f.*,
             COALESCE(f.person_id, f.matched_person_id, NULL) AS identity_person_key,
             COALESCE(f.person_id, f.matched_person_id, f.label) AS identity_key,
             row_number() OVER (
               PARTITION BY COALESCE(f.person_id, f.matched_person_id, f.label)
               ORDER BY
                 CASE WHEN f.status = 'trained' THEN 1 ELSE 0 END DESC,
                 CASE WHEN f.person_id IS NOT NULL OR f.matched_person_id IS NOT NULL THEN 1 ELSE 0 END DESC,
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

export async function readFaceDays(limit = 14) {
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

export async function readIdentityVisits(limit = 100) {
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

export async function readPersonMovement({ personId = null, visitorLabel = "" }) {
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

export async function searchFaceEvidence(body = {}) {
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
    if (embeddingResult.rejected) throw new Error("No face detected in the uploaded photo.");
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

export async function processPendingFaces(captureId = null) {
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

export function faceRetentionScore(face = {}) {
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

export async function applyPrivacyRetention() {
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
      AND status <> 'trained'
      AND id NOT IN (
        SELECT best_face_id
        FROM person_tracks
        WHERE best_face_id IS NOT NULL
      )
      AND (
        created_at < now() - ($1::text || ' days')::interval
        OR created_at < now() - ($2::text || ' days')::interval
      )
  `, [String(deleteAfterDays), String(retentionDays)]);
  if (result.rowCount) await audit("privacy_retention_applied", `${result.rowCount} old face image(s) cleared`);
  return { clearedImages: result.rowCount || 0 };
}

export async function runDailyFaceRetention(targetDate = yesterday()) {
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
    const trainedFaces = sorted.filter((face) => face.status === "trained");
    const best = trainedFaces[0] || sorted[0];
    if (!best) continue;
    kept.push(best);
    const duplicates = sorted.filter((face) => face.id !== best.id);
    for (const duplicate of duplicates) {
      if (duplicate.status === "trained") continue;
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

let lastFaceRetentionRunDate = "";
export function startFaceRetentionScheduler() {
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

export async function backfillEmbeddingVectors() {
  const result = await pool.query("SELECT id, embedding FROM detected_faces WHERE embedding_vector IS NULL AND jsonb_array_length(embedding) > 0 LIMIT 500");
  for (const row of result.rows) {
    const embedding = Array.isArray(row.embedding) ? row.embedding : [];
    await pool.query(
      "UPDATE detected_faces SET embedding_vector = $2::vector, embedding_dim = 512 WHERE id = $1",
      [row.id, vectorLiteral(embedding)]
    );
  }
}

export async function normalizeTrainedFaceIdentities() {
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

export async function backfillAreaDwellFromVisits() {
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

export async function backfillPersonTracks() {
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

export async function runStartupBackfills() {
  await backfillEmbeddingVectors();
  await normalizeTrainedFaceIdentities();
  await backfillAreaDwellFromVisits();
  await backfillPersonTracks();
}

export async function createIncidentReport(data, eventId, enrichEvents) {
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
  await mkdir(reportsDir, { recursive: true });
  await writeFile(path, lines.join("\n"), "utf8");
  return { fileName, path, content: lines.join("\n") };
}

export function sendSnapshot(res, eventId) {
  const label = String(eventId || "event").toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="520"><defs><linearGradient id="g" x1="0" x2="1"><stop stop-color="#05111c"/><stop offset="1" stop-color="#163c43"/></linearGradient></defs><rect width="900" height="520" fill="url(#g)"/><rect x="55" y="55" width="790" height="410" rx="28" fill="#0b1724" stroke="#3be3d0" stroke-opacity=".55"/><circle cx="450" cy="230" r="82" fill="#f6c85f" opacity=".2"/><path d="M350 310 C410 170 500 170 560 310" fill="none" stroke="#3be3d0" stroke-width="16" stroke-linecap="round"/><text x="450" y="430" text-anchor="middle" fill="#eef6ff" font-size="32" font-family="Arial" font-weight="700">AI Evidence Snapshot ${label}</text></svg>`;
  res.set("Content-Type", "image/svg+xml");
  res.send(svg);
}
