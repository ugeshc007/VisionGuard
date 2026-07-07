const express = require("express");
const router = express.Router();

const controller = require("../controllers/forensics.controller.js");

router.get("/", controller.getForensics);
router.post("/face-search", controller.faceSearch);

module.exports = router;
