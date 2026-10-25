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

		await page.goto(`${origin}${thread}`);
		await page.getByText("Two of the four flagged", { exact: false }).waitFor();
		assert.equal(
			await composer(page).getAttribute("placeholder"),
			"Ask a follow-up…",
			`open thread placeholder at ${width}px`,
		);

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
