import {
  annotationVersion,
  type AnnotationPoint,
  type PhotoAnnotation,
  type PhotoMark,
} from "@home-measure/domain";

export type AnnotationTool = "pen" | "measure" | "note" | "erase";

export const emptyAnnotation: PhotoAnnotation = { version: annotationVersion, marks: [] };

/**
 * Marks are stored as fractions of the photo, so the same sketch lines up whether it is drawn on a
 * phone held sideways or reopened on a wider screen. This converts a pointer position on the
 * displayed image into that space.
 */
export function toAnnotationPoint(
  client: { x: number; y: number; pressure?: number | undefined },
  bounds: { left: number; top: number; width: number; height: number },
): AnnotationPoint {
  if (bounds.width <= 0 || bounds.height <= 0) return { x: 0, y: 0 };
  const point: AnnotationPoint = {
    x: round((client.x - bounds.left) / bounds.width),
    y: round((client.y - bounds.top) / bounds.height),
  };
  // A stylus reports real pressure; browsers report a flat 0.5 for anything else, which says nothing.
  if (client.pressure !== undefined && client.pressure > 0 && client.pressure !== 0.5) {
    return { ...point, pressure: Math.round(client.pressure * 100) / 100 };
  }
  return point;
}

/** Drops the points a finger produces faster than the drawing needs, keeping the stroke light. */
export function appendPoint(points: AnnotationPoint[], next: AnnotationPoint, minimumStep = 0.0015): AnnotationPoint[] {
  const last = points.at(-1);
  if (last && Math.hypot(next.x - last.x, next.y - last.y) < minimumStep) return points;
  return [...points, next];
}

/**
 * Drops marks that carry nothing: a line with no length, a label with no text, a stroke of one
 * point. They can only come from a stray tap, and saving them leaves clutter nobody can select.
 */
export function meaningfulMarks(marks: readonly PhotoMark[], minimumLength = 0.02): PhotoMark[] {
  return marks.filter((mark) => {
    if (mark.kind === "pen") return mark.points.length >= 2;
    if (mark.kind === "note") return mark.text.trim() !== "";
    return Math.hypot(mark.end.x - mark.start.x, mark.end.y - mark.start.y) >= minimumLength;
  });
}

export function penPath(points: readonly AnnotationPoint[], width: number, height: number): string {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${format(point.x * width)} ${format(point.y * height)}`)
    .join(" ");
}

/**
 * Width of the nib at each point. A stylus reports how hard it is pressed; a finger or a mouse does
 * not, so speed stands in for it — a quick stroke thins the way a real pen skips, and a slow,
 * deliberate one stays full. Without this a stroke is a uniform pipe and reads as a computer line.
 */
export function nibWidths(points: readonly AnnotationPoint[], baseWidth: number): number[] {
  let carried = 1;
  return points.map((point, index) => {
    const previous = points[Math.max(0, index - 1)]!;
    const speed = Math.hypot(point.x - previous.x, point.y - previous.y);
    const fromSpeed = clamp(1.1 - speed * 9, 0.55, 1.1);
    const target = point.pressure === undefined ? fromSpeed : 0.35 + point.pressure * 1.1;
    // Ease into the taper so the nib never jumps between neighbouring points.
    carried = index === 0 ? target : carried + (target - carried) * 0.45;
    return baseWidth * carried;
  });
}

/**
 * The stroke as a filled shape rather than a stroked line, which is what lets it change width along
 * its length. Both sides are walked with quadratic curves through the midpoints, so the edge stays
 * smooth between the points the screen actually sampled.
 */
export function inkOutline(
  points: readonly AnnotationPoint[],
  scale: { width: number; height: number },
  baseWidth: number,
): string {
  if (points.length < 2) return "";
  const widths = nibWidths(points, baseWidth);
  const left: Array<{ x: number; y: number }> = [];
  const right: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const previous = points[Math.max(0, index - 1)]!;
    const next = points[Math.min(points.length - 1, index + 1)]!;
    const spanX = (next.x - previous.x) * scale.width;
    const spanY = (next.y - previous.y) * scale.height;
    const length = Math.hypot(spanX, spanY) || 1;
    const normalX = -spanY / length;
    const normalY = spanX / length;
    const half = widths[index]! / 2;
    const x = point.x * scale.width;
    const y = point.y * scale.height;
    left.push({ x: x + normalX * half, y: y + normalY * half });
    right.push({ x: x - normalX * half, y: y - normalY * half });
  }
  return `${smoothSide(left)} ${smoothSide([...right].reverse()).replace("M", "L")} Z`;
}

function smoothSide(side: ReadonlyArray<{ x: number; y: number }>): string {
  const first = side[0]!;
  if (side.length === 1) return `M ${format(first.x)} ${format(first.y)}`;
  let path = `M ${format(first.x)} ${format(first.y)}`;
  for (let index = 1; index < side.length - 1; index += 1) {
    const point = side[index]!;
    const following = side[index + 1]!;
    path += ` Q ${format(point.x)} ${format(point.y)} ${format((point.x + following.x) / 2)} ${format((point.y + following.y) / 2)}`;
  }
  const last = side[side.length - 1]!;
  return `${path} L ${format(last.x)} ${format(last.y)}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Length of a measurement line on screen, used to place its label clear of the line. */
export function markMidpoint(mark: { start: AnnotationPoint; end: AnnotationPoint }): AnnotationPoint {
  return { x: (mark.start.x + mark.end.x) / 2, y: (mark.start.y + mark.end.y) / 2 };
}

/** The mark nearest a point, so tapping with the eraser removes what the user aimed at. */
export function markAt(marks: readonly PhotoMark[], point: AnnotationPoint, reach = 0.05): PhotoMark | null {
  let closest: { mark: PhotoMark; distance: number } | null = null;
  for (const mark of marks) {
    const distance = distanceToMark(mark, point);
    if (distance > reach) continue;
    if (!closest || distance < closest.distance) closest = { mark, distance };
  }
  return closest?.mark ?? null;
}

function distanceToMark(mark: PhotoMark, point: AnnotationPoint): number {
  if (mark.kind === "note") return Math.hypot(mark.position.x - point.x, mark.position.y - point.y);
  if (mark.kind === "measure") return distanceToSegment(point, mark.start, mark.end);
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < mark.points.length; index += 1) {
    closest = Math.min(closest, distanceToSegment(point, mark.points[index - 1]!, mark.points[index]!));
  }
  return closest;
}

function distanceToSegment(point: AnnotationPoint, start: AnnotationPoint, end: AnnotationPoint): number {
  const spanX = end.x - start.x;
  const spanY = end.y - start.y;
  const lengthSquared = spanX * spanX + spanY * spanY;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const along = Math.max(0, Math.min(1, ((point.x - start.x) * spanX + (point.y - start.y) * spanY) / lengthSquared));
  return Math.hypot(point.x - (start.x + along * spanX), point.y - (start.y + along * spanY));
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
