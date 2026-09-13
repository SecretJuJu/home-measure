import { expect, type Page } from "@playwright/test";
import { test } from "./photo-fixture";
import type { LocalChecklistItem, LocalMeasurement, LocalPhotoMetadata, LocalProperty, LocalRoom } from "../src/local";

test.use({ viewport: { width: 1194, height: 834 }, hasTouch: true });

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const undersized = await page.locator('button, input:not([type="file"]):not([type="checkbox"]), select, textarea, summary').evaluateAll((nodes) => nodes.flatMap((node) => {
    if (!node.checkVisibility()) return [];
    const bounds = node.getBoundingClientRect();
    return bounds.width < 43.9 || bounds.height < 43.9
      ? [{ label: node.getAttribute("aria-label") ?? node.textContent, width: bounds.width, height: bounds.height }]
      : [];
  }));
  expect(undersized).toEqual([]);
}

async function createHome(page: Page) {
  await page.goto("/");
  await page.getByLabel("집 이름").fill("현장 검증 집");
  await page.getByRole("button", { name: "새 집 만들기" }).click();
}

async function addRoom(page: Page) {
  await page.getByRole("button", { name: "공간 추가" }).first().click();
  await page.getByRole("button", { name: "생성", exact: true }).click();
  await expect(page.locator(".room-create-form")).toHaveCount(0);
}

async function screenPoint(page: Page, x: number, y: number) {
  return page.locator(".floor-plan-canvas").evaluate((node, point) => {
    const matrix = (node as SVGSVGElement).getScreenCTM();
    if (!matrix) throw new Error("SVG not rendered");
    const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
    return { x: screen.x, y: screen.y };
  }, { x, y });
}

async function expectFieldActions(page: Page) {
  const input = page.locator(".measurement-input input");
  const save = page.getByRole("button", { name: "저장 후 다음 →" });
  const inputRect = await input.boundingBox();
  const saveRect = await save.boundingBox();
  const visible = await page.evaluate(() => ({ top: visualViewport?.offsetTop ?? 0, height: visualViewport?.height ?? innerHeight }));
  expect(inputRect).not.toBeNull(); expect(saveRect).not.toBeNull();
  expect(inputRect!.y).toBeGreaterThanOrEqual(visible.top);
  expect(inputRect!.y + inputRect!.height).toBeLessThanOrEqual(saveRect!.y);
  expect(saveRect!.y + saveRect!.height).toBeLessThanOrEqual(visible.top + visible.height + 1);
  expect(saveRect!.height).toBeGreaterThanOrEqual(44);
  await noHorizontalOverflow(page);
}

test("iPad editor fits the viewport, selects real SVG touch targets and keeps tablet/phone controls reachable", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, body: "{}" }));
  await createHome(page);
  await expect(page.locator(".empty-plan-label")).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: test.info().outputPath("empty-editor.png") });
  await addRoom(page);
  for (const width of [1194, 1024]) {
    await page.setViewportSize({ width, height: 768 });
    await expect(page.getByRole("complementary", { name: "선택한 객체 편집" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(768);
    const canvas = await page.locator(".floor-plan-canvas").boundingBox();
    expect(canvas!.width).toBeGreaterThan(width / 2);
    await noHorizontalOverflow(page);
  }
  await page.getByRole("button", { name: "문 배치", exact: true }).click();
  const wall = await screenPoint(page, 3100, 900);
  await page.touchscreen.tap(wall.x, wall.y);
  await expect(page.getByLabel("문 폭 밀리미터")).toBeVisible();
  await expect(page.locator(".door-drawing.selected")).toHaveCount(1);
  await page.getByRole("button", { name: "바깥쪽으로 열림" }).click();
  await expect(page.getByRole("button", { name: "바깥쪽으로 열림" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "거실 선택", exact: true }).click();
  await expect(page.locator(".room-drawing.selected")).toHaveCount(1);
  const south = await screenPoint(page, 3100, 4200);
  await page.touchscreen.tap(south.x, south.y - 16);
  await expect(page.locator(".wall-line.active")).toHaveCount(1);
  for (const width of [900, 768]) {
    await page.setViewportSize({ width, height: 600 });
    await expect(page.locator(".inspector-pane")).toBeHidden();
    const trigger = page.getByRole("button", { name: "속성 · 체크리스트" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "선택한 객체 편집" });
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`inspector-${width}.png`) });
    await page.keyboard.press("Shift+Tab");
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await noHorizontalOverflow(page);
  }
  await page.getByRole("button", { name: "속성 · 체크리스트" }).click();
  await page.setViewportSize({ width: 1194, height: 834 });
  await expect(page.locator("[inert]")).toHaveCount(0);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole("button", { name: "실측 모드 ▶" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "현재 공간" })).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ path: test.info().outputPath(`phone-${width}.png`) });
    await page.getByRole("button", { name: "요약", exact: true }).click();
    await expect(page.getByRole("main", { name: "실측 요약" })).toBeVisible();
    await noHorizontalOverflow(page);
    await page.getByRole("button", { name: "편집으로 돌아가기" }).click();
  }
});

