import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer("/browser-tests/app-runtime.html");
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [375, 1280]) {
		const page = await browser.newPage({ viewport: { width, height: 812 } });
		const calls: string[] = [];
		let saved: unknown;
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
			calls.push(input.method);
			if (input.method === "rate") saved = input.args[0];
			return route.fulfill({
				json: {
					json: { result: input.method === "rate" ? saved : { one: saved } },
				},
			});
		});
		await page.goto(`${server.origin}/browser-tests/app-runtime.html`);
		const guest = page
			.frameLocator('iframe[title="Rating app"]')
			.frameLocator("iframe");
		await guest.getByRole("button", { name: "Hilfreich", exact: true }).click();
		await guest
			.getByRole("status")
			.filter({ hasText: '"decision":"Hilfreich"' })
			.waitFor();
		assert.deepEqual(calls, ["rate", "ratings"]);
		assert.equal(
			await page.locator("[data-app-runtime-frame]").getAttribute("data-state"),
			"ready",
		);
		await page.close();
	}
	console.log(
		"Runtime app sandbox rating round trip passed at 375px and 1280px",
	);
} finally {
	await browser.close();
	await server.stop();
}
