import { expect, test } from "@playwright/test";

/**
 * The README's screenshots, captured from the demo build so they can never contain a real
 * tenant. Run with `bunx playwright test e2e/screenshots.spec.ts --grep @screenshot`.
 */

const shots = [
  { name: "dashboard", path: "/", open: "Executive overview" },
  { name: "explore", path: "/explore" },
  { name: "errors", path: "/errors" },
  { name: "connections", path: "/connections/new" },
  { name: "customers", path: "/customers" },
];

test.describe("@screenshot", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const shot of shots) {
    test(`capture ${shot.name}`, async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("dashflow.theme", "dark"));
      await page.goto(shot.path);
      if (shot.open) await page.getByRole("heading", { name: shot.open }).click();
      // Charts animate in; give them a moment so nothing is captured mid-transition.
      await expect(page.locator("canvas").first())
        .toBeVisible({ timeout: 20_000 })
        .catch(() => {});
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `docs/images/${shot.name}.png`, animations: "disabled" });
    });
  }

  test("capture light theme", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("dashflow.theme", "light"));
    await page.goto("/");
    await page.getByRole("heading", { name: "User experience" }).click();
    await expect(page.locator("canvas").first())
      .toBeVisible({ timeout: 20_000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "docs/images/dashboard-light.png", animations: "disabled" });
  });
});
