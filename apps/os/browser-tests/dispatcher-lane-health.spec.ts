import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ??
	new URL("../node_modules/.cache/dispatcher-health/", import.meta.url)
		.pathname;
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer();
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [375, 1280]) {
		const page = await browser.newPage({ viewport: { width, height: 900 } });
		await page.goto(`${server.origin}/work/capacity`);
		const section = page.getByRole("region", { name: "Local lanes" });
		await section.getByText("Unknown · stale", { exact: true }).waitFor();
		for (const state of ["Slots in use", "Idle", "Unknown · stale"])
			assert.equal(
				await section.locator(`[data-lane-state="${state}"]`).count(),
				1,
			);
		assert.match(
			await section.innerText(),
			/Recent skipped work: Waiting for approval \(2 occurrences\)/,
		);
		assert.match(await section.innerText(), /Last admission: Not observed/);
		assert.ok(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		);
		await section.screenshot({ path: `${evidence}/lanes-${width}.png` });
		await page.close();
	}
	for (const mode of ["empty", "error"] as const) {
		const page = await browser.newPage();
		await page.route("**/dispatcherHealth/list**", (route) =>
			route.fulfill({
				status: mode === "error" ? 503 : 200,
				contentType: "application/json",
				body: JSON.stringify({
					json:
						mode === "error"
							? { message: "Unavailable" }
							: { reportedAt: new Date().toISOString(), data: [] },
				}),
			}),
		);
		await page.goto(`${server.origin}/work/capacity`);
		await page
			.getByText(
				mode === "empty"
					? "No lane observations"
					: "Lane observations unavailable",
				{ exact: true },
			)
			.waitFor();
		assert.equal(await page.locator("[data-lane-state]").count(), 0);
		await page.close();
	}
	console.log(
		"PASS: local lane states, stale reports, empty/error states, phone and desktop",
	);
} finally {
	await browser.close();
	await server.stop();
}
