export function attachHls(video, url) {
  if (!video || !url) return null;
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
    video.play().catch(() => {});
    return null;
  }
  if (!window.Hls?.isSupported?.()) return null;
  const player = new window.Hls({
    lowLatencyMode: true,
    liveSyncDurationCount: 2,
    maxLiveSyncPlaybackRate: 1.5
  });
  player.loadSource(url);
  player.attachMedia(video);
  player.on(window.Hls.Events.ERROR, (_event, data) => {
    if (data?.fatal) {
      video.closest(".camera-feed")?.classList.add("stream-error");
    }
  });
  return player;
}
