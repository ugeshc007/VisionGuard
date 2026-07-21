


require("dotenv").config({});

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const morgan = require("morgan");

const app = express();

const port = process.env.PORT

morgan.token("time", () => {
  return new Date().toISOString(); // clean ISO timestamp
});


app.use(morgan("dev"));

// Import all API routes
const apiRoutes = require("./routes");
const { runStartupBackfills, startFaceRetentionScheduler } = require("./utils/faceEngine.js");
const { syncAllGatewayStreams } = require("./controllers/streams.controller.js");

// ======================
// Middleware
// ======================

app.use(cors());

// Capture payloads carry a full base64 camera frame plus per-face crops, which can
// comfortably exceed body-parser's 100kb default — raise it well above what a
// multi-megapixel frame + several face crops needs.
app.use(bodyParser.json({ limit: "25mb" }));

app.use(bodyParser.urlencoded({ extended: true, limit: "25mb" }));

// ======================
// Health Check
// ======================

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "VisionGuard Face Service is running.",
    });
});
app.get("/health", (req, res) => {
    res.status(200).json({
        success: true,
        service: "VisionGuard Face Service",
        status: "healthy",
        timestamp: new Date().toISOString(),
    });
});

// ======================
// API Routes
// ======================

app.use("/api", apiRoutes);

// ======================
// 404 Route
// ======================

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: "Route not found",
    });
});

// ======================
// Global Error Handler
// ======================

app.use((err, req, res, next) => {
    console.error(err);

    res.status(err.status || 500).json({
        success: false,
        message: err.message || "Internal Server Error",
    });
});

// ======================
// Start Server
// ======================

async function bootstrap() {
    await runStartupBackfills().catch((error) => {
        console.error("Startup backfills failed:", error.message);
    });
    app.listen(port, () => {
        console.log(`🚀 Server running on http://localhost:${port}`);
        startFaceRetentionScheduler();
        syncAllGatewayStreams()
            .then((results) => {
                const synced = results.filter((item) => item.ok).length;
                const failed = results.filter((item) => item.ok === false).length;
                console.log(`Stream gateway sync: ${synced}/${results.length} synced, ${failed} failed`);
            })
            .catch((error) => console.warn(`Stream gateway sync skipped: ${error.message}`));
    });
}

bootstrap();
