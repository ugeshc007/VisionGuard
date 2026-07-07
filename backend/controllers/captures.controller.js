const { rows, one, id, audit } = require("../utils/utils.js");
const {
    parseDataUrl,
    visitorCode,
    scoreFaceQualityDetailed,
    buildFaceEmbedding,
    findBestVectorMatch,
    isReliableFaceMatch,
    getOrCreatePersonTrack,
    identityResultForCategory,
    recordAreaPresence,
    findRecentFaceForPerson,
    findRecentDuplicateFace,
    duplicateThresholdForModel,
    updateTrackBestFace,
    upsertAttendance,
    vectorLiteral
} = require("../utils/faceEngine.js");
const pg = require("pg");

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL || "postgresql://postgres:everfresh@123@127.0.0.1:5432/visionguard";
const pool = new Pool({ connectionString: databaseUrl });

exports.getAll = async (req, res, next) => {
    try {
        const captures = await rows(`
      SELECT c.id, c.camera_id, c.source, c.image_mime, c.width, c.height, c.face_count, c.created_at,
             cam.name AS camera_name
      FROM camera_captures c
      LEFT JOIN cameras cam ON cam.id = c.camera_id
      ORDER BY c.created_at DESC
      LIMIT 50
    `);
        res.status(200).json({ captures });
    } catch (error) {
        next(error);
    }
};

exports.getImage = async (req, res, next) => {
    try {
        const captureId = req.params.id;
        const result = await pool.query("SELECT image_mime, image_data FROM camera_captures WHERE id = $1", [captureId]);
        if (!result.rows[0]) return res.status(404).json({ message: "Capture not found" });
        res.set("Content-Type", result.rows[0].image_mime || "image/jpeg");
        res.send(result.rows[0].image_data);
    } catch (error) {
        next(error);
    }
};

exports.create = async (req, res, next) => {
    try {
        const body = req.body;
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
        res.status(201).json({ capture, faces: savedFaces, skippedFaces });
    } catch (error) {
        next(error);
    }
};
