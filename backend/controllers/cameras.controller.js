const { sendJson, rows, isGatewayPlayable, id, one, audit } = require("../utils/utils.js");
const spawn = require("node:child_process").spawn;
const streamGatewayUrl = (process.env.STREAM_GATEWAY_URL || "http://127.0.0.1:1984").replace(/\/+$/, "");
const publicStreamGatewayUrl = (process.env.PUBLIC_STREAM_GATEWAY_URL || "http://localhost:1984").replace(/\/+$/, "");
const ffmpegCommand = "C:\\Users\\Muhammad Asif Ganai\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.2-full_build\\bin\\ffmpeg.exe"

function cameraStatusFromSource(camera = {}) {
    const streamUrl = String(camera.streamUrl || "").trim();
    if (String(camera.status || "").toLowerCase() === "disabled") return "disabled";
    if (isGatewayPlayable(streamUrl)) return "online";
    if (streamUrl.startsWith("local://")) return "local-only";
    return "offline";
}
function cameraAlias(camera = {}) {
    const raw = String(camera.streamAlias || "").trim();
    if (raw) return raw;
    return `cam-${String(camera.id || camera.name || "stream").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}
function enrichCameraStream(camera = {}) {
    const alias = cameraAlias(camera);
    const streamUrl = String(camera.streamUrl || "");
    const playable = isGatewayPlayable(streamUrl) && camera.gatewayEnabled !== false;
    const src = encodeURIComponent(alias);
    const status = cameraStatusFromSource(camera);
    return {
        ...camera,
        status,
        health: status === "online" || status === "local-only" ? Number(camera.health || 0) : 0,
        streamAlias: alias,
        gatewayUrl: streamGatewayUrl,
        publicGatewayUrl: publicStreamGatewayUrl,
        playable,
        hlsUrl: playable ? `${publicStreamGatewayUrl}/api/stream.m3u8?src=${src}` : "",
        webrtcPageUrl: playable ? `${publicStreamGatewayUrl}/stream.html?src=${src}` : "",
        mjpegUrl: playable ? `${publicStreamGatewayUrl}/api/frame.jpeg?src=${src}` : "",
        streamStatus: playable ? "gateway-ready" : streamUrl ? "local-or-unsupported" : "no-stream"
    };
}

async function gatewayRequest(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(process.env.STREAM_GATEWAY_TIMEOUT_MS || 3500));
    try {
        const response = await fetch(`${streamGatewayUrl}${path}`, { ...options, signal: controller.signal });
        const text = await response.text();
        let data = text;
        try { data = text ? JSON.parse(text) : null; } catch { }
        return { ok: response.ok, status: response.status, data };
    } finally {
        clearTimeout(timer);
    }
}
async function syncGatewayStream(camera = {}) {
    const streamUrl = String(camera.streamUrl || "").trim();
    const enabled = camera.gatewayEnabled !== false;
    if (!enabled || !isGatewayPlayable(streamUrl)) {
        return { cameraId: camera.id, alias: cameraAlias(camera), skipped: true, reason: streamUrl ? "unsupported" : "missing stream url" };
    }
    const alias = cameraAlias(camera);
    const params = new URLSearchParams({ name: alias, src: streamUrl });
    const result = await gatewayRequest(`/api/streams?${params.toString()}`, { method: "PUT" });
    return { cameraId: camera.id, alias, streamUrl, ...result };
}
async function syncAllGatewayStreams() {
    const cameras = await rows("SELECT * FROM cameras ORDER BY created_at DESC");
    const results = [];
    for (const camera of cameras) {
        try {
            results.push(await syncGatewayStream(camera));
        } catch (error) {
            results.push({ cameraId: camera.id, alias: cameraAlias(camera), ok: false, message: error.message });
        }
    }
    return results;
}
function captureCameraFrame(camera = {}) {
    const streamUrl = String(camera.streamUrl || "").trim();
    if (!isGatewayPlayable(streamUrl)) throw new Error("Selected camera does not have an RTSP/HTTP stream URL.");
    return new Promise((resolve, reject) => {
        const args = [
            "-hide_banner",
            "-loglevel", "error",
            "-rtsp_transport", "tcp",
            "-i", streamUrl,
            "-frames:v", "1",
            "-q:v", "3",
            "-f", "image2pipe",
            "-vcodec", "mjpeg",
            "pipe:1"
        ];
        const child = spawn(ffmpegCommand, args, { windowsHide: true });
        const chunks = [];
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error("Timed out while capturing RTSP frame. Check stream URL, network, and camera credentials."));
        }, Number(process.env.RTSP_FRAME_TIMEOUT_MS || 12000));
        child.stdout.on("data", (chunk) => chunks.push(chunk));
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(new Error(`Could not run ffmpeg for RTSP capture: ${error.message}`));
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            const buffer = Buffer.concat(chunks);
            if (code !== 0 || !buffer.length) {
                reject(new Error(stderr.trim() || `ffmpeg exited ${code} without a frame.`));
                return;
            }
            resolve(buffer);
        });
    });
}

exports.getAll = async (req, res, next) => {
    try {
        const [cameras, sites] = await Promise.all([
            rows("SELECT * FROM cameras ORDER BY created_at DESC"),
            rows("SELECT * FROM sites ORDER BY created_at DESC")
        ]);
        res.status(200).json({
            cameras: cameras.map(enrichCameraStream),
            sites
        });
    } catch (error) {
        next(error);
    }
};

exports.create = async (req, res, next) => {
    try {
        const body = req.body;
        const cameraId = id("cam");
        const streamUrl = String(body.streamUrl || "").trim();
        const alias = String(body.streamAlias || "").trim()
            || `cam-${String(body.name || cameraId).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
        const camera = await one(
            `INSERT INTO cameras (id, name, site_id, zone, stream_url, camera_role, stream_alias, gateway_enabled, stream_mode, status, fps, health, ai_enabled)
               VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $9, 20, 90, TRUE) RETURNING *`,
            [cameraId, body.name, body.siteId || null, body.zone || "", streamUrl, body.cameraRole || "area", alias, body.streamMode || "hls", isGatewayPlayable(streamUrl) ? "online" : streamUrl.startsWith("local://") ? "local-only" : "offline"]
        );
        await audit("camera_created", camera.name);
        const streamSync = await syncGatewayStream(camera).catch((error) => ({ ok: false, message: error.message }));
        res.status(201).json({
            camera: enrichCameraStream(camera),
            streamSync
        });
    } catch (error) {
        next(error);
    }
};

