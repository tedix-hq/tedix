import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { startFixtureServer } from "./fixture-server";

const fixture = "/browser-tests/canvas-proposals.html";
const server = await startFixtureServer(fixture);
try {
	for (const engine of [chromium, webkit]) {
		const browser = await engine.launch({ headless: true });
		try {
			for (const width of [320, 1280])
				for (const theme of ["light", "dark"]) {
					const page = await browser.newPage({
						viewport: { width, height: 900 },
						colorScheme: theme as "light" | "dark",
					});
					await page.goto(`${server.origin}${fixture}?theme=${theme}`);
					await page
						.getByText("Approved · not applied", { exact: true })
						.waitFor();
					const layout = await page
						.locator('[data-slot="card-header"]')
						.evaluate((header) => {
							const title = header
								.querySelector('[data-slot="card-title"]')!
								.getBoundingClientRect();
							const action = header
								.querySelector('[data-slot="card-action"]')!
								.getBoundingClientRect();
							return {
								title: {
									top: title.top,
									bottom: title.bottom,
									right: title.right,
								},
								action: { top: action.top, left: action.left },
								overflow: document.documentElement.scrollWidth > innerWidth,
							};
						});
					assert(
						!layout.overflow,
						`${engine.name()}/${width}/${theme}: no overflow`,
					);
					if (width >= 640) {
						assert(
							Math.abs(layout.title.top - layout.action.top) <= 1,
							"desktop title/status share a row",
						);
						assert(
							layout.action.left - layout.title.right >= 8,
							"desktop title/status have a gap",
						);
					} else
						assert(
							layout.action.top - layout.title.bottom >= 8,
							"phone status wraps below title with a gap",
						);
					await page.close();
					console.log(
						`PASS suggested changes ${engine.name()}/${width}/${theme}`,
					);
				}
		} finally {
			await browser.close();
		}
	}
} finally {
	await server.stop();
}
