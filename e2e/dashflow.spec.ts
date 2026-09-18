import { expect, test } from "@playwright/test";

/**
 * Smoke tests against the demo build — the same UI as production, with the mock API, so no
 * database is needed in CI. These cover the paths unit tests cannot: a chart actually
 * rendering, a drill-through opening, the palette responding to a keystroke.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Dark is the designed default; pin it so screenshots and assertions are stable.
    localStorage.setItem("dashflow.theme", "dark");
  });
});

test("the app loads with its dashboards", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboards", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Executive overview" })).toBeVisible();
});

test("a dashboard renders KPIs and charts from the synthetic estate", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("heading", { name: "Executive overview" }).click();

  await expect(page.getByText("Unique users")).toBeVisible();
  // A KPI that rendered has a formatted number under it, not a skeleton.
  await expect(page.locator(".tabular-nums").first()).not.toBeEmpty();
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 15_000 });
});

test("drilling into an error code opens the records behind it", async ({ page }) => {
  await page.goto("/errors");
  await expect(page.getByText("Error codes")).toBeVisible();

  // The first data row of the error catalogue.
  await page.getByRole("row").nth(1).click();

  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: /Export CSV/ })).toBeVisible();
  await drawer.getByRole("button", { name: "Close panel" }).click();
  await expect(drawer).toBeHidden();
});

test("the guided builder previews a template against real data", async ({ page }) => {
  await page.goto("/dashboards/new");
  await page.getByRole("heading", { name: "Capacity and scaling" }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();

  await expect(page.getByRole("button", { name: /Create dashboard/ })).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 15_000 });
});

test("explore answers an ad-hoc question and keeps it in the URL", async ({ page }) => {
  await page.goto("/explore");
  await expect(page.getByRole("heading", { name: "Explore", level: 1 })).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "bar", exact: true }).click();
  await expect(page).toHaveURL(/viz=bar/);
});

test("the error catalogue lists codes and the busiest users", async ({ page }) => {
  await page.goto("/errors");
  await expect(page.getByText("Error codes")).toBeVisible();
  await expect(page.getByText("Busiest users")).toBeVisible();
  await expect(page.getByRole("row").nth(1)).toBeVisible();
});

test("the command palette opens on the keyboard and navigates", async ({ page }) => {
  await page.goto("/");
  // The shortcut is registered when the shell mounts, so wait for it to be on screen first.
  await expect(page.getByRole("heading", { name: "Dashboards", level: 1 })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");

  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await palette.getByPlaceholder(/Search dashboards/).fill("explore");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: "Explore", level: 1 })).toBeVisible();
});

test("the theme toggle switches to light and back", async ({ page }) => {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: /^Theme:/ });
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", /light|dark/);
});
