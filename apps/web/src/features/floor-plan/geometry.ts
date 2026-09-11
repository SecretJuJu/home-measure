import type {
  DoorElement,
  RoomCorner,
  RoomLayout,
  RoomNotch,
  UtilityElement,
  Wall,
  WindowElement,
} from "@home-measure/domain";

export type { RoomCorner, Wall };

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WallSegment {
  wall: Wall;
  start: Point;
  end: Point;
  length: number;
}

export interface WallTarget {
  wall: Wall;
  offset: number;
  distance: number;
}

export interface DoorGeometry {
  hinge: Point;
  closedEnd: Point;
  openEnd: Point;
  radius: number;
  sweep: 0 | 1;
  arcPath: string;
}

export interface SvgViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An alignment line shown while a room snaps to another room. */
export interface SnapGuide {
  axis: "x" | "y";
  position: number;
  from: number;
  to: number;
}

export interface RoomSnap {
  position: Point;
  guides: SnapGuide[];
}

export interface RoomResize {
  rect: Rect;
  guides: SnapGuide[];
}

export interface NeighborRoom {
  id: string;
  name: string;
  rect: Rect;
}

/** The free distance between one wall of a room and the closest room facing it. */
export interface RoomGap {
  wall: Wall;
  distance: number;
  neighbor: NeighborRoom;
  start: Point;
  end: Point;
}

const outerWalls: readonly Wall[] = ["north", "east", "south", "west"];
const notchWalls: readonly Wall[] = ["notchVertical", "notchHorizontal"];

export const minViewportWidth = 800;
export const maxViewportWidth = 160_000;
/** Dragging a corner never collapses a room below a size a person could stand in. */
export const minimumRoomSize = 500;

export const roomCorners: readonly RoomCorner[] = ["northWest", "northEast", "southEast", "southWest"];

const gridSteps: readonly number[] = [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000];

export function roomRect(layout: RoomLayout): Rect {
  return {
    x: layout.position.x,
    y: layout.position.y,
    width: layout.size.width,
    height: layout.size.height,
  };
}

/** Every wall that exists on this room, clockwise, including the inner pair a notch creates. */
export function roomWalls(layout: RoomLayout): Wall[] {
  return layout.notch ? [...outerWalls, ...notchWalls] : [...outerWalls];
}

/** The rectangular bite a notch takes out of the room, in plan coordinates. */
export function notchRect(layout: RoomLayout): Rect | null {
  const notch = layout.notch;
  if (!notch) return null;
  const { x, y } = layout.position;
  const { width, height } = layout.size;
  const west = notch.corner === "northWest" || notch.corner === "southWest";
  const north = notch.corner === "northWest" || notch.corner === "northEast";
  return {
    x: west ? x : x + width - notch.width,
    y: north ? y : y + height - notch.height,
    width: notch.width,
    height: notch.height,
  };
}

/**
 * The wall direction follows the room perimeter clockwise, keeping placement deterministic.
 * A notch shortens the two outer walls meeting at its corner and inserts the two inner walls
 * between them, so the clockwise walk still closes.
 */
