// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { HomeMeasureDatabase, LocalFirstRepository } from "../../local";
import type { LocalChecklistItem, LocalProperty, LocalRoom } from "../../local";
import { PhotoCaptureControl } from "./PhotoCaptureControl";
import type { PhotoUploadQueue } from "./photo-upload-queue";

describe("PhotoCaptureControl", () => {
  let db: HomeMeasureDatabase | undefined;
  let repository: LocalFirstRepository | undefined;

  afterEach(async () => {
    cleanup();
    repository?.dispose();
    await db?.delete();
  });

  it("binds the photo note to the active property, room, and checklist context before enqueueing", async () => {
    const enqueue = vi.fn(async () => undefined);
    db = new HomeMeasureDatabase(`photo-control-${crypto.randomUUID()}`);
    repository = new LocalFirstRepository(db, { send: async () => undefined }, undefined);
    const property: LocalProperty = { id: "property_00004", name: "우리 집", address: null, note: null, createdAt: 1, updatedAt: 1, dirty: false };
    const room: LocalRoom = { id: "room_00004", propertyId: property.id, name: "안방", type: "bedroom", createdAt: 1, updatedAt: 1, dirty: false, layout: { version: 1, position: { x: 0, y: 0 }, size: { width: 2_000, height: 1_500 }, doors: [], windows: [], utilities: [] } };
    const checklistItem: LocalChecklistItem = { id: "checklist_00004", propertyId: property.id, roomId: room.id, elementId: null, label: "창문 폭", category: "window", required: true, status: "pending", measurementId: null, sortOrder: 0, createdAt: 1, updatedAt: 1, dirty: false };
    const user = userEvent.setup();

    render(<PhotoCaptureControl repository={repository} queue={{ enqueue } as unknown as PhotoUploadQueue} property={property} room={room} checklistItem={checklistItem} />);
    const note = screen.getByLabelText("사진 메모 (선택)");
    expect(note.getAttribute("maxlength")).toBe("4000");
    await user.type(note, "창틀 왼쪽 모서리");
    await user.upload(screen.getByLabelText("첨부할 사진 선택"), new File(["photo"], "window.jpg", { type: "image/jpeg" }));

    await waitFor(() => expect(enqueue).toHaveBeenCalledWith(expect.any(File), {
      property,
      room,
      checklistItem: { id: checklistItem.id, label: checklistItem.label, elementId: null },
      note: "창틀 왼쪽 모서리",
    }));
    expect((screen.getByLabelText("사진 메모 (선택)") as HTMLTextAreaElement).value).toBe("");
  });
});
