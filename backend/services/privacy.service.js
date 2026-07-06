const { rows, one, audit, id } = require("../utils/utils.js");

exports.getOne = async () => {
    const policy = await one("SELECT * FROM privacy_policies WHERE id = 'default' LIMIT 1");
    return policy;
};

exports.create = async (data) => {
    //    const body = await readBody(req);

   const body = data;
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
           return  policy;

};