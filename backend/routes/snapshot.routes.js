const express = require("express");
const router = express.Router();

const controller = require("../controllers/system.controller.js");

router.get("/:id", controller.getSnapshot);

module.exports = router;
