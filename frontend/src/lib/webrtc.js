// go2rtc exposes a WHEP-style endpoint: POST an SDP offer, get an SDP answer back, no
// separate signaling channel needed. Preferred over hls.js for browser preview here —
// go2rtc's live HLS remux of an ffmpeg-transcoded stream reliably throws a fatal
// hls.js fragParsingError, whereas WebRTC uses the browser's native RTP/H.264 decode path.
export function attachWebRTC(video, url) {
  if (!video || !url || !window.RTCPeerConnection) return null;
  const pc = new RTCPeerConnection();
  let stopped = false;

  pc.ontrack = (event) => {
    if (stopped) return;
    video.srcObject = event.streams[0];
    video.play().catch(() => {});
  };
  pc.oniceconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(pc.iceConnectionState)) {
      video.closest(".camera-feed")?.classList.add("stream-error");
    }
  };

  pc.addTransceiver("video", { direction: "recvonly" });

  (async () => {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);
    if (stopped) return;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: pc.localDescription.sdp
    });
    if (!response.ok) throw new Error(`WebRTC gateway returned ${response.status}`);
    const answerSdp = await response.text();
    if (stopped) return;
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  })().catch(() => {
    video.closest(".camera-feed")?.classList.add("stream-error");
  });

  return {
    destroy() {
      stopped = true;
      pc.close();
    }
  };
}

function waitForIceGatheringComplete(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    pc.addEventListener("icegatheringstatechange", function onChange() {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    });
  });
}
