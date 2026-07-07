import { useUi } from "../context/UiContext.jsx";

export default function FaceThumb({ imageUrl, title = "Detected face", alt = "Detected face" }) {
  const { openFaceImageViewer } = useUi();
  if (!imageUrl) return <div className="face-placeholder">?</div>;
  return (
    <button type="button" className="face-thumb-button" onClick={() => openFaceImageViewer(imageUrl, title)}>
      <img src={imageUrl} alt={alt} />
      <span>View</span>
    </button>
  );
}
