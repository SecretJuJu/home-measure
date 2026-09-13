import { describe, expect, it } from "vitest";

import {
  clientIdSchema,
  clientMutationIdSchema,
  credentialsSchema,
  layoutVersion,
  roomLayoutSchema,
  roomWallLengths,
} from "./index";

const validLayout = {
  version: layoutVersion,
  position: { x: 0, y: 0 },
  size: { width: 3120, height: 2870 },
  doors: [{
    id: "door_0001",
    wall: "north",
    offset: 300,
    width: 820,
    hinge: "left",
    opening: "inward",
  }],
  windows: [],
  utilities: [],
};

describe("shared domain schemas", () => {
  it("accepts a versioned rectangular layout with stable element IDs", () => {
    expect(roomLayoutSchema.parse(validLayout)).toEqual(validLayout);
  });

  it("normalises a username and holds the line on password length", () => {
    // #given
    const mixedCase = { username: "  Field.Owner  ", password: "measure-tape-2026" };

    // #when
    const parsed = credentialsSchema.parse(mixedCase);
    const rejected = [
      credentialsSchema.safeParse({ username: "ab", password: "measure-tape-2026" }),
      credentialsSchema.safeParse({ username: "no spaces", password: "measure-tape-2026" }),
      credentialsSchema.safeParse({ username: "field.owner", password: "short" }),
    ];

    // #then
    expect(parsed).toEqual({ username: "field.owner", password: "measure-tape-2026" });
    expect(rejected.map((result) => result.success)).toEqual([false, false, false]);
  });

  it("accepts a corner notch and measures the walls it shortens and creates", () => {
    // #given
    const notched = { ...validLayout, notch: { corner: "northEast" as const, width: 1000, height: 900 } };

    // #when
    const parsed = roomLayoutSchema.parse(notched);

    // #then
    expect(parsed).toEqual(notched);
    expect(roomWallLengths(notched)).toMatchObject({
      north: 2120,
      east: 1970,
      south: 3120,
      west: 2870,
      notchHorizontal: 1000,
      notchVertical: 900,
    });
  });

  it("rejects a notch that swallows the room and an element hanging on a missing inner wall", () => {
    // #given
    const swallowed = { ...validLayout, notch: { corner: "northEast", width: 3120, height: 900 } };
    const orphan = { ...validLayout, doors: [{ ...validLayout.doors[0], wall: "notchVertical" }] };

    // #when
    const results = [roomLayoutSchema.safeParse(swallowed), roomLayoutSchema.safeParse(orphan)];

    // #then
    expect(results.map((result) => result.success)).toEqual([false, false]);
  });

  it("rejects an unsupported layout version and duplicate room-local IDs", () => {
    expect(roomLayoutSchema.safeParse({ ...validLayout, version: 2 }).success).toBe(false);
    expect(roomLayoutSchema.safeParse({
      ...validLayout,
      windows: [{
        id: "door_0001",
        wall: "south",
        offset: 0,
        width: 1000,
        height: 1200,
        sillHeight: 900,
        opening: "sliding",
      }],
    }).success).toBe(false);
    expect(roomLayoutSchema.safeParse({
      ...validLayout,
      doors: [{ ...validLayout.doors[0], offset: 3000, width: 820 }],
    }).success).toBe(false);
  });

  it("requires non-trivial stable entity and mutation IDs", () => {
    expect(clientIdSchema.safeParse("short").success).toBe(false);
    expect(clientMutationIdSchema.safeParse("mutation_0001").success).toBe(true);
  });
});
