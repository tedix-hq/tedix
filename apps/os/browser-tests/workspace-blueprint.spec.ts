import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const path = "/browser-tests/workspace-blueprint.html";
const server = await startFixtureServer(path);
const browser = await chromium.launch({ headless: true });
const directory =
	process.env.TEDIX_BROWSER_ARTIFACTS_DIR ?? "/tmp/tedix-workspace-blueprint";
await mkdir(directory, { recursive: true });
try {
	for (const width of [375, 1280]) {
		const page = await browser.newPage({ viewport: { width, height: 900 } });
		const calls: unknown[] = [];
		let fail = true;
		await page.route("**/api/**", async (route) => {
			const pathname = new URL(route.request().url()).pathname;
			if (pathname === "/api/rpc/webPush/getStatus") return route.fallback();
			if (pathname !== "/api/rpc/osWorkspaces/blueprints/saveWorkspace")
				throw new Error(`Unexpected API request: ${route.request().url()}`);
			const raw = route.request().postDataJSON();
			calls.push(raw.json ?? raw);
			if (fail)
				return route.fulfill({
					status: 409,
					json: {
						json: {
							code: "CONFLICT",
							message: "A blueprint with this name already exists",
						},
					},
				});
			return route.fulfill({
				json: {
					json: {
						blueprint: {
							id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
							name: "Research kit",
							status: "draft",
							visibility: "org",
						},
						revision: { revision: 1 },
					},
				},
			});
		});
		await page.goto(`${server.origin}${path}`, {
			waitUntil: "domcontentloaded",
		});
		await page.getByRole("button", { name: "Workspace actions" }).click();
		await page.getByRole("menuitem", { name: "Save as blueprint" }).click();
		const dialog = page.getByRole("dialog");
		await dialog.waitFor();
		assert.match(
			await dialog.innerText(),
			/App data, documents and chats stay here/,
		);
		await page
			.getByRole("textbox", { name: "Blueprint name" })
			.fill("Research kit");
		await page
			.getByRole("button", { name: "Save blueprint", exact: true })
			.click();
		await page.getByText("Blueprint not saved", { exact: true }).waitFor();
		assert.equal(
			await page.getByRole("textbox", { name: "Blueprint name" }).inputValue(),
			"Research kit",
		);
		fail = false;
		await page.screenshot({
			path: `${directory}/blueprint-${width}.png`,
			fullPage: true,
		});
		const bounds = await dialog.boundingBox();
		assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
		await page
			.getByRole("button", { name: "Save blueprint", exact: true })
			.click();
		await page.getByText("Blueprint saved", { exact: true }).waitFor();
		await page.screenshot({
			path: `${directory}/blueprint-saved-${width}.png`,
			fullPage: true,
		});
		assert.deepEqual(
			calls,
			Array(2).fill({
				workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				name: "Research kit",
			}),
		);
		await page.getByRole("button", { name: "Done", exact: true }).click();
		assert.equal(await page.getByRole("dialog").count(), 0);
		await page.close();
		console.log(`PASS workspace blueprint menu/save/error/retry at ${width}px`);
	}
} finally {
	await browser.close();
	await server.stop();
}