test("short measurement viewports keep numeric input and Save separate and persist before advancing", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, body: "{}" }));
  await createHome(page); await addRoom(page);
  await page.getByRole("button", { name: "실측 모드 ▶" }).click();
  for (const width of [1024, 390, 320]) {
    await page.setViewportSize({ width, height: 400 });
    await page.locator(".measurement-input input").fill("3450");
    await expectFieldActions(page);
    await page.screenshot({ path: test.info().outputPath(`measurement-${width}x400.png`) });
  }
  await page.getByRole("button", { name: "저장 후 다음 →" }).click();
  await expect(page.getByRole("heading", { name: "공간 세로" })).toBeVisible();
  await page.getByRole("button", { name: "목록으로" }).click();
  await expect(page.getByRole("button", { name: /공간 가로, 필수, 완료/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: /공간 가로, 필수, 완료/ })).toBeVisible();
});

test("keyboard visual viewport resize and pan keep actions inside the visible area", async ({ page }) => {
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { height: 834, offsetTop: 0 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  });
  await page.route("**/api/**", (route) => route.fulfill({ status: 503, body: "{}" }));
  await createHome(page); await addRoom(page);
  await page.getByRole("button", { name: "실측 모드 ▶" }).click();
  await page.evaluate(() => {
    Object.assign(visualViewport!, { height: 360, offsetTop: 80 });
    visualViewport!.dispatchEvent(new Event("resize"));
    visualViewport!.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator(".measurement-mode")).toHaveAttribute("data-compact", "true");
  await page.locator(".measurement-input input").fill("3120");
  await expectFieldActions(page);
  await page.screenshot({ path: test.info().outputPath("keyboard-visual-viewport.png") });
  await page.getByRole("button", { name: "저장 후 다음 →" }).click();
  await expect(page.getByRole("heading", { name: "공간 세로" })).toBeVisible();
});

test("real HTTP requests show syncing, failure and offline retry without changing mutation IDs", async ({ page }) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const mutationIds: string[] = [];
  let fail = true;
  await page.route("**/api/**", async (route) => {
    const body = route.request().postDataJSON() as { clientMutationId?: string } | null;
    // Only queued mutations carry an ID; the account probe answers straight away as signed out.
    if (!body?.clientMutationId) {
      await route.fulfill({ status: 401, body: JSON.stringify({ error: "unauthorized" }) });
      return;
    }
    mutationIds.push(body.clientMutationId);
    await gate;
    await route.fulfill({ status: fail ? 503 : 200, body: "{}" });
  });
  await createHome(page);
  await expect(page.getByRole("status")).toContainText("동기화 중");
  await page.screenshot({ path: test.info().outputPath("syncing.png") });
  release();
  await expect(page.getByRole("status")).toContainText("동기화 실패");
  await page.context().setOffline(true);
  await expect(page.getByRole("status")).toContainText("오프라인");
  await page.screenshot({ path: test.info().outputPath("offline.png") });
  fail = false;
  await page.context().setOffline(false);
  await expect(page.getByRole("status")).toContainText("동기화됨");
  expect(mutationIds.length).toBeGreaterThanOrEqual(2);
  expect(new Set(mutationIds).size).toBe(1);
});

