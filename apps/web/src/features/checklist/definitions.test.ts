import { describe, expect, it } from "vitest";

import { checklistCompletion, measurementTypeForItem } from "./completion";
import { checklistDefinitionsFor, createChecklistDefaults } from "./definitions";
import type { LocalChecklistItem, LocalRoom } from "../../local";

const room: LocalRoom = {
  id: "room_00001",
  propertyId: "property_00001",
  name: "주방",
  type: "kitchen",
  layout: { version: 1, position: { x: 0, y: 0 }, size: { width: 3_000, height: 2_400 }, doors: [], windows: [], utilities: [] },
  createdAt: 1,
  updatedAt: 1,
  dirty: false,
};

describe("room checklist definitions and completion", () => {
  it("creates required and recommended definitions for every supported room type", () => {
    for (const type of ["entrance", "living_room", "bedroom", "kitchen", "balcony", "bathroom", "other"] as const) {
      const definitions = checklistDefinitionsFor(type);
      expect(definitions.length).toBeGreaterThan(0);
      expect(definitions.some((item) => item.required)).toBe(true);
    }
    const defaults = createChecklistDefaults(room);
    expect(defaults.map((item) => item.label)).toEqual(expect.arrayContaining(["냉장고 공간 가로", "수도·배수"]));
    expect(defaults.every((item) => item.roomId === room.id && item.propertyId === room.propertyId && item.status === "pending")).toBe(true);
    expect(defaults.some((item) => item.required)).toBe(true);
    expect(defaults.some((item) => !item.required)).toBe(true);
  });

  it("separates completed, required missing, recommended missing, and later items", () => {
    const items: LocalChecklistItem[] = [
      { ...createChecklistDefaults(room)[0]!, status: "complete" },
      { ...createChecklistDefaults(room)[1]!, status: "pending", required: true },
      { ...createChecklistDefaults(room)[2]!, status: "pending", required: false },
      { ...createChecklistDefaults(room)[3]!, status: "skipped", required: false },
    ];
    const completion = checklistCompletion(items);
    expect(completion).toMatchObject({ total: 4, complete: 1, percentage: 25 });
    expect(completion.requiredMissing).toHaveLength(1);
    expect(completion.recommendedMissing).toHaveLength(1);
    expect(completion.skipped).toHaveLength(1);
    expect(measurementTypeForItem(items[1]!)).toBe("depth");
  });
});

