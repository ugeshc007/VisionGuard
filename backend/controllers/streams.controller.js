const { rows, isGatewayPlayable, audit } = require("../utils/utils.js");

const streamGatewayUrl = process.env.STREAM_GATEWAY_URL.replace(/\/+$/, "");

function cameraAlias(camera = {}) {
    const raw = String(camera.streamAlias || "").trim();
    if (raw) return raw;
    return `cam-${String(camera.id || camera.name || "stream").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

async function gatewayRequest(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(process.env.STREAM_GATEWAY_TIMEOUT_MS));
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
    const rawParams = new URLSearchParams({ name: alias, src: streamUrl });
    const rawResult = await gatewayRequest(`/api/streams?${rawParams.toString()}`, { method: "PUT" });
    // Most RTSP cameras/NVRs on site encode in H.265, which browsers can't decode via
    // HLS/MSE (hls.js) — the <video> element silently stays at 0x0. Register a second,
    // dedicated stream name whose only producer is go2rtc spawning ffmpeg to transcode the
    // raw stream (referenced by alias, so it reuses go2rtc's own connection rather than
    // opening a second one to the camera) to H.264 on demand for browser playback.
    const webParams = new URLSearchParams({ name: `${alias}-web`, src: `ffmpeg:${alias}#video=h264` });
    const webResult = await gatewayRequest(`/api/streams?${webParams.toString()}`, { method: "PUT" });
    const result = webResult.ok ? webResult : rawResult;
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

exports.postWebRtcOffer = async (req, res) => {
    // go2rtc's /api/webrtc (WHEP-style: POST an SDP offer, get an SDP answer) doesn't send
    // CORS headers on its OPTIONS preflight, so browsers block a direct cross-port POST from
    // the frontend. Proxy it server-side instead, where CORS doesn't apply.
    const src = String(req.query.src || "").trim();
    if (!src) return res.status(400).json({ message: "src is required" });
    if (typeof req.body !== "string" || !req.body) return res.status(400).json({ message: "SDP offer body is required" });
    try {
        const params = new URLSearchParams({ src });
        const response = await fetch(`${streamGatewayUrl}/api/webrtc?${params.toString()}`, {
            method: "POST",
            headers: { "content-type": "application/sdp" },
            body: req.body
        });
        const answerSdp = await response.text();
        if (!response.ok) return res.status(response.status).json({ message: answerSdp || "Gateway WebRTC request failed" });
        res.status(200).type("application/sdp").send(answerSdp);
    } catch (error) {
        res.status(502).json({ message: error.message || "Could not reach stream gateway" });
    }
};

exports.syncAllGatewayStreams = syncAllGatewayStreams;
