import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer("/browser-tests/web-push.html");
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [390, 1280]) {
		const page = await browser.newPage({ viewport: { width, height: 844 } });
		page.setDefaultTimeout(20_000);
		let preferences: {
			mutedProjectIds: string[];
			mutedWorkspaceIds?: string[];
		} = { mutedProjectIds: [] };
		await page.route("**/api/rpc/webPush/*", async (route) => {
			const method = new URL(route.request().url()).pathname.split("/").at(-1);
			if (method === "setPreferences")
				preferences = route.request().postDataJSON().json;
			const disabled = page.url().includes("disabled");
			const result =
				method === "getStatus"
					? {
							enabled: !disabled,
							publicKey: disabled ? null : "B".repeat(87),
							preferences,
						}
					: preferences;
			await route.fulfill({ json: { json: result } });
		});
		await page.addInitScript(() => {
			Object.defineProperty(Notification, "requestPermission", {
				value: async () => {
					document.documentElement.dataset.pushPermissionAsked = "true";
					return "denied";
				},
			});
		});
		await page.goto(`${server.origin}/browser-tests/web-push.html`);
		await page.getByRole("heading", { name: "Push notifications" }).waitFor();
		assert.equal(
			await page.locator("html").getAttribute("data-push-permission-asked"),
			null,
		);
		const mute = page.getByRole("switch", { name: "Mute Example Project" });
		await mute.click();
		await page.waitForFunction(
			() =>
				document
					.querySelector('[role="switch"]')
					?.getAttribute("aria-checked") === "true",
		);
		const workspaceMute = page.getByRole("switch", {
			name: "Mute Example Workspace",
		});
		await workspaceMute.click();
		await page.waitForFunction(
			() =>
				document.querySelectorAll('[role="switch"][aria-checked="true"]')
					.length === 2,
		);
		assert.deepEqual(preferences.mutedWorkspaceIds, [
			"00000000-0000-4000-8000-000000000002",
		]);
		assert(
			(await page
				.getByText("Mute run updates; approval requests stay enabled.")
				.count()) === 1,
		);
		assert(
			(await page
				.getByText(
					"Mute run updates for this workspace; approval requests stay enabled.",
				)
				.count()) === 1,
		);
		await page.getByRole("button", { name: "Enable notifications" }).click();
		await page
			.getByText(
				"Allow notifications in your browser or device settings to enable push.",
			)
			.waitFor();
		assert.equal(
			await page.locator("html").getAttribute("data-push-permission-asked"),
			"true",
		);
		assert(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth + 1,
			),
		);
		if (process.env.TEDIX_SCREENSHOT_DIR) {
			await mkdir(process.env.TEDIX_SCREENSHOT_DIR, { recursive: true });
			await page.screenshot({
				path: `${process.env.TEDIX_SCREENSHOT_DIR}/web-push-${width}.png`,
				fullPage: true,
			});
		}
		await page.goto(`${server.origin}/browser-tests/web-push.html?disabled`);
		await page
			.getByText("Push is not configured for this installation.")
			.waitFor();
		assert(
			await page
				.getByRole("button", { name: "Enable notifications" })
				.isDisabled(),
		);
		await page.close();
		console.log(
			`PASS Web Push settings ${width}: permission click, project and workspace mute, missing keys, no overflow`,
		);
	}
} finally {
	await browser.close();
	await server.stop();
}
