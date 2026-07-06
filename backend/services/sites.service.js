
const { rows, one, audit, id } = require("../utils/utils.js");

exports.getAll = async () => {
    return  {sites: await rows("SELECT * FROM sites ORDER BY created_at DESC") };
};

exports.create = async (data) => {
    //    const body = await readBody(req);
    const body = data;
    const site = await one(
        "INSERT INTO sites (id, name, address, status) VALUES ($1, $2, $3, $4) RETURNING *",
        [id("site"), body.name, body.address || "", body.status || "active"]
    );
    await audit("site_created", site.name);
    return site ;
};