export function wallSegment(layout: RoomLayout, wall: Wall): WallSegment {
  const { x, y } = layout.position;
  const { width, height } = layout.size;
  const notch = layout.notch;
  const cutAt = (...corners: RoomCorner[]) => (notch && corners.includes(notch.corner) ? notch : null);
  const northWest = cutAt("northWest");
  const northEast = cutAt("northEast");
  const southEast = cutAt("southEast");
  const southWest = cutAt("southWest");
  switch (wall) {
    case "north": return segment(wall,
      { x: x + (northWest?.width ?? 0), y },
      { x: x + width - (northEast?.width ?? 0), y });
    case "east": return segment(wall,
      { x: x + width, y: y + (northEast?.height ?? 0) },
      { x: x + width, y: y + height - (southEast?.height ?? 0) });
    case "south": return segment(wall,
      { x: x + width - (southEast?.width ?? 0), y: y + height },
      { x: x + (southWest?.width ?? 0), y: y + height });
    case "west": return segment(wall,
      { x, y: y + height - (southWest?.height ?? 0) },
      { x, y: y + (northWest?.height ?? 0) });
    case "notchVertical":
    case "notchHorizontal": {
      const walk = notchWalk(layout);
      if (!walk) return segment(wall, { x, y }, { x, y });
      const vertical = walk.verticalFirst
        ? { start: walk.entry, end: walk.inner }
        : { start: walk.inner, end: walk.exit };
      const horizontal = walk.verticalFirst
        ? { start: walk.inner, end: walk.exit }
        : { start: walk.entry, end: walk.inner };
      const chosen = wall === "notchVertical" ? vertical : horizontal;
      return segment(wall, chosen.start, chosen.end);
    }
  }
  throw new Error("Unknown wall");
}

/** Clockwise order of the walls, with the notch pair spliced in where it interrupts the perimeter. */
export function roomOutline(layout: RoomLayout): Point[] {
  const walk = notchWalk(layout);
  if (!walk) return outerWalls.map((wall) => wallSegment(layout, wall).start);
  const pair: Wall[] = walk.verticalFirst ? ["notchVertical", "notchHorizontal"] : ["notchHorizontal", "notchVertical"];
  const order = outerWalls.flatMap((wall) => (wall === walk.after ? [wall, ...pair] : [wall]));
  return order.map((wall) => wallSegment(layout, wall).start);
}

export function roomOutlinePath(layout: RoomLayout): string {
  const points = roomOutline(layout);
  return `${points.map((point, index) => `${index === 0 ? "M" : "L"} ${format(point.x)} ${format(point.y)}`).join(" ")} Z`;
}

/**
 * The biggest full rectangle inside the room, so a label never sits in the corner that was cut
 * away. An L always contains two such strips; the wider one wins.
 */
export function roomLabelBox(layout: RoomLayout): Rect {
  const rect = roomRect(layout);
  const notch = layout.notch;
  if (!notch) return rect;
  const north = notch.corner === "northWest" || notch.corner === "northEast";
  const west = notch.corner === "northWest" || notch.corner === "southWest";
  const band: Rect = { x: rect.x, y: north ? rect.y + notch.height : rect.y, width: rect.width, height: rect.height - notch.height };
  const column: Rect = { x: west ? rect.x + notch.width : rect.x, y: rect.y, width: rect.width - notch.width, height: rect.height };
  return band.width * band.height >= column.width * column.height ? band : column;
}

/** The reflex corner a notch creates, which is the point the user drags to reshape the L. */
export function notchInnerCorner(layout: RoomLayout): Point | null {
  return notchWalk(layout)?.inner ?? null;
}

/** The unit vector an offset grows along, following the same clockwise perimeter as wallSegment. */
export function wallDirection(layout: RoomLayout, wall: Wall): Point {
  return unitDirection(wallSegment(layout, wall));
}

export function wallPoint(layout: RoomLayout, wall: Wall, offset: number): Point {
  const segment = wallSegment(layout, wall);
  const safeOffset = clamp(offset, 0, segment.length);
  const direction = unitDirection(segment);
  return {
    x: segment.start.x + direction.x * safeOffset,
    y: segment.start.y + direction.y * safeOffset,
  };
}

export function wallElementPoints(
  layout: RoomLayout,
  element: Pick<DoorElement | WindowElement, "wall" | "offset" | "width">,
): { start: Point; end: Point } {
  return {
    start: wallPoint(layout, element.wall, element.offset),
    end: wallPoint(layout, element.wall, element.offset + element.width),
  };
}

