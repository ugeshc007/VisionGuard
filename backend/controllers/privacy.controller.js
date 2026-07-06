const privacyService = require("../services/privacy.service.js");
const { sendJson } = require("../utils/utils.js");

exports.getOne = async (req, res, next) => {
    try {
        const policy = await privacyService.getOne();
        return sendJson(res, 200, policy);
    } catch (error) {
        next(error);
    }
};

exports.create = async (req, res, next) => {
    try {
        // const { name, address, status } = req.body;

        const privacy = await privacyService.create(
            req.body
        );
        return sendJson(res, 201, privacy);
    } catch (error) {
        next(error);
    }
};