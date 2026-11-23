import { waitForFixtureServer } from "../dev/fixture-server-readiness";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chromium, type Browser, type Page } from "playwright";

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
		// The classic pack carries a conversation with messages.
		env: { ...process.env, TEDIX_OS_FIXTURE_PACK: "classic" },
	},
);
const shots = process.env.CHAT_COMPOSER_SHOTS;
const thread = "/chat?conversation=00000060-0000-4000-8000-000000000001";

function composer(page: Page) {
	return page.getByRole("combobox", { name: "Message", exact: true });
}

let browser: Browser | undefined;
try {
	await waitForFixtureServer(origin, { server });
	browser = await chromium.launch({ headless: true });
	for (const width of [1280, 375]) {
		const page = await browser.newPage({
			viewport: { width, height: 812 },
			hasTouch: width < 1280,
		});

		await page.route("**/api/rpc/apps/listComposerCommands**", (route) =>
			route.fulfill({
				json: {
					json: {
						commands: [
							{
								command: "/sample.send_message",
								description: "Send a prepared update.",
								instruction:
									"Use the app tool sample.send_message for this request. Follow the existing approval policy before making changes.",
							},
						],
					},
				},
			}),
		);
		// A new chat runs in the person's private workspace with the
		// organization chat's own box (0d286fef9), not the Home composer.
		await page.goto(`${origin}/chat`);
		const fresh = page.getByRole("textbox", {
			name: "Message Tedix",
			exact: true,
		});
		await fresh.waitFor();
		assert.equal(
			await fresh.getAttribute("placeholder"),
			"Ask a question or hand off a task…",
			`new conversation placeholder at ${width}px`,
		);
		// With no tedi picked, the workspace's own agent replies. The choice
		// sits behind the composer's settings gear.
		const settings = page.locator('summary[aria-label="Chat settings"]');
		await settings.click();
		const agent = page.getByRole("combobox", {
			name: "Replying agent",
			exact: true,
		});
		assert.equal(await agent.innerText(), "Workspace agent");
		await settings.click();
		await agent.waitFor({ state: "hidden" });
		assert.equal(await page.getByRole("menu").count(), 0);

		// Starters: one line each, inside the page, and a pick fills the box.
		const starters = page.locator(".workspace-chat-empty button");
		assert.equal(await starters.count(), 3);
		for (const starter of await starters.all()) {
			assert(
				await starter.evaluate(
					(el) =>
						el.scrollWidth <= el.clientWidth &&
						el.getBoundingClientRect().right <= innerWidth,
				),
				`${await starter.innerText()} fits at ${width}px`,
			);
		}
		if (shots)
			await page.screenshot({ path: `${shots}/new-chat-${width}.png` });
		await starters.nth(0).click();
		assert.equal(await fresh.inputValue(), "Plan my week: ");

		await page.goto(`${origin}${thread}`);
		await page.getByText("Two of the four flagged", { exact: false }).waitFor();
		assert.equal(
			await composer(page).getAttribute("placeholder"),
			"Ask a follow-up…",
			`open thread placeholder at ${width}px`,
		);

		const options = page.getByRole("button", {
			name: "Composer options",
			exact: true,
		});
		if (width === 1280) {
			await composer(page).fill("Keep my draft");
			await options.press("ArrowDown");
			const menu = page.getByRole("menu");
			await menu.waitFor();
			await page.waitForFunction(
				() => document.activeElement?.getAttribute("role") === "menuitem",
			);
			await page.keyboard.press("Escape");
			await menu.waitFor({ state: "hidden" });
			assert(await options.evaluate((el) => el === document.activeElement));
		}
		await options.click();
		for (const command of [
			"/summarize",
			"/delegate",
			"/investigate",
			"/read",
			"/sample.send_message",
		]) {
			await page
				.getByRole("menuitem")
				.filter({ has: page.getByText(command, { exact: true }) })
				.waitFor();
		}
		await page
			.getByRole("menuitem")
			.filter({ has: page.getByText("/sample.send_message", { exact: true }) })
			.click();
		const draft = await composer(page).inputValue();
		assert(draft.includes("sample.send_message"));
		if (width === 1280) assert(draft.includes("Keep my draft"));
		await page.close();
		console.log(`PASS chat composer ${width}px`);
	}
} finally {
	await browser?.close();
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch {
		server.kill();
	}
}