/** Returns a wall only when the point projects inside the actual segment (including endpoints). */
export function targetWall(layout: RoomLayout, point: Point, maxDistance = 180): WallTarget | null {
  let closest: WallTarget | null = null;
  for (const wall of roomWalls(layout)) {
    const segment = wallSegment(layout, wall);
    const direction = unitDirection(segment);
    const projected = (point.x - segment.start.x) * direction.x + (point.y - segment.start.y) * direction.y;
    if (projected < 0 || projected > segment.length) continue;
    const projectedPoint = {
      x: segment.start.x + direction.x * projected,
      y: segment.start.y + direction.y * projected,
    };
    const distance = Math.hypot(point.x - projectedPoint.x, point.y - projectedPoint.y);
    if (distance <= maxDistance && (!closest || distance < closest.distance)) {
      closest = { wall, offset: projected, distance };
    }
  }
  return closest;
}

export function doorGeometry(layout: RoomLayout, door: DoorElement): DoorGeometry {
  const start = wallPoint(layout, door.wall, door.offset);
  const end = wallPoint(layout, door.wall, door.offset + door.width);
  const hinge = door.hinge === "left" ? start : end;
  const closedEnd = door.hinge === "left" ? end : start;
  const closedVector = { x: closedEnd.x - hinge.x, y: closedEnd.y - hinge.y };
  const turn = doorTurn(door.hinge, door.opening);
  const openVector = turn > 0
    ? { x: -closedVector.y, y: closedVector.x }
    : { x: closedVector.y, y: -closedVector.x };
  const openEnd = { x: hinge.x + openVector.x, y: hinge.y + openVector.y };
  const radius = Math.hypot(closedVector.x, closedVector.y);
  const sweep: 0 | 1 = turn > 0 ? 1 : 0;
  return {
    hinge,
    closedEnd,
    openEnd,
    radius,
    sweep,
    arcPath: `M ${format(hinge.x)} ${format(hinge.y)} A ${format(radius)} ${format(radius)} 0 0 ${sweep} ${format(openEnd.x)} ${format(openEnd.y)}`,
  };
}

/** Updates a room position without allowing a negative floor-plan origin. */
export function moveRoom(layout: RoomLayout, delta: Point): RoomLayout {
  return {
    ...layout,
    position: {
      x: Math.max(0, Math.round(layout.position.x + delta.x)),
      y: Math.max(0, Math.round(layout.position.y + delta.y)),
    },
  };
}

export function clampWallElement<T extends Pick<DoorElement | WindowElement, "wall" | "offset" | "width">>(
  layout: RoomLayout,
  element: T,
): T {
  const length = wallSegment(layout, element.wall).length;
  const width = clamp(Math.round(element.width), 1, length);
  return { ...element, width, offset: clamp(Math.round(element.offset), 0, length - width) };
}

/** Keeps an in-room utility marker inside the room, and out of the corner a notch cut away. */
export function clampUtilityPosition(layout: RoomLayout, position: Point): Point {
  const rect = roomRect(layout);
  const inside = {
    x: clamp(Math.round(position.x), rect.x, rect.x + rect.width),
    y: clamp(Math.round(position.y), rect.y, rect.y + rect.height),
  };
  const cut = notchRect(layout);
  if (!cut || !rectsOverlap({ ...inside, width: 0, height: 0 }, cut)) return inside;
  // Push it out through whichever inner wall is closer, so the marker lands back in the L.
  const inner = notchInnerCorner(layout);
  if (!inner) return inside;
  return Math.abs(inside.x - inner.x) < Math.abs(inside.y - inner.y)
    ? { x: inner.x, y: inside.y }
    : { x: inside.x, y: inner.y };
}

/**
 * Changes a room's dimensions and revalidates the notch and every element against the smaller
 * (or larger) set of legal walls and interior bounds.
 */
export function resizeRoom(layout: RoomLayout, size: RoomLayout["size"]): RoomLayout {
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  const resized: RoomLayout = { ...layout, size: { width, height } };
  const notch = clampNotch(resized, layout.notch);
  const bounded: RoomLayout = notch ? { ...resized, notch } : withoutNotch(resized);
  return {
    ...bounded,
    doors: layout.doors.map((door) => clampWallElement(bounded, door)),
    windows: layout.windows.map((window) => clampWallElement(bounded, window)),
    utilities: layout.utilities.map((utility) => ({ ...utility, position: clampUtilityPosition(bounded, utility.position) })),
  };
}

