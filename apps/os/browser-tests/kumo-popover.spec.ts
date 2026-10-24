import assert from "node:assert/strict";
import { chromium, webkit, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

const fixture = "/browser-tests/kumo-popover.html";
const server = await startFixtureServer(fixture, { shared: false });
async function settled(page: Page) {
	await page.waitForFunction(
		() =>
			!document.querySelector("[data-starting-style], [data-ending-style]") &&
			document
				.getAnimations()
				.every((animation) => animation.playState !== "running"),
	);
}
try {
	for (const engine of [chromium, webkit]) {
		const browser = await engine.launch();
		try {
			for (const width of [390, 1280])
				for (const theme of ["light", "dark"] as const) {
					const context = await browser.newContext({
						viewport: { width, height: 844 },
						colorScheme: theme,
						reducedMotion: "no-preference",
					});
					const page = await context.newPage();
					const errors: string[] = [];
					page.on("pageerror", (error) => errors.push(error.message));
					for (const target of ["provider", "explicit", "body"]) {
						await page.goto(
							`${server.origin}${fixture}?theme=${theme}&target=${target}`,
						);
						const trigger = page.getByRole("button", { name: "Open popup" });
						await trigger.focus();
						await page.keyboard.press("Enter");
						const popup = page.getByRole("dialog", { name: "Adapter popup" });
						await popup.waitFor();
						await settled(page);
						await page.waitForFunction(
							() =>
								document.activeElement?.getAttribute("aria-label") ===
								"First field",
						);
						const geometry = await popup.evaluate((element) => {
							const rect = element.getBoundingClientRect();
							const style = getComputedStyle(element);
							return {
								owner:
									element.closest("#provider-portal, #explicit-portal")?.id ??
									"body",
								left: rect.left,
								right: rect.right,
								top: rect.top,
								bottom: rect.bottom,
								available: parseFloat(
									style.getPropertyValue("--available-height"),
								),
								height: rect.height,
								overflow: style.overflowY,
								zIndex: getComputedStyle(element.parentElement!).zIndex,
								fontSize: style.fontSize,
								shadow: style.boxShadow,
								expectedShadow: getComputedStyle(
									document.getElementById("style-reference")!,
								).boxShadow,
								side: element.getAttribute("data-side"),
								overscroll: style.overscrollBehaviorY,
								duration: style.transitionDuration,
								instant: element.getAttribute("data-instant"),
								easing: style.transitionTimingFunction,
								bodyOverflow: getComputedStyle(document.body).overflow,
							};
						});
						assert.equal(
							geometry.owner,
							target === "body" ? "body" : `${target}-portal`,
						);
						assert(
							geometry.left >= 0 && geometry.right <= width,
							JSON.stringify(geometry),
						);
						assert(
							geometry.top >= 0 && geometry.bottom <= 844,
							JSON.stringify(geometry),
						);
						assert(geometry.height <= geometry.available + 1);
						assert.equal(geometry.overflow, "auto");
						assert.equal(geometry.zIndex, "200");
						assert.equal(geometry.fontSize, "14px");
						assert.equal(geometry.shadow, geometry.expectedShadow);
						assert.notEqual(geometry.side, "bottom");
						assert.equal(geometry.overscroll, "contain");
						assert.equal(geometry.instant, "click");
						assert.equal(geometry.duration, "0s");
						assert.equal(geometry.easing, "cubic-bezier(0.4, 0, 0.2, 1)");
						assert.notEqual(geometry.bodyOverflow, "hidden");
						await popup.hover();
						await page.mouse.wheel(0, 250);
						await page.waitForFunction(
							() =>
								(document.querySelector('[role="dialog"]')?.scrollTop ?? 0) > 0,
						);
						await page.mouse.move(1, 1);
						await page.mouse.wheel(0, 100);
						await page.waitForFunction(() => window.scrollY > 0);
						await page.keyboard.press("Escape");
						await popup.waitFor({ state: "hidden" });
						assert(
							await trigger.evaluate(
								(element) => document.activeElement === element,
							),
						);
					}
					await page.goto(
						`${server.origin}${fixture}?theme=${theme}&focus=custom`,
					);
					await page.getByRole("button", { name: "Open popup" }).click();
					await page.waitForFunction(
						() =>
							document.activeElement?.getAttribute("aria-label") ===
							"Chosen field",
					);
					await page.keyboard.press("Escape");
					await page.waitForFunction(
						() => document.activeElement?.textContent === "After popup",
					);
					await page.goto(`${server.origin}${fixture}?theme=${theme}&hover`);
					await page.getByRole("button", { name: "Open popup" }).hover();
					const hoverPopup = page.getByRole("dialog", {
						name: "Adapter popup",
					});
					await hoverPopup.waitFor();
					await settled(page);
					assert.equal(
						await hoverPopup.evaluate(
							(element) => getComputedStyle(element).transitionDuration,
						),
						"0.15s",
					);
					await page.emulateMedia({ reducedMotion: "reduce" });
					await page.goto(
						`${server.origin}${fixture}?theme=${theme}&focus=none`,
					);
					const trigger = page.getByRole("button", { name: "Open popup" });
					await trigger.click();
					const popup = page.getByRole("dialog", { name: "Adapter popup" });
					await popup.waitFor();
					await settled(page);
					assert(
						await trigger.evaluate(
							(element) => document.activeElement === element,
						),
					);
					assert.equal(
						await popup.evaluate(
							(element) => getComputedStyle(element).transitionProperty,
						),
						"none",
					);
					await page.getByRole("textbox", { name: "Chosen field" }).click();
					await page.keyboard.press("Escape");
					await popup.waitFor({ state: "hidden" });
					assert.equal(
						await trigger.evaluate(
							(element) => document.activeElement === element,
						),
						false,
					);
					assert.deepEqual(errors, []);
					await context.close();
					console.log(`PASS Kumo popover ${engine.name()} ${width}px ${theme}`);
				}
		} finally {
			await browser.close();
		}
	}
} finally {
	await server.stop();
}
