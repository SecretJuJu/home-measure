// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { HomeMeasureDatabase, LocalFirstRepository } from "../../local";
import type { ApiClient, LocalChecklistItem, LocalProperty, LocalRoom } from "../../local";
import { FloorPlanEditor, type FloorPlanSelection } from "../floor-plan";
import { ChecklistPanel } from "./ChecklistPanel";
import { HomeMeasureWorkspace } from "./HomeMeasureWorkspace";

const databaseName = "home-measure";

afterEach(async () => {
  cleanup();
  await Promise.all([databaseName, "linked-canvas"].map((name) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener("success", () => resolve());
    request.addEventListener("blocked", () => resolve());
    request.addEventListener("error", () => reject(request.error));
  })));
});

describe("HomeMeasure checklist field flow", () => {
  it("persists generated checklist definitions and a saved measurement before a reload, then advances", async () => {
    const user = userEvent.setup();
    const first = render(<HomeMeasureWorkspace />);

    await user.type(await screen.findByLabelText("집 이름"), "실측 아파트");
    await user.click(screen.getByRole("button", { name: "새 집 만들기" }));
    await screen.findByRole("heading", { name: "실측 아파트" });
    await user.click(screen.getAllByRole("button", { name: "공간 추가" })[0]!);
    await user.type(screen.getByLabelText("공간 이름"), "거실");
    await user.click(screen.getByRole("button", { name: "생성" }));

    await screen.findByRole("button", { name: /공간 가로, 필수, 미측정/ });
    await user.click(screen.getByRole("button", { name: "실측 모드 ▶" }));
    const valueInput = await screen.findByLabelText("공간 가로 밀리미터");
    await user.type(valueInput, "3450");
    await user.type(screen.getByLabelText("메모 (선택)"), "창문 반대쪽 벽");
    await user.click(screen.getByRole("button", { name: "저장 후 다음 →" }));

    await screen.findByRole("heading", { name: "공간 세로" });
    const db = new HomeMeasureDatabase(databaseName);
    await waitFor(async () => {
      const checklist = await db.checklistItems.toArray();
      const measurement = await db.measurements.toArray();
      expect(checklist.some((item) => item.label === "공간 가로" && item.status === "complete" && item.measurementId !== null)).toBe(true);
      expect(measurement.some((item) => item.value === 3450 && item.note === "창문 반대쪽 벽")).toBe(true);
    });
    first.unmount();
    db.close();

    render(<HomeMeasureWorkspace />);
    await screen.findByRole("heading", { name: "실측 아파트" });
    await screen.findByRole("button", { name: /공간 가로, 필수, 완료/ });
  });

  it("selects the linked floor-plan object and inspector from a checklist row", async () => {
    const db = new HomeMeasureDatabase("linked-canvas");
    const property: LocalProperty = { id: "property_00002", name: "연결 테스트", address: null, note: null, createdAt: 1, updatedAt: 1, dirty: false };
    const room: LocalRoom = {
      id: "room_00002", propertyId: property.id, name: "현관", type: "entrance", createdAt: 2, updatedAt: 2, dirty: false,
      layout: { version: 1, position: { x: 0, y: 0 }, size: { width: 2_000, height: 1_500 }, doors: [{ id: "door_00002", wall: "north", offset: 400, width: 820, hinge: "left", opening: "inward" }], windows: [], utilities: [] },
    };
    const item: LocalChecklistItem = { id: "checklist_00002", propertyId: property.id, roomId: room.id, elementId: "door_00002", label: "현관문 폭", category: "door", required: true, status: "pending", measurementId: null, sortOrder: 0, createdAt: 3, updatedAt: 3, dirty: false };
    await db.properties.put(property);
    await db.rooms.put(room);
    await db.checklistItems.bulkPut([item, { ...item, id: "checklist_00003", label: "현관문 확인", sortOrder: 1 }]);
    const api: ApiClient = { send: async () => undefined };
    const repository = new LocalFirstRepository(db, api);
    const user = userEvent.setup();

    render(<LinkedCanvasTest repository={repository} />);
    await screen.findByRole("button", { name: /현관문 폭, 필수, 미측정, 평면도 객체 연결됨/ });
    await user.click(screen.getByRole("button", { name: /현관문 폭, 필수, 미측정, 평면도 객체 연결됨/ }));

    const inspectorField = await screen.findByLabelText("문 폭 밀리미터");
    expect(document.querySelector(".door-drawing.selected")).toBeTruthy();
    expect(document.activeElement).toBe(inspectorField);
    expect(document.querySelectorAll('.checklist-item[aria-current="true"]')).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /현관문 확인, 필수/ }));
    expect(document.querySelectorAll('.checklist-item[aria-current="true"]')).toHaveLength(1);
    expect(screen.getByRole("button", { name: /현관문 확인, 필수/ }).getAttribute("aria-current")).toBe("true");
    repository.dispose();
    db.close();
  });
});

function LinkedCanvasTest({ repository }: { repository: LocalFirstRepository }) {
  const [selection, setSelection] = useState<FloorPlanSelection>(null);
  return <FloorPlanEditor
    repository={repository}
    selection={selection}
    onSelectionChange={setSelection}
    inspectorSupplement={({ property, room, selection: canvasSelection, select }) => <ChecklistPanel
      repository={repository}
      property={property}
      room={room}
      selection={canvasSelection}
      onSelectionChange={select}
      onStartMeasurement={() => undefined}
      onOpenSummary={() => undefined}
    />}
  />;
}
