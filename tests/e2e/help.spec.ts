import { expect, test } from "@playwright/test";

test("signed-out users can access support and recovery guidance", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "HaloChat Help & Support" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account recovery" })).toBeVisible();
  await expect(page.getByRole("link", { name: "support@halochat.app" })).toHaveAttribute("href", /^mailto:/);
});
