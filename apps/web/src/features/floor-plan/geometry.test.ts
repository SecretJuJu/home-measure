import type { DoorElement, RoomLayout } from "@home-measure/domain";
import { describe, expect, it } from "vitest";

import {
  clampUtilityPosition,
  clampWallElement,
  doorGeometry,
  notchInnerCorner,
  roomLabelBox,
  roomOutline,
  roomWalls,
  setRoomNotch,
  floorPlanViewport,
  minimumRoomSize,
  minViewportWidth,
  moveWallElement,
  moveRoom,
  panViewport,
  planGridStep,
  pointFromClient,
  positionForGap,
  rectsOverlap,
  resizeRoom,
  resizeRoomCorner,
  roomGaps,
  snapRoomPosition,
  snapTolerance,
  snapUtilityToWall,
  targetWall,
  utilityRect,
  wallElementAtClearance,
  wallElementClearances,
  wallElementPoints,
  wallNeighbours,
  wallSegment,
  zoomViewport,
} from "./geometry";

const layout: RoomLayout = {
  version: 1,
  position: { x: 1_000, y: 2_000 },
  size: { width: 4_000, height: 3_000 },
  doors: [],
  windows: [],
  utilities: [],
};

function door(overrides: Partial<DoorElement> = {}): DoorElement {
  return { id: "door_0001", wall: "north", offset: 1_000, width: 800, hinge: "left", opening: "inward", ...overrides };
}

describe("floor-plan geometry", () => {
  it("uses a clockwise wall coordinate system with correct endpoints", () => {
    expect(wallSegment(layout, "north")).toMatchObject({ start: { x: 1_000, y: 2_000 }, end: { x: 5_000, y: 2_000 }, length: 4_000 });
    expect(wallSegment(layout, "east")).toMatchObject({ start: { x: 5_000, y: 2_000 }, end: { x: 5_000, y: 5_000 }, length: 3_000 });
    expect(wallSegment(layout, "south")).toMatchObject({ start: { x: 5_000, y: 5_000 }, end: { x: 1_000, y: 5_000 }, length: 4_000 });
    expect(wallSegment(layout, "west")).toMatchObject({ start: { x: 1_000, y: 5_000 }, end: { x: 1_000, y: 2_000 }, length: 3_000 });
  });

  it.each([
    ["left hinge, inward", { hinge: "left", opening: "inward" }, { x: 2_000, y: 2_000 }, { x: 2_000, y: 2_800 }, 1],
    ["left hinge, outward", { hinge: "left", opening: "outward" }, { x: 2_000, y: 2_000 }, { x: 2_000, y: 1_200 }, 0],
    ["right hinge, inward", { hinge: "right", opening: "inward" }, { x: 2_800, y: 2_000 }, { x: 2_800, y: 2_800 }, 0],
    ["right hinge, outward", { hinge: "right", opening: "outward" }, { x: 2_800, y: 2_000 }, { x: 2_800, y: 1_200 }, 1],
  ] as const)("draws the swing arc for %s", (_name, controls, expectedHinge, expectedOpenEnd, expectedSweep) => {
    const geometry = doorGeometry(layout, door(controls));
    expect(geometry.hinge).toEqual(expectedHinge);
    expect(geometry.openEnd).toEqual(expectedOpenEnd);
    expect(geometry.radius).toBe(800);
    expect(geometry.sweep).toBe(expectedSweep);
    expect(geometry.arcPath).toContain(`A 800 800 0 0 ${expectedSweep}`);
  });

  it("keeps doors and windows within the attached wall instead of overflowing a corner", () => {
    const clampedDoor = clampWallElement(layout, door({ wall: "east", offset: 2_700, width: 900 }));
    expect(clampedDoor).toMatchObject({ wall: "east", offset: 2_100, width: 900 });
    expect(wallElementPoints(layout, clampedDoor)).toEqual({ start: { x: 5_000, y: 4_100 }, end: { x: 5_000, y: 5_000 } });

    const oversizedWindow = clampWallElement(layout, { id: "window_0001", wall: "west", offset: 5, width: 7_000, height: 1_200, sillHeight: 900, opening: "sliding" as const });
    expect(oversizedWindow).toMatchObject({ wall: "west", offset: 0, width: 3_000 });
  });

  it("does not target an extended wall line beyond the room corner", () => {
    expect(targetWall(layout, { x: 5_120, y: 3_100 }, 150)).toMatchObject({ wall: "east", offset: 1_100 });
    expect(targetWall(layout, { x: 5_100, y: 5_180 }, 200)).toBeNull();
    expect(targetWall(layout, { x: 3_000, y: 2_350 }, 200)).toBeNull();
  });

  it("transforms pointer client coordinates and clamps room movement to the floor origin", () => {
    expect(pointFromClient({ x: 210, y: 110 }, { left: 10, top: 10, width: 400, height: 200 }, { x: 1_000, y: 2_000, width: 4_000, height: 2_000 })).toEqual({ x: 3_000, y: 3_000 });
    expect(moveRoom(layout, { x: -4_000, y: -8_000 }).position).toEqual({ x: 0, y: 0 });
  });

  it("creates a view box that includes every room with usable padding", () => {
    expect(floorPlanViewport([layout, { ...layout, position: { x: 8_000, y: 3_000 } }], 500)).toEqual({ x: 500, y: 1_500, width: 12_000, height: 5_000 });
  });

  it("resizes a room while clamping wall objects and utilities to the new legal bounds", () => {
    const resized = resizeRoom({
      ...layout,
      doors: [door({ offset: 3_700, width: 900 })],
      windows: [{ id: "window_0001", wall: "east", offset: 2_100, width: 1_800, height: 1_200, sillHeight: 900, opening: "sliding" }],
      utilities: [{ id: "utility_0001", type: "outlet", position: { x: 8_000, y: 8_000 } }],
    }, { width: 2_000, height: 1_000 });

    expect(resized.doors[0]).toMatchObject({ offset: 1_100, width: 900 });
    expect(resized.windows[0]).toMatchObject({ offset: 0, width: 1_000 });
    expect(resized.utilities[0]?.position).toEqual({ x: 3_000, y: 3_000 });
  });

  it("moves a wall element by pointer position but never lets it pass a corner", () => {
    expect(moveWallElement(layout, door(), { x: 8_000, y: 2_000 })).toMatchObject({ wall: "north", offset: 3_200, width: 800 });
    expect(moveWallElement(layout, door(), { x: -1_000, y: 2_000 })).toMatchObject({ wall: "north", offset: 0, width: 800 });
  });
});

describe("notched (L-shaped) rooms", () => {
  const notched: RoomLayout = { ...layout, notch: { corner: "northEast", width: 1_500, height: 1_000 } };

  it("shortens the two walls meeting at the cut corner and adds the inner pair", () => {
    // #when
    const walls = roomWalls(notched).map((wall) => ({ wall, length: wallSegment(notched, wall).length }));

    // #then
    expect(walls).toEqual([
      { wall: "north", length: 2_500 },
      { wall: "east", length: 2_000 },
      { wall: "south", length: 4_000 },
      { wall: "west", length: 3_000 },
      { wall: "notchVertical", length: 1_000 },
      { wall: "notchHorizontal", length: 1_500 },
    ]);
  });

  it("walks the outline clockwise through the reflex corner", () => {
    // #when
    const outline = roomOutline(notched);

    // #then
    expect(outline).toEqual([
      { x: 1_000, y: 2_000 },
      { x: 3_500, y: 2_000 },
      { x: 3_500, y: 3_000 },
      { x: 5_000, y: 3_000 },
      { x: 5_000, y: 5_000 },
      { x: 1_000, y: 5_000 },
    ]);
    expect(notchInnerCorner(notched)).toEqual({ x: 3_500, y: 3_000 });
  });

  it("places doors on an inner wall and keeps utilities out of the cut corner", () => {
    // #given
    const innerDoor = clampWallElement(notched, door({ wall: "notchHorizontal", offset: 200, width: 900 }));

    // #when
    const points = wallElementPoints(notched, innerDoor);
    const pushedOut = clampUtilityPosition(notched, { x: 4_800, y: 2_100 });

    // #then
    expect(points).toEqual({ start: { x: 3_700, y: 3_000 }, end: { x: 4_600, y: 3_000 } });
    expect(pushedOut).toEqual({ x: 4_800, y: 3_000 });
    expect(clampUtilityPosition(notched, { x: 2_000, y: 2_500 })).toEqual({ x: 2_000, y: 2_500 });
  });

  it("drops inner-wall elements when the cut corner is filled back in", () => {
    // #given
    const withElements: RoomLayout = {
      ...notched,
      doors: [door({ wall: "notchHorizontal", offset: 200, width: 900 }), door({ id: "door_0002", wall: "south" })],
    };

    // #when
    const restored = setRoomNotch(withElements, null);

    // #then
    expect(restored.notch).toBeUndefined();
    expect(restored.doors.map((item) => item.id)).toEqual(["door_0002"]);
    expect(wallSegment(restored, "north").length).toBe(4_000);
  });

  it("keeps a label out of the cut corner by using the largest full rectangle", () => {
    // #when
    const box = roomLabelBox(notched);

    // #then
    expect(box).toEqual({ x: 1_000, y: 3_000, width: 4_000, height: 2_000 });
    expect(roomLabelBox(layout)).toEqual({ x: 1_000, y: 2_000, width: 4_000, height: 3_000 });
  });
});

describe("wall-mounted objects", () => {
  it("pulls a utility flush against the wall it was dropped near, and leaves a central one alone", () => {
    // #given
    const nearNorth = { id: "utility_0001" as const, type: "outlet" as const, position: { x: 3_000, y: 2_090 } };
    const middle = { ...nearNorth, position: { x: 3_000, y: 3_500 } };

    // #when
    const snapped = snapUtilityToWall(layout, nearNorth, 150);
    const untouched = snapUtilityToWall(layout, middle, 150);

    // #then
    expect(snapped).toEqual({ x: 3_000, y: 2_060 });
    expect(utilityRect({ position: snapped })).toMatchObject({ y: 2_000, height: 120 });
    expect(untouched).toEqual(middle.position);
  });

  it("names the walls a door sits between and moves it to an exact clearance", () => {
    // #given
    const placed = door({ wall: "north", offset: 1_000, width: 800 });

    // #when
    const clearances = wallElementClearances(layout, placed);
    const moved = wallElementAtClearance(layout, placed, "end", 500);

    // #then
    expect(wallNeighbours("north")).toEqual({ start: "west", end: "east" });
    expect(clearances).toEqual({ start: 1_000, end: 2_200 });
    expect(moved.offset).toBe(2_700);
    expect(wallElementClearances(layout, moved)).toEqual({ start: 2_700, end: 500 });
  });
});

describe("floor-plan view", () => {
  const viewport = { x: 200, y: 200, width: 5_800, height: 4_700 };

  it("keeps the focused point in place while zooming in", () => {
    // #given
    const focus = { x: 3_100, y: 2_550 };

    // #when
    const zoomed = zoomViewport(viewport, 1.25, focus);

    // #then
    expect(zoomed).toEqual({ x: 780, y: 670, width: 4_640, height: 3_760 });
    expect((focus.x - zoomed.x) / zoomed.width).toBeCloseTo((focus.x - viewport.x) / viewport.width);
    expect((focus.y - zoomed.y) / zoomed.height).toBeCloseTo((focus.y - viewport.y) / viewport.height);
  });

  it("stops zooming in once the smallest legible area is reached", () => {
    // #given
    const focus = { x: 3_100, y: 2_550 };

    // #when
    const zoomed = zoomViewport(viewport, 1_000, focus);

    // #then
    expect(zoomed.width).toBe(minViewportWidth);
    expect(zoomed.height).toBe(Math.round(minViewportWidth * (viewport.height / viewport.width)));
  });

  it("pans the visible area without changing its size", () => {
    // #given
    const delta = { x: -400.4, y: 250.6 };

    // #when
    const panned = panViewport(viewport, delta);

    // #then
    expect(panned).toEqual({ x: -200, y: 451, width: 5_800, height: 4_700 });
  });

  it("thins the grid and widens the snap pull as the visible area grows", () => {
    // #given
    const wide = { x: 0, y: 0, width: 60_000, height: 40_000 };

    // #when
    const steps = [planGridStep(viewport), planGridStep(wide)];

    // #then
    expect(steps).toEqual([500, 5_000]);
    expect(snapTolerance(viewport)).toBe(116);
    expect(snapTolerance(wide)).toBe(600);
  });
});

