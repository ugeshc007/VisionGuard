import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./tailwind.css";

// StrictMode is intentionally omitted: it double-invokes effects in dev, which
// would double-fire the live camera/getUserMedia and auto-capture interval logic.
createRoot(document.getElementById("root")).render(<App />);
