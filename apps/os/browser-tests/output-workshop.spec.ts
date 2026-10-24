import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer("/browser-tests/output-workshop.html");
const browser = await chromium.launch();
const evidence = process.env.OUTPUTS_EVIDENCE_DIR;
try {
	if (evidence) await mkdir(evidence, { recursive: true });
	for (const width of [375, 390, 1280]) {
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
				hasTouch: width < 640,
			});
			await page.goto(
				`${server.origin}/browser-tests/output-workshop.html?theme=${theme}`,
			);
			await page.getByRole("button", { name: "Save version" }).waitFor();
			await page.evaluate(() => document.fonts.ready);
			for (const surface of ["standalone", "workspace"]) {
				const section = page.getByRole("region", { name: surface });
				const header = section.locator("header");
				assert(
					await header.evaluate((el) => el.scrollWidth <= el.clientWidth),
					`${surface}: command bar fits`,
				);
				for (const selector of [
					".output-workshop-identity",
					".output-workshop-status",
				]) {
					assert(
						await section
							.locator(selector)
							.evaluate((el) => el.scrollWidth <= el.clientWidth),
						`${surface}: ${selector} is not clipped`,
					);
				}
				for (const target of await section.locator("button, input").all()) {
					await target.focus();
					await page.keyboard.press("Tab");
					await page.keyboard.press("Shift+Tab");
					const unreachable = await target.evaluate((el) => {
						const box = el.getBoundingClientRect();
						const css = getComputedStyle(el);
						const reach = Math.max(
							0,
							Number.parseFloat(css.outlineWidth) +
								Number.parseFloat(css.outlineOffset),
						);
						if (el !== document.activeElement) return "lost keyboard focus";
						if (box.left - reach < 0 || box.right + reach > innerWidth)
							return "outside viewport";
						for (
							let parent = el.parentElement;
							parent;
							parent = parent.parentElement
						) {
							const style = getComputedStyle(parent);
							if (
								style.overflowX === "visible" &&
								style.overflowY === "visible"
							)
								continue;
							const clip = parent.getBoundingClientRect();
							if (
								box.left - reach < clip.left ||
								box.right + reach > clip.right ||
								box.top - reach < clip.top ||
								box.bottom + reach > clip.bottom
							)
								return `clipped by ${parent.className}: ${JSON.stringify({ box, clip, reach })}`;
						}
						return el.contains(
							document.elementFromPoint(
								box.x + box.width / 2,
								box.y + box.height / 2,
							),
						)
							? ""
							: "covered";
					});
					assert.equal(
						unreachable,
						"",
						`${width}px ${theme} ${surface}: ${(await target.textContent()) || "title"} and focus ring are reachable`,
					);
					if (await target.evaluate((el) => el.tagName === "BUTTON")) {
						await target.click();
						assert.equal(
							await page.getByLabel("Last action").textContent(),
							await target.textContent(),
						);
					}
				}
			}
			if (evidence)
				await page.screenshot({
					path: `${evidence}/workshop-${width}-${theme}.png`,
				});
			await page.close();
			console.log(`Workshop reachability passed: ${width}px ${theme}`);
		}
	}
} finally {
	await browser.close();
	await server.stop();
}