test("photo upload failure retains context, memo and preview; reconnect retries the same upload", async ({ photoPage: page }) => {
  let uploadFails = true;
  const uploadIds: string[] = [];
  await page.route("**/api/**", async (route) => {
    const isUpload = route.request().url().endsWith("/upload");
    if (isUpload) uploadIds.push(route.request().headers()["x-client-mutation-id"]!);
    await route.fulfill({ status: isUpload && uploadFails ? 503 : 200, body: "{}" });
  });
  await createHome(page); await addRoom(page);
  await page.getByRole("button", { name: "실측 모드 ▶" }).click();
  await page.getByLabel("사진 메모 (선택)").fill("창틀 왼쪽 모서리");
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 100; canvas.height = 80;
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#d8dde5"; ctx.fillRect(0, 0, 100, 80);
    ctx.strokeStyle = "#202630"; ctx.strokeRect(20, 15, 60, 50);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await page.getByLabel("첨부할 사진 선택").setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await expect(page.locator('[data-photo-status="failed"]')).toBeVisible();
  const trigger = page.getByRole("button", { name: "사진 열기: 거실 · 공간 가로" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "거실 · 공간 가로" });
  await expect(dialog).toContainText("창틀 왼쪽 모서리");
  await expect(dialog.getByRole("img", { name: "거실 · 공간 가로 사진 상세 미리보기", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("photo-failure-detail.png") });
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "사진 상세 닫기" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  uploadFails = false;
  await page.context().setOffline(true); await page.context().setOffline(false);
  await expect(page.locator('[data-photo-status="uploaded"]')).toBeVisible();
  expect(uploadIds).toHaveLength(2); expect(uploadIds[0]).toBe(uploadIds[1]);
  await expect(trigger.getByText("미리보기 없음", { exact: true })).toBeVisible();
});

export async function seedReferenceHome(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "새 집 만들기" })).toBeVisible();
  const property: LocalProperty = { id: "property_visual01", name: "성수동 새집", address: "서울 성동구", note: null, createdAt: 1, updatedAt: 1, dirty: false };
  const rooms: LocalRoom[] = [
    { id: "room_visual01", name: "현관", type: "entrance", layout: { version: 1, position: { x: 900, y: 900 }, size: { width: 2200, height: 3300 }, doors: [{ id: "door_visual01", wall: "south", offset: 550, width: 820, hinge: "left", opening: "inward" }], windows: [], utilities: [{ id: "utility_visual01", type: "interphone", position: { x: 1300, y: 1500 } }] }, propertyId: property.id, createdAt: 1, updatedAt: 1, dirty: false },
    { id: "room_visual02", name: "거실", type: "living_room", layout: { version: 1, position: { x: 3400, y: 900 }, size: { width: 4400, height: 3300 }, doors: [{ id: "door_visual02", wall: "west", offset: 600, width: 900, hinge: "right", opening: "inward" }], windows: [{ id: "window_visual01", wall: "north", offset: 600, width: 2200, height: 1500, sillHeight: 800, opening: "sliding" }], utilities: [{ id: "utility_visual02", type: "outlet", position: { x: 7200, y: 3600 } }] }, propertyId: property.id, createdAt: 2, updatedAt: 2, dirty: false },
    { id: "room_visual03", name: "주방", type: "kitchen", layout: { version: 1, position: { x: 3400, y: 4500 }, size: { width: 3400, height: 2200 }, doors: [], windows: [], utilities: [{ id: "utility_visual03", type: "water", position: { x: 5900, y: 5000 } }] }, propertyId: property.id, createdAt: 3, updatedAt: 3, dirty: false },
  ];
  const labels = ["현관문 폭", "최소 통과 폭", "천장 높이", "창문 폭", "콘센트 위치", "냉장고 공간 가로", "냉장고 공간 깊이", "냉장고 공간 높이"];
  const items: LocalChecklistItem[] = labels.map((label, index) => ({ id: `checklist_visual0${index}`, propertyId: property.id, roomId: rooms[index < 3 ? 0 : index < 5 ? 1 : 2]!.id, elementId: index === 0 ? "door_visual01" : index === 3 ? "window_visual01" : null, label, category: "other", required: index !== 4, status: index === 2 || index === 4 || index === 7 ? "pending" : "complete", measurementId: index === 2 || index === 4 || index === 7 ? null : `measurement_visual0${index}`, sortOrder: index, createdAt: index, updatedAt: index, dirty: false }));
  const values = [820, 780, 0, 2200, 0, 900, 750, 0];
  const measurements: LocalMeasurement[] = items.filter((item) => item.measurementId).map((item) => ({ id: item.measurementId!, propertyId: property.id, roomId: item.roomId, elementId: item.elementId, checklistItemId: item.id, type: "width", value: values[item.sortOrder]!, unit: "mm", note: null, createdAt: 1, updatedAt: 1, dirty: false }));
  const photos: LocalPhotoMetadata[] = [{ id: "photo_visual01", propertyId: property.id, roomId: rooms[1]!.id, elementId: "window_visual01", checklistItemId: items[3]!.id, r2Key: "photos/visual/photo.webp", mimeType: "image/webp", width: 800, height: 600, note: "창틀 왼쪽 · 벽에서 120 mm", createdAt: 1, updatedAt: 1, dirty: false, uploadStatus: "uploaded", uploadMutationId: "upload_visual01", uploadAttempts: 1, uploadError: null }];
  await page.evaluate(async (records) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("home-measure"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(Object.keys(records), "readwrite");
      for (const [table, entities] of Object.entries(records)) for (const entity of entities) tx.objectStore(table).put(entity);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    }); db.close();
  }, { properties: [property], rooms, checklistItems: items, measurements, photoMetadata: photos });
  await page.reload();
  await expect(page.getByRole("heading", { name: property.name })).toBeVisible();
}

