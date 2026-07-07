const express = require("express");
const router = express.Router();

const controller = require("../controllers/forensics.controller.js");

router.post("/incident", controller.createIncident);

module.exports = router;
