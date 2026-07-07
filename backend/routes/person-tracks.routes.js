const express = require("express");
const router = express.Router();

const controller = require("../controllers/faces.controller.js");

router.get("/", controller.getPersonTracks);

module.exports = router;