/**
 * Cuts, reshapes or removes the corner notch. Removing it drops the doors and windows that were
 * hanging on the inner walls, because those walls stop existing.
 */
export function setRoomNotch(layout: RoomLayout, notch: RoomNotch | null): RoomLayout {
  const clamped = notch ? clampNotch(layout, notch) : null;
  const next: RoomLayout = clamped ? { ...layout, notch: clamped } : withoutNotch(layout);
  const onLiveWall = <T extends DoorElement | WindowElement>(element: T) =>
    clamped !== null || (element.wall !== "notchHorizontal" && element.wall !== "notchVertical");
  return {
    ...next,
    doors: next.doors.filter(onLiveWall).map((door) => clampWallElement(next, door)),
    windows: next.windows.filter(onLiveWall).map((window) => clampWallElement(next, window)),
    utilities: next.utilities.map((utility) => ({ ...utility, position: clampUtilityPosition(next, utility.position) })),
  };
}

/** A notch has to leave a strip of room on both axes, otherwise the L degenerates into a rectangle. */
function clampNotch(layout: RoomLayout, notch: RoomNotch | undefined): RoomNotch | null {
  if (!notch) return null;
  const width = clamp(Math.round(notch.width), 1, layout.size.width - minimumRoomSize);
  const height = clamp(Math.round(notch.height), 1, layout.size.height - minimumRoomSize);
  if (width < 1 || height < 1) return null;
  return { corner: notch.corner, width, height };
}

function withoutNotch(layout: RoomLayout): RoomLayout {
  const rest = { ...layout };
  delete rest.notch;
  return rest;
}

/** Moves a wall element by its centre while preserving its attached wall and legal offset. */
export function moveWallElement<T extends DoorElement | WindowElement>(layout: RoomLayout, element: T, point: Point): T {
  const segment = wallSegment(layout, element.wall);
  const direction = unitDirection(segment);
  const projected = (point.x - segment.start.x) * direction.x + (point.y - segment.start.y) * direction.y;
  return clampWallElement(layout, { ...element, offset: Math.round(projected - element.width / 2) });
}

export function pointFromClient(
  client: Point,
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  viewBox: SvgViewport,
): Point {
  return {
    x: viewBox.x + ((client.x - bounds.left) / bounds.width) * viewBox.width,
    y: viewBox.y + ((client.y - bounds.top) / bounds.height) * viewBox.height,
  };
}

export function floorPlanViewport(layouts: RoomLayout[], padding = 700): SvgViewport {
  if (layouts.length === 0) return { x: 0, y: 0, width: 10_000, height: 7_000 };
  const rects = layouts.map(roomRect);
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: Math.max(0, minX - padding), y: Math.max(0, minY - padding), width: maxX - minX + padding * 2, height: maxY - minY + padding * 2 };
}

/**
 * Scales a viewport so `anchor` lands at `ratio`, the relative position of the gesture inside the
 * canvas. Every pinch frame recomputes this from the viewport the gesture started with, so two
 * fingers reported in the same frame cannot each apply the zoom on top of a half-updated view.
 */
