import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer("/browser-tests/dialogs.html");
const evidence = process.env.TEDIX_SCREENSHOT_DIR;
if (evidence) await mkdir(evidence, { recursive: true });
try {
	for (const engine of [chromium, webkit]) {
		const browser = await engine.launch({ headless: true });
		try {
			for (const width of [375, 1280]) {
				for (const theme of ["light", "dark"] as const) {
					for (const side of ["right", "bottom"]) {
						const page = await browser.newPage({
							viewport: { width, height: 740 },
							colorScheme: theme,
							reducedMotion: "reduce",
							hasTouch: width === 375,
						});
						const label = `${engine.name()}-${width}-${theme}-${side}`;
						await page.goto(
							`${server.origin}/browser-tests/dialogs.html?view=sheet&long&theme=${theme}&side=${side}`,
						);
						const opener = page.getByRole("button", { name: "Open details" });
						await opener.click();
						const sheet = page.getByRole("dialog", { name: "Source details" });
						await sheet.waitFor();
						await page.waitForFunction(
							() => !document.querySelector("[data-starting-style]"),
						);
						const close = sheet.getByRole("button", {
							name: "Close",
							exact: true,
						});
						for (const scrolled of [false, true]) {
							if (scrolled) {
								await sheet.evaluate((el) => {
									el.scrollTop = el.scrollHeight;
								});
								assert(
									await sheet.evaluate((el) => el.scrollTop > 0),
									`${label}: scroll exercised`,
								);
							}
							const geometry = await close.evaluate((el) => {
								const r = el.getBoundingClientRect();
								return {
									width: r.width,
									height: r.height,
									inView:
										r.left >= 0 &&
										r.top >= 0 &&
										r.right <= innerWidth &&
										r.bottom <= innerHeight,
									hits: [
										[2, r.height / 2],
										[r.width / 2, 2],
										[r.width / 2, r.height / 2],
										[r.width - 2, r.height / 2],
										[r.width / 2, r.height - 2],
									].every(([x, y]) =>
										el.contains(
											document.elementFromPoint(r.left + x!, r.top + y!),
										),
									),
								};
							});
							assert(
								geometry.width >= 44 &&
									geometry.height >= 44 &&
									geometry.inView &&
									geometry.hits,
								`${label} scrolled=${scrolled}: ${JSON.stringify(geometry)}`,
							);
						}
						if (evidence)
							await page.screenshot({ path: `${evidence}/${label}.png` });
						if (width === 375) await close.tap();
						else await close.click();
						await sheet.waitFor({ state: "hidden" });
						await opener.focus();
						await page.keyboard.press("Enter");
						await sheet.waitFor();
						await close.focus();
						await page.keyboard.press("Enter");
						await sheet.waitFor({ state: "hidden" });
						await page.close();
						console.log(`Sheet close passed: ${label}`);
					}
				}
			}
		} finally {
			await browser.close();
		}
	}
} finally {
	await server.stop();
}
