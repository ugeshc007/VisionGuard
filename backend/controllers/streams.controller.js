const { rows, isGatewayPlayable, audit } = require("../utils/utils.js");

const streamGatewayUrl = (process.env.STREAM_GATEWAY_URL || "http://127.0.0.1:1984").replace(/\/+$/, "");

function cameraAlias(camera = {}) {
    const raw = String(camera.streamAlias || "").trim();
    if (raw) return raw;
    return `cam-${String(camera.id || camera.name || "stream").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
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

exports.getStreamsHealth = async (req, res, next) => {
    try {
        const result = await gatewayRequest("/api");
        res.status(200).json({ ok: result.ok, gatewayUrl: streamGatewayUrl, status: result.status, api: result.data });
    } catch (error) {
        res.status(200).json({ ok: false, gatewayUrl: streamGatewayUrl, message: error.message });
    }
};

exports.getStreams = async (req, res, next) => {
    try {
        const result = await gatewayRequest("/api/streams");
        res.status(200).json({ ok: result.ok, gatewayUrl: streamGatewayUrl, status: result.status, streams: result.data || {} });
    } catch (error) {
        res.status(200).json({ ok: false, gatewayUrl: streamGatewayUrl, message: error.message, streams: {} });
    }
};

exports.syncStreams = async (req, res, next) => {
    try {
        const results = await syncAllGatewayStreams();
        const failed = results.filter((item) => item.ok === false);
        await audit("streams_synced", `${results.length} camera stream(s), ${failed.length} failed`);
        res.status(200).json({
            ok: failed.length === 0,
            gatewayUrl: streamGatewayUrl,
            total: results.length,
            synced: results.filter((item) => item.ok).length,
            skipped: results.filter((item) => item.skipped).length,
            failed: failed.length,
            results
        });
    } catch (error) {
        next(error);
    }
};

exports.syncAllGatewayStreams = syncAllGatewayStreams;
