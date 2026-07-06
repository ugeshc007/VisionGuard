const { rows, one, audit, id, sendJson } = require("../utils/utils.js");

exports.getAll = async (req, res, next) => {
    try {
        const sites = await rows("SELECT * FROM sites ORDER BY created_at DESC");
        return sendJson(res, 200, { sites });
    } catch (error) {
        next(error);
    }
};

exports.create = async (req, res, next) => {
    try {
        const { name, address, status } = req.body;

        const site = await one(
            "INSERT INTO sites (id, name, address, status) VALUES ($1, $2, $3, $4) RETURNING *",
            [id("site"), name, address || "", status || "active"]
        );
        await audit("site_created", site.name);
        return sendJson(res, 201, { site });
    } catch (error) {
        next(error);
    }
};
