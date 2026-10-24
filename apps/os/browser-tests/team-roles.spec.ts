import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer("/team?tab=roles");
const browser = await chromium.launch();
try {
	for (const width of [375, 1280]) {
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
			});
			await page.addInitScript(
				(mode) => localStorage.setItem("tedix-os-theme", mode),
				theme,
			);
			await page.goto(`${server.origin}/team?tab=roles`);
			await page.getByText("Roles are fixed security boundaries").waitFor();
			if (width === 375) {
				assert(
					await page
						.getByRole("region", { name: "Organization role permissions" })
						.isHidden(),
				);
				const summaries = page.locator(
					'[aria-label="Organization role summaries"]',
				);
				assert(await summaries.isVisible());
				const permissions = summaries.getByRole("button").first();
				await permissions.click();
				assert.equal(await permissions.getAttribute("aria-expanded"), "true");
			} else {
				const cells = page.locator(
					'[aria-label="Organization role permissions"] tbody td',
				);
				assert.equal(await cells.count(), 12);
				for (const cell of await cells.all()) {
					assert.equal(
						await cell.evaluate((node) => getComputedStyle(node).whiteSpace),
						"normal",
					);
				}
				const responsibility = cells.nth(1);
				await responsibility.evaluate((node) => {
					node.textContent =
						"Review the fictional orchard policy and coordinate the seasonal harvest permissions. ".repeat(
							8,
						);
				});
				assert(
					await responsibility.evaluate((node) => {
						const range = document.createRange();
						range.selectNodeContents(node);
						return (
							range.getClientRects().length > 1 &&
							node.scrollWidth <= node.clientWidth
						);
					}),
				);
			}
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
			);
			console.log(`PASS Team roles ${width}px ${theme}`);
			await page.close();
		}
	}
} finally {
	await browser.close();
	await server.stop();
}
