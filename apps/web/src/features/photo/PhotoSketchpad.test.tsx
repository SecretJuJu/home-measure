// @vitest-environment jsdom
import type { PhotoAnnotation } from "@home-measure/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PhotoSketchpad } from "./PhotoSketchpad";
import type { LocalPhotoMetadata } from "../../local";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const photo: LocalPhotoMetadata = {
  id: "photo_0001",
  propertyId: "property_0001",
  roomId: "room_0001",
  elementId: null,
  checklistItemId: null,
  r2Key: "photos/property_0001/photo_0001.webp",
  mimeType: "image/webp",
  width: 1_600,
  height: 1_200,
  note: "거실 창문",
  createdAt: 1,
  updatedAt: 1,
  dirty: false,
  uploadStatus: "pending",
  uploadMutationId: "upload_0001",
  uploadAttempts: 0,
  uploadError: null,
};

function sizedSheet() {
  const sheet = document.querySelector(".sketchpad-sheet")!;
  Object.defineProperty(sheet, "getBoundingClientRect", {
    value: () => ({ left: 0, top: 0, width: 1_000, height: 750 }),
  });
  return sheet;
}

describe("PhotoSketchpad", () => {
  it("draws a measurement line on the photo and saves it with the length written on it", async () => {
    const user = userEvent.setup();
    // #given
    const saved: PhotoAnnotation[] = [];
    render(<PhotoSketchpad photo={photo} source="blob:photo" onSave={(annotation) => { saved.push(annotation); }} onClose={() => undefined} />);
    const sheet = sizedSheet();

    // #when the user drags across the part they measured, then types the reading
    fireEvent.pointerDown(sheet, { clientX: 200, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(sheet, { clientX: 700, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 700, clientY: 300, pointerId: 1 });
    await user.type(await screen.findByLabelText("길이 입력"), "2,340 mm");
    await user.click(screen.getByRole("button", { name: "확인" }));
    await user.click(screen.getByRole("button", { name: "필기 저장" }));

    // #then
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.marks).toEqual([
      { id: expect.any(String), kind: "measure", start: { x: 0.2, y: 0.4 }, end: { x: 0.7, y: 0.4 }, text: "2,340 mm" },
    ]);
    expect(document.querySelector(".sketch-mark.measure text")?.textContent).toBe("2,340 mm");
  });

  it("keeps a freehand stroke but ignores a stray tap", async () => {
    const user = userEvent.setup();
    // #given
    const saved: PhotoAnnotation[] = [];
    render(<PhotoSketchpad photo={photo} source="blob:photo" onSave={(annotation) => { saved.push(annotation); }} onClose={() => undefined} />);
    const sheet = sizedSheet();
    await user.click(screen.getByRole("button", { name: "펜" }));

    // #when
    fireEvent.pointerDown(sheet, { clientX: 100, clientY: 100, pointerId: 2 });
    fireEvent.pointerUp(sheet, { clientX: 100, clientY: 100, pointerId: 2 });
    fireEvent.pointerDown(sheet, { clientX: 200, clientY: 200, pointerId: 3 });
    fireEvent.pointerMove(sheet, { clientX: 300, clientY: 260, pointerId: 3 });
    fireEvent.pointerMove(sheet, { clientX: 420, clientY: 340, pointerId: 3 });
    fireEvent.pointerUp(sheet, { clientX: 420, clientY: 340, pointerId: 3 });
    await user.click(screen.getByRole("button", { name: "필기 저장" }));

    // #then
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.marks).toHaveLength(1);
    expect(saved[0]?.marks[0]?.kind).toBe("pen");
  });

  it("reopens an existing sketch and lets the eraser remove one mark", async () => {
    const user = userEvent.setup();
    // #given a photo that already carries two marks
    const existing: PhotoAnnotation = {
      version: 1,
      marks: [
        { id: "mark_0001", kind: "measure", start: { x: 0.1, y: 0.4 }, end: { x: 0.5, y: 0.4 }, text: "820 mm" },
        { id: "mark_0002", kind: "note", position: { x: 0.8, y: 0.8 }, text: "배관" },
      ],
    };
    const saved: PhotoAnnotation[] = [];
    render(<PhotoSketchpad photo={{ ...photo, annotation: existing }} source="blob:photo" onSave={(annotation) => { saved.push(annotation); }} onClose={() => undefined} />);
    const sheet = sizedSheet();
    expect(document.querySelectorAll(".sketch-mark")).toHaveLength(2);

    // #when
    await user.click(screen.getByRole("button", { name: "지우개" }));
    fireEvent.pointerDown(sheet, { clientX: 300, clientY: 300, pointerId: 4 });
    await user.click(screen.getByRole("button", { name: "필기 저장" }));

    // #then
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.marks.map((mark) => mark.id)).toEqual(["mark_0002"]);
  });
});
