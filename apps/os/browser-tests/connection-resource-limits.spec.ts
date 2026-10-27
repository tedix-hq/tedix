import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ??
	new URL("../node_modules/.cache/connection-resource-limits/", import.meta.url)
		.pathname;
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer();
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [375, 1280])
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.route(
				"**/api/rpc/connections/getConnectionsOverview*",
				async (route) => {
					const response = await route.fetch();
					const body = await response.json();
					const row = structuredClone(body.json.rows[0]);
					row.provider = {
						...row.provider,
						appId: "github",
						name: "GitHub",
						category: "development",
					};
					row.accountLabel = "GitHub";
					row.references = [];
					row.connectionInstanceId = undefined;
					body.json.rows.push(row);
					body.json.total++;
					await route.fulfill({ response, json: body });
				},
			);
			await page.goto(`${server.origin}/admin/connections`);
			const row = page.locator('li[data-account-group="github"]');
			await row
				.getByRole("button", { name: "GitHub details", exact: true })
				.click();
			await row.getByRole("button", { name: "Details", exact: true }).click();
			const control = row.getByRole("switch", {
				name: "Limit repositories for GitHub",
			});
			await control.waitFor({ state: "visible" });
			await page.waitForFunction(
				() =>
					!document.querySelector<HTMLButtonElement>(
						'[aria-label="Limit repositories for GitHub"]',
					)?.disabled,
			);
			if ((await control.getAttribute("aria-checked")) !== "true")
				await control.click();
			const field = row.getByRole("textbox", { name: "Allowed repositories" });
			await field.fill("https://github.com/example/repo-x");
			const save = row.getByRole("button", {
				name: "Save resource limits",
				exact: true,
			});
			assert.equal(
				await save.isDisabled(),
				true,
				"malformed target cannot be saved",
			);
			await field.fill("example/repo-x");
			await save.click();
			await row
				.getByRole("status")
				.filter({ hasText: "Resource limits saved" })
				.waitFor();
			assert.equal(
				await field.inputValue(),
				"example/repo-x",
				"saved exact repository is read back",
			);
			await field.focus();
			assert.equal(
				await field.evaluate((element) => element === document.activeElement),
				true,
				"keyboard focus reaches the field",
			);
			assert.equal(
				await page.evaluate(
					() => document.documentElement.scrollWidth - innerWidth,
				),
				0,
				"no horizontal overflow",
			);
			assert.ok(
				(await control.boundingBox())!.height >= 24,
				"switch target height",
			);
			assert.ok((await save.boundingBox())!.height >= 32, "save target height");
			assert.deepEqual(errors, [], "no page errors");
			await field.scrollIntoViewIfNeeded();
			await page.screenshot({
				path: `${evidence}/repositories-${width}-${theme}.png`,
			});
			await page.close();
		}
	console.log(
		`PASS: repository limits, validation, save/readback, focus and overflow at 375/1280 in light/dark; screenshots ${evidence}`,
	);
} finally {
	await browser.close();
	await server.stop();
}
