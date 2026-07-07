const express = require("express");
const router = express.Router();

const controller = require("../controllers/faces.controller.js");

router.get("/status", controller.getFaceAiStatus);

module.exports = router;
