import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer();
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [375, 1280])
		for (const theme of ["light", "dark"]) {
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				reducedMotion: "reduce",
			});
			const failures: string[] = [];
			page.on("pageerror", (error) => failures.push(error.message));
			page.on("requestfailed", (request) =>
				failures.push(
					`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`,
				),
			);
			try {
				let failRead = width === 375 && theme === "light";
				await page.route(
					"**/api/rpc/workAgentSessions/listOperations",
					async (route) => {
						if (failRead)
							await route.fulfill({
								status: 503,
								contentType: "application/json",
								body: JSON.stringify({ message: "Fixture unavailable" }),
							});
						else await route.continue();
					},
				);
				await page.goto(`${server.origin}/work?app=office`);
				const timeline = page.locator(
					"[aria-labelledby=office-timeline-title]",
				);
				if (failRead) {
					await timeline.getByRole("alert").waitFor();
					assert.equal(
						await timeline
							.getByText(
								"Activity is unavailable; this does not mean nothing happened.",
								{ exact: true },
							)
							.count(),
						1,
					);
					failRead = false;
					await timeline
						.getByRole("button", { name: "Retry activity" })
						.click();
				}
				await timeline
					.getByText("Reply saved; delivery is unconfirmed", { exact: true })
					.waitFor();
				await page.evaluate((theme) => {
					document.documentElement.classList.toggle("dark", theme === "dark");
					document.documentElement.dataset.mode = theme;
					document.documentElement.style.colorScheme = theme;
				}, theme);
				await page.evaluate(() => document.fonts.ready);
				await timeline.scrollIntoViewIfNeeded();
				assert.equal(
					await timeline
						.getByText("4 coalesced status observations", { exact: false })
						.count(),
					1,
				);
				assert.equal(
					await timeline
						.getByText(
							"Work closed; successful Attempt and result note recorded",
							{ exact: true },
						)
						.count(),
					1,
				);
				await timeline
					.getByRole("combobox", { name: "Sources", exact: true })
					.click();
				await page
					.getByRole("option", { name: "supervisor", exact: true })
					.click();
				await timeline
					.getByText(
						"Reply fallback · Queued or unconfirmed; pickup is unknown",
						{ exact: true },
					)
					.waitFor();
				assert.equal(
					await timeline
						.getByText("Reply saved; delivery is unconfirmed", { exact: true })
						.count(),
					0,
				);
				assert(
					await page.evaluate(
						() => document.documentElement.scrollWidth <= innerWidth,
					),
					`${width}/${theme}: no page overflow`,
				);
				assert.equal(
					await timeline.locator('a[href^="/work/interactions/"]').count(),
					1,
				);
				console.log(
					`Office timeline ${width}/${theme}: source filtering, receipt wording, links and width passed`,
				);
			} catch (error) {
				console.error("Office fixture diagnostics", {
					width,
					theme,
					url: page.url(),
					failures,
					text: (await page.locator("body").innerText()).slice(0, 4000),
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
