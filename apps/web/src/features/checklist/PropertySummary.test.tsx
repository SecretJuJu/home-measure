// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { HomeMeasureDatabase, LocalFirstRepository } from "../../local";
import type { LocalChecklistItem, LocalPhotoMetadata, LocalProperty, LocalRoom } from "../../local";
import { PropertySummary } from "./PropertySummary";

describe("PropertySummary connected photos", () => {
  let db: HomeMeasureDatabase | undefined;
  let repository: LocalFirstRepository | undefined;

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    repository?.dispose();
    await db?.delete();
  });

  it("shows a device-local preview with room, checklist, note, and upload-state references in its detail overlay", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:summary-preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    db = new HomeMeasureDatabase(`summary-photo-${crypto.randomUUID()}`);
    repository = new LocalFirstRepository(db, { send: async () => undefined }, undefined);
    const property: LocalProperty = { id: "property_00005", name: "사진 요약 집", address: null, note: null, createdAt: 1, updatedAt: 1, dirty: false };
    const room: LocalRoom = { id: "room_00005", propertyId: property.id, name: "거실", type: "living_room", createdAt: 1, updatedAt: 1, dirty: false, layout: { version: 1, position: { x: 0, y: 0 }, size: { width: 2_000, height: 1_500 }, doors: [], windows: [], utilities: [] } };
    const item: LocalChecklistItem = { id: "checklist_00005", propertyId: property.id, roomId: room.id, elementId: null, label: "창문 폭", category: "window", required: true, status: "pending", measurementId: null, sortOrder: 0, createdAt: 1, updatedAt: 1, dirty: false };
    const photo: LocalPhotoMetadata = { id: "photo_00000005", propertyId: property.id, roomId: room.id, elementId: null, checklistItemId: item.id, r2Key: "photos/property_00005/photo_00000005.jpg", mimeType: "image/jpeg", width: 800, height: 600, note: "창틀 왼쪽 모서리", createdAt: 2, updatedAt: 2, dirty: false, uploadStatus: "failed", uploadMutationId: "upload_00000005", uploadAttempts: 1, uploadError: "retry" };
    await db.properties.put(property);
    await db.rooms.put(room);
    await db.checklistItems.put(item);
    await db.photoMetadata.put(photo);
    await db.photoBlobs.put({ photoId: photo.id, blob: new Blob(["preview"], { type: "image/jpeg" }), uploadMutationId: photo.uploadMutationId, createdAt: 2 });
    await repository.rehydrate();
    const user = userEvent.setup();

    render(<PropertySummary repository={repository} property={property} onBack={() => undefined} />);
    expect((await screen.findByAltText("거실 · 창문 폭 사진 미리보기")).getAttribute("src")).toBe("blob:summary-preview");
    await user.click(screen.getByRole("button", { name: "사진 열기: 거실 · 창문 폭" }));

    const dialog = screen.getByRole("dialog", { name: "거실 · 창문 폭" });
    expect(dialog.textContent).toContain("사진 업로드 재시도 대기");
    expect(dialog.textContent).toContain("창틀 왼쪽 모서리");
    expect(screen.getByAltText("거실 · 창문 폭 사진 상세 미리보기")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "사진 상세 닫기" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "사진 상세 닫기" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "사진 열기: 거실 · 창문 폭" }));
    expect(document.querySelector("[inert]")).toBeNull();
  });

  it("groups every room's door widths and major utility coordinates under that room", async () => {
    db = new HomeMeasureDatabase(`summary-spatial-${crypto.randomUUID()}`);
    repository = new LocalFirstRepository(db, { send: async () => undefined }, undefined);
    const property: LocalProperty = { id: "property_00006", name: "공간 요약 집", address: null, note: null, createdAt: 1, updatedAt: 1, dirty: false };
    const kitchen: LocalRoom = {
      id: "room_00006", propertyId: property.id, name: "주방", type: "kitchen", createdAt: 1, updatedAt: 1, dirty: false,
      layout: {
        version: 1, position: { x: 1_000, y: 2_000 }, size: { width: 3_400, height: 2_500 },
        doors: [
          { id: "door_00006", wall: "north", offset: 400, width: 820, hinge: "left", opening: "inward" },
          { id: "door_00007", wall: "east", offset: 900, width: 740, hinge: "right", opening: "outward" },
        ],
        windows: [],
        utilities: [
          { id: "utility_00006", type: "water", position: { x: 2_450, y: 3_100 } },
          { id: "utility_00007", type: "drain", position: { x: 2_700, y: 3_100 } },
        ],
      },
    };
    const bedroom: LocalRoom = { id: "room_00007", propertyId: property.id, name: "침실", type: "bedroom", createdAt: 2, updatedAt: 2, dirty: false, layout: { version: 1, position: { x: 5_000, y: 2_000 }, size: { width: 3_000, height: 2_600 }, doors: [], windows: [], utilities: [] } };
    await db.properties.put(property);
    await db.rooms.bulkPut([kitchen, bedroom]);
    await repository.rehydrate();

    render(<PropertySummary repository={repository} property={property} onBack={() => undefined} />);

    const kitchenDetails = screen.getByRole("article", { name: "주방 문과 주요 설비" });
    expect(kitchenDetails.textContent).toContain("문 1 · 위쪽 벽 · 820 mm");
    expect(kitchenDetails.textContent).toContain("문 2 · 오른쪽 벽 · 740 mm");
    expect(kitchenDetails.textContent).toContain("수도 · 2450 × 3100 mm");
    expect(kitchenDetails.textContent).toContain("배수구 · 2700 × 3100 mm");

    const bedroomDetails = screen.getByRole("article", { name: "침실 문과 주요 설비" });
    expect(bedroomDetails.textContent).toContain("기록된 문 없음");
    expect(bedroomDetails.textContent).toContain("기록된 주요 설비 없음");
  });
});
