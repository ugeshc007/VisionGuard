export function boxIou(a = {}, b = {}) {
  const x1 = Math.max(a.x || 0, b.x || 0);
  const y1 = Math.max(a.y || 0, b.y || 0);
  const x2 = Math.min((a.x || 0) + (a.width || 0), (b.x || 0) + (b.width || 0));
  const y2 = Math.min((a.y || 0) + (a.height || 0), (b.y || 0) + (b.height || 0));
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, a.width || 0) * Math.max(0, a.height || 0);
  const areaB = Math.max(0, b.width || 0) * Math.max(0, b.height || 0);
  return intersection / (areaA + areaB - intersection || 1);
}

export function boxTrackingScore(nextBox = {}, previousBox = {}) {
  const overlap = boxIou(nextBox, previousBox);
  const nextCenter = { x: nextBox.x + nextBox.width / 2, y: nextBox.y + nextBox.height / 2 };
  const previousCenter = { x: previousBox.x + previousBox.width / 2, y: previousBox.y + previousBox.height / 2 };
  const distance = Math.hypot(nextCenter.x - previousCenter.x, nextCenter.y - previousCenter.y);
  const size = Math.max(nextBox.width, nextBox.height, previousBox.width, previousBox.height, 1);
  const centerScore = Math.max(0, 1 - (distance / (size * 1.8)));
  return Math.max(overlap, centerScore * 0.72);
}
