const express = require("express");
const router = express.Router();

const controller = require("../controllers/event-Attendance-Visit-analytics-areaTraffic.controller.js");

router.get("/", controller.getAttendance);

module.exports = router;
