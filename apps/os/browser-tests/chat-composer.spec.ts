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
		await page.goto(`${origin}/chat`);
		await composer(page).waitFor();
		assert.equal(
			await composer(page).getAttribute("placeholder"),
			"Ask a question or hand off a task…",
			`new conversation placeholder at ${width}px`,
		);
		// The fixture catalog has no selectable models: the organization picks.
		const model = page.getByRole("button", {
			name: "Model: Auto",
			exact: true,
		});
		assert.equal(await model.innerText(), "Auto");
		assert.equal(await model.isDisabled(), true);
		assert.equal(await page.getByRole("menu").count(), 0);

		// Starters: icon, a title that fits on one line, one line of context.
		const starters = page.locator(".chat-starter-prompts button");
		assert.equal(await starters.count(), 3);
		for (const starter of await starters.all()) {
			assert.equal(await starter.locator("svg").count(), 1);
			const lines = starter.locator("span.block");
			assert.equal(await lines.count(), 2);
			for (const line of await lines.all()) {
				assert(
					await line.evaluate(
						(el) =>
							el.scrollWidth <= el.clientWidth &&
							el.getClientRects().length === 1,
					),
					`${await line.innerText()} fits on one line at ${width}px`,
				);
			}
		}
		if (shots)
			await page.screenshot({ path: `${shots}/new-chat-${width}.png` });
		await starters.nth(0).click();
		assert.equal(
			await composer(page).inputValue(),
			"Create a doc titled Weekly update with three short sections.",
		);

		await page.goto(`${origin}${thread}`);
		await page.getByText("Two of the four flagged", { exact: false }).waitFor();
		assert.equal(
			await composer(page).getAttribute("placeholder"),
			"Ask a follow-up…",
			`open thread placeholder at ${width}px`,
		);

		await page
			.getByRole("button", { name: "Composer options", exact: true })
			.click();
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
		assert((await composer(page).inputValue()).includes("sample.send_message"));
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
