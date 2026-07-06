
const { rows, one, audit, id } = require("../utils/utils.js");
async function readDetectedFaces(limit = 100) {
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
exports.getAll = async () => {
    console.log("identityService.getAll called");
    return {
        people: await rows("SELECT * FROM people ORDER BY created_at DESC"),
        faces: await readDetectedFaces()
    };
};

exports.create = async (data) => {
    //  const body = await readBody(req);
    const body = data
    const person = await one(
        `INSERT INTO people (id, name, category, department, access_level, status, face_status, last_seen)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING *`,
        [id("p"), body.name, body.category || "employee", body.department || "", body.accessLevel || "standard", body.status || "authorized", body.faceStatus || "enrolled"]
    );
    await audit("face_enrolled", person.name);
    return person;
};