import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

const KEY = "tedix:model-choice:v1:demo-model-picker";
const shots = process.env.QUICK_CHAT_MODEL_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const server = await startFixtureServer("/browser-tests/quick-chat-model.html");
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	for (const width of [375, 1280]) {
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height: 844 },
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			const label = `${width}px ${theme}`;
			try {
				const trigger = page.getByRole("button", { name: /^Choose model:/ });
				const open = async () => {
					await page.locator(".tedix-launcher").click();
					await trigger.waitFor();
				};
				await page.goto(
					`${server.origin}/browser-tests/quick-chat-model.html?theme=${theme}`,
				);
				await page.evaluate((key) => sessionStorage.removeItem(key), KEY);
				await page.reload();
				await open();
				// Nothing chosen yet: the trigger names Auto, the session default.
				assert.equal(
					await trigger.getAttribute("aria-label"),
					"Choose model: Auto",
				);
				assert.equal(await page.locator("select").count(), 0, label);
				const box = await trigger.boundingBox();
				assert(box && box.x >= 0 && box.x + box.width <= width, label);
				if (width === 375) assert(box.height >= 44, JSON.stringify(box));

				await trigger.click();
				const menu = page.getByRole("menu", { name: "Choose model" });
				await menu.waitFor();
				// Auto leads, there is no "Default", and no provider name shows.
				assert.deepEqual(
					await menu.getByRole("menuitemradio").allTextContents(),
					["Auto", "Fast"],
				);
				assert.equal(
					await menu
						.getByRole("menuitemradio", { name: "Auto" })
						.getAttribute("aria-checked"),
					"true",
				);
				const list = await menu.boundingBox();
				assert(list && list.x >= 0 && list.x + list.width <= width, label);
				if (shots)
					await page.screenshot({
						path: join(shots, `model-menu-${width}-${theme}.png`),
					});
				await page.keyboard.press("Escape");
				assert.equal(await menu.isVisible(), false);

				// A choice persists across a reload and is named on the trigger.
				await trigger.click();
				await menu.getByRole("menuitemradio", { name: "Fast" }).click();
				assert.equal(await menu.isVisible(), false);
				assert.equal(
					await trigger.getAttribute("aria-label"),
					"Choose model: Fast",
				);
				await page.reload();
				await open();
				assert.equal(
					await trigger.getAttribute("aria-label"),
					"Choose model: Fast",
				);
				await trigger.click();
				await menu.getByRole("menuitemradio", { name: "Auto" }).click();
				await page.reload();
				await open();
				assert.equal(
					await trigger.getAttribute("aria-label"),
					"Choose model: Auto",
				);
				assert.equal(
					await page.evaluate((key) => sessionStorage.getItem(key), KEY),
					JSON.stringify({ modelRef: "cloudflare/auto", effort: "" }),
				);
				console.log(
					`PASS quick chat model menu ${label}: Auto first, no Default`,
				);
			} finally {
				await page.close();
			}
		}
	}
} finally {
	await browser?.close();
	await server.stop();
}
