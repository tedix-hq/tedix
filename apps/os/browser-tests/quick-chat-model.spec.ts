import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer("/browser-tests/quick-chat-model.html");
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	for (const width of [375, 1440]) {
		for (const modelRef of ["", "cloudflare/auto"]) {
			const page = await browser.newPage({
				viewport: { width, height: 844 },
				reducedMotion: "reduce",
			});
			try {
				const saved = JSON.stringify({ modelRef, effort: "" });
				await page.addInitScript((value) => {
					if (
						!sessionStorage.getItem("tedix:model-choice:v1:demo-model-picker")
					)
						sessionStorage.setItem(
							"tedix:model-choice:v1:demo-model-picker",
							value,
						);
				}, saved);
				const open = async () => {
					await page.locator(".tedix-launcher").click();
					await page.getByRole("combobox", { name: "Choose model" }).waitFor();
				};
				await page.goto(`${server.origin}/browser-tests/quick-chat-model.html`);
				await open();
				const picker = page.getByRole("combobox", { name: "Choose model" });
				assert.deepEqual(await picker.locator("option").allTextContents(), [
					"Default",
					"Auto",
					"Fast",
				]);
				assert.equal(await picker.inputValue(), modelRef);
				assert.equal(
					await page.evaluate(() =>
						sessionStorage.getItem("tedix:model-choice:v1:demo-model-picker"),
					),
					saved,
				);
				const box = await picker.boundingBox();
				assert(box && box.height >= 44 && box.width >= 44, JSON.stringify(box));
				assert(box.x >= 0 && box.x + box.width <= width);
				await picker.selectOption("fast");
				await picker.selectOption("cloudflare/auto");
				await page.reload();
				await open();
				assert.equal(await picker.inputValue(), "cloudflare/auto");
				await picker.selectOption("");
				await page.reload();
				await open();
				assert.equal(await picker.inputValue(), "");
				console.log(
					`PASS quick chat ${width}px, saved ${JSON.stringify(modelRef)}: single Auto, 44px target, persisted Default/Auto`,
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
