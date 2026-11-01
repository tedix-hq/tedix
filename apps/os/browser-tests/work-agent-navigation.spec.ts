import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ??
	new URL("../node_modules/.cache/agent-navigation/", import.meta.url).pathname;
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer();
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [375, 1280]) {
		const page = await browser.newPage({ viewport: { width, height: 900 } });
		await page.goto(`${server.origin}/work?app=office`);
		const nav = page.getByRole("navigation", { name: "Agents", exact: true });
		await page.locator('[data-workspace-app-entry="office"]').waitFor();
		assert.deepEqual(await nav.getByRole("link").allTextContents(), [
			"For you",
			"Sessions",
			"Capacity",
		]);
		assert.equal(
			await nav.locator('[aria-current="page"]').innerText(),
			"For you",
		);
		for (const link of await nav.getByRole("link").all()) {
			const bounds = await link.boundingBox();
			assert.ok(
				bounds && bounds.height >= 44,
				"Tab links need a 44px touch target",
			);
		}
		await page.screenshot({
			path: `${evidence}/agents-tabs-for-you-${width}.png`,
		});
		await nav.getByRole("link", { name: "Sessions", exact: true }).click();
		await page.locator('[data-workspace-app-entry="agents"]').waitFor();
		assert.equal(
			await page.locator('[data-workspace-app-entry="office"]').count(),
			0,
		);
		assert.equal(
			await nav.locator('[aria-current="page"]').innerText(),
			"Sessions",
		);
		assert.match(
			new URL(page.url()).searchParams.get("app")!,
			/^[a-f0-9-]{36}$/,
		);
		const sessionsUrl = page.url();
		await page.screenshot({
			path: `${evidence}/agents-tabs-sessions-${width}.png`,
		});
		await nav.getByRole("link", { name: "Capacity", exact: true }).click();
		await page
			.getByRole("region", { name: "Local lanes", exact: true })
			.waitFor();
		assert.equal(await page.locator("[data-workspace-app-entry]").count(), 0);
		assert.equal(
			await nav.locator('[aria-current="page"]').innerText(),
			"Capacity",
		);
		assert.ok(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		);
		await page.screenshot({
			path: `${evidence}/agents-tabs-capacity-${width}.png`,
		});
		await page
			.getByRole("button", { name: "More views: Agents", exact: true })
			.click();
		const menu = page.getByRole("menu");
		await menu.locator('[data-work-view="agents"]').waitFor();
		assert.equal(await menu.locator('[data-work-view="agents"]').count(), 1);
		assert.equal(
			await menu
				.locator('[data-work-view="office"], [data-work-view="capacity"]')
				.count(),
			0,
		);
		await page.keyboard.press("Escape");
		await page.goBack();
		await page.locator('[data-workspace-app-entry="agents"]').waitFor();
		assert.equal(page.url(), sessionsUrl);
		assert.equal(
			await nav.locator('[aria-current="page"]').innerText(),
			"Sessions",
		);
		await page.close();
	}
	const unavailable = await browser.newPage({
		viewport: { width: 375, height: 900 },
	});
	await unavailable.route(
		"**/osWorkspaces/gadgets/workApps**",
		async (route) => {
			const response = await route.fetch();
			const body = await response.json();
			body.json.items = body.json.items.filter(
				(item: { currentRevision: { manifest: { entry: string } } }) =>
					!["tedix:app/office", "tedix:app/agents"].includes(
						item.currentRevision.manifest.entry,
					),
			);
			await route.fulfill({ response, json: body });
		},
	);
	await unavailable.goto(`${server.origin}/work/capacity`);
	const restrictedNav = unavailable.getByRole("navigation", {
		name: "Agents",
		exact: true,
	});
	await restrictedNav.waitFor();
	assert.deepEqual(await restrictedNav.getByRole("link").allTextContents(), [
		"Capacity",
	]);
	await unavailable.goto(`${server.origin}/work?app=agents`);
	await unavailable
		.getByText("This app is not available in your workspaces.", {
			exact: true,
		})
		.waitFor();
	assert.equal(
		await unavailable.locator("[data-workspace-app-entry]").count(),
		0,
	);
	assert.equal(
		await unavailable
			.getByRole("navigation", { name: "Agents", exact: true })
			.count(),
		0,
	);
	await unavailable.close();
	console.log(
		"PASS: unified Agents navigation at phone and desktop widths, with unavailable apps preserved",
	);
} finally {
	await browser.close();
	await server.stop();
}
