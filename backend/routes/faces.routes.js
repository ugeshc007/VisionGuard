const express = require("express");
const router = express.Router();

const controller = require("../controllers/faces.controller.js");

router.get("/", controller.getAll);
router.post("/merge", controller.merge);
router.post("/split", controller.split);
router.post("/process", controller.process);
router.post("/search", controller.search);
router.post("/retention/run", controller.runRetention);
router.get("/:id/image", controller.getImage);
router.patch("/:id", controller.update);
router.delete("/:id", controller.remove);

module.exports = router;
