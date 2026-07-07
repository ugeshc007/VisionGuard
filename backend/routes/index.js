const express = require("express");
const router = express.Router();
const camerasRoutes = require("./cameras.routes");
const sitesRoutes = require("./sites.routes");
const vehiclesRoutes= require("./vehicles.routes");
const privacyRoutes= require("./privacy.routes");
const auditRoutes= require("./audit.routes");
const identityRoutes= require("./identity.routes");
const rulesRoutes= require("./rules.routes");
const eventsRoutes= require("./events.routes");
const attendanceRoutes= require("./attendance.routes");
const visitsRoutes= require("./visits.routes");
const analyticsRoutes= require("./analytics.routes");
const areaTrafficRoutes= require("./area-traffic.routes");
const simulateEventRoutes= require("./simulate-event.routes");



router.use("/cameras", camerasRoutes);
router.use("/sites", sitesRoutes);
router.use("/vehicles", vehiclesRoutes);
router.use("/privacy", privacyRoutes);
router.use("/audit", auditRoutes);
router.use("/people", identityRoutes); 
router.use("/rules", rulesRoutes);
router.use("/events", eventsRoutes);
router.use("/attendance", attendanceRoutes);
router.use("/visits", visitsRoutes);
router.use("/analytics", analyticsRoutes);
router.use("/area-traffic", areaTrafficRoutes);
router.use("/simulate-event", simulateEventRoutes);
// router.use("/employees", employeeRoutes);
// router.use("/faces", faceRoutes);

module.exports = router;
