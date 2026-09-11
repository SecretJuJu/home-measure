import { expect, test } from "@playwright/test";

test("creates and retains a property, room, door, and saved door-width measurement while the API is unavailable", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "unavailable_in_local_e2e" }),
    });
  });

  await page.goto("/");
  await page.getByLabel("집 이름").fill("Playwright 현관 측정");
  await page.getByRole("button", { name: "새 집 만들기" }).click();
  await expect(page.getByRole("heading", { name: "Playwright 현관 측정" })).toBeVisible();

  await page.getByRole("button", { name: "공간 추가" }).first().click();
  await page.getByLabel("공간 이름").fill("현관");
  await page.getByLabel("공간 유형").selectOption("entrance");
  await page.getByRole("button", { name: "생성" }).click();
  await expect(page.getByRole("button", { name: "현관 선택" })).toBeVisible();

  await page.getByRole("button", { name: "문 배치", exact: true }).click();
  // Use the rendered wall, including SVG letterboxing, as a real touch would.
  const wallPoint = await page.locator(".floor-plan-canvas").evaluate((element) => {
    const svg = element as SVGSVGElement;
    const matrix = svg.getScreenCTM();
    if (!matrix) throw new Error("Floor-plan canvas is not rendered");
    const point = new DOMPoint(3100, 900).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(wallPoint.x, wallPoint.y);
  const door = page.getByRole("button", { name: /문 선택, 폭 820mm/ });
  await expect(door).toBeVisible();
  // The placement pointer event already selects the new door and focuses its Inspector.
  await page.getByLabel("문 폭 밀리미터").fill("910");
  await expect(page.getByLabel("문 폭 밀리미터")).toHaveValue("910");

  await expect(page.getByRole("button", { name: /현관문 폭, 필수, 미측정/ })).toBeVisible();
  await page.getByRole("button", { name: "실측 모드 ▶" }).click();
  await expect(page.getByRole("heading", { name: "현관문 폭" })).toBeVisible();
  await page.getByLabel("현관문 폭 밀리미터").fill("910");
  await page.getByRole("button", { name: "저장 후 다음 →" }).click();
  await expect(page.getByRole("heading", { name: "현관문 높이" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Playwright 현관 측정" })).toBeVisible();
  await expect(page.getByRole("button", { name: /현관문 폭, 필수, 완료/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /문 선택, 폭 910mm/ })).toBeVisible();
});
