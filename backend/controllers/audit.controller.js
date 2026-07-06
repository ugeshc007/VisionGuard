const auditService = require("../services/audit.service.js");
const { sendJson } = require("../utils/utils.js");

exports.getAll = async (req, res, next) => {
    try {
        const auditLogs = await auditService.getAll();
        return sendJson(res, 200, auditLogs);
    } catch (error) {
        next(error);
    }
};