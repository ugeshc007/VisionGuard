import { cosineSimilarity, makeVisitorCode } from "../../lib/format.js";
import { boxTrackingScore } from "./boxGeometry.js";
import { cropFace, computeImageEmbedding, blendEmbedding } from "./faceEmbedding.js";
import { findBestKnownFace, requestServerIdentity } from "./faceRecognition.js";

function createTrackingState() {
  return { liveFaces: [], lastTrackedBoxes: [] };
}

function findTrack(trackingState, trackId) {
  return trackingState.liveFaces.find((face) => face.trackId === trackId);
}

function isTrackRecentlyCaptured(trackingState, trackId) {
  const track = findTrack(trackingState, trackId);
  return Boolean(track?.savedAt && Date.now() - track.savedAt < 30 * 60 * 1000);
}

function markTracksCaptured(trackingState, trackIds = []) {
  const now = Date.now();
  const ids = new Set(trackIds.filter(Boolean));
  trackingState.liveFaces.forEach((face) => {
    if (ids.has(face.trackId)) face.savedAt = now;
  });
}

function filterNewFaceCandidates(trackingState, knownFaces, candidates) {
  const knownEmbeddings = knownFaces
    .map((face) => Array.isArray(face.embedding) ? face.embedding : [])
    .filter((embedding) => embedding.length);
  const accepted = [];
  return candidates.filter((candidate) => {
    if (candidate.trackId && isTrackRecentlyCaptured(trackingState, candidate.trackId)) return false;
    const bestStored = Math.max(0, ...knownEmbeddings.map((embedding) => cosineSimilarity(candidate.embedding, embedding)));
    if (bestStored >= 0.94) return false;
    const bestCurrentFrame = Math.max(0, ...accepted.map((embedding) => cosineSimilarity(candidate.embedding, embedding)));
    if (bestCurrentFrame >= 0.985) return false;
    accepted.push(candidate.embedding);
    return true;
  });
}

function summarizeSkippedFaces(skippedFaces = []) {
  if (!Array.isArray(skippedFaces) || !skippedFaces.length) return "";
  const first = skippedFaces[0] || {};
  const reason = [first.reason, first.detail].filter(Boolean).join(": ");
  return reason ? `First skipped reason: ${reason}.` : "";
}

function findBestLiveTrack(trackingState, box, embedding, usedTrackIds = new Set()) {
  let best = null;
  trackingState.liveFaces.forEach((face) => {
    if (usedTrackIds.has(face.trackId)) return;
    const embedScore = cosineSimilarity(embedding, face.embedding);
    const boxScore = face.box ? boxTrackingScore(box, face.box) : 0;
    const sameAppearance = embedScore >= 0.94;
    const sameMovingFace = boxScore >= 0.68 && embedScore >= 0.82;
    if (!sameAppearance && !sameMovingFace) return;
    const score = (embedScore * 0.7) + (boxScore * 0.3);
    if (!best || score > best.score) best = { ...face, score, embedScore, boxScore };
  });
  return best;
}

