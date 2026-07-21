const { rows, one, id, audit } = require("../utils/utils.js");
const {
    readDetectedFaces,
    readFaceDays,
    resolveTrainingPerson,
    identityResultForCategory,
    isReliableFaceMatch,
    cosineSimilarity,
    processPendingFaces,
    runDailyFaceRetention,
    visitorCode
} = require("../utils/faceEngine.js");
const pg = require("pg");

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL || "postgres://visionguard:visionguard_dev_password@127.0.0.1:5438/visionguard";
const faceEmbeddingUrl = process.env.FACE_EMBEDDING_URL || "http://127.0.0.1:8091/embed";
const pool = new Pool({ connectionString: databaseUrl });

function yesterday() {
    const businessTimezone = process.env.BUSINESS_TIMEZONE || "Asia/Dubai";
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: businessTimezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(new Date(Date.now() - 86_400_000));
}

exports.getAll = async (req, res, next) => {
    try {
        res.status(200).json({ faces: await readDetectedFaces() });
    } catch (error) {
        next(error);
    }
};

exports.getFaceDays = async (req, res, next) => {
    try {
        res.status(200).json({ days: await readFaceDays() });
    } catch (error) {
        next(error);
    }
};

exports.getPersonTracks = async (req, res, next) => {
    try {
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
        res.status(200).json({ tracks });
    } catch (error) {
        next(error);
    }
};

exports.getFaceAiStatus = async (req, res, next) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
        const response = await fetch(faceEmbeddingUrl.replace(/\/embed$/, "/health"), { signal: controller.signal });
        const status = response.ok ? await response.json() : { ok: false, status: response.status };
        res.status(200).json({ ok: response.ok, provider: "insightface-service", url: faceEmbeddingUrl, status });
    } catch (error) {
        res.status(200).json({ ok: false, provider: "fallback", url: faceEmbeddingUrl, message: error.message });
    } finally {
        clearTimeout(timer);
    }
};

exports.merge = async (req, res, next) => {
    try {
        const body = req.body;
        const sourceFace = await one("SELECT * FROM detected_faces WHERE id = $1", [body.sourceFaceId]);
        const targetFace = await one("SELECT * FROM detected_faces WHERE id = $1", [body.targetFaceId]);
        if (!sourceFace || !targetFace) return res.status(404).json({ message: "Source or target face not found" });
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
        res.status(200).json({ ok: true });
    } catch (error) {
        next(error);
    }
};

exports.split = async (req, res, next) => {
    try {
        const body = req.body;
        const face = await one("SELECT * FROM detected_faces WHERE id = $1", [body.faceId]);
        if (!face) return res.status(404).json({ message: "Face not found" });
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
        res.status(200).json({ face: { ...updated, imageUrl: `/api/faces/${updated.id}/image` } });
    } catch (error) {
        next(error);
    }
};

exports.process = async (req, res, next) => {
    try {
        const body = req.body;
        const processed = await processPendingFaces(body.captureId || null);
        res.status(200).json(processed);
    } catch (error) {
        next(error);
    }
};

exports.getImage = async (req, res, next) => {
    try {
        const faceId = req.params.id;
        const result = await pool.query("SELECT face_mime, face_image FROM detected_faces WHERE id = $1", [faceId]);
        if (!result.rows[0] || !result.rows[0].face_image) return res.status(404).json({ message: "Face image not found" });
        res.set("Content-Type", result.rows[0].face_mime || "image/jpeg");
        res.send(result.rows[0].face_image);
    } catch (error) {
        next(error);
    }
};

exports.update = async (req, res, next) => {
    try {
        const faceId = req.params.id;
        const body = req.body;
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
        if (!updated) return res.status(404).json({ message: "Detected face not found" });
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
        res.status(200).json({ face: { ...updated, imageUrl: `/api/faces/${updated.id}/image` } });
    } catch (error) {
        next(error);
    }
};

exports.remove = async (req, res, next) => {
    try {
        const faceId = req.params.id;
        const existing = await one("SELECT id, label FROM detected_faces WHERE id = $1", [faceId]);
        if (!existing) return res.status(404).json({ message: "Detected face not found" });
        await pool.query("DELETE FROM identity_visits WHERE face_id = $1", [faceId]);
        await pool.query("DELETE FROM events WHERE snapshot = $1", [`/api/faces/${faceId}/image`]);
        await pool.query("DELETE FROM detected_faces WHERE id = $1", [faceId]);
        await audit("face_deleted", existing.label || faceId);
        res.status(200).json({ ok: true });
    } catch (error) {
        next(error);
    }
};

exports.search = async (req, res, next) => {
    try {
        const body = req.body;
        const queryEmbedding = Array.isArray(body.embedding) ? body.embedding : [];
        const faces = await readDetectedFaces(250);
        const results = faces
            .map((face) => ({ ...face, similarity: cosineSimilarity(queryEmbedding, Array.isArray(face.embedding) ? face.embedding : []) }))
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, 20);
        res.status(200).json({ results });
    } catch (error) {
        next(error);
    }
};

exports.runRetention = async (req, res, next) => {
    try {
        const body = req.body;
        const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? body.date : yesterday();
        res.status(200).json(await runDailyFaceRetention(targetDate));
    } catch (error) {
        next(error);
    }
};
