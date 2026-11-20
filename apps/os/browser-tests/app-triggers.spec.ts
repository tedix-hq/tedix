import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const path = "/browser-tests/app-triggers.html";
const server = await startFixtureServer(path);
const browser = await chromium.launch({ headless: true });
try {
	const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
	const items = [
		{
			trigger: {
				id: "morning",
				kind: "schedule",
				cron: "0 9 * * *",
				method: "sweep",
			},
			enabled: false,
			lastRunAt: null,
		},
		{
			trigger: { id: "inbound", kind: "webhook", method: "receive" },
			enabled: true,
			lastRunAt: "2026-11-20T08:00:00Z",
		},
		{
			trigger: {
				id: "saved",
				kind: "interaction",
				methods: ["save"],
				method: "sync",
			},
			enabled: true,
			lastRunAt: null,
		},
		{
			trigger: {
				id: "scouted",
				kind: "skill",
				slot: "scout",
				method: "review",
			},
			enabled: true,
			lastRunAt: null,
		},
	];
	const writes: unknown[] = [];
	await page.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname.endsWith("/osWorkspaces/workspaces/activity"))
			return route.fulfill({
				json: {
					json: {
						items: [
							{
								id: "registered",
								workspaceId: "11111111-1111-4111-8111-111111111111",
								seq: 1,
								kind: "run",
								entityId: "turn",
								revision: 1,
								actor: { kind: "user", id: "person" },
								changeRecordId: "event",
								title: null,
								summary: null,
								occurredAt: new Date().toISOString(),
								action: {
									resource: "app_schedule",
									operation: "schedule.registered",
									outcome: "applied",
									surface: "workspace_object",
									automaticRun: {
										gadgetId: "22222222-2222-4222-8222-222222222222",
										triggerId: "morning",
									},
								},
							},
						],
						next: null,
					},
				},
			});
		if (url.pathname.endsWith("/osAppRuntime/listTriggers"))
			return route.fulfill({ json: { json: { items } } });
		if (url.pathname.endsWith("/osAppRuntime/setTriggerEnabled")) {
			const { json: input } = route.request().postDataJSON();
			writes.push(input);
			items.find((item) => item.trigger.id === input.triggerId)!.enabled =
				input.enabled;
			return route.fulfill({ json: { json: { enabled: input.enabled } } });
		}
		return route.continue();
	});
	await page.goto(`${server.origin}${path}`);
	const switches = page.getByRole("switch");
	await switches.first().waitFor();
	assert.equal(await switches.count(), 4);
	assert.equal(await switches.first().isChecked(), false);
	assert(await page.getByText("Off until you turn it on.").isVisible());
	assert(await page.getByText("When a webhook arrives").isVisible());
	assert(await page.getByText("When someone uses the app").isVisible());
	assert(await page.getByText("When the linked skill finishes").isVisible());
	assert.equal(await page.locator("time").count(), 1);
	await switches.first().click();
	await page.waitForFunction(
		() =>
			document
				.querySelector('[role="switch"]')
				?.getAttribute("aria-checked") === "true",
	);
	assert.equal(writes.length, 1);
	await switches.first().click();
	await page.getByText("Off until you turn it on.").waitFor();
	assert.equal(await switches.first().isChecked(), false);
	assert.equal(writes.length, 2);
	assert(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	);
	for (const surface of ["activity", "chat"]) {
		await page.goto(`${server.origin}${path}?surface=${surface}`);
		const control = page.getByRole("switch");
		await control.waitFor();
		assert.equal(await control.count(), 1);
		assert.equal(await control.isChecked(), false);
		if (surface === "chat")
			assert(
				await page.getByText(/It starts off until you turn it on/).isVisible(),
			);
		else
			assert(
				await page
					.getByText("The agent registered a scheduled run", { exact: true })
					.isVisible(),
			);
		await control.click();
		await page.waitForFunction(
			() =>
				document
					.querySelector('[role="switch"]')
					?.getAttribute("aria-checked") === "true",
		);
		await control.click();
		await page.getByText("Off until you turn it on.").waitFor();
		await page.waitForFunction(
			() =>
				document
					.querySelector('[role="switch"]')
					?.getAttribute("aria-checked") === "false",
		);
		assert.equal(await control.isChecked(), false);
	}
	assert.equal(writes.length, 6);
	console.log(
		"Automatic runs: all kinds listed, last run shown, schedule off, both toggle directions persisted",
	);
} finally {
	await browser.close();
	await server.stop();
}
