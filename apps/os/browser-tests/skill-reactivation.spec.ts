import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const evidence = new URL(
	"../node_modules/.cache/skill-reactivation/",
	import.meta.url,
).pathname;
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer(
	"/browser-tests/skill-reactivation.html",
);
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [375, 1280]) {
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
			});
			let role = "owner";
			let fail = false;
			let lifecycleState = "draft";
			const writes: unknown[] = [];
			await page.route("**/api/rpc/**", async (route) => {
				const endpoint = new URL(route.request().url()).pathname.split(
					"/api/rpc/",
				)[1];
				let result: unknown = {};
				if (endpoint === "userSettings/getContext")
					result = {
						authority: { role, permissions: ["tedis:read", "tedis:update"] },
						organization: { id: "fictional-org", appearance: null },
					};
				if (endpoint === "skills/get")
					result = {
						entry: {
							id: "fictional-skill",
							organizationId: "fictional-org",
							tediId: "fictional-tedi",
							title: "Daily operating loop",
							summary: "Review the team's work each morning.",
							revision: 7,
							lifecycleState,
							content: "# Daily loop",
							files: { "scripts/workflow.ts": "export default {}" },
						},
					};
				if (endpoint === "tedis/list") result = { data: [] };
				if (endpoint === "skills/improve") {
					writes.push(route.request().postDataJSON().json);
					if (fail)
						return route.fulfill({
							status: 403,
							contentType: "application/json",
							body: JSON.stringify({
								json: {
									defined: false,
									code: "FORBIDDEN",
									status: 403,
									message: "Only an owner or admin can turn this skill back on",
								},
							}),
						});
					lifecycleState = "active";
				}
				await route.fulfill({
					contentType: "application/json",
					body: JSON.stringify({ json: result }),
				});
			});
			const url = `${server.origin}/browser-tests/skill-reactivation.html?theme=${theme}`;
			await page.goto(url);
			const button = page.getByRole("button", {
				name: "Turn back on",
				exact: true,
			});
			await button.waitFor();
			await page.evaluate(() => document.fonts.ready);
			assert.equal(
				await page.evaluate(
					() => document.documentElement.scrollWidth > innerWidth,
				),
				false,
			);
			await page.screenshot({
				path: `${evidence}/${width}-${theme}.png`,
				fullPage: true,
			});
			await button.click();
			await page.getByText("Active", { exact: true }).waitFor();
			assert.equal(writes.length, 1);
			assert.deepEqual(writes[0], {
				id: "fictional-skill",
				lifecycleState: "active",
				force: true,
				revisionReasoning:
					"Owner or admin turned the skill back on from its Tedix OS page.",
			});
			assert(await page.getByText("Active", { exact: true }).isVisible());
			lifecycleState = "draft";
			fail = true;
			await page.reload();
			await button.click();
			await page.getByRole("alert").waitFor();
			assert(await button.isEnabled(), "a refused request can be retried");
			role = "member";
			await page.reload();
			await page
				.getByRole("heading", { name: "Daily operating loop" })
				.waitFor();
			assert.equal(
				await button.count(),
				0,
				"members have no activation control",
			);
			await page.close();
			console.log(
				`${width}/${theme}: one-click activation, refreshed state, refusal and member visibility passed`,
			);
		}
	}
} finally {
	await browser.close();
	await server.stop();
}
