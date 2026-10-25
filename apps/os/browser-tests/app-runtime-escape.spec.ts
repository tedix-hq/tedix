import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const requests: string[] = [];
const outside = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		requests.push(new URL(request.url).pathname);
		return new Response("<p>Outside origin</p>", {
			headers: { "Content-Type": "text/html" },
		});
	},
});
const server = await startFixtureServer("/browser-tests/app-runtime.html");
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [375, 1280]) {
		requests.length = 0;
		const page = await browser.newPage({ viewport: { width, height: 812 } });
		let apiCalls = 0;
		await page.route("**/api/rpc/**", (route) => {
			apiCalls++;
			return route.abort();
		});
		await page
			.context()
			.addCookies([
				{ name: "host-secret", value: "fictional", url: server.origin },
			]);
		await page.addInitScript(() => {
			if (window === window.top) {
				localStorage.setItem("host-secret", "fictional");
				sessionStorage.setItem("host-secret", "fictional");
			}
		});
		const url = `${server.origin}/browser-tests/app-runtime.html?escape&destination=${encodeURIComponent(outside.url.origin)}`;
		await page.goto(url);
		const guest = page
			.frameLocator('iframe[title="Rating app"]')
			.frameLocator("iframe");
		const report = guest.locator("#escape-results");
		await report.waitFor();
		const results = JSON.parse((await report.textContent())!);
		for (const name of [
			"parent",
			"top",
			"cookie",
			"cookieWrite",
			"localStorage",
			"sessionStorage",
			"indexedDB",
		])
			assert.equal(results[name], 18, `${name} must throw SecurityError`);
		for (const method of [
			"fs.read",
			"outputs.write",
			"connections.call",
			"skills.run",
			"tools/call",
			"__proto__",
			"constructor",
			"toString",
			"app.call.evil",
			"",
			null,
			{},
		])
			assert.equal(
				results["method:" + JSON.stringify(method)],
				"unknown_method",
			);
		assert.equal(results["server:constructor"], "bad_arguments");
		assert.equal(results["output:ungranted"], "not_permitted");
		assert.equal(results.popup, true);
		assert.equal(results.role, "use");
		assert.equal(results.prototype, null);
		for (const directive of [
			"connect-src",
			"img-src",
			"frame-src",
			"form-action",
		])
			assert.ok(
				results.violations.includes(directive),
				`missing ${directive} enforcement`,
			);
		assert.deepEqual(
			requests,
			[],
			"guest must send no outside-origin requests",
		);
		assert.equal(apiCalls, 0, "forged or denied calls must not reach the API");
		assert.equal(
			await page.evaluate(() => document.cookie),
			"host-secret=fictional",
		);
		assert.equal(page.url(), url);
		// CSP does not block a guest navigating its own frame: keep this residual
		// boundary visible until the follow-up changes the containment model.
		await Promise.all([
			page.waitForResponse(`${outside.url.origin}/navigation?data=fictional`),
			guest.getByRole("button", { name: "Probe self navigation" }).click(),
		]);
		assert.deepEqual(requests, ["/navigation"]);
		assert.equal(page.url(), url);
		await page.close();
	}
	console.log(
		"Runtime sandbox escape checks passed at 375px and 1280px; self-navigation remains possible",
	);
} finally {
	await browser.close();
	await server.stop();
	outside.stop(true);
}
