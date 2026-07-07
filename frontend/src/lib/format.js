export function statusClass(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "-");
}

export function localizeGatewayUrl(value = "") {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.hostname === "stream-gateway") {
      url.hostname = location.hostname;
    }
    if (["127.0.0.1", "localhost"].includes(url.hostname) && !["127.0.0.1", "localhost"].includes(location.hostname)) {
      url.hostname = location.hostname;
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function formatDuration(seconds = 0) {
  const value = Number(seconds || 0);
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  const remaining = value % 60;
  if (minutes < 60) return `${minutes}m ${remaining}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatConfidence(score) {
  const value = Number(score || 0);
  if (!value) return "0%";
  return `${Math.round(value * 100)}%`;
}

export function formatDisplayDate(value = "") {
  const [year, month, day] = String(value).split("-");
  return year && month && day ? `${day}-${month}-${year}` : value;
}

export function cameraRoleLabel(role = "area") {
  return {
    area: "Area monitor",
    entry: "Entry camera",
    exit: "Exit camera"
  }[role] || "Area monitor";
}

export function initials(name = "") {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "?";
}

export function displayFaceName(face = {}) {
  return face.matchedPersonName || face.personName || face.label || "Known face";
}

export function isBrowserLocalCamera(camera = {}) {
  return String(camera.streamUrl || "").startsWith("local://");
}

export function isRemoteFrameCamera(camera = {}) {
  return /^(rtsp|rtsps|http|https):\/\//i.test(String(camera.streamUrl || ""));
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += Number(a[index] || 0) * Number(b[index] || 0);
    magA += Number(a[index] || 0) ** 2;
    magB += Number(b[index] || 0) ** 2;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

export function makeVisitorCode(serialRef, index = 0) {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  serialRef.current = (Number(serialRef.current || 0) % 9999) + 1;
  const serial = String(serialRef.current + index).padStart(4, "0");
  return `VIS-${date}-${serial}`;
}
