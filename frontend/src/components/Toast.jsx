import { useUi } from "../context/UiContext.jsx";

export default function Toast() {
  const { toastMessage, toastVisible } = useUi();
  return (
    <div id="toast" className={`toast ${toastVisible ? "show" : ""}`}>{toastMessage}</div>
  );
}
