const express = require("express");
const router = express.Router();

const controller = require("../controllers/privacy.controller.js");

router.get("/", controller.getOne);

// PUT /api/privacy
router.put("/", controller.create);


module.exports = router;