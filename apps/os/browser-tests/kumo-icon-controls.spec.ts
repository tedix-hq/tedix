import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { startFixtureServer } from "./fixture-server";

// Icon-only Kumo controls keep their glyph centred at the desktop size and at
// the 44px touch target, without call-site className overrides.
const fixture = "/browser-tests/kumo-icon-controls.html";
const evidence = new URL(
	"../node_modules/.cache/kumo-icon-controls/",
	import.meta.url,
).pathname;
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer(fixture);
let checks = 0;
try {
	for (const engine of [chromium, webkit]) {
		const browser = await engine.launch({ headless: true });
		try {
			for (const [width, touch] of [
				[375, false],
				[1280, false],
				[1280, true],
			] as const) {
				for (const theme of ["light", "dark"] as const) {
					const label = `${engine.name()}-${width}${touch ? "-touch" : ""}-${theme}`;
					const context = await browser.newContext({
						viewport: { width, height: 480 },
						colorScheme: theme,
						hasTouch: touch,
						isMobile: touch && engine === chromium,
					});
					const page = await context.newPage();
					const errors: string[] = [];
					page.on("pageerror", (error) => errors.push(error.message));
					await page.goto(`${server.origin}${fixture}?theme=${theme}`);
					const layout = page.getByRole("group", { name: "Layout" });
					await layout.waitFor();
					await page.evaluate(() => document.fonts.ready);
					const coarse = await page.evaluate(
						() => matchMedia("(pointer: coarse)").matches,
					);
					const target = width < 640 || coarse;

					const geometry = await page.evaluate(() =>
						[...document.querySelectorAll<HTMLElement>("[data-icon-only]")].map(
							(button) => {
								const box = button.getBoundingClientRect();
								const icon = button
									.querySelector("svg")!
									.getBoundingClientRect();
								return {
									name: button.getAttribute("aria-label"),
									width: box.width,
									height: box.height,
									dx: icon.left + icon.width / 2 - (box.left + box.width / 2),
									dy: icon.top + icon.height / 2 - (box.top + box.height / 2),
								};
							},
						),
					);
					assert.equal(geometry.length, 7, `${label}: icon-only controls`);
					for (const button of geometry) {
						assert.ok(
							Math.abs(button.dx) <= 0.5 && Math.abs(button.dy) <= 0.5,
							`${label}: ${button.name} icon is centred (${button.dx}, ${button.dy})`,
						);
						assert.equal(
							button.width,
							button.height,
							`${label}: ${button.name} is square`,
						);
						if (target)
							assert.ok(
								button.width >= 44,
								`${label}: ${button.name} keeps the 44px target (${button.width})`,
							);
					}
					const segments = geometry.filter((button) =>
						button.name?.endsWith(" view"),
					);
					for (const segment of segments)
						assert.equal(
							segment.width,
							target ? 44 : 32,
							`${label}: ${segment.name} segment size`,
						);

					// The toggle sits on the same centre line as the header action.
					const header = await page.evaluate(() => {
						const centre = (element: Element) => {
							const box = element.getBoundingClientRect();
							return box.top + box.height / 2;
						};
						const action = [
							...document.querySelectorAll('[data-fixture="header"] button'),
						].find((button) => button.textContent?.includes("New document"))!;
						return {
							action: centre(action),
							rail: centre(
								document.querySelector(
									'[data-kumo-component="SegmentedControl"]',
								)!,
							),
						};
					});
					assert.ok(
						Math.abs(header.action - header.rail) <= 1 || target,
						`${label}: toggle shares the header centre line`,
					);

					const link = page.getByRole("button", { name: "Try again" });
					assert.equal(
						await link.evaluate(
							(element) => getComputedStyle(element).paddingLeft,
						),
						"0px",
						`${label}: link action is flush with its sentence`,
					);

					await page.getByRole("button", { name: "Grid view" }).click();
					assert.equal(
						await page
							.getByRole("button", { name: "Grid view" })
							.getAttribute("aria-pressed"),
						"true",
						`${label}: grid view selects`,
					);
					await page.mouse.move(0, 0);
					await page.waitForFunction(() =>
						document
							.getAnimations()
							.every((animation) => animation.playState !== "running"),
					);
					await page.screenshot({ path: `${evidence}${label}.png` });
					assert.deepEqual(errors, [], `${label}: no page errors`);
					checks++;
					await context.close();
				}
			}
		} finally {
			await browser.close();
		}
	}
	console.log(
		`PASS: kumo icon controls ${checks} engine/viewport/theme checks; screenshots in ${evidence}`,
	);
} finally {
	await server.stop();
}
