import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit, devices, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";
import { RpcSession } from "capnweb";
import { CapnChatSession } from "../src/capnweb/session-root";

let server: Awaited<ReturnType<typeof startFixtureServer>> | undefined;
const conversation = "00000060-0000-4000-8000-000000000009";
const screenshots = process.env.TEDIX_SCREENSHOT_DIR;
let browser: Browser | undefined;
const stopSessions = new Set<() => void>();
try {
	if (screenshots) await mkdir(screenshots, { recursive: true });
	for (const [engine, options, label] of [
		[chromium, { viewport: { width: 1280, height: 900 } }, "desktop"],
		[webkit, { ...devices["iPhone 13"] }, "iphone"],
	] as const) {
		server = await startFixtureServer("/chat", { shared: false });
		browser = await engine.launch({ headless: true });
		const context = await browser.newContext(options);
		const page = await context.newPage();
		const origin = server.origin;
		const calls: string[] = [];
		// Vite serves HTTP fixtures; run the real capability server on the intercepted socket.
		await page.routeWebSocket("**/capn", (socket) => {
			const messages: string[] = [];
			let waiting:
				| { resolve(value: string): void; reject(error: Error): void }
				| undefined;
			let closed = false;
			const root = new CapnChatSession({
				env: {
					API_SERVICE: {
						fetch: (request: Request) => {
							const url = new URL(request.url);
							calls.push(url.pathname);
							return fetch(
								new Request(
									`${origin}/api${url.pathname}${url.search}`,
									request,
								),
							);
						},
					},
				},
				hostTenantId: null,
				credentialHeaders: {},
			});
			socket.onMessage((message) => {
				if (waiting) {
					const next = waiting;
					waiting = undefined;
					next.resolve(message.toString());
				} else messages.push(message.toString());
			});
			const stop = () => {
				if (closed) return;
				closed = true;
				waiting?.reject(new Error("Browser closed"));
				root[Symbol.dispose]();
				stopSessions.delete(stop);
			};
			stopSessions.add(stop);
			socket.onClose(stop);
			new RpcSession(
				{
					send: (message) => socket.send(message),
					receive: () =>
						messages.length
							? Promise.resolve(messages.shift()!)
							: closed
								? Promise.reject(new Error("Browser closed"))
								: new Promise((resolve, reject) => {
										waiting = { resolve, reject };
									}),
					abort: () => {
						stop();
						void socket.close();
					},
				},
				root,
			);
		});
		await page.goto(`${server.origin}/chat?conversation=${conversation}`);
		const composer = page.getByRole("combobox", {
			name: "Message",
			exact: true,
		});
		const send = page.getByRole("button", {
			name: "Queue steering message",
			exact: true,
		});
		// An empty composer offers Stop; typing turns the slot into Queue.
		await page
			.locator(".chat-composer-actions")
			.getByRole("button", { name: "Stop", exact: true })
			.waitFor();
		await composer.fill(`Use the newest evidence on ${label}.`);
		await send.click();
		const queued = page.locator('[data-steering-status="queued"]');
		await queued
			.getByText("Queued · waiting for the run", { exact: true })
			.waitFor();
		assert.match(await queued.innerText(), /Use the newest evidence/);
		assert.equal(await composer.inputValue(), "");
		await page.waitForFunction(() => {
			const bubble = document
				.querySelector('[data-steering-status="queued"]')
				?.getBoundingClientRect();
			const transcript = document
				.querySelector('[data-slot="conversation-transcript"]')
				?.getBoundingClientRect();
			return (
				bubble &&
				transcript &&
				bubble.top >= transcript.top &&
				bubble.bottom <= transcript.bottom
			);
		});
		assert.equal(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
			true,
		);
		if (screenshots)
			await page.screenshot({
				path: `${screenshots}/steering-${label}.png`,
				fullPage: true,
			});
		// The empty composer's send slot is Stop; stopping returns the unread
		// steering text to the draft.
		await page
			.locator(".chat-composer-actions")
			.getByRole("button", { name: "Stop", exact: true })
			.click();
		await page.waitForFunction(() =>
			document
				.querySelector<HTMLTextAreaElement>("textarea")
				?.value.includes("Use the newest evidence"),
		);
		assert.equal(
			await composer.inputValue(),
			`Use the newest evidence on ${label}.`,
		);
		const deadline = Date.now() + 5000;
		while (
			!calls.includes("/rpc/kernelRuntime/cancelRun") &&
			Date.now() < deadline
		)
			await Bun.sleep(20);
		assert.deepEqual(
			calls.filter((path) =>
				/\/(steerRun|controlRunSteering|cancelRun)$/.test(path),
			),
			[
				"/rpc/kernelRuntime/steerRun",
				"/rpc/kernelRuntime/controlRunSteering",
				"/rpc/kernelRuntime/cancelRun",
			],
		);
		for (const stop of stopSessions) stop();
		await context.close();
		await browser.close();
		browser = undefined;
		await server.stop();
		server = undefined;
	}
	console.log("Chat steering desktop and iPhone WebKit passed");
} finally {
	for (const stop of stopSessions) stop();
	await browser?.close();
	await server?.stop();
}
