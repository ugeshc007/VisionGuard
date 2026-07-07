const express = require("express");
const router = express.Router();

const controller = require("../controllers/streams.controller.js");

router.get("/health", controller.getStreamsHealth);
router.get("/", controller.getStreams);
router.post("/sync", controller.syncStreams);

module.exports = router;
