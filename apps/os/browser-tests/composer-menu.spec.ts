import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { chromium, type Browser } from "playwright";

const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
const address = probe.address();
assert(address && typeof address !== "string");
const port = String(address.port);
await new Promise<void>((resolve, reject) =>
	probe.close((error) => (error ? reject(error) : resolve())),
);
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
	{
		cwd: new URL("../", import.meta.url).pathname,
		stdout: "ignore",
		stderr: "inherit",
		detached: true,
	},
);
const shots = process.env.COMPOSER_MENU_SHOTS;
let browser: Browser | undefined;
try {
	for (let i = 0; i < 200; i++) {
		if (server.exitCode !== null)
			throw new Error(`Vite exited: ${server.exitCode}`);
		try {
			if ((await fetch(origin)).ok) break;
		} catch {}
		await Bun.sleep(250);
	}
	browser = await chromium.launch({ headless: true });
	if (shots) await mkdir(shots, { recursive: true });
	for (const viewport of [
		{ width: 1280, height: 900 },
		{ width: 375, height: 812 },
		{ width: 375, height: 667 },
	]) {
		const page = await browser.newPage({ viewport });
		await page.goto(`${origin}/chat`, { waitUntil: "domcontentloaded" });
		const trigger = page.getByRole("button", {
			name: "Composer options",
			exact: true,
		});
		await trigger.waitFor();
		await trigger.focus();
		await page.keyboard.press("ArrowDown");
		const menu = page.getByRole("menu");
		await menu.waitFor();
		await page.waitForFunction(
			() => document.activeElement?.getAttribute("role") === "menuitem",
		);
		const groups = menu.getByRole("group");
		assert.equal(await groups.count(), 3);
		for (const [i, label] of ["Add", "Commands", "Create"].entries()) {
			assert((await groups.nth(i).innerText()).startsWith(label));
		}
		assert.equal(await menu.getByRole("separator").count(), 2);
		const items = menu.getByRole("menuitem");
		const count = await items.count();
		assert(count === 9 || count === 10);
		for (let i = 0; i < count; i++) {
			const item = items.nth(i);
			if (i > 0) await page.keyboard.press("ArrowDown");
			await page.waitForFunction(
				(text) => document.activeElement?.textContent === text,
				await item.textContent(),
			);
			assert.equal(await item.locator('svg[aria-hidden="true"]').count(), 1);
			const description = item.locator("span.whitespace-nowrap");
			assert((await description.innerText()).length > 0);
			assert(
				await description.evaluate((el) => {
					const range = document.createRange();
					range.selectNodeContents(el);
					const bounds = el.getBoundingClientRect();
					return (
						range.getClientRects().length === 1 &&
						range.getBoundingClientRect().right <= bounds.right + 1
					);
				}),
				`description ${i} fits on one line at ${viewport.width}px`,
			);
			const box = await item.boundingBox();
			assert(
				box &&
					box.x >= 0 &&
					box.x + box.width <= viewport.width &&
					box.y >= 0 &&
					box.y + box.height <= viewport.height,
			);
			if (viewport.width === 375) assert(box.height >= 44);
		}
		await page.keyboard.press("ArrowUp");
		assert(
			await items
				.nth(count - 2)
				.evaluate((el) => el === document.activeElement),
		);
		await page.keyboard.press("Escape");
		await menu.waitFor({ state: "hidden" });
		assert(await trigger.evaluate((el) => el === document.activeElement));
		const textarea = page.locator('[data-slot="chat-composer"] textarea');
		await textarea.fill("Keep my draft");
		await trigger.press("ArrowDown");
		await menu.waitFor();
		await page.waitForFunction(
			() => document.activeElement?.getAttribute("role") === "menuitem",
		);
		await page.keyboard.press("Home");
		const delegateIndex = (await items.allTextContents()).findIndex((text) =>
			text.startsWith("/delegate"),
		);
		for (let i = 0; i < delegateIndex; i++)
			await page.keyboard.press("ArrowDown");
		assert(
			await items
				.nth(delegateIndex)
				.evaluate((el) => el === document.activeElement),
		);
		await page.keyboard.press("Enter");
		await menu.waitFor({ state: "hidden" });
		assert.equal(
			await textarea.inputValue(),
			"Prepare a bounded delegation proposal; do not dispatch without the required approval.\n\nKeep my draft",
		);
		await trigger.press("ArrowDown");
		await menu.waitFor();
		await page.waitForFunction(
			() => document.activeElement?.getAttribute("role") === "menuitem",
		);
		await page.keyboard.press("Home");
		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		assert(
			(await textarea.inputValue()).endsWith(
				"Create a Presentation output for this request.",
			),
		);
		await trigger.click();
		await menu.waitFor();
		if (shots)
			await page.screenshot({
				path: `${shots}/composer-${viewport.width}x${viewport.height}.png`,
			});
		await page.keyboard.press("Escape");
		await page.close();
		console.log(
			`PASS composer menu ${viewport.width}x${viewport.height}: groups, icons, descriptions, keyboard, draft actions, viewport bounds`,
		);
	}
} finally {
	await browser?.close();
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch {
		server.kill();
	}
}