export function pinchViewport(start: SvgViewport, scale: number, anchor: Point, ratio: Point): SvgViewport {
  const aspect = start.height / start.width;
  const width = clamp(start.width / scale, minViewportWidth, maxViewportWidth);
  const height = width * aspect;
  return {
    x: Math.round(anchor.x - ratio.x * width),
    y: Math.round(anchor.y - ratio.y * height),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/** Zooms around a plan point so whatever sits under the pointer or fingers stays in place. */
export function zoomViewport(viewport: SvgViewport, factor: number, focus: Point): SvgViewport {
  return pinchViewport(viewport, factor, focus, {
    x: (focus.x - viewport.x) / viewport.width,
    y: (focus.y - viewport.y) / viewport.height,
  });
}

export function panViewport(viewport: SvgViewport, delta: Point): SvgViewport {
  return { ...viewport, x: Math.round(viewport.x + delta.x), y: Math.round(viewport.y + delta.y) };
}

/** The snap pull follows the visible area, so it feels identical at every zoom level. */
export function snapTolerance(viewport: SvgViewport): number {
  return clamp(viewport.width * 0.02, 20, 600);
}

/**
 * How many plan units one screen pixel covers. Labels and handles are written in real pixels and
 * multiplied by this, so they stay the same size on screen at any zoom and on any canvas width.
 */
export function unitsPerPixel(viewport: SvgViewport, canvasWidth: number): number {
  return viewport.width / (canvasWidth > 0 ? canvasWidth : 1_000);
}

export function planGridStep(viewport: SvgViewport, maxLines = 16): number {
  const step = gridSteps.find((candidate) => viewport.width / candidate <= maxLines);
  return step ?? 25_000;
}

/** Pulls a dragged room onto the edges and centres of the other rooms, like a design tool. */
export function snapRoomPosition(rect: Rect, others: readonly Rect[], tolerance: number): RoomSnap {
  const horizontal = axisSnap(rect, others, tolerance, "x");
  const vertical = axisSnap(rect, others, tolerance, "y");
  const guides: SnapGuide[] = [];
  if (horizontal.guide) guides.push(horizontal.guide);
  if (vertical.guide) guides.push(vertical.guide);
  return {
    position: {
      x: Math.max(0, Math.round(rect.x + horizontal.delta)),
      y: Math.max(0, Math.round(rect.y + vertical.delta)),
    },
    guides,
  };
}

/** Touching edges are not an overlap: adjacent rooms in a home share a wall. */
export function rectsOverlap(left: Rect, right: Rect): boolean {
  return left.x < right.x + right.width && right.x < left.x + left.width
    && left.y < right.y + right.height && right.y < left.y + left.height;
}

export function cornerPoint(rect: Rect, corner: RoomCorner): Point {
  return {
    x: corner === "northWest" || corner === "southWest" ? rect.x : rect.x + rect.width,
    y: corner === "northWest" || corner === "northEast" ? rect.y : rect.y + rect.height,
  };
}

/**
 * Drags one corner while the opposite one stays put, then pulls the two moving edges onto the
 * edges of nearby rooms so a resized room lines up the same way a dragged one does.
 */
export function resizeRoomCorner(
  rect: Rect,
  corner: RoomCorner,
  point: Point,
  others: readonly Rect[],
  tolerance: number,
): RoomResize {
  const west = corner === "northWest" || corner === "southWest";
  const north = corner === "northWest" || corner === "northEast";
  const anchor = { x: west ? rect.x + rect.width : rect.x, y: north ? rect.y + rect.height : rect.y };
  const horizontal = edgeSnap(point.x, others.flatMap((other) => [other.x, other.x + other.width]), tolerance);
  const vertical = edgeSnap(point.y, others.flatMap((other) => [other.y, other.y + other.height]), tolerance);
  const x = clamp(horizontal.value, west ? 0 : anchor.x + minimumRoomSize, west ? anchor.x - minimumRoomSize : Number.MAX_SAFE_INTEGER);
  const y = clamp(vertical.value, north ? 0 : anchor.y + minimumRoomSize, north ? anchor.y - minimumRoomSize : Number.MAX_SAFE_INTEGER);
  const resized: Rect = {
    x: Math.round(Math.min(x, anchor.x)),
    y: Math.round(Math.min(y, anchor.y)),
    width: Math.round(Math.abs(anchor.x - x)),
    height: Math.round(Math.abs(anchor.y - y)),
  };
  const guides: SnapGuide[] = [];
  if (horizontal.matched && x === horizontal.value) guides.push({ axis: "x", position: Math.round(x), from: Math.round(resized.y), to: Math.round(resized.y + resized.height) });
  if (vertical.matched && y === vertical.value) guides.push({ axis: "y", position: Math.round(y), from: Math.round(resized.x), to: Math.round(resized.x + resized.width) });
  return { rect: resized, guides };
}

/** Measures each wall against the nearest room that actually faces it. */
export function roomGaps(rect: Rect, neighbors: readonly NeighborRoom[]): RoomGap[] {
  const gaps: RoomGap[] = [];
  for (const wall of outerWalls) {
    let closest: { neighbor: NeighborRoom; distance: number; overlapCentre: number } | null = null;
    for (const neighbor of neighbors) {
      const measured = wallGap(rect, neighbor.rect, wall);
      if (!measured) continue;
      if (!closest || measured.distance < closest.distance) closest = { neighbor, ...measured };
    }
    if (!closest) continue;
    gaps.push({
      wall,
      distance: Math.round(closest.distance),
      neighbor: closest.neighbor,
      ...gapLine(rect, closest.neighbor.rect, wall, Math.round(closest.overlapCentre)),
    });
  }
  return gaps;
}

/** Returns the room position that leaves exactly the requested gap against one neighbour. */
export function positionForGap(rect: Rect, wall: Wall, distance: number, neighbor: Rect): Point {
  const gap = Math.max(0, Math.round(distance));
  switch (wall) {
    case "north": return { x: rect.x, y: Math.max(0, neighbor.y + neighbor.height + gap) };
    case "south": return { x: rect.x, y: Math.max(0, neighbor.y - gap - rect.height) };
    case "west": return { x: Math.max(0, neighbor.x + neighbor.width + gap), y: rect.y };
    case "east": return { x: Math.max(0, neighbor.x - gap - rect.width), y: rect.y };
  }
  throw new Error("Unknown wall");
}

export function utilityLabel(utility: Pick<UtilityElement, "type">): string {
  const labels: Record<UtilityElement["type"], string> = {
    outlet: "콘센트",
    lan: "LAN",
    water: "수도",
    drain: "배수구",
    gas: "가스",
    boiler: "보일러",
    ac: "에어컨",
    interphone: "인터폰",
  };
  return labels[utility.type];
}

function axisSnap(
  rect: Rect,
  others: readonly Rect[],
  tolerance: number,
  axis: "x" | "y",
): { delta: number; guide: SnapGuide | null } {
  const start = axis === "x" ? rect.x : rect.y;
  const size = axis === "x" ? rect.width : rect.height;
  const anchors = [start, start + size / 2, start + size];
  let closest: { delta: number; position: number; other: Rect } | null = null;
  for (const other of others) {
    const otherStart = axis === "x" ? other.x : other.y;
    const otherSize = axis === "x" ? other.width : other.height;
    for (const target of [otherStart, otherStart + otherSize / 2, otherStart + otherSize]) {
      for (const anchor of anchors) {
        const delta = target - anchor;
        if (Math.abs(delta) > tolerance) continue;
        if (!closest || Math.abs(delta) < Math.abs(closest.delta)) closest = { delta, position: target, other };
      }
    }
  }
  if (!closest) return { delta: 0, guide: null };
  const crossStart = axis === "x" ? rect.y : rect.x;
  const crossSize = axis === "x" ? rect.height : rect.width;
  const otherCrossStart = axis === "x" ? closest.other.y : closest.other.x;
  const otherCrossSize = axis === "x" ? closest.other.height : closest.other.width;
  return {
    delta: closest.delta,
    guide: {
      axis,
      position: Math.round(closest.position),
      from: Math.round(Math.min(crossStart, otherCrossStart)),
      to: Math.round(Math.max(crossStart + crossSize, otherCrossStart + otherCrossSize)),
    },
  };
}

function edgeSnap(value: number, candidates: readonly number[], tolerance: number): { value: number; matched: boolean } {
  let closest: number | null = null;
  for (const candidate of candidates) {
    if (Math.abs(candidate - value) > tolerance) continue;
    if (closest === null || Math.abs(candidate - value) < Math.abs(closest - value)) closest = candidate;
  }
  return closest === null ? { value, matched: false } : { value: closest, matched: true };
}

/** A neighbour only counts when it overlaps the wall, so diagonal rooms never report a gap. */
function wallGap(rect: Rect, other: Rect, wall: Wall): { distance: number; overlapCentre: number } | null {
  const horizontal = wall === "north" || wall === "south";
  const overlapStart = horizontal ? Math.max(rect.x, other.x) : Math.max(rect.y, other.y);
  const overlapEnd = horizontal
    ? Math.min(rect.x + rect.width, other.x + other.width)
    : Math.min(rect.y + rect.height, other.y + other.height);
  if (overlapEnd <= overlapStart) return null;
  const distance = wall === "north" ? rect.y - (other.y + other.height)
    : wall === "south" ? other.y - (rect.y + rect.height)
    : wall === "west" ? rect.x - (other.x + other.width)
    : other.x - (rect.x + rect.width);
  if (distance < 0) return null;
  return { distance, overlapCentre: (overlapStart + overlapEnd) / 2 };
}

function gapLine(rect: Rect, other: Rect, wall: Wall, centre: number): { start: Point; end: Point } {
  switch (wall) {
    case "north": return { start: { x: centre, y: other.y + other.height }, end: { x: centre, y: rect.y } };
    case "south": return { start: { x: centre, y: rect.y + rect.height }, end: { x: centre, y: other.y } };
    case "west": return { start: { x: other.x + other.width, y: centre }, end: { x: rect.x, y: centre } };
    case "east": return { start: { x: rect.x + rect.width, y: centre }, end: { x: other.x, y: centre } };
  }
  throw new Error("Unknown wall");
}

/**
 * Where the clockwise walk leaves the outer wall, turns at the reflex corner, and rejoins the next
 * outer wall. `after` is the outer wall the notch interrupts.
 */
function notchWalk(layout: RoomLayout): { after: Wall; entry: Point; inner: Point; exit: Point; verticalFirst: boolean } | null {
  const cut = notchRect(layout);
  const corner = layout.notch?.corner;
  if (!cut || !corner) return null;
  const left = cut.x;
  const right = cut.x + cut.width;
  const top = cut.y;
  const bottom = cut.y + cut.height;
  switch (corner) {
    case "northEast": return { after: "north", entry: { x: left, y: top }, inner: { x: left, y: bottom }, exit: { x: right, y: bottom }, verticalFirst: true };
    case "southEast": return { after: "east", entry: { x: right, y: top }, inner: { x: left, y: top }, exit: { x: left, y: bottom }, verticalFirst: false };
    case "southWest": return { after: "south", entry: { x: right, y: bottom }, inner: { x: right, y: top }, exit: { x: left, y: top }, verticalFirst: true };
    case "northWest": return { after: "west", entry: { x: left, y: bottom }, inner: { x: right, y: bottom }, exit: { x: right, y: top }, verticalFirst: false };
  }
  throw new Error("Unknown corner");
}

function segment(wall: Wall, start: Point, end: Point): WallSegment {
  return { wall, start, end, length: Math.hypot(end.x - start.x, end.y - start.y) };
}

function unitDirection(segment: WallSegment): Point {
  if (segment.length === 0) return { x: 0, y: 0 };
  return { x: (segment.end.x - segment.start.x) / segment.length, y: (segment.end.y - segment.start.y) / segment.length };
}

function doorTurn(hinge: DoorElement["hinge"], opening: DoorElement["opening"]): 1 | -1 {
  const hingeTurn = hinge === "left" ? 1 : -1;
  return (opening === "inward" ? hingeTurn : -hingeTurn) as 1 | -1;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
