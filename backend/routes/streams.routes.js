const express = require("express");
const bodyParser = require("body-parser");
const router = express.Router();

const controller = require("../controllers/streams.controller.js");

router.get("/health", controller.getStreamsHealth);
router.get("/", controller.getStreams);
router.post("/sync", controller.syncStreams);
router.post("/webrtc", bodyParser.text({ type: "application/sdp" }), controller.postWebRtcOffer);

module.exports = router;
