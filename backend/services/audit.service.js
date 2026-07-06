
const { rows, one, audit, id } = require("../utils/utils.js");

exports.getAll = async () => {
    return  { audit: await rows("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100") };
};

