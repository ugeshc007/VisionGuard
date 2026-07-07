import { useEffect } from "react";
import { useUi } from "../../context/UiContext.jsx";

export default function FaceImageViewerModal() {
  const { faceImageViewer, faceImageZoom, closeFaceImageViewer, setFaceImageZoom } = useUi();
  const open = Boolean(faceImageViewer);

  useEffect(() => {
    function handleKeydown(event) {
      if (event.key === "Escape") closeFaceImageViewer();
    }
    document.addEventListener("keydown", handleKeydown);
    return () => document.removeEventListener("keydown", handleKeydown);
  }, [closeFaceImageViewer]);

  return (
    <div
      id="faceImageViewer"
      className={`image-viewer ${open ? "open" : ""}`}
      aria-hidden={!open}
      onClick={(event) => { if (event.target.id === "faceImageViewer") closeFaceImageViewer(); }}
    >
      <div className="image-viewer-card">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Face image review</span>
            <h2>{faceImageViewer?.title || "Detected face"}</h2>
          </div>
          <button className="ghost" type="button" onClick={closeFaceImageViewer}>Close</button>
        </div>
        <div className="image-viewer-stage">
          <img
            src={faceImageViewer?.src || ""}
            alt="Detected face full preview"
            style={{ transform: `scale(${faceImageZoom})` }}
          />
        </div>
        <div className="viewer-toolbar">
          <button className="ghost" type="button" onClick={() => setFaceImageZoom(faceImageZoom - 0.25)}>Zoom out</button>
          <button className="ghost" type="button" onClick={() => setFaceImageZoom(1)}>Reset</button>
          <button type="button" onClick={() => setFaceImageZoom(faceImageZoom + 0.25)}>Zoom in</button>
        </div>
      </div>
    </div>
  );
}
