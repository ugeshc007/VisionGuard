const identityService = require("../services/identity.service.js");
const { sendJson } = require("../utils/utils.js");

exports.getAll = async (req, res, next) => {
    try {
        const people = await identityService.getAll();
        return sendJson(res, 200, people);
    } catch (error) {
        next(error);
    }
};

exports.create = async (req, res, next) => {
    try {
        const{ name, category, department, accessLevel, status, faceStatus } = req.body;

        const person = await identityService.create({
            name, category, department, accessLevel, status, faceStatus
        });
        return sendJson(res, 201, person);
    } catch (error) {
        next(error);
    }
};