import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const path = "/browser-tests/workspace-timeline.html";
const server = await startFixtureServer(path);
const browser = await chromium.launch({ headless: true });
const directory =
	process.env.TEDIX_BROWSER_ARTIFACTS_DIR ?? "/tmp/tedix-workspace-timeline";
await mkdir(directory, { recursive: true });
const title =
	"Review the quarterly supplier onboarding and contract renewal documents";
const started = performance.now();
try {
	for (const theme of ["light", "dark"] as const) {
		for (const width of [390, 1280]) {
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
			});
			await page.goto(`${server.origin}${path}?theme=${theme}`);
			await page.getByRole("button", { name: "Timeline", exact: true }).click();
			const scheduled = page.getByRole("region", {
				name: "Scheduled work",
				exact: true,
			});
			await scheduled.waitFor();
			assert.equal(
				await scheduled.getByRole("link", { name: title, exact: true }).count(),
				1,
			);
			assert.equal(
				await scheduled.getByRole("button").count(),
				1,
				"completed work stays read-only",
			);
			assert.equal(
				await page
					.getByRole("button", {
						name: "Schedule Plan the next review",
						exact: true,
					})
					.count(),
				1,
			);
			const measurements = await scheduled.evaluate((element) => ({
				overflow: element.scrollWidth - element.clientWidth,
				pageOverflow: document.documentElement.scrollWidth - innerWidth,
				rows: [...element.children].slice(1).map((row) => ({
					linkBottom: row.querySelector("a")!.getBoundingClientRect().bottom,
					dateTop: row.querySelector("p")!.getBoundingClientRect().top,
				})),
			}));
			assert(measurements.overflow <= 1, JSON.stringify(measurements));
			assert(measurements.pageOverflow <= 1, JSON.stringify(measurements));
			if (width === 390) {
				assert(
					await scheduled
						.getByText("Oct 24 · 3 days", { exact: true })
						.isVisible(),
				);
				assert(
					await scheduled
						.getByText("Oct 25 · 1 day", { exact: true })
						.isVisible(),
				);
				for (const row of measurements.rows)
					assert(row.dateTop >= row.linkBottom, JSON.stringify(row));
			}
			const action = scheduled.getByRole("button", {
				name: `Schedule ${title}`,
				exact: true,
			});
			const bounds = await action.boundingBox();
			assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
			if (width === 390) assert(bounds.height >= 44 && bounds.width >= 44);
			await action.focus();
			await page.screenshot({
				path: `${directory}/${width}-${theme}.png`,
				fullPage: true,
			});
			await page.keyboard.press("Enter");
			await page.getByRole("dialog").waitFor();
			assert.equal(
				await page.locator('input[type="date"]').inputValue(),
				"2026-10-24",
			);
			assert.equal(
				await page.locator('input[type="number"]').inputValue(),
				"3",
			);
			await page.close();
			console.log(`PASS workspace timeline ${width}px ${theme}`);
		}
	}
} finally {
	await browser.close();
	await server.stop();
}
console.log(
	`4 viewport/theme cases in ${((performance.now() - started) / 1000).toFixed(1)}s`,
);
