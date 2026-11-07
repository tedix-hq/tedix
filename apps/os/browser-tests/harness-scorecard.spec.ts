import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer();
const browser = await chromium.launch({ headless: true });
try {
	for (const theme of ["light", "dark"] as const) {
		const page = await browser.newPage({
			viewport: { width: 800, height: 1000 },
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
			const scorecard = page.getByRole("region", {
				name: "Runner scorecard",
				exact: true,
			});
			await scorecard.getByRole("table").waitFor();
			await scorecard
				.getByRole("cell", { name: "codex", exact: true })
				.waitFor();
			await page.evaluate(() => document.fonts.ready);
			assert.deepEqual(
				await scorecard.getByRole("columnheader").allTextContents(),
				[
					"Runner",
					"Started",
					"Succeeded",
					"Failed",
					"Orphaned*",
					"Held",
					"Supervisor kills",
					"Commits on main†",
				],
			);
			assert.equal(await scorecard.getByText(/Counts are unknown/).count(), 0);
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				"Page must fit at 800 px",
			);
			assert(
				await scorecard.getByRole("table").evaluate((table) => {
					return [...table.querySelectorAll("th, td")].every(
						(cell) => cell.scrollWidth <= cell.clientWidth + 1,
					);
				}),
				"All scorecard cells must fit without clipping",
			);
			assert.equal(
				await scorecard
					.getByRole("columnheader", { name: "Succeeded", exact: true })
					.evaluate((head) => {
						const range = document.createRange();
						range.selectNodeContents(head);
						return range.getClientRects().length;
					}),
				1,
				"Succeeded must remain readable on one line",
			);
			if (process.env.TEDIX_SCREENSHOT_DIR)
				await scorecard.screenshot({
					path: `${process.env.TEDIX_SCREENSHOT_DIR}/scorecard-800-${theme}.png`,
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
