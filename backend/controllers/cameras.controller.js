const cameraService = require("../services/cameras.service.js");

exports.getAll = async (req, res, next) => {
    try {
        const result = await cameraService.getAll();
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

exports.create = async (req, res, next) => {
    try {
        const result = await cameraService.create(req.body, res);
        res.status(201).json(result);
    } catch (error) {
        next(error);
    }
};

exports.update = async (req, res, next) => {

    try {
        console.log("Updating camera with ID:", req.params.id, "Data:", req.body);
        const result = await cameraService.update(req, res);
        console.log("Update result:", result);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

exports.remove = async (req, res, next) => {
    try {
        const result = await cameraService.remove(req, res);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};



exports.captureFrame = async (req, res, next) => {
    try {
        // const frame = await cameraService.captureFrame(req.params.id);
        const frame = await cameraService.captureFrame(req, res);

        res.set("Content-Type", "image/jpeg");
        res.send(frame);
    } catch (error) {
        next(error);
    }
};