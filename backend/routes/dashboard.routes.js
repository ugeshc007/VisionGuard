const express = require("express");
const router = express.Router();

const controller = require("../controllers/system.controller.js");

router.get("/", controller.getDashboard);

module.exports = router;
