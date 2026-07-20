import { padFaceBox } from "./boxGeometry.js";

export function drawFaceBoxes(context, boxes) {
  context.lineWidth = 4;
  context.font = "700 18px system-ui, sans-serif";
  context.textBaseline = "top";
  boxes.forEach((box) => {
    // MediaPipe's raw box is tight around eyes/nose/mouth - pad it out for display
    // so the drawn box actually frames the whole face instead of cropping the
    // forehead/chin, matching the padding already applied to saved face crops.
    const displayBox = padFaceBox(box, context.canvas.width, context.canvas.height);
    const colors = box.state === "known"
      ? { stroke: "#1ce187", fill: "rgba(28, 225, 135, .16)", pill: "rgba(28, 225, 135, .94)" }
      : box.state === "low-confidence"
        ? { stroke: "#ff6b6b", fill: "rgba(255, 107, 107, .12)", pill: "rgba(255, 107, 107, .92)" }
        : box.state === "tracking"
          ? { stroke: "#ffd166", fill: "rgba(255, 209, 102, .14)", pill: "rgba(255, 209, 102, .95)" }
          : { stroke: "#37e7d4", fill: "rgba(55, 231, 212, .16)", pill: "rgba(55, 231, 212, .95)" };
    context.globalAlpha = Number(box.opacity || 1);
    context.strokeStyle = colors.stroke;
    context.fillStyle = colors.fill;
    context.fillRect(displayBox.x, displayBox.y, displayBox.width, displayBox.height);
    context.strokeRect(displayBox.x, displayBox.y, displayBox.width, displayBox.height);
    const label = `${box.label || "Face detected"}${box.confidenceLabel ? ` ${box.confidenceLabel}` : ""}`;
    const textWidth = context.measureText(label).width + 18;
    const labelY = Math.max(0, displayBox.y - 30);
    context.fillStyle = colors.pill;
    context.fillRect(displayBox.x, labelY, textWidth, 26);
    context.fillStyle = "#071019";
    context.fillText(label, displayBox.x + 9, labelY + 4);
    context.globalAlpha = 1;
  });
  context.globalAlpha = 1;
}
