import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { startFixtureServer } from "./fixture-server";

// The workpiece view switcher (App / Code / Runs / Connections / Review) is
// shell chrome shared by every workspace gadget. On a phone its labels must
// never overlap or clip, and every view must stay reachable. When the row is
// too narrow for every segment (chat open beside the app), the selected view
// stays scrolled into sight.
const workpiecePath =
	"/workspace/00000030-0000-4000-8000-000000000001?workpiece=gadget%3A00000031-0000-4000-8000-00000000000a&pane=workpiece";
const views = ["App", "Code", "Runs", "Connections", "Review"];
const server = await startFixtureServer("/work");

try {
	for (const { engine, widths } of [
		{ engine: chromium, widths: [375, 1024, 1280] },
		{ engine: webkit, widths: [390] },
	]) {
		const browser = await engine.launch({ headless: true });
		try {
			for (const width of widths) {
				const label = `${engine.name()}/${width}`;
				const phone = width < 640;
				const page = await browser.newPage({
					viewport: { width, height: 844 },
					isMobile: phone && engine === chromium,
					hasTouch: phone,
				});
				await page.goto(`${server.origin}${workpiecePath}`);
				const switcher = page.getByRole("group", {
					name: "Active workpiece view",
				});
				await switcher.waitFor();
				const segments = await switcher.locator("button").evaluateAll((els) =>
					els.map((el) => {
						const box = el.getBoundingClientRect();
						return {
							text: el.textContent ?? "",
							left: box.left,
							right: box.right,
							clipped: el.scrollWidth > el.clientWidth,
						};
					}),
				);
				assert.deepEqual(
					segments.map((segment) => segment.text),
					views,
					`${label}: all five views are offered`,
				);
				for (const [index, segment] of segments.entries()) {
					assert(!segment.clipped, `${label}: ${segment.text} label fits`);
					const next = segments[index + 1];
					if (next)
						assert(
							segment.right <= next.left + 0.5,
							`${label}: ${segment.text} does not overlap ${next.text}`,
						);
				}
				assert(
					await page.evaluate(
						() => document.documentElement.scrollWidth <= innerWidth,
					),
					`${label}: no sideways page scroll`,
				);
				for (const view of views.toReversed()) {
					const segment = switcher.getByRole("button", {
						name: view,
						exact: true,
					});
					await segment.click();
					assert.equal(
						await segment.getAttribute("aria-pressed"),
						"true",
						`${label}: ${view} is reachable`,
					);
				}
				// Open straight on the last view: the row must reveal it unaided.
				await page.goto(`${server.origin}${workpiecePath}&view=activity`);
				await switcher.waitFor();
				await page.waitForTimeout(200);
				const reveal = await switcher.evaluate((el) => {
					const view = el.getBoundingClientRect();
					const active = el
						.querySelector('[aria-pressed="true"]')
						?.getBoundingClientRect();
					return active
						? {
								inside:
									active.left >= view.left - 0.5 &&
									active.right <= view.right + 0.5,
								onScreen: active.right <= innerWidth + 0.5,
							}
						: null;
				});
				assert.deepEqual(
					reveal,
					{ inside: true, onScreen: true },
					`${label}: the selected Review view is in sight on load`,
				);
				await page.close();
			}
		} finally {
			await browser.close();
		}
	}
} finally {
	await server.stop();
}
