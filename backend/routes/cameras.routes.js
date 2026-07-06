const express = require("express");
const router = express.Router();

const controller = require("../controllers/cameras.controller.js");

// GET /api/cameras
router.get("/", controller.getAll);

// POST /api/cameras
router.post("/", controller.create);

// PATCH /api/cameras/:id
router.patch("/:id", controller.update);

// DELETE /api/cameras/:id
router.delete("/:id", controller.remove);

// GET /api/cameras/:id/frame
router.get("/:id/frame", controller.captureFrame);

module.exports = router;