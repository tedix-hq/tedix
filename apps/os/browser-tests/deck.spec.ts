import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chromium, type Browser } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
const probe = createServer();
await new Promise<void>((resolve, reject) => {
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", resolve);
});
const address = probe.address();
assert(address && typeof address !== "string");
const port = String(address.port);
await new Promise<void>((resolve, reject) => {
	probe.close((error) => (error ? reject(error) : resolve()));
});
const origin = `http://127.0.0.1:${port}`;
const server = Bun.spawn(
	[
		"../../node_modules/.bin/vp",
		"dev",
		"--port",
		port,
		"--strictPort",
		"--host",
		"127.0.0.1",
	],
	{ cwd, stdout: "ignore", stderr: "inherit", detached: true },
);
let browser: Browser | undefined;
try {
	let ready = false;
	for (let i = 0; i < 100; i++) {
		if (server.exitCode !== null)
			throw new Error(`Vite exited: ${server.exitCode}`);
		try {
			ready = (await fetch(`${origin}/browser-tests/deck.html`)).ok;
		} catch {}
		if (ready) break;
		await Bun.sleep(250);
	}
	assert(ready, "Vite serves the real generic renderer and app CSS");
	browser = await chromium.launch({ headless: true });
	for (const viewport of [
		{ width: 1280, height: 800 },
		{ width: 390, height: 844 },
	]) {
		const page = await browser.newPage({ viewport });
		try {
			await page.goto(`${origin}/browser-tests/deck.html`);
			await page
				.getByRole("button", { name: "Decision context", exact: true })
				.click();
			await page
				.getByRole("button", { name: "Try examples", exact: true })
				.click();
			if (viewport.width < 640)
				await page
					.getByRole("button", { name: "Close decision context", exact: true })
					.click();
			else await page.keyboard.press("Escape");
			const card = page.getByRole("region", {
				name: "Send Morgan the revised delivery date?",
			});
			await card.waitFor();
			assert.equal(
				await page
					.locator('[data-workspace-app-entry="decision-deck"] .fd-decision')
					.count(),
				1,
				"one card at a time",
			);
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				"phone and desktop have no horizontal overflow",
			);
			await card.focus();
			await page.keyboard.press("ArrowRight");
			await page.getByRole("alertdialog").waitFor();
			await page.getByRole("button", { name: "Go back", exact: true }).click();
			await card.focus();
			await page.keyboard.press("?");
			await page
				.getByRole("heading", { name: "Shortcuts", exact: true })
				.waitFor();
			await page.keyboard.press("Escape");
			await page.getByRole("button", { name: "Why this", exact: true }).click();
			await page
				.getByText("Prefer a bounded next step with evidence", { exact: false })
				.waitFor();
			await page.keyboard.press("Escape");
			await card.evaluate((element) => {
				element.dispatchEvent(
					new TouchEvent("touchstart", {
						bubbles: true,
						touches: [
							new Touch({
								identifier: 1,
								target: element,
								clientX: 300,
								clientY: 200,
							}),
						],
					}),
				);
				element.dispatchEvent(
					new TouchEvent("touchend", {
						bubbles: true,
						changedTouches: [
							new Touch({
								identifier: 1,
								target: element,
								clientX: 90,
								clientY: 205,
							}),
						],
					}),
				);
			});
			await page
				.getByRole("button", { name: "wrong tone", exact: true })
				.click();
			await page
				.getByRole("region", {
					name: "File this request under Supplier review?",
				})
				.waitFor();
			await page
				.getByRole("region", {
					name: "File this request under Supplier review?",
				})
				.focus();
			await page.keyboard.press("d");
			await page
				.getByRole("region", {
					name: "Which outcome matters most for this project?",
				})
				.waitFor();
			for (let i = 0; i < 4; i++) {
				await page
					.locator('[data-workspace-app-entry="decision-deck"] section')
					.focus();
				await page.keyboard.press("j");
			}
			await page.getByText("All clear", { exact: false }).waitFor();
			assert.equal(
				await page
					.locator('[data-workspace-app-entry="decision-deck"] .fd-decision')
					.count(),
				0,
				"the deck ends instead of wrapping",
			);
			assert(
				await page.getByText("Next cards at", { exact: false }).isVisible(),
				"closure names the next scheduled batch",
			);
			console.log(
				`Decision deck browser passed: ${viewport.width}x${viewport.height}`,
			);
		} finally {
			await page.close();
		}
	}
	assert.equal(server.exitCode, null, "Own fixture server stayed alive");
} finally {
	await browser?.close();
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	await server.exited;
}
