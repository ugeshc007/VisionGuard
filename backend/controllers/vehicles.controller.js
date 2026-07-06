const vehiclesService = require("../services/vehicles.service.js");
const { sendJson } = require("../utils/utils.js");

exports.getAll = async (req, res, next) => {
    try {
        const vehicles = await vehiclesService.getAll();
        return sendJson(res, 200, vehicles);
    } catch (error) {
        next(error);
    }
};

exports.create = async (req, res, next) => {
    try {
        const { plate,
            owner,
            type,
            status } = req.body;

        const vehicle = await vehiclesService.create({
            plate,
            owner,
            type,
            status
        });
        return sendJson(res, 201, { vehicle });
    } catch (error) {
        next(error);
    }
};