describe("floor-plan room alignment", () => {
  const dragged = { x: 1_600, y: 900, width: 4_400, height: 3_300 };
  const neighbor = { x: 6_100, y: 900, width: 4_400, height: 3_300 };

  it("pulls a dragged room flush against the wall it approaches", () => {
    // #given
    const tolerance = 220;

    // #when
    const snapped = snapRoomPosition(dragged, [neighbor], tolerance);

    // #then
    expect(snapped.position).toEqual({ x: 1_700, y: 900 });
    expect(snapped.guides).toContainEqual({ axis: "x", position: 6_100, from: 900, to: 4_200 });
  });

  it("leaves the room untouched when no wall is within reach", () => {
    // #given
    const tolerance = 50;

    // #when
    const snapped = snapRoomPosition({ ...dragged, y: 2_000 }, [neighbor], tolerance);

    // #then
    expect(snapped.position).toEqual({ x: 1_600, y: 2_000 });
    expect(snapped.guides).toEqual([]);
  });

  it("measures only the rooms that actually face a wall", () => {
    // #given
    const rect = { x: 900, y: 900, width: 4_400, height: 3_300 };
    const neighbors = [
      { id: "room_bedroom", name: "침실", rect: neighbor },
      { id: "room_corner", name: "모서리", rect: { x: 12_000, y: 5_000, width: 1_000, height: 1_000 } },
    ];

    // #when
    const gaps = roomGaps(rect, neighbors);

    // #then
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      wall: "east",
      distance: 800,
      start: { x: 5_300, y: 2_550 },
      end: { x: 6_100, y: 2_550 },
    });
    expect(gaps[0]?.neighbor.name).toBe("침실");
  });

  it("treats a shared wall as contact and only a real intrusion as overlap", () => {
    // #given
    const rect = { x: 1_000, y: 1_000, width: 4_000, height: 3_000 };

    // #when
    const flush = rectsOverlap(rect, { x: 5_000, y: 1_000, width: 2_000, height: 3_000 });
    const intruding = rectsOverlap(rect, { x: 4_900, y: 1_000, width: 2_000, height: 3_000 });

    // #then
    expect(flush).toBe(false);
    expect(intruding).toBe(true);
    expect(rectsOverlap(rect, { x: 5_000, y: 4_000, width: 500, height: 500 })).toBe(false);
  });

  it("resizes from one corner while the opposite corner stays put", () => {
    // #given
    const rect = { x: 1_000, y: 1_000, width: 4_000, height: 3_000 };

    // #when
    const resized = resizeRoomCorner(rect, "northWest", { x: 1_500, y: 1_400 }, [], 100);

    // #then
    expect(resized.rect).toEqual({ x: 1_500, y: 1_400, width: 3_500, height: 2_600 });
    expect(resized.guides).toEqual([]);
  });

  it("snaps a resized edge onto a nearby room edge", () => {
    // #given
    const rect = { x: 1_000, y: 1_000, width: 4_000, height: 3_000 };
    const others = [{ x: 6_000, y: 200, width: 1_000, height: 600 }];

    // #when
    const resized = resizeRoomCorner(rect, "southEast", { x: 5_950, y: 4_000 }, others, 100);

    // #then
    expect(resized.rect).toEqual({ x: 1_000, y: 1_000, width: 5_000, height: 3_000 });
    expect(resized.guides).toEqual([{ axis: "x", position: 6_000, from: 1_000, to: 4_000 }]);
  });

  it("never lets a corner drag collapse the room", () => {
    // #given
    const rect = { x: 1_000, y: 1_000, width: 4_000, height: 3_000 };

    // #when
    const resized = resizeRoomCorner(rect, "northWest", { x: 4_900, y: 3_900 }, [], 0);

    // #then
    expect(resized.rect).toEqual({ x: 4_500, y: 3_500, width: minimumRoomSize, height: minimumRoomSize });
  });

  it("places a room at the exact gap requested against one neighbour", () => {
    // #given
    const rect = { x: 900, y: 900, width: 4_400, height: 3_300 };

    // #when
    const position = positionForGap(rect, "east", 1_500, neighbor);

    // #then
    expect(position).toEqual({ x: 200, y: 900 });
    expect(positionForGap(rect, "east", 0, neighbor)).toEqual({ x: 1_700, y: 900 });
  });
});