function resolveLiveFaceLabels(trackingState, knownFaces, visitorSerial, context, boxes) {
  const now = Date.now();
  trackingState.liveFaces = trackingState.liveFaces.filter((face) => now - face.lastSeen < 120000);
  const usedTrackIds = new Set();
  boxes.forEach((box, index) => {
    const crop = cropFace(context, box);
    const embedding = computeImageEmbedding(crop.context, crop.width, crop.height);
    const known = findBestKnownFace(embedding, knownFaces);
    if (known && known.score >= 0.985) {
      box.label = known.label;
      box.isKnown = true;
      box.state = "known";
      box.confidenceLabel = `${Math.round(known.score * 100)}%`;
      box.trackId = known.personId || known.label;
      const existingKnownTrack = trackingState.liveFaces.find((face) => face.personId && face.personId === known.personId);
      if (existingKnownTrack) {
        Object.assign(existingKnownTrack, { label: known.label, embedding, box: { ...box }, lastSeen: now, isKnown: true, personId: known.personId });
        usedTrackIds.add(existingKnownTrack.trackId);
      } else {
        const trackId = known.personId || `known-${known.label}`;
        trackingState.liveFaces.push({ trackId, personId: known.personId, label: known.label, embedding, box: { ...box }, lastSeen: now, isKnown: true, savedAt: now });
        usedTrackIds.add(trackId);
      }
      return;
    }
    const recent = findBestLiveTrack(trackingState, box, embedding, usedTrackIds);
    if (recent && recent.score >= 0.78) {
      const track = trackingState.liveFaces.find((face) => face.trackId === recent.trackId);
      if (track) {
        track.lastSeen = now;
        track.embedding = blendEmbedding(track.embedding, embedding);
        track.box = { ...box };
        usedTrackIds.add(track.trackId);
        box.label = track.label;
        box.trackId = track.trackId;
        box.isKnown = Boolean(track.isKnown);
        box.state = track.isKnown ? "known" : "tracking";
        box.confidenceLabel = recent.score ? `${Math.round(recent.score * 100)}%` : "";
        requestServerIdentity(trackingState.liveFaces, track, crop, box.confidence);
        return;
      }
    }
    const label = makeVisitorCode(visitorSerial, index);
    const trackId = `track-${Date.now()}-${index}-${Math.random().toString(16).slice(2, 6)}`;
    const newTrack = { trackId, label, embedding, box: { ...box }, lastSeen: now, isKnown: false, savedAt: 0 };
    trackingState.liveFaces.push(newTrack);
    usedTrackIds.add(trackId);
    requestServerIdentity(trackingState.liveFaces, newTrack, crop, box.confidence);
    box.label = label;
    box.trackId = trackId;
    box.isKnown = false;
    box.state = "new";
    box.confidenceLabel = "new";
  });
}

function stabilizeFaceBoxes(trackingState, knownFaces, visitorSerial, context, boxes = []) {
  const now = Date.now();
  if (boxes.length) {
    resolveLiveFaceLabels(trackingState, knownFaces, visitorSerial, context, boxes);
    trackingState.lastTrackedBoxes = boxes.map((box) => {
      const previous = trackingState.lastTrackedBoxes.find((item) => item.trackId && item.trackId === box.trackId);
      if (!previous) return { ...box, lastSeen: now };
      return {
        ...box,
        x: (previous.x * 0.45) + (box.x * 0.55),
        y: (previous.y * 0.45) + (box.y * 0.55),
        width: (previous.width * 0.35) + (box.width * 0.65),
        height: (previous.height * 0.35) + (box.height * 0.65),
        lastSeen: now
      };
    });
    return boxes;
  }
  trackingState.lastTrackedBoxes = trackingState.lastTrackedBoxes.filter((box) => now - Number(box.lastSeen || 0) < 4200);
  return trackingState.lastTrackedBoxes.map((box) => ({
    ...box,
    confidence: Math.max(40, Number(box.confidence || 0) - 10),
    opacity: Math.max(0.35, 1 - ((now - Number(box.lastSeen || 0)) / 4200)),
    isKnown: box.isKnown,
    state: box.state || (box.isKnown ? "known" : "tracking"),
    confidenceLabel: box.confidenceLabel || "",
    label: box.label || "Tracking"
  }));
}

// Single entry point for this module: callers get a tracker bound to its own
// internal live-track state, without needing to pass trackingState around themselves.
export function createFaceTracker() {
  const trackingState = createTrackingState();
  return {
    stabilize: (knownFaces, visitorSerial, context, boxes) => stabilizeFaceBoxes(trackingState, knownFaces, visitorSerial, context, boxes),
    isRecentlyCaptured: (trackId) => isTrackRecentlyCaptured(trackingState, trackId),
    markCaptured: (trackIds) => markTracksCaptured(trackingState, trackIds),
    filterNewCandidates: (knownFaces, candidates) => filterNewFaceCandidates(trackingState, knownFaces, candidates),
    summarizeSkipped: (skippedFaces) => summarizeSkippedFaces(skippedFaces),
    clearTrackedBoxes: () => { trackingState.lastTrackedBoxes = []; }
  };
}
