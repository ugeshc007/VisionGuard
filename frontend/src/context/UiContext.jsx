import { createContext, useCallback, useContext, useRef, useState } from "react";

const UiContext = createContext(null);

export function UiProvider({ children }) {
  const [toastMessage, setToastMessage] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const toastTimer = useRef(null);

  const toast = useCallback((message) => {
    setToastMessage(message);
    setToastVisible(true);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastVisible(false), 2600);
  }, []);

  const [cameraViewerCameraId, setCameraViewerCameraId] = useState(null);
  const openCameraViewer = useCallback((cameraId) => setCameraViewerCameraId(cameraId), []);
  const closeCameraViewer = useCallback(() => setCameraViewerCameraId(null), []);

  const [faceImageViewer, setFaceImageViewer] = useState(null);
  const [faceImageZoom, setFaceImageZoomState] = useState(2.25);
  const openFaceImageViewer = useCallback((src, title = "Detected face") => {
    if (!src) return;
    setFaceImageViewer({ src, title });
    setFaceImageZoomState(2.25);
  }, []);
  const closeFaceImageViewer = useCallback(() => setFaceImageViewer(null), []);
  const setFaceImageZoom = useCallback((value) => {
    setFaceImageZoomState(Math.max(0.5, Math.min(4, Number(value || 1))));
  }, []);

  const value = {
    toastMessage,
    toastVisible,
    toast,
    cameraViewerCameraId,
    openCameraViewer,
    closeCameraViewer,
    faceImageViewer,
    faceImageZoom,
    openFaceImageViewer,
    closeFaceImageViewer,
    setFaceImageZoom
  };

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi() {
  const context = useContext(UiContext);
  if (!context) throw new Error("useUi must be used within UiProvider");
  return context;
}
