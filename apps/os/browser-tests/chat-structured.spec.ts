import { waitForFixtureServer } from "../dev/fixture-server-readiness";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser } from "playwright";

// Structured chat content: a parked write's approval request reads as a
// summary with folded JSON arguments, and a failed write reads as one error
// line instead of a raw MCP content array. Uses the default sample pack's
// "Sam · …" conversations. Set CHAT_STRUCTURED_TEST_ORIGIN to reuse a running
// fixture server, CHAT_STRUCTURED_SCREENSHOTS to save screenshots.
const cwd = new URL("../", import.meta.url).pathname;
let origin = process.env.CHAT_STRUCTURED_TEST_ORIGIN;
let server: ReturnType<typeof Bun.spawn> | undefined;
if (!origin) {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const address = probe.address();
	assert(address && typeof address !== "string");
	const port = String(address.port);
	await new Promise<void>((resolve, reject) =>
		probe.close((error) => (error ? reject(error) : resolve())),
	);
	origin = `http://127.0.0.1:${port}`;
	server = Bun.spawn(
		[
			"../../node_modules/.bin/vp",
			"dev",
			"--port",
			port,
			"--strictPort",
			"--host",
			"127.0.0.1",
		],
		{ cwd, stdout: "inherit", stderr: "inherit", detached: true },
	);
}
const approvalChat = "/chat?conversation=00000060-0000-4000-8000-000000000005";
const failureChat = "/chat?conversation=00000060-0000-4000-8000-000000000006";
const screenshots = process.env.CHAT_STRUCTURED_SCREENSHOTS;
let browser: Browser | undefined;
try {
	await waitForFixtureServer(origin, server ? { server } : {});
	browser = await chromium.launch({ headless: true });
	if (screenshots) await mkdir(screenshots, { recursive: true });
	for (const width of [1280, 375]) {
		for (const theme of ["light", "dark"] as const) {
			const context = await browser.newContext({
				viewport: { width, height: 900 },
				hasTouch: width < 1280,
				permissions: ["clipboard-read", "clipboard-write"],
				colorScheme: theme,
			});
			const page = await context.newPage();
			await page.goto(`${origin}${approvalChat}`);
			const approval = page.locator('[data-slot="chat-write-approval"]');
			await approval.waitFor();
			await page.evaluate(
				(dark) => document.documentElement.classList.toggle("dark", dark),
				theme === "dark",
			);
			assert.match(
				await approval.innerText(),
				/^Create sheet “Opportunities - final format”/,
			);
			assert.doesNotMatch(await approval.innerText(), /\{"kind"/);
			const trigger = approval.getByRole("button", { name: /Arguments/ });
			assert.equal(await trigger.getAttribute("aria-expanded"), "false");
			assert.equal(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				true,
				`chat stays within the ${width}px viewport`,
			);
			if (screenshots)
				await page.screenshot({
					path: `${screenshots}/approval-collapsed-${width}-${theme}.png`,
				});
			await trigger.click();
			const code = approval.locator('[data-slot="chat-json-code"]');
			await code.waitFor();
			assert.match(await code.innerText(), /"kind": "sheet"/);
			await approval.getByText("Shortened by the server").waitFor();
			await approval.getByRole("button", { name: "Copy JSON" }).click();
			assert.match(
				await page.evaluate(() => navigator.clipboard.readText()),
				/"title": "Opportunities - final format"/,
			);
			assert.equal(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				true,
				`open arguments stay within the ${width}px viewport`,
			);
			if (screenshots)
				await page.screenshot({
					path: `${screenshots}/approval-open-${width}-${theme}.png`,
				});

			await page.goto(`${origin}${failureChat}`);
			const failure = page.locator('[data-slot="chat-write-failure"]');
			await failure.waitFor();
			await page.evaluate(
				(dark) => document.documentElement.classList.toggle("dark", dark),
				theme === "dark",
			);
			const text = await failure.innerText();
			assert.match(
				text,
				/^Couldn't create the output: Action "tedix__create_os_output" requires approval\./,
			);
			assert.doesNotMatch(text, /"type"/);
			if (screenshots)
				await page.screenshot({
					path: `${screenshots}/failure-${width}-${theme}.png`,
				});
			await context.close();
		}
	}
	console.log(
		"Chat structured content passed: approval summary, folded arguments, copy, failure line, light/dark at 1280/375.",
	);
} finally {
	await browser?.close();
	if (server) {
		try {
			process.kill(-server.pid, "SIGTERM");
		} catch {
			server.kill();
		}
		await server.exited;
	}
}
