// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FloorPlanEditor } from "./FloorPlanEditor";
import { HomeMeasureDatabase, LocalFirstRepository } from "../../local";

/** The room body is an outline path, so tests read its bounding box back out of the points. */
function roomBox(index = 0) {
  const points = document.querySelectorAll(".room-fill")[index]?.getAttribute("d")?.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  const xs = points.filter((_, position) => position % 2 === 0);
  const ys = points.filter((_, position) => position % 2 === 1);
  return {
    x: String(Math.min(...xs)),
    y: String(Math.min(...ys)),
    width: String(Math.max(...xs) - Math.min(...xs)),
    height: String(Math.max(...ys) - Math.min(...ys)),
  };
}

let db: HomeMeasureDatabase;
let repository: LocalFirstRepository;
beforeEach(() => {
  db = new HomeMeasureDatabase(`editor-test-${crypto.randomUUID()}`);
  repository = new LocalFirstRepository(db, { send: async () => undefined });
});

afterEach(async () => {
  cleanup();
  await repository.flush();
  repository.dispose();
  await db.delete();
  vi.restoreAllMocks();
});

describe("FloorPlanEditor", () => {
  it("creates a property and room, then selects and edits the room locally", async () => {
    const user = userEvent.setup();
    render(<FloorPlanEditor repository={repository} />);

    await user.type(await screen.findByLabelText("집 이름"), "테스트 아파트");
    await user.click(screen.getByRole("button", { name: "새 집 만들기" }));
    await screen.findByRole("heading", { name: "테스트 아파트" });

    await user.click(screen.getAllByRole("button", { name: "공간 추가" })[0]!);
    await user.type(screen.getByLabelText("공간 이름"), "거실");
    await user.click(screen.getByRole("button", { name: "생성" }));
    await waitFor(() => expect(document.querySelector(".room-create-form")).toBeNull());
    await user.click(await screen.findByRole("button", { name: "거실 선택" }));

    const roomName = screen.getByLabelText("공간 이름");
    await user.clear(roomName);
    await user.type(roomName, "수정 거실");
    fireEvent.blur(roomName);

    await waitFor(() => expect(screen.getByRole("heading", { name: "수정 거실" })).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "문 배치" }));
    await screen.findByText("문을 놓을 벽을 누르세요.");
    const canvas = screen.getByRole("application", { name: /평면도/ });
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 580, height: 470 }),
    });
    fireEvent.pointerDown(document.querySelector(".room-drawing")!, { clientX: 290, clientY: 70, pointerId: 1 });

    await screen.findByRole("button", { name: /문 선택, 폭 820mm/ });
    await screen.findByLabelText("문 폭 밀리미터");
    const swingBefore = document.querySelector(".door-arc")?.getAttribute("d");
    await user.click(await screen.findByRole("button", { name: "바깥쪽으로 열림" }));
    await waitFor(() => expect(document.querySelector(".door-arc")?.getAttribute("d")).not.toBe(swingBefore));
  });

  it("dismisses the Inspector with Escape and returns focus to its trigger", async () => {
    const user = userEvent.setup();
    render(<FloorPlanEditor repository={repository} />);
    await user.type(await screen.findByLabelText("집 이름"), "Inspector 테스트");
    await user.click(screen.getByRole("button", { name: "새 집 만들기" }));
    const trigger = await screen.findByRole("button", { name: "속성 · 체크리스트" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "선택한 객체 편집" }).getAttribute("aria-modal")).toBe("true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector(".workspace-header")?.hasAttribute("inert")).toBe(false);
  });

  it("updates property name, address, and note locally before confirmed property deletion", async () => {
    const user = userEvent.setup();
    render(<FloorPlanEditor repository={repository} />);

    await user.type(await screen.findByLabelText("집 이름"), "기존 집");
    await user.click(screen.getByRole("button", { name: "새 집 만들기" }));
    await screen.findByRole("heading", { name: "기존 집" });

    await user.click(screen.getByText("집 정보 편집", { selector: "summary" }));
    await user.clear(screen.getByLabelText("집 이름"));
    await user.type(screen.getByLabelText("집 이름"), "수정 집");
    await user.type(screen.getByLabelText("집 주소"), "서울 성동구");
    await user.type(screen.getByLabelText("집 메모"), "엘리베이터 확인");
    await user.click(screen.getByRole("button", { name: "집 정보 저장" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "수정 집" })).toBeTruthy());

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "집 삭제" }));
    await screen.findByRole("heading", { name: "새 집을 시작하세요" });
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("resizes a room through Inspector while preserving legal element constraints, then deletes after confirmation", async () => {
    const user = userEvent.setup();
    render(<FloorPlanEditor repository={repository} />);
    await user.type(await screen.findByLabelText("집 이름"), "치수 테스트");
    await user.click(screen.getByRole("button", { name: "새 집 만들기" }));
    await user.click(screen.getAllByRole("button", { name: "공간 추가" })[0]!);
    await user.type(screen.getByLabelText("공간 이름"), "작은 방");
    await user.click(screen.getByRole("button", { name: "생성" }));
    await waitFor(() => expect(document.querySelector(".room-create-form")).toBeNull());
    await user.click(await screen.findByRole("button", { name: "작은 방 선택" }));

    await user.click(screen.getByRole("button", { name: "문 배치" }));
    const canvas = screen.getByRole("application", { name: /평면도/ });
    Object.defineProperty(canvas, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 580, height: 470 }) });
    fireEvent.pointerDown(document.querySelector(".room-drawing")!, { clientX: 290, clientY: 70, pointerId: 1 });
    await screen.findByRole("button", { name: /문 선택, 폭 820mm/ });
    await screen.findByLabelText("문 폭 밀리미터");

    await user.click(screen.getByRole("button", { name: "작은 방 선택" }));
    const width = screen.getByLabelText("공간 가로 밀리미터");
    await user.clear(width);
    await user.type(width, "700");
    fireEvent.blur(width);
    await waitFor(() => expect(roomBox().width).toBe("700"));
    await screen.findByRole("button", { name: /문 선택, 폭 700mm/ });

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "작은 방 선택" }));
    await user.click(screen.getByRole("button", { name: "공간 삭제" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "작은 방 선택" })).toBeNull());
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("moves doors, windows, and utilities with Pointer Events while clamping their legal bounds", async () => {
    const user = userEvent.setup();
    render(<FloorPlanEditor repository={repository} />);
    await user.type(await screen.findByLabelText("집 이름"), "이동 테스트");
    await user.click(screen.getByRole("button", { name: "새 집 만들기" }));
    await user.click(screen.getAllByRole("button", { name: "공간 추가" })[0]!);
    await user.click(screen.getByRole("button", { name: "생성" }));
    await waitFor(() => expect(document.querySelector(".room-create-form")).toBeNull());
    const canvas = screen.getByRole("application", { name: /평면도/ });
    Object.defineProperty(canvas, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 580, height: 470 }) });

    await user.click(screen.getByRole("button", { name: "문 배치" }));
    await screen.findByText("문을 놓을 벽을 누르세요.");
    fireEvent.pointerDown(document.querySelector(".room-drawing")!, { clientX: 290, clientY: 70, pointerId: 1 });
    await screen.findByRole("button", { name: /문 선택/ });
    // Optimistic geometry appears before placement finishes its local transaction.
    await screen.findByLabelText("문 폭 밀리미터");
    fireEvent.pointerDown(document.querySelector(".door-drawing")!, { clientX: 290, clientY: 70, pointerId: 2 });
    fireEvent.pointerMove(canvas, { clientX: 580, clientY: 70, pointerId: 2 });
    fireEvent.pointerUp(canvas, { clientX: 580, clientY: 70, pointerId: 2 });
    await waitFor(() => expect(document.querySelector(".door-line")?.getAttribute("x1")).toBe("4480"));

    await user.click(screen.getByRole("button", { name: "창문 배치" }));
    await screen.findByText("창문을 놓을 벽을 누르세요.");
    fireEvent.pointerDown(document.querySelector(".room-drawing")!, { clientX: 290, clientY: 70, pointerId: 3 });
    await screen.findByRole("button", { name: /창문 선택/ });
    await screen.findByLabelText("창문 폭 밀리미터");
    fireEvent.pointerDown(document.querySelector(".window-line")!, { clientX: 290, clientY: 70, pointerId: 4 });
    fireEvent.pointerMove(canvas, { clientX: 0, clientY: 70, pointerId: 4 });
    fireEvent.pointerUp(canvas, { clientX: 0, clientY: 70, pointerId: 4 });
    await waitFor(() => expect(document.querySelector(".window-line")?.getAttribute("x1")).toBe("900"));

    await user.click(screen.getByRole("button", { name: "콘센트 배치" }));
    await screen.findByText("콘센트를 놓을 공간 내부를 누르세요.");
    fireEvent.pointerDown(document.querySelector(".room-drawing")!, { clientX: 290, clientY: 200, pointerId: 5 });
    await screen.findByRole("button", { name: "콘센트 선택" });
    await screen.findByRole("heading", { name: "콘센트" });
    fireEvent.pointerDown(document.querySelector(".utility-marker")!, { clientX: 290, clientY: 200, pointerId: 6 });
    fireEvent.pointerMove(canvas, { clientX: -100, clientY: -100, pointerId: 6 });
    fireEvent.pointerUp(canvas, { clientX: -100, clientY: -100, pointerId: 6 });
    await waitFor(() => expect(document.querySelector(".utility-marker circle")?.getAttribute("cx")).toBe("900"));
  });

  it("zooms the canvas around its centre and restores the fitted view", async () => {
    const user = userEvent.setup();
    render(<FloorPlanEditor repository={repository} />);
    // #given
    await user.type(await screen.findByLabelText("집 이름"), "줌 테스트");
    await user.click(screen.getByRole("button", { name: "새 집 만들기" }));
    await user.click(screen.getAllByRole("button", { name: "공간 추가" })[0]!);
    await user.click(screen.getByRole("button", { name: "생성" }));
    await waitFor(() => expect(document.querySelector(".room-create-form")).toBeNull());
    const canvas = screen.getByRole("application", { name: /평면도/ });
    await waitFor(() => expect(canvas.getAttribute("viewBox")).toBe("200 200 5800 4700"));

    // #when
    await user.click(screen.getByRole("button", { name: "확대" }));

    // #then
    expect(canvas.getAttribute("viewBox")).toBe("780 670 4640 3760");
    expect(screen.getByRole("button", { name: "화면에 맞추기" }).textContent).toBe("125%");
    await user.click(screen.getByRole("button", { name: "화면에 맞추기" }));
    expect(canvas.getAttribute("viewBox")).toBe("200 200 5800 4700");
  });

  it("snaps a dragged room flush against the neighbouring wall and reports the contact", async () => {
    const user = userEvent.setup();
    render(<FloorPlanEditor repository={repository} />);
    // #given
    await user.type(await screen.findByLabelText("집 이름"), "스냅 테스트");
    await user.click(screen.getByRole("button", { name: "새 집 만들기" }));
    for (const name of ["거실", "침실"]) {
      await user.click(screen.getAllByRole("button", { name: "공간 추가" })[0]!);
      await user.type(document.querySelector<HTMLInputElement>(".room-create-form input")!, name);
      await user.click(screen.getByRole("button", { name: "생성" }));
      await waitFor(() => expect(document.querySelector(".room-create-form")).toBeNull());
    }
    const canvas = screen.getByRole("application", { name: /평면도/ });
    Object.defineProperty(canvas, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 1_020, height: 470 }) });
    // A new room starts flush against the current one, so the drag has to break the contact first.
    await waitFor(() => expect(canvas.getAttribute("viewBox")).toBe("200 200 10200 4700"));
    const bedroom = document.querySelectorAll(".room-drawing")[1]!;
    fireEvent.pointerDown(bedroom, { clientX: 730, clientY: 230, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 800, clientY: 230, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 800, clientY: 230, pointerId: 1 });
    await waitFor(() => expect(roomBox(1).x).toBe("6000"));

    // #when
    fireEvent.pointerDown(document.querySelectorAll(".room-drawing")[1]!, { clientX: 800, clientY: 230, pointerId: 2 });
    fireEvent.pointerMove(canvas, { clientX: 740, clientY: 230, pointerId: 2 });

    // #then
    expect(screen.getByText("맞닿음")).toBeTruthy();
    fireEvent.pointerUp(canvas, { clientX: 740, clientY: 230, pointerId: 2 });
    await waitFor(() => expect(roomBox(1).x).toBe("5300"));
    expect(screen.queryByText("맞닿음")).toBeNull();
  });

  it("moves a room to the exact wall gap typed in the Inspector", async () => {
    const user = userEvent.setup();
    render(<FloorPlanEditor repository={repository} />);
    // #given
    await user.type(await screen.findByLabelText("집 이름"), "간격 테스트");
    await user.click(screen.getByRole("button", { name: "새 집 만들기" }));
    for (const name of ["거실", "침실"]) {
      await user.click(screen.getAllByRole("button", { name: "공간 추가" })[0]!);
      await user.type(document.querySelector<HTMLInputElement>(".room-create-form input")!, name);
      await user.click(screen.getByRole("button", { name: "생성" }));
      await waitFor(() => expect(document.querySelector(".room-create-form")).toBeNull());
    }
    await user.click(await screen.findByRole("button", { name: "침실 선택" }));
    const gap = screen.getByLabelText("왼쪽 벽 간격 밀리미터");
    expect((gap as HTMLInputElement).value).toBe("0");

    // #when
    await user.clear(gap);
    await user.type(gap, "1500");
    fireEvent.blur(gap);

    // #then
    await waitFor(() => expect(roomBox(1).x).toBe("6800"));
    expect((screen.getByLabelText("왼쪽 벽 간격 밀리미터") as HTMLInputElement).value).toBe("1500");
  });

  it("deletes a placed door and restores it with undo", async () => {
    const user = userEvent.setup();
    render(<FloorPlanEditor repository={repository} />);
    // #given
    await user.type(await screen.findByLabelText("집 이름"), "삭제 테스트");
    await user.click(screen.getByRole("button", { name: "새 집 만들기" }));
    await user.click(screen.getAllByRole("button", { name: "공간 추가" })[0]!);
    await user.click(screen.getByRole("button", { name: "생성" }));
    await waitFor(() => expect(document.querySelector(".room-create-form")).toBeNull());
    const canvas = screen.getByRole("application", { name: /평면도/ });
    Object.defineProperty(canvas, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 580, height: 470 }) });
    await user.click(screen.getByRole("button", { name: "문 배치" }));
    fireEvent.pointerDown(document.querySelector(".room-drawing")!, { clientX: 290, clientY: 70, pointerId: 1 });
    await screen.findByRole("button", { name: /문 선택, 폭 820mm/ });
    await screen.findByLabelText("문 폭 밀리미터");

    // #when
    await user.click(screen.getByRole("button", { name: "문 삭제" }));

    // #then
    await waitFor(() => expect(document.querySelector(".door-drawing")).toBeNull());
    await user.click(screen.getByRole("button", { name: "실행 취소" }));
    await waitFor(() => expect(document.querySelector(".door-drawing")).not.toBeNull());
    await user.click(screen.getByRole("button", { name: "다시 실행" }));
    await waitFor(() => expect(document.querySelector(".door-drawing")).toBeNull());
  });

  it("nudges the selected room with arrow keys and clears the selection with Escape", async () => {
    const user = userEvent.setup();
    render(<FloorPlanEditor repository={repository} />);
    // #given
    await user.type(await screen.findByLabelText("집 이름"), "방향키 테스트");
    await user.click(screen.getByRole("button", { name: "새 집 만들기" }));
    await user.click(screen.getAllByRole("button", { name: "공간 추가" })[0]!);
    await user.click(screen.getByRole("button", { name: "생성" }));
    await waitFor(() => expect(document.querySelector(".room-create-form")).toBeNull());
    await user.click(await screen.findByRole("button", { name: "거실 선택" }));

    // #when
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(roomBox().x).toBe("910"));
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");

    // #then
    await waitFor(() => expect(roomBox().y).toBe("1000"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.querySelector(".room-drawing.selected")).toBeNull());
  });

  it("resizes a room by dragging its corner handle", async () => {
    const user = userEvent.setup();
    render(<FloorPlanEditor repository={repository} />);
    // #given
    await user.type(await screen.findByLabelText("집 이름"), "손잡이 테스트");
    await user.click(screen.getByRole("button", { name: "새 집 만들기" }));
    await user.click(screen.getAllByRole("button", { name: "공간 추가" })[0]!);
    await user.click(screen.getByRole("button", { name: "생성" }));
    await waitFor(() => expect(document.querySelector(".room-create-form")).toBeNull());
    const canvas = screen.getByRole("application", { name: /평면도/ });
    Object.defineProperty(canvas, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 580, height: 470 }) });
    await user.click(await screen.findByRole("button", { name: "거실 선택" }));
    const handle = await screen.findByRole("button", { name: "거실 오른쪽 아래 크기 조절" });

    // #when
    fireEvent.pointerDown(handle, { clientX: 510, clientY: 400, pointerId: 9 });
    fireEvent.pointerMove(canvas, { clientX: 410, clientY: 300, pointerId: 9 });
    fireEvent.pointerUp(canvas, { clientX: 410, clientY: 300, pointerId: 9 });

    // #then
    await waitFor(() => expect(roomBox().width).toBe("3400"));
    expect(roomBox().height).toBe("2300");
    expect(roomBox().x).toBe("900");
  });

  it("cuts a corner into an L, exposes the inner walls, and fills it back in", async () => {
    const user = userEvent.setup();
    render(<FloorPlanEditor repository={repository} />);
    // #given
    await user.type(await screen.findByLabelText("집 이름"), "ㄱ자 테스트");
    await user.click(screen.getByRole("button", { name: "새 집 만들기" }));
    await user.click(screen.getAllByRole("button", { name: "공간 추가" })[0]!);
    await user.click(screen.getByRole("button", { name: "생성" }));
    await waitFor(() => expect(document.querySelector(".room-create-form")).toBeNull());
    await user.click(await screen.findByRole("button", { name: "거실 선택" }));
    expect(document.querySelectorAll(".wall-line")).toHaveLength(4);

    // #when
    await user.click(screen.getByRole("button", { name: "오른쪽 위 모서리 파내기" }));

    // #then
    await waitFor(() => expect(document.querySelectorAll(".wall-line")).toHaveLength(6));
    expect(await screen.findByRole("button", { name: "거실 안쪽 가로 벽 선택" })).toBeTruthy();
    // 4,400 × 3,300 minus a third of each axis leaves the outline running through the reflex corner.
    expect(roomBox()).toMatchObject({ x: "900", y: "900", width: "4400", height: "3300" });
    expect(document.querySelector(".room-fill")?.getAttribute("d")).toContain("L 3833 2000");

    const width = screen.getByLabelText("파낸 가로 밀리미터");
    await user.clear(width);
    await user.type(width, "2000");
    fireEvent.blur(width);
    await waitFor(() => expect(document.querySelector(".room-fill")?.getAttribute("d")).toContain("L 3300 2000"));

    await user.click(screen.getByRole("button", { name: "오른쪽 위 모서리 파내기" }));
    await waitFor(() => expect(document.querySelectorAll(".wall-line")).toHaveLength(4));
  });

  it("changes a selected window's opening method locally", async () => {
    const user = userEvent.setup();
    render(<FloorPlanEditor repository={repository} />);
    await user.type(await screen.findByLabelText("집 이름"), "창문 테스트");
    await user.click(screen.getByRole("button", { name: "새 집 만들기" }));
    await user.click(screen.getAllByRole("button", { name: "공간 추가" })[0]!);
    await user.click(screen.getByRole("button", { name: "생성" }));
    await waitFor(() => expect(document.querySelector(".room-create-form")).toBeNull());
    const canvas = screen.getByRole("application", { name: /평면도/ });
    Object.defineProperty(canvas, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 580, height: 470 }) });
    await user.click(screen.getByRole("button", { name: "창문 배치" }));
    await screen.findByText("창문을 놓을 벽을 누르세요.");
    fireEvent.pointerDown(document.querySelector(".room-drawing")!, { clientX: 290, clientY: 70, pointerId: 1 });
    const opening = await screen.findByLabelText("창문 개폐 방식");
    await user.selectOptions(opening, "casement");
    await waitFor(() => expect((screen.getByLabelText("창문 개폐 방식") as HTMLSelectElement).value).toBe("casement"));
  });
});
