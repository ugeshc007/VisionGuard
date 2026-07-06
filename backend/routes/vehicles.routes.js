const express = require("express");
const router = express.Router();

const controller = require("../controllers/vehicles.controller.js");

router.get("/", controller.getAll);

// POST /api/cameras
router.post("/", controller.create);

module.exports = router;