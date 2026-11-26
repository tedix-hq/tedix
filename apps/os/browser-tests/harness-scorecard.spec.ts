import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer();
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [375, 800]) {
		const theme = "light";
		const page = await browser.newPage({
			viewport: { width, height: 1000 },
			colorScheme: theme,
		});
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		try {
			await page.goto(`${server.origin}/work?view=feed`);
			await page.evaluate((theme) => {
				document.documentElement.classList.toggle("dark", theme === "dark");
				document.documentElement.dataset.mode = theme;
			}, theme);
			const trigger = page.getByRole("button", { name: /Agent scorecard/ });
			const running = page.getByRole("button", {
				name: "Running now",
				exact: true,
			});
			// Phones keep Running now behind its toolbar toggle.
			await trigger.or(running).first().waitFor();
			if (!(await trigger.isVisible())) await running.click();
			await trigger.click();
			const scorecard = page.getByRole("region", {
				name: "Agent scorecard",
				exact: true,
			});
			await scorecard.getByRole("table").waitFor();
			await scorecard.getByText("example-model").first().waitFor();
			assert.equal(
				await scorecard.getByRole("cell", { name: /Codex/ }).count(),
				1,
			);
			await scorecard
				.getByRole("button", { name: "30 days", exact: true })
				.click();
			await scorecard.getByText("8 attempts · 2 items").first().waitFor();
			await scorecard
				.getByRole("button", { name: "7 days", exact: true })
				.click();
			await scorecard.getByText("3 attempts · 2 items").first().waitFor();
			await page.evaluate(() => document.fonts.ready);
			assert.deepEqual(
				await scorecard.getByRole("columnheader").allTextContents(),
				["Agent / model", "Outcomes", "Settlement", "Cost / quality"],
			);
			assert.equal(await scorecard.getByText(/Unknown/).count(), 0);
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				`Page must fit at ${width} px`,
			);
			assert(
				await scorecard.getByRole("table").evaluate((table) => {
					const box = table.parentElement!;
					return (
						box.scrollWidth <= box.clientWidth &&
						[...table.querySelectorAll("th, td")].every(
							(cell) => cell.scrollWidth <= cell.clientWidth + 1,
						)
					);
				}),
				`All scorecard cells must fit at ${width} px without scrolling`,
			);
			if (process.env.TEDIX_SCREENSHOT_DIR)
				await scorecard.screenshot({
					path: `${process.env.TEDIX_SCREENSHOT_DIR}/scorecard-${width}-${theme}.png`,
				});
		} catch (error) {
			console.error({
				url: page.url(),
				errors,
				body: (await page.locator("body").innerText()).slice(0, 5000),
			});
			throw error;
		} finally {
			await page.close();
		}
	}
} finally {
	await browser.close();
	await server.stop();
}
