import type { Page } from "playwright";

export async function openExamples(page: Page) {
	await page.locator(".fd-app-toolbar").waitFor();
	const filters = page.getByRole("button", { name: "Filters", exact: true });
	if (await filters.isVisible()) await filters.click();
	await page.getByRole("button", { name: "Kind", exact: true }).click();
	await page.getByRole("button", { name: "Try examples", exact: true }).click();
	await page.keyboard.press("Escape");
	if (await filters.isVisible()) await page.keyboard.press("Escape");
}