exports.update = async (req, res, next) => {
    try {
        console.log("Updating camera with ID:", req.params.id, "Data:", req.body);
        const cameraId = req.params.id;
        const body = req.body;
        const nextStreamUrl = typeof body.streamUrl === "string" ? body.streamUrl.trim() : null;
        const camera = await one(
            `UPDATE cameras
               SET name = COALESCE($2, name),
                   site_id = COALESCE($3, site_id),
                   zone = COALESCE($4, zone),
                   stream_url = COALESCE($5, stream_url),
                   stream_alias = COALESCE($6, stream_alias),
                   camera_role = COALESCE($7, camera_role),
                   min_face_size = COALESCE($8, min_face_size),
                   quality_threshold = COALESCE($9, quality_threshold),
                   detection_interval_ms = COALESCE($10, detection_interval_ms),
                   recognition_threshold = COALESCE($11, recognition_threshold),
                   retention_days = COALESCE($12, retention_days),
                   blur_untrusted = COALESCE($13, blur_untrusted),
                   status = CASE
                     WHEN COALESCE($5, stream_url) ~* '^(rtsp|rtsps|http|https)://' THEN 'online'
                     WHEN COALESCE($5, stream_url) LIKE 'local://%' THEN 'local-only'
                     ELSE 'offline'
                   END,
                   updated_at = now()
               WHERE id = $1
               RETURNING *`,
            [
                cameraId,
                body.name || null,
                body.siteId || null,
                body.zone || null,
                nextStreamUrl,
                body.streamAlias || null,
                body.cameraRole || null,
                Number.isFinite(Number(body.minFaceSize)) ? Number(body.minFaceSize) : null,
                Number.isFinite(Number(body.qualityThreshold)) ? Number(body.qualityThreshold) : null,
                Number.isFinite(Number(body.detectionIntervalMs)) ? Number(body.detectionIntervalMs) : null,
                Number.isFinite(Number(body.recognitionThreshold)) ? Number(body.recognitionThreshold) : null,
                Number.isFinite(Number(body.retentionDays)) ? Number(body.retentionDays) : null,
                typeof body.blurUntrusted === "boolean" ? body.blurUntrusted : null
            ]
        );
        if (!camera) return sendJson(res, 404, { message: "Camera not found" });
        await audit("camera_tuning_updated", camera.name);
        const streamSync = await syncGatewayStream(camera).catch((error) => ({ ok: false, message: error.message }));
        const result = { camera: enrichCameraStream(camera), streamSync };
        console.log("Update result:", result);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

exports.remove = async (req, res, next) => {
    try {
        const cameraId = req.params.id;
        const camera = await one("DELETE FROM cameras WHERE id = $1 RETURNING *", [cameraId]);
        if (!camera) return sendJson(res, 404, { message: "Camera not found" });
        await audit("camera_deleted", camera.name);
        await syncAllGatewayStreams().catch(() => []);
        res.status(200).json({ cameraId, message: "Camera deleted" });
    } catch (error) {
        next(error);
    }
};

exports.captureFrame = async (req, res, next) => {
    try {
        const cameraId = decodeURIComponent(req.originalUrl.split("/")[3]);
        const camera = await one("SELECT * FROM cameras WHERE id = $1", [cameraId]);
        if (!camera) {
            const err = new Error("Camera not found");
            err.status = 404;
            throw err;
        }
        const frame = await captureCameraFrame(camera);
        res.set("Content-Type", "image/jpeg");
        res.send(frame);
    } catch (error) {
        return sendJson(res, 502, { message: error.message || "Could not capture camera frame" });
    }
};
