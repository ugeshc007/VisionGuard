const { rows, sendJson } = require("../utils/utils.js");

exports.getAll = async (req, res, next) => {
    try {
        const auditLogs = await rows("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100");
        return sendJson(res, 200, { audit: auditLogs });
    } catch (error) {
        next(error);
    }
};