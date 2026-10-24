import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const path = "/browser-tests/workspace-timeline.html";
const server = await startFixtureServer(path);
const browser = await chromium.launch({ headless: true });
const directory =
	process.env.TEDIX_BROWSER_ARTIFACTS_DIR ?? "/tmp/tedix-workspace-board";
await mkdir(directory, { recursive: true });
const started = performance.now();
try {
	for (const theme of ["light", "dark"] as const) {
		for (const width of [375, 390, 1280]) {
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
			});
			await page.goto(`${server.origin}${path}?theme=${theme}`);
			await page.getByRole("button", { name: "Board", exact: true }).click();
			const proposed = page.getByRole("region", {
				name: "Proposed",
				exact: true,
			});
			const board = proposed.locator("..");
			const lanes = board.getByRole("region");
			assert.equal(await lanes.count(), 3);
			const measurements = await board.evaluate((element) => ({
				pageOverflow: document.documentElement.scrollWidth - innerWidth,
				overflow: element.scrollWidth - element.clientWidth,
				lanes: [...element.querySelectorAll("section")].map((lane) => {
					const { x, y, width, bottom } = lane.getBoundingClientRect();
					return { x, y, width, bottom };
				}),
			}));
			assert(measurements.pageOverflow <= 1, JSON.stringify(measurements));
			for (const [index, lane] of measurements.lanes.entries()) {
				if (width < 768) {
					assert(
						lane.x >= 0 && lane.x + lane.width <= width,
						JSON.stringify(lane),
					);
					assert(measurements.overflow <= 1, JSON.stringify(measurements));
					if (index > 0) assert(lane.y >= measurements.lanes[index - 1].bottom);
				} else {
					assert.equal(lane.y, measurements.lanes[0].y);
					if (index > 0) assert(lane.x > measurements.lanes[index - 1].x);
				}
			}
			assert.equal(await board.getByRole("link").count(), 3);
			assert.equal(await board.getByRole("button").count(), 2);
			for (const action of await board.getByRole("button").all()) {
				await action.scrollIntoViewIfNeeded();
				const bounds = await action.boundingBox();
				assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
				await action.focus();
				await page.keyboard.press("Enter");
				await page.getByRole("dialog").waitFor();
				await page.keyboard.press("Escape");
				await page.getByRole("dialog").waitFor({ state: "hidden" });
			}
			await page.getByRole("button", { name: "Show empty groups" }).click();
			assert((await lanes.count()) > 3);
			if (width < 768)
				assert(
					await board.evaluate(
						(element) => element.scrollWidth <= element.clientWidth + 1,
					),
				);
			await page.screenshot({
				path: `${directory}/${width}-${theme}.png`,
				fullPage: true,
			});
			await page.getByRole("button", { name: "Hide empty groups" }).click();
			assert.equal(await lanes.count(), 3);
			await page.close();
			console.log(`PASS workspace board ${width}px ${theme}`);
		}
	}
} finally {
	await browser.close();
	await server.stop();
}
console.log(
	`6 viewport/theme cases in ${((performance.now() - started) / 1000).toFixed(1)}s`,
);
