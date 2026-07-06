const sitesService = require("../services/sites.service.js");
const { sendJson } = require("../utils/utils.js");

exports.getAll = async (req, res, next) => {
    try {
        const sites = await sitesService.getAll();
        return sendJson(res, 200, sites);
    } catch (error) {
        next(error);
    }
};

exports.create = async (req, res, next) => {
    try {
        const { name, address, status } = req.body;

        const site = await sitesService.create({
            name,
            address,
            status
        });
        return sendJson(res, 201, { site });
    } catch (error) {
        next(error);
    }
};