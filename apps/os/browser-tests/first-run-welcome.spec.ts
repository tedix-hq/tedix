import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer("/work");
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	{
		const width = 375;
		const context = await browser.newContext({
			viewport: { width, height: 812 },
		});
		let completed = true;
		let writes = 0;
		let failSave = false;
		await context.route("**/api/rpc/userProfile/getMine", (route) =>
			route.fulfill({
				json: {
					json: {
						id: "welcome-person",
						name: "Welcome Person",
						email: "welcome@example.com",
						avatarUrl: null,
						revision: 1,
						updatedAt: null,
						welcomeCompleted: completed,
					},
				},
			}),
		);
		await context.route("**/api/rpc/userProfile/completeWelcome", (route) => {
			writes++;
			if (failSave)
				return route.fulfill({
					status: 503,
					json: {
						json: {
							code: "INTERNAL_SERVER_ERROR",
							message: "Unavailable",
							defined: false,
						},
					},
				});
			completed = true;
			return route.fulfill({ json: { json: { completed } } });
		});
		await context.route("**/widget/branding/*", (route) =>
			route.fulfill({ json: { branding: {} } }),
		);
		const page = await context.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		const pending = new Set<string>();
		const requests: string[] = [];
		page.on("request", (request) => {
			pending.add(request.url());
			requests.push(request.url());
		});
		page.on("requestfinished", (request) => pending.delete(request.url()));
		page.on("requestfailed", (request) => pending.delete(request.url()));
		try {
			await Promise.all([
				page.waitForResponse("**/api/rpc/userProfile/getMine"),
				page.goto(`${server.origin}/work`),
			]);
		} catch (error) {
			console.error({
				pending: [...pending],
				errors,
				text: await page.locator("body").innerText(),
			});
			throw error;
		}
		const dialog = page.getByRole("dialog", { name: "Welcome to Tedix" });
		const waitForWelcome = async (stage: string) => {
			try {
				await dialog.waitFor();
			} catch (error) {
				console.error({
					width,
					stage,
					completed,
					writes,
					errors,
					pending: [...pending],
					text: await page.locator("body").innerText(),
				});
				throw error;
			}
		};
		try {
			await page.locator(".os-shell").waitFor();
		} catch (error) {
			console.error({
				width,
				errors,
				pending: [...pending],
				text: await page.locator("body").innerText(),
			});
			throw error;
		}
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				),
		);
		assert.equal(await dialog.count(), 0, "existing account sees no welcome");
		assert.equal(writes, 0, "existing account needs no completion write");
		assert.equal(
			requests.filter((url) => url.endsWith("/userProfile/getMine")).length,
			1,
		);
		assert.equal(
			requests.some((url) => url.includes("first-run-welcome.tsx")),
			false,
			"existing account does not load the welcome component",
		);
		completed = false;
		await page.reload();
		await waitForWelcome("first visit");
		assert.ok(
			await dialog
				.getByText("A platform for agents, apps, and work.", { exact: false })
				.isVisible(),
		);
		const guest = page
			.frameLocator('iframe[title="Tedix welcome"]')
			.frameLocator("iframe");
		await guest.getByRole("heading", { name: "Your profile" }).waitFor();
		await guest.getByRole("button", { name: "Next", exact: true }).click();
		await guest.getByRole("heading", { name: "Choose a model" }).waitFor();
		await guest.getByRole("button", { name: "Next", exact: true }).click();
		await guest.getByRole("heading", { name: "Connect your tools" }).waitFor();
		await guest
			.getByText("Sign-in and consent stay with you", { exact: false })
			.waitFor();
		await guest.getByRole("button", { name: "Next", exact: true }).click();
		await guest
			.getByRole("heading", { name: "Set up this computer" })
			.waitFor();
		await guest.getByRole("button", { name: "Next", exact: true }).click();
		await guest
			.getByRole("heading", { name: "Start with a question" })
			.waitFor();
		await guest
			.getByRole("button", { name: "Ask your first question" })
			.click();
		await page.waitForURL(/\/chat$/);
		await page
			.getByRole("combobox", { name: "Message", exact: true })
			.waitFor();
		assert.equal(completed, true);
		assert.equal(writes, 1);
		await page.reload();
		await page
			.getByRole("combobox", { name: "Message", exact: true })
			.waitFor();
		assert.equal(
			await dialog.count(),
			0,
			"completed welcome stays hidden after reload",
		);
		const anotherTab = await context.newPage();
		await anotherTab.goto(`${server.origin}/chat`);
		await anotherTab
			.getByRole("combobox", { name: "Message", exact: true })
			.waitFor();
		assert.equal(
			await anotherTab
				.getByRole("dialog", { name: "Welcome to Tedix" })
				.count(),
			0,
		);
		await anotherTab.close();
		completed = false;
		await page.reload();
		await waitForWelcome("reset for skip");
		failSave = true;
		await page.getByRole("button", { name: "Skip welcome" }).click();
		await dialog.getByRole("alert").waitFor();
		assert.equal(
			completed,
			false,
			"failed persistence cannot mark welcome done",
		);
		failSave = false;
		await page.getByRole("button", { name: "Skip welcome" }).click();
		await dialog.waitFor({ state: "hidden" });
		await page
			.getByRole("combobox", { name: "Message", exact: true })
			.waitFor();
		assert.equal(completed, true);
		assert.equal(
			requests.some((url) => url.includes("/userProfile/getWelcomeState")),
			false,
			"the shell never makes a separate welcome-state request",
		);
		assert.deepEqual(errors, []);
		assert.ok(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth + 1,
			),
		);
		console.log(
			`PASS ${width}px: existing account without welcome request or chunk; new account steps, completion, reload, second tab, failed save and skip to chat`,
		);
		await context.close();
	}
} finally {
	await browser?.close();
	await server.stop();
}
