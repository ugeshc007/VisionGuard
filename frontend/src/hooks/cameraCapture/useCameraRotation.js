import { useRef } from "react";

export function useCameraRotation({ getCameras, onSelect }) {
  const r = useRef({ timer: null, index: -1 }).current;

  function stopRotation() {
    if (r.timer) clearInterval(r.timer);
    r.timer = null;
    r.index = -1;
  }

  function startRotation(getCandidateIds, intervalMs = 6000) {
    stopRotation();
    const rotate = () => {
      // Re-derive candidates fresh every tick (rather than a fixed list captured
      // at start time) so a camera that becomes playable mid-rotation (gateway
      // sync finishes, a new camera is added) gets picked up without needing to
      // restart rotation.
      const playableIds = getCandidateIds().filter((cameraId) => {
        const camera = getCameras().find((item) => item.id === cameraId);
        return camera?.playable && camera?.webrtcUrl;
      });
      if (!playableIds.length) return;
      r.index = (r.index + 1) % playableIds.length;
      onSelect(playableIds[r.index]);
    };
    r.index = -1;
    rotate();
    r.timer = setInterval(rotate, intervalMs);
  }

  return { startRotation, stopRotation };
}
