import { parsePhotoAnnotation } from "@home-measure/domain";
import { describe, expect, it } from "vitest";

import { appendPoint, inkOutline, markAt, markMidpoint, meaningfulMarks, nibWidths, penPath, toAnnotationPoint } from "./annotation";

describe("photo annotations", () => {
  it("records a pointer position as a fraction of the photo, so it survives a different screen", () => {
    // #given a photo drawn at 800x600 on screen
    const bounds = { left: 40, top: 20, width: 800, height: 600 };

    // #when
    const point = toAnnotationPoint({ x: 440, y: 320 }, bounds);

    // #then
    expect(point).toEqual({ x: 0.5, y: 0.5 });
    expect(toAnnotationPoint({ x: 440, y: 320 }, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
  });

  it("keeps a stroke light by dropping points a finger produces on top of each other", () => {
    // #given
    const points = [{ x: 0.1, y: 0.1 }];

    // #when
    const tooClose = appendPoint(points, { x: 0.101, y: 0.101 });
    const farEnough = appendPoint(points, { x: 0.2, y: 0.2 });

    // #then
    expect(tooClose).toHaveLength(1);
    expect(farEnough).toHaveLength(2);
  });

  it("erases the mark nearest the tap and leaves the rest alone", () => {
    // #given
    const marks = [
      { id: "mark_0001", kind: "measure" as const, start: { x: 0.1, y: 0.1 }, end: { x: 0.4, y: 0.1 }, text: "2,340 mm" },
      { id: "mark_0002", kind: "note" as const, position: { x: 0.8, y: 0.8 }, text: "배관" },
    ];

    // #when
    const onTheLine = markAt(marks, { x: 0.25, y: 0.11 });
    const nowhereNear = markAt(marks, { x: 0.5, y: 0.5 });

    // #then
    expect(onTheLine?.id).toBe("mark_0001");
    expect(nowhereNear).toBeNull();
  });

  it("draws a stroke at the size the photo is shown and labels a measurement at its middle", () => {
    // #given
    const stroke = [{ x: 0, y: 0 }, { x: 0.5, y: 0.25 }];

    // #when
    const path = penPath(stroke, 1_000, 1_000);

    // #then
    expect(path).toBe("M 0 0 L 500 250");
    expect(markMidpoint({ start: { x: 0.2, y: 0.4 }, end: { x: 0.6, y: 0.8 } })).toEqual({ x: 0.4, y: 0.6000000000000001 });
  });

  it("round-trips through the shared schema so a sketch can be synced and reopened", () => {
    // #given
    const annotation = {
      version: 1,
      marks: [
        { id: "mark_0001", kind: "pen", points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.3 }] },
        { id: "mark_0002", kind: "measure", start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, text: "2,340 mm" },
      ],
    };

    // #when
    const parsed = parsePhotoAnnotation(annotation);

    // #then
    expect(parsed).toEqual(annotation);
    expect(parsePhotoAnnotation({ version: 1, marks: [{ id: "mark_0003", kind: "pen", points: [{ x: 0.1, y: 0.1 }] }] })).toBeNull();
    expect(parsePhotoAnnotation({ version: 2, marks: [] })).toBeNull();
  });
});

describe("marks worth keeping", () => {
  it("drops a stray tap but keeps a real line, stroke and label", () => {
    // #given marks as a stray tap could leave them
    const marks = [
      { id: "mark_0001", kind: "measure" as const, start: { x: 0.3, y: 0.3 }, end: { x: 0.3, y: 0.3 }, text: "" },
      { id: "mark_0002", kind: "note" as const, position: { x: 0.5, y: 0.5 }, text: "  " },
      { id: "mark_0003", kind: "measure" as const, start: { x: 0.1, y: 0.5 }, end: { x: 0.9, y: 0.5 }, text: "2,340 mm" },
      { id: "mark_0004", kind: "pen" as const, points: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.4 }] },
    ];

    // #when
    const kept = meaningfulMarks(marks);

    // #then
    expect(kept.map((mark) => mark.id)).toEqual(["mark_0003", "mark_0004"]);
  });
});

describe("ink", () => {
  it("thins a fast stroke and holds a slow one, so the line reads as drawn by hand", () => {
    // #given the same three points, once crossing the photo quickly and once barely moving
    const fast = [{ x: 0, y: 0 }, { x: 0.3, y: 0 }, { x: 0.6, y: 0 }];
    const slow = [{ x: 0, y: 0 }, { x: 0.004, y: 0 }, { x: 0.008, y: 0 }];

    // #when
    const fastWidths = nibWidths(fast, 10);
    const slowWidths = nibWidths(slow, 10);

    // #then
    expect(fastWidths.at(-1)!).toBeLessThan(slowWidths.at(-1)!);
    expect(Math.max(...slowWidths)).toBeLessThanOrEqual(11);
  });

  it("follows stylus pressure when the device reports it", () => {
    // #given
    const light = [{ x: 0, y: 0, pressure: 0.1 }, { x: 0.05, y: 0, pressure: 0.1 }, { x: 0.1, y: 0, pressure: 0.1 }];
    const heavy = light.map((point) => ({ ...point, pressure: 0.9 }));

    // #when
    const lightWidths = nibWidths(light, 10);
    const heavyWidths = nibWidths(heavy, 10);

    // #then
    expect(heavyWidths.at(-1)!).toBeGreaterThan(lightWidths.at(-1)! * 1.5);
  });

  it("keeps a flat 0.5 out of the record, because that is a browser default and not a reading", () => {
    // #given
    const bounds = { left: 0, top: 0, width: 1_000, height: 1_000 };

    // #when
    const finger = toAnnotationPoint({ x: 100, y: 200, pressure: 0.5 }, bounds);
    const stylus = toAnnotationPoint({ x: 100, y: 200, pressure: 0.82 }, bounds);

    // #then
    expect(finger.pressure).toBeUndefined();
    expect(stylus.pressure).toBe(0.82);
  });

  it("draws the stroke as a closed shape with curved edges rather than a straight pipe", () => {
    // #when
    const outline = inkOutline([{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.2 }, { x: 0.5, y: 0.1 }], { width: 1_000, height: 1_000 }, 8);

    // #then
    expect(outline.startsWith("M ")).toBe(true);
    expect(outline).toContain("Q ");
    expect(outline.endsWith("Z")).toBe(true);
    expect(inkOutline([{ x: 0.1, y: 0.1 }], { width: 1_000, height: 1_000 }, 8)).toBe("");
  });
});
