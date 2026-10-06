import { chromium, type Browser, type Page } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
const origin = "http://127.0.0.1:3010";

async function waitForServer(proc: Bun.Subprocess) {
	for (let attempt = 0; attempt < 80; attempt += 1) {
		if (proc.exitCode !== null)
			throw new Error(`OS dev server exited: ${proc.exitCode}`);
		try {
			const response = await fetch(`${origin}/browser-tests/widget-apps.html`);
			if (response.ok) return;
		} catch {}
		await Bun.sleep(250);
	}
	throw new Error("Timed out waiting for the OS Vite browser-test server.");
}

async function expectEvent(page: Page, event: string) {
	await page.waitForFunction(
		(event) =>
			(
				window as Window & { __MCP_APP_EVENTS__: Array<{ event: string }> }
			).__MCP_APP_EVENTS__?.some((item) => item.event === event),
		event,
		{ timeout: 10_000 },
	);
}

async function run() {
	const build = await Bun.build({
		entrypoints: [`${cwd}browser-tests/widget-app-guest-entry.ts`],
		target: "browser",
		format: "iife",
		globalName: "McpAppsGuest",
		write: false,
	});
	if (!build.success) throw new Error(build.logs.map(String).join("\n"));
	const bundle = await build.outputs[0]!.text();
	const server = Bun.spawn(
		[
			"../../node_modules/.bin/vp",
			"dev",
			"--port",
			"3010",
			"--strictPort",
			"--host",
			"127.0.0.1",
		],
		{
			cwd,
			stdout: "ignore",
			stderr: "inherit",
			env: { ...process.env, TEDIX_BUILD_LOCAL_DEMO_ENABLED: "false" },
		},
	);
	let browser: Browser | undefined;
	try {
		await waitForServer(server);
		browser = await chromium.launch({ headless: true }).catch((error) => {
			throw new Error(
				`${error}\nInstall Chromium: cd apps/os && bunx playwright install --with-deps chromium`,
			);
		});
		const context = await browser.newContext();
		await context.addInitScript((guestBundle) => {
			(
				window as Window & { __MCP_APP_GUEST_BUNDLE__: string }
			).__MCP_APP_GUEST_BUNDLE__ = guestBundle;
		}, bundle);
		const page = await context.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		page.on("console", (message) => {
			if (message.type() === "error") errors.push(message.text());
		});
		await page.goto(`${origin}/browser-tests/widget-apps.html`);
		try {
			await expectEvent(page, "connected");
		} catch (error) {
			const frames = await page.locator("iframe").evaluateAll((items) =>
				items.map((item) => ({
					title: item.getAttribute("title"),
					sandbox: item.getAttribute("sandbox"),
					src: item.getAttribute("src"),
				})),
			);
			throw new Error(
				`${String(error)}; browser errors=${errors.join("; ")}; frames=${JSON.stringify(frames)}`,
			);
		}
		await expectEvent(page, "input");
		await expectEvent(page, "result");

		const proxy = page.locator('iframe[title="Interactive widget"]');
		const proxyFrame = await (await proxy.elementHandle())?.contentFrame();
		if (!proxyFrame) throw new Error("Sandbox proxy frame did not load.");
		const guest = proxy.contentFrame().locator('iframe[title="MCP app"]');
		const outerSandbox = await proxy.getAttribute("sandbox");
		const innerSandbox = await guest.getAttribute("sandbox");
		if (outerSandbox !== "allow-scripts allow-forms") {
			throw new Error(`Unexpected proxy sandbox: ${outerSandbox}`);
		}
		if (innerSandbox !== "allow-scripts allow-forms") {
			throw new Error(`Unexpected guest sandbox: ${innerSandbox}`);
		}
		if (
			outerSandbox.includes("allow-same-origin") ||
			innerSandbox.includes("allow-same-origin")
		) {
			throw new Error("MCP app sandbox must not grant allow-same-origin.");
		}
		const allow = await guest.getAttribute("allow");
		if (allow !== "camera")
			throw new Error(`Unexpected guest permissions: ${allow}`);
		const initial = await page.evaluate(
			() =>
				(
					window as Window & {
						__MCP_APP_EVENTS__: Array<{ event: string; value: any }>;
					}
				).__MCP_APP_EVENTS__.find((item) => item.event === "connected")?.value,
		);
		if (
			initial.context?.theme !== "dark" ||
			initial.context?.locale !== "en-US"
		) {
			throw new Error(
				`Host context did not arrive: ${JSON.stringify(initial)}`,
			);
		}
		if (
			initial.capabilities?.sandbox?.permissions?.camera === undefined ||
			initial.capabilities?.sandbox?.permissions?.microphone !== undefined
		) {
			throw new Error(
				`Unexpected MCP permission capabilities: ${JSON.stringify(initial.capabilities)}`,
			);
		}
		const receivedInput = await page.evaluate(
			() =>
				(
					window as Window & {
						__MCP_APP_EVENTS__: Array<{ event: string; value: any }>;
					}
				).__MCP_APP_EVENTS__.find((item) => item.event === "input")?.value,
		);
		const receivedResult = await page.evaluate(
			() =>
				(
					window as Window & {
						__MCP_APP_EVENTS__: Array<{ event: string; value: any }>;
					}
				).__MCP_APP_EVENTS__.find((item) => item.event === "result")?.value,
		);
		if (
			receivedInput?.value !== "host input" ||
			receivedResult?.structuredContent?.answer !== 42
		) {
			throw new Error(
				`Tool input/result did not arrive: ${JSON.stringify({ receivedInput, receivedResult })}`,
			);
		}

		const guestFrame = page
			.frames()
			.find((frame) => frame.url() === "about:srcdoc");
		if (!guestFrame)
			throw new Error(
				"Opaque guest document is absent from the browser frame tree.",
			);
		await guestFrame.getByRole("button", { name: "Call host tool" }).click();
		await page.waitForFunction(
			() =>
				(window as Window & { __MCP_APP_CALLS__: unknown[] }).__MCP_APP_CALLS__
					.length === 1,
		);
		const calls = await page.evaluate(
			() =>
				(
					window as Window & {
						__MCP_APP_CALLS__: Array<{ name: string; arguments: unknown }>;
					}
				).__MCP_APP_CALLS__,
		);
		if (
			calls[0]?.name !== "integration.echo" ||
			JSON.stringify(calls[0]?.arguments) !==
				JSON.stringify({ value: "from guest" })
		) {
			throw new Error(
				`Outbound guest tool call did not reach the host: ${JSON.stringify(calls)}`,
			);
		}
		await expectEvent(page, "outboundResult");

		// A same-origin sibling frame is not the registered host window and must
		// not be able to replace the injected app through the resource-ready path.
		const originalGuest = await proxyFrame
			.locator('iframe[title="MCP app"]')
			.elementHandle();
		const sibling = await proxyFrame.evaluateHandle(() => {
			const frame = document.createElement("iframe");
			frame.src = "about:blank";
			document.body.appendChild(frame);
			return frame;
		});
		const forged = {
			jsonrpc: "2.0",
			method: "ui/notifications/sandbox-resource-ready",
			params: { html: "<body>forged sibling</body>" },
		};
		await sibling.evaluate(
			(frame, message) =>
				frame.contentWindow?.postMessage(message, location.origin),
			forged,
		);
		await page.waitForTimeout(150);
		if (!(await originalGuest?.evaluate((frame) => frame.isConnected))) {
			throw new Error(
				"Same-origin sibling frame injected an MCP app resource.",
			);
		}

		// A nested cross-origin sender has a distinct event.origin and source.
		await page.route("https://wrong-origin.test/**", (route) =>
			route.fulfill({
				status: 200,
				contentType: "text/html",
				body: "<html></html>",
			}),
		);
		const attacker = await proxyFrame.evaluateHandle(() => {
			const frame = document.createElement("iframe");
			frame.src = "https://wrong-origin.test/attacker.html";
			document.body.appendChild(frame);
			return frame;
		});
		await attacker.evaluate((frame) =>
			frame.contentWindow?.postMessage(
				{
					jsonrpc: "2.0",
					method: "ui/notifications/sandbox-resource-ready",
					params: { html: "<body>forged origin</body>" },
				},
				"*",
			),
		);
		await page.waitForTimeout(150);
		if (!(await originalGuest?.evaluate((frame) => frame.isConnected))) {
			throw new Error("Cross-origin frame injected an MCP app resource.");
		}
		if (errors.length)
			throw new Error(`Browser page errors: ${errors.join("; ")}`);
		await page.evaluate(() =>
			(
				window as Window & { __MCP_APP_UNMOUNT__: () => void }
			).__MCP_APP_UNMOUNT__(),
		);
		await proxy.waitFor({ state: "detached" });
		if (
			(await page.locator('iframe[title="Interactive widget"]').count()) !== 0
		) {
			throw new Error("Widget teardown left its sandbox iframe mounted.");
		}
		const bridgeCloses = await page.evaluate(
			() =>
				(window as Window & { __MCP_APP_BRIDGE_CLOSES__: number })
					.__MCP_APP_BRIDGE_CLOSES__,
		);
		if (bridgeCloses !== 1)
			throw new Error(`Expected one host bridge close, got ${bridgeCloses}.`);
		await context.close();
		console.log(
			"PASS: real MCP Apps v2 browser handshake, data, tool call, permissions, source/origin checks, and sandbox attributes.",
		);
	} finally {
		await browser?.close();
		server.kill();
		await server.exited;
	}
}

await run();
