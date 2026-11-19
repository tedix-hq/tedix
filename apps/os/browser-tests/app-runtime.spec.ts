import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";
import { routeSandboxProxy } from "./sandbox-proxy-router";
import { App } from "../../../plugins/tedix/skills/tedix-build-app/assets/sheet-review/server.js";
import manifest from "../../../plugins/tedix/skills/tedix-build-app/assets/sheet-review/manifest.json";

const server = await startFixtureServer("/browser-tests/app-runtime.html");
const browser = await chromium.launch({ headless: true });
try {
	{
		const width = 375;
		const page = await browser.newPage({
			viewport: { width, height: 812 },
			colorScheme: "light",
		});
		const values = new Map<string, unknown>([["unrelated", "keep"]]);
		const kv = {
			get: (key: string) => values.get(key),
			put: (key: string, value: unknown) => values.set(key, value),
			delete: (key: string) => values.delete(key),
			list: ({ prefix }: { prefix: string }) =>
				new Map([...values].filter(([key]) => key.startsWith(prefix))),
		};
		const sheet = {
			kind: "sheet",
			columns: ["ID", "Title", "Text", "Topic"],
			rows: [
				[
					"one",
					"Ein hilfreicher Vorschlag",
					"Langer deutscher Text ".repeat(24),
					"Planung",
				],
				["two", "Zweiter Vorschlag", "<script>untrusted</script>", "Team"],
			],
		};
		const app = new App(
			{ storage: { kv } },
			{
				CONFIG: manifest.config,
				TEDIX: {
					outputsRead: async (slot: string) => {
						assert.equal(slot, "cards");
						return { revision: { content: sheet } };
					},
				},
			},
		);
		await assert.rejects(() => app.rate("one", "send"));
		await assert.rejects(() => app.rate("missing", "useful"));
		await page.route("**/api/rpc/osAppRuntime/*", async (route) => {
			const method = new URL(route.request().url()).pathname.split("/").pop();
			if (method === "open")
				return route.fulfill({
					json: {
						json: {
							session: "host-only",
							expiresAt: Math.floor(Date.now() / 1000) + 60,
							role: "use",
							revisionId: "33333333-3333-4333-8333-333333333333",
						},
					},
				});
			const input = route.request().postDataJSON().json;
			assert.equal(input.session, "host-only");
			const result =
				input.method === "cards"
					? await app.cards()
					: input.method === "rate"
						? await app.rate(...input.args)
						: app.reset();
			await route.fulfill({ json: { json: { result } } });
		});
		await page.goto(`${server.origin}/browser-tests/app-runtime.html?starter`);
		const guest = page
			.frameLocator('iframe[title="Rating app"]')
			.frameLocator("iframe");
		await guest
			.getByRole("heading", { name: "Ein hilfreicher Vorschlag" })
			.waitFor();
		assert.equal(await guest.locator("html").getAttribute("lang"), "en");
		const geometry = await guest.locator("body").evaluate((body) => ({
			overflow: body.scrollWidth > document.documentElement.clientWidth,
			background: getComputedStyle(body).backgroundColor,
			targets: [...body.querySelectorAll("button")].map((button) => ({
				width: button.getBoundingClientRect().width,
				height: button.getBoundingClientRect().height,
			})),
		}));
		assert.equal(geometry.overflow, false);
		// The starter has no palette of its own: it follows the OS theme live.
		await page.evaluate(() => {
			document.documentElement.style.setProperty(
				"--background",
				"rgb(18, 52, 86)",
			);
			document.documentElement.style.setProperty(
				"--foreground",
				"rgb(240, 241, 242)",
			);
		});
		await guest.locator("body").evaluate(
			(body) =>
				new Promise<void>((resolve, reject) => {
					const started = Date.now();
					const check = () => {
						const style = getComputedStyle(body);
						if (
							style.backgroundColor === "rgb(18, 52, 86)" &&
							style.color === "rgb(240, 241, 242)"
						)
							return resolve();
						if (Date.now() - started > 5000)
							return reject(
								new Error(
									`theme not applied: ${style.backgroundColor} / ${style.color}`,
								),
							);
						requestAnimationFrame(check);
					};
					check();
				}),
		);
		assert(
			geometry.targets.every(
				({ width, height }) => width >= 44 && height >= 44,
			),
		);
		if (process.env.TEDIX_STARTER_SCREENSHOT_DIR)
			await page.screenshot({
				path: `${process.env.TEDIX_STARTER_SCREENSHOT_DIR}/starter-${width}.png`,
				fullPage: true,
			});
		await guest.getByRole("button", { name: "Useful", exact: true }).click();
		await guest.getByRole("heading", { name: "Zweiter Vorschlag" }).waitFor();
		assert.equal(values.get("review:one"), "useful");
		await guest.getByRole("tab", { name: "Reviewed" }).click();
		await guest
			.getByRole("heading", { name: "Ein hilfreicher Vorschlag" })
			.waitFor();
		await page.reload();
		await guest.getByRole("heading", { name: "Zweiter Vorschlag" }).waitFor();
		await guest.getByRole("button", { name: "Reset ratings" }).click();
		await guest.getByRole("button", { name: "Cancel" }).click();
		assert.equal(values.get("review:one"), "useful");
		await guest.getByRole("button", { name: "Reset ratings" }).click();
		await guest.getByRole("button", { name: "Yes, reset" }).click();
		await guest
			.getByRole("heading", { name: "Ein hilfreicher Vorschlag" })
			.waitFor();
		assert.equal(values.has("review:one"), false);
		assert.equal(values.get("unrelated"), "keep");
		assert.equal(sheet.rows.length, 2);
		sheet.rows = [];
		await guest.getByRole("button", { name: "Reload" }).click();
		await guest
			.getByText("All reviewed. Thank you!", { exact: true })
			.waitFor();
		await page.route("**/api/rpc/osAppRuntime/call", (route) => route.abort());
		await guest.getByRole("button", { name: "Reload" }).click();
		await guest.getByRole("alert").waitFor();
		await page.close();
	}
	console.log("Runtime app starter rating, reset, and recovery passed");
	{
		// A failing app tells the host: uncaught error (with its client.js
		// line), unhandled rejection and console.error.
		const page = await browser.newPage({
			viewport: { width: 1280, height: 812 },
		});
		await routeSandboxProxy(page);
		await page.goto(`${server.origin}/browser-tests/app-runtime.html?errors`);
		const bar = page.locator("[data-app-runtime-errors]");
		await bar.filter({ hasText: "This app reported 3 errors." }).waitFor();
		const reported = JSON.parse(
			(await page.locator("[data-app-errors]").textContent()) ?? "[]",
		) as Array<{ kind: string; message: string; line?: number }>;
		assert.deepEqual(
			reported.toSorted((a, b) => a.kind.localeCompare(b.kind)),
			[
				{ kind: "console", message: 'Could not load {"sheet":"cards"}' },
				{ kind: "error", message: "TypeError: rows is undefined", line: 5 },
				{ kind: "rejection", message: "Error: not_permitted" },
			],
		);
		// No chat on this page, so there is nothing to send them to.
		assert.equal(
			await page.getByRole("button", { name: "Send to the agent" }).count(),
			0,
		);
		await page
			.getByRole("button", { name: "Dismiss the app's errors" })
			.click();
		assert.equal(await bar.count(), 0);
		await page.close();
		console.log("Runtime app errors reach the host with their client.js line");
	}
} finally {
	await browser.close();
	await server.stop();
}
