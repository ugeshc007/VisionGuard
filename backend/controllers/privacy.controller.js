const { one, audit, sendJson } = require("../utils/utils.js");

exports.getOne = async (req, res, next) => {
    try {
        const policy = await one("SELECT * FROM privacy_policies WHERE id = 'default' LIMIT 1");
        return sendJson(res, 200, policy);
    } catch (error) {
        next(error);
    }
};

exports.create = async (req, res, next) => {
    try {
        const body = req.body;
        const policy = await one(
            `UPDATE privacy_policies
          SET retention_days = $1,
              delete_untrained_after_days = $2,
              blur_unknown = $3,
              allow_export = $4,
              consent_required = $5,
              updated_at = now()
          WHERE id = 'default'
          RETURNING *`,
            [
                Math.max(1, Number(body.retentionDays || 30)),
                Math.max(1, Number(body.deleteUntrainedAfterDays || 7)),
                Boolean(body.blurUnknown),
                body.allowExport !== false,
                Boolean(body.consentRequired)
            ]
        );
        await audit("privacy_policy_updated", "Default face privacy policy updated");
        return sendJson(res, 201, policy);
    } catch (error) {
        next(error);
    }
};