test("Summary shows recorded values, explicit missing axes, room details and contextual photos", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ status: 200, body: "{}" }));
  await seedReferenceHome(page);
  await page.getByRole("button", { name: /현관문 폭, 필수, 완료/ }).click();
  await page.screenshot({ path: test.info().outputPath("ipad-editor.png") });
  await page.getByRole("button", { name: "요약 보기" }).click();
  await expect(page.getByRole("region", { name: "최소 통과 폭" })).toContainText("780 mm");
  await expect(page.getByRole("region", { name: "기록된 가전 설치 공간" })).toContainText("900 mm");
  await expect(page.getByRole("region", { name: "기록된 가전 설치 공간" })).toContainText("미측정");
  await expect(page.getByRole("article", { name: "현관 문과 주요 설비" })).toContainText("820 mm");
  await expect(page.getByRole("article", { name: "주방 문과 주요 설비" })).toContainText("5900 × 5000 mm");
  await page.screenshot({ path: test.info().outputPath("summary.png"), fullPage: true });
  await page.getByRole("button", { name: "사진 열기: 거실 · 창문 폭" }).click();
  await expect(page.getByRole("dialog")).toContainText("창틀 왼쪽 · 벽에서 120 mm");
  await expect(page.getByRole("dialog")).toContainText("사진 업로드됨");
  await expect(page.getByRole("dialog")).toContainText("미리보기 없음");
  await page.keyboard.press("Escape");
  for (const width of [1024, 768, 390, 320]) { await page.setViewportSize({ width, height: 700 }); await noHorizontalOverflow(page); }
});
