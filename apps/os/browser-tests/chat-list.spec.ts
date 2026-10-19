import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = probe.port!;
probe.stop();
const origin = `http://127.0.0.1:${port}`;
const server = Bun.spawn(
	[
		"../../node_modules/.bin/vp",
		"dev",
		"--port",
		String(port),
		"--strictPort",
		"--host",
		"127.0.0.1",
	],
	{ cwd, stdout: "ignore", stderr: "inherit", detached: true },
);
const evidenceDir = process.env.CHAT_LIST_EVIDENCE_DIR;
let browser: Browser | undefined;
try {
	let ready = false;
	for (let i = 0; i < 100; i++) {
		if (server.exitCode !== null)
			throw new Error(`Vite exited: ${server.exitCode}`);
		try {
			ready = (await fetch(`${origin}/chat`)).ok;
		} catch {}
		if (ready) break;
		await Bun.sleep(200);
	}
	assert(ready, "Chat fixture server starts");
	if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
	browser = await chromium.launch();
	for (const width of [1280, 390])
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
				hasTouch: width === 390,
			});
			await page.addInitScript(
				(mode) => localStorage.setItem("tedix-os-theme", mode),
				theme,
			);
			await page.goto(`${origin}/chat`);
			if (width === 390)
				await page
					.getByRole("button", { name: "Back to conversations" })
					.click();
			const row = page.locator("[data-conversation-id]").first();
			await row.waitFor();
			const open = row.getByRole("button").first();
			const actions = row.getByRole("button", {
				name: /^Conversation actions for /,
			});
			const title = (await open.locator("span.truncate").textContent())!;
			assert.equal(
				await actions.getAttribute("aria-label"),
				`Conversation actions for ${title}`,
			);
			const rowBox = (await row.boundingBox())!;
			const openBox = (await open.boundingBox())!;
			assert.equal(
				openBox.width,
				rowBox.width,
				"conversation target spans the entire row",
			);
			assert.equal(openBox.x, rowBox.x);
			assert(rowBox.height >= 44);
			assert.equal(
				await row.evaluate((el) => getComputedStyle(el).borderRadius),
				"8px",
			);
			if (width === 390) {
				assert.equal(
					await actions.evaluate((el) => getComputedStyle(el).opacity),
					"1",
					"touch actions are always visible",
				);
				assert((await actions.boundingBox())!.width >= 44);
			}
			await open.hover();
			await page.waitForTimeout(250);
			assert.equal(
				await open.evaluate((el) => getComputedStyle(el).backgroundColor),
				"rgba(0, 0, 0, 0)",
				"main button has no separate hover fill",
			);
			assert.equal(
				await actions.evaluate((el) => getComputedStyle(el).backgroundColor),
				"rgba(0, 0, 0, 0)",
				"menu inherits no rectangular row fill",
			);
			await page.getByRole("tooltip").filter({ hasText: title }).waitFor();
			if (evidenceDir)
				await page.screenshot({
					path: `${evidenceDir}/chat-list-after-${width}-${theme}.png`,
				});
			const initialUrl = page.url();
			await actions.click();
			await page
				.getByRole("menuitem", { name: "Rename", exact: true })
				.waitFor();
			assert.equal(
				page.url(),
				initialUrl,
				"opening the menu does not select a conversation",
			);
			await page.keyboard.press("Escape");
			await page.waitForFunction(
				(label) => document.activeElement?.getAttribute("aria-label") === label,
				await actions.getAttribute("aria-label"),
			);
			await page.keyboard.press("Shift+Tab");
			assert(
				await open.evaluate((el) => el === document.activeElement),
				"row precedes its menu in tab order",
			);
			assert(
				await open.evaluate((el) => el.matches(":focus-visible")),
				"keyboard navigation shows focus",
			);
			await page.keyboard.press("Tab");
			assert(
				await actions.evaluate((el) => el === document.activeElement),
				"Tab reaches overflow",
			);
			await page.keyboard.press("Enter");
			await page
				.getByRole("menuitem", { name: "Rename", exact: true })
				.waitFor();
			await page.keyboard.press("Escape");
			await page.waitForFunction(
				(label) => document.activeElement?.getAttribute("aria-label") === label,
				await actions.getAttribute("aria-label"),
			);
			await page.keyboard.press("Shift+Tab");
			await page.keyboard.press("Enter");
			await page.waitForURL(/conversation=/);
			if (width === 390)
				await page
					.getByRole("button", { name: "Back to conversations" })
					.click();
			// The mobile back button starts a fresh selection; check selected styling on desktop.
			if (width === 1280) {
				await page.mouse.click(1, 1);
				await open.click();
				await page.mouse.move(1, 1);
				assert.equal(await row.getAttribute("data-active"), "true");
				assert.equal(
					await actions.evaluate((el) => getComputedStyle(el).opacity),
					"1",
					"selected actions stay visible",
				);
				assert.equal(
					await open.evaluate((el) => el.matches(":focus-visible")),
					false,
					"mouse selection has no keyboard focus ring",
				);
				assert.equal(
					await row.evaluate((el) => getComputedStyle(el).boxShadow),
					"none",
					"selection has no blue row border",
				);
				if (evidenceDir)
					await page.screenshot({
						path: `${evidenceDir}/chat-list-after-selected-${width}-${theme}.png`,
					});
			}
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				"no horizontal page overflow",
			);
			await page.close();
			console.log(`Chat list passed: ${width} ${theme}`);
		}
} finally {
	await browser?.close();
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}
