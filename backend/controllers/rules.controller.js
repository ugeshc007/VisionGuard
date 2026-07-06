const { rows, one, audit, id, sendJson } = require("../utils/utils.js");

exports.getAll = async (req, res, next) => {
    try {
        const [rules, cameras] = await Promise.all([
            rows("SELECT * FROM rules ORDER BY created_at DESC"),
            rows("SELECT * FROM cameras ORDER BY created_at DESC")
        ]);
        return sendJson(res, 200, { rules, cameras });
    } catch (error) {
        next(error);
    }
};

exports.create = async (req, res, next) => {
    try {
        const { name, type, cameraId, severity, schedule, action } = req.body;

        const rule = await one(
            `INSERT INTO rules (id, name, type, camera_id, severity, schedule, enabled, action)
             VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7) RETURNING *`,
            [id("r"), name, type, cameraId || null, severity || "medium", schedule || "always", action || "notify"]
        );
        await audit("rule_created", rule.name);
        return sendJson(res, 201, { rule });
    } catch (error) {
        next(error);
    }
};
