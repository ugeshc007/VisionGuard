const express = require("express");
const router = express.Router();

const controller = require("../controllers/captures.controller.js");

router.get("/", controller.getAll);
router.post("/", controller.create);
router.get("/:id/image", controller.getImage);

module.exports = router;
