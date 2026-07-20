import { api } from "../../lib/api.js";
import { cosineSimilarity, displayFaceName } from "../../lib/format.js";

export function findBestKnownFace(embedding, faces) {
  let best = null;
  faces.forEach((face) => {
    const isKnown = face.status === "trained" || ["employee", "customer", "known", "watchlist", "blocked"].includes(face.identityResult || "");
    if (!isKnown) return;
    const candidate = Array.isArray(face.embedding) ? face.embedding : [];
    const score = cosineSimilarity(embedding, candidate);
    if (!best || score > best.score) {
      best = { score, personId: face.personId || face.matchedPersonId, label: displayFaceName(face) };
    }
  });
  return best;
}

export async function identifyFaceOnServer(imageData) {
  // The client-side embedding (computeImageEmbedding) is a crude 8x8
  // average-luminance grid - nowhere near good enough to recognize a real
  // face reliably. The backend's /api/forensics/face-search route runs the
  // crop through the real embedding pipeline (InsightFace/embedding
  // service) and compares it against trained people with pgvector cosine
  // similarity, so that's what decides actual identity, not the local grid
  // descriptor above (which only drives fast, latency-free box tracking).
  try {
    const result = await api("/api/forensics/face-search", {
      method: "POST",
      body: JSON.stringify({ imageData })
    });
    const best = (result.matches || [])[0];
    if (!best || !best.personId) return null;
    // The backend's own "reliable match" bar for its capture pipeline is 0.55
    // (real InsightFace/ArcFace cosine similarity on this app's CCTV-angle crops
    // runs genuine same-person pairs around 0.5-0.9, not near 1.0). That pipeline
    // only ever feeds it pre-vetted face crops, though, and live tracking crops
    // aren't vetted at all - a false detection (e.g. a PC case or a reflection)
    // can still embed to *something*, so require a somewhat higher bar here to
    // avoid confidently mislabeling non-face objects with a real person's name.
    if (Number(best.similarity) < 0.6) return null;
    return { personId: best.personId, name: best.displayName || best.label };
  } catch {
    return null;
  }
}

export function requestServerIdentity(liveFaces, track, crop, detectionConfidence = 0) {
  if (!track || track.isKnown) return;
  // Don't bother identifying low-confidence detections - these are the ones
  // most likely to be false positives (round/high-contrast non-face shapes)
  // rather than a real face worth a name lookup.
  if (detectionConfidence < 55) return;
  const now = Date.now();
  if (now - Number(track.serverCheckAt || 0) < 6000) return;
  track.serverCheckAt = now;
  const imageData = crop.canvas.toDataURL("image/jpeg", 0.85);
  identifyFaceOnServer(imageData).then((match) => {
    const current = liveFaces.find((face) => face.trackId === track.trackId);
    if (!current || current.isKnown) return;
    if (!match) {
      current.pendingMatch = null;
      return;
    }
    // Require the same person to come back on two separate lookups before
    // trusting it - a single lookup on a borderline/non-face crop can land
    // above the similarity bar by chance, which is exactly what mislabeled
    // a PC case as a person earlier.
    if (current.pendingMatch?.personId === match.personId) {
      current.isKnown = true;
      current.personId = match.personId;
      current.label = match.name;
    } else {
      current.pendingMatch = match;
    }
  });
}
