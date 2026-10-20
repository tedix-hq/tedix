import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
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
		cwd,
		stdout: "ignore",
		stderr: "inherit",
		detached: true,
		// Response details need the classic fixture's saved run and cost receipt.
		env: { ...process.env, TEDIX_OS_FIXTURE_PACK: "classic" },
	},
);
const conversation = "00000060-0000-4000-8000-000000000001";
const runId = "00000062-0000-4000-8000-000000000001";
const chat = `/chat?conversation=${conversation}`;
const screenshots = process.env.CHAT_ACTIONS_SCREENSHOTS;
let browser: Browser | undefined;
try {
	for (let i = 0; i < 100; i++) {
		assert(server.exitCode === null, "fixture server stays alive");
		try {
			if ((await fetch(origin)).ok) break;
		} catch {}
		await Bun.sleep(250);
	}
	browser = await chromium.launch({ headless: true });
	if (screenshots) await mkdir(screenshots, { recursive: true });
	for (const width of [1280, 390]) {
		for (const theme of ["light", "dark"]) {
			const context = await browser.newContext({
				viewport: { width, height: 900 },
				hasTouch: width === 390,
				permissions: ["clipboard-read", "clipboard-write"],
				colorScheme: theme as "light" | "dark",
			});
			const page = await context.newPage();
			await page.goto(`${origin}${chat}`);
			await page
				.getByText("Two of the four flagged", { exact: false })
				.waitFor();
			await page.evaluate(
				(dark) => document.documentElement.classList.toggle("dark", dark),
				theme === "dark",
			);
			assert.equal(
				await page.locator('[data-slot="chat-response-actions"]').count(),
				0,
			);
			assert.equal(
				await page.getByText("Copy response", { exact: true }).count(),
				0,
			);
			const actions = page.locator('[data-slot="chat-message-actions"]').last();
			assert.equal(
				await actions.evaluate((el) => getComputedStyle(el).opacity),
				"1",
				"latest assistant actions stay visible",
			);
			const copy = actions.getByRole("button", { name: "Copy", exact: true });
			await copy.click();
			await actions
				.getByRole("button", { name: "Copied", exact: true })
				.waitFor();
			assert.match(
				await page.evaluate(() => navigator.clipboard.readText()),
				/Two of the four flagged/,
			);
			const details = page.getByRole("button", {
				name: "Details",
				exact: true,
			});
			if (width === 390) {
				const box = await details.boundingBox();
				assert(
					box && box.width >= 44 && box.height >= 44,
					"touch targets are at least 44px",
				);
			}
			if (screenshots)
				await page.screenshot({
					path: `${screenshots}/chat-actions-after-${width}-${theme}.png`,
				});
			const scroll = page
				.locator('[data-role="assistant"]')
				.last()
				.locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]');
			const scrollTop = await scroll.evaluate((el) => el.scrollTop);
			await details.focus();
			await details.press("Enter");
			const dialog = page.getByRole("dialog", {
				name: "Response details",
				exact: true,
			});
			await dialog.getByLabel("Response summary").waitFor();
			assert.equal(new URL(page.url()).pathname, "/chat");
			assert.equal(new URL(page.url()).searchParams.get("details"), runId);
			assert.equal(
				new URL(page.url()).searchParams.get("conversation"),
				conversation,
			);
			await page.waitForFunction(() =>
				document
					.getAnimations()
					.every(
						(a) =>
							a.effect?.getTiming().iterations === Infinity ||
							a.playState !== "running",
					),
			);
			const box = await dialog.boundingBox();
			assert(box && box.x >= 0 && box.x + box.width <= width + 1);
			if (width === 1280)
				assert(
					box.width >= 420 && box.width <= 480,
					"desktop drawer is 420–480px",
				);
			else assert.equal(await dialog.getAttribute("data-side"), "bottom");
			assert.match(await dialog.innerText(), /\$0.0179/);
			assert.equal(
				await dialog.getByLabel("Execution summary").isVisible(),
				false,
				"technical sections start collapsed",
			);
			if (screenshots)
				await page.screenshot({
					path: `${screenshots}/chat-actions-after-details-${width}-${theme}.png`,
				});
			await dialog
				.getByRole("button", { name: "Execution and trace", exact: true })
				.click();
			await dialog.getByLabel("Execution summary").waitFor();
			await page.keyboard.press("Escape");
			await dialog.waitFor({ state: "hidden" });
			assert.equal(
				await details.evaluate((el) => document.activeElement === el),
				true,
				"Escape returns focus to Details",
			);
			assert.equal(
				await scroll.evaluate((el) => el.scrollTop),
				scrollTop,
				"opening and closing preserves transcript scroll",
			);
			assert.equal(new URL(page.url()).searchParams.has("details"), false);
			await page.goto(`${origin}${chat}&details=${runId}`);
			await page
				.getByRole("dialog", { name: "Response details", exact: true })
				.getByLabel("Response summary")
				.waitFor();
			await page.getByRole("button", { name: "Close", exact: true }).click();
			await page
				.getByRole("dialog", { name: "Response details", exact: true })
				.waitFor({ state: "hidden" });
			await page.goto(`${origin}/work/executions/${runId}`);
			await page
				.getByRole("dialog", { name: "Response details", exact: true })
				.getByLabel("Response summary")
				.waitFor();
			assert.equal(
				new URL(page.url()).pathname,
				"/chat",
				"legacy execution links redirect into Chat",
			);
			await context.close();
		}
	}
	console.log(
		"Chat actions passed: clipboard, focus, scroll, deep links, legacy redirect, light/dark at 1280/390.",
	);
} finally {
	await browser?.close();
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch {
		server.kill();
	}
	await server.exited;
}
