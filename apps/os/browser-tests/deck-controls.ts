import type { Page } from "playwright";

export async function openExamples(page: Page) {
	await page.locator(".fd-app-toolbar").waitFor();
	await page.getByRole("button", { name: "Try examples", exact: true }).click();
}
