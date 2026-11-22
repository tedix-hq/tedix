import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

// Runs in `bun run --cwd apps/os test:browser:settings` (part of test:run).
// The settings sidebar is a contained Kumo sidebar: grouped rows with icons on
// a desktop rail, and a sheet opened from one menu row on a phone.
const shots = process.env.TEDIX_SCREENSHOT_DIR;
if (shots) await mkdir(shots, { recursive: true });
const server = await startFixtureServer();
let browser;

async function navState(page: Page) {
	return page
		.locator('nav[aria-label="Settings sections"]')
		.evaluate((nav) => ({
			groups: [...nav.querySelectorAll('[data-sidebar="group-label"]')].map(
				(label) => label.textContent,
			),
			links: [...nav.querySelectorAll("a")].map((link) => {
				const rect = link.getBoundingClientRect();
				return {
					text: link.textContent,
					icon: Boolean(link.querySelector("svg")),
					current: link.getAttribute("aria-current"),
					left: rect.left,
					right: rect.right,
				};
			}),
			documentWidth: document.documentElement.scrollWidth,
			innerWidth,
		}));
}

const background = (page: Page, name: string) =>
	page
		.locator('nav[aria-label="Settings sections"]')
		.getByRole("link", { name, exact: true })
		.evaluate((link) => getComputedStyle(link).backgroundColor);

try {
	browser = await chromium.launch({ headless: true });
	for (const [width, theme] of [
		[375, "dark"],
		[1280, "light"],
	] as const) {
		const phone = width < 768;
		const page = await browser.newPage({
			viewport: { width, height: phone ? 844 : 900 },
			isMobile: phone,
			hasTouch: phone,
			colorScheme: theme,
			reducedMotion: "reduce",
		});
		await page.addInitScript(
			(value) => localStorage.setItem("tedix-os-theme", value),
			theme,
		);
		await page.goto(`${server.origin}/admin/connections`);
		const navigation = page.locator('nav[aria-label="Settings sections"]');
		await navigation.waitFor({ state: "attached" });
		await page.evaluate(() => document.fonts.ready);
		if (phone) {
			const trigger = page.locator("[data-settings-menu]");
			await trigger.waitFor();
			assert.match((await trigger.textContent()) ?? "", /Connected accounts/);
			assert.equal(await trigger.getAttribute("aria-expanded"), "false");
			if (shots)
				await page.screenshot({
					path: `${shots}/settings-sidebar-${width}-${theme}-closed.png`,
				});
			await trigger.click();
			assert.equal(await trigger.getAttribute("aria-expanded"), "true");
			await navigation
				.getByRole("link", { name: "Activity log", exact: true })
				.waitFor();
		}
		const state = await navState(page);
		assert.deepEqual(
			state.groups,
			["Organization", "Connections", "Billing", "Agents", "History"],
			JSON.stringify(state),
		);
		assert(state.links.length >= 10, JSON.stringify(state));
		for (const link of state.links) {
			assert(link.icon, JSON.stringify(link));
			assert(
				link.left >= -1 && link.right <= state.innerWidth + 1,
				`destination off screen: ${JSON.stringify(link)}`,
			);
		}
		assert.deepEqual(
			state.links.filter((link) => link.current === "page").map((l) => l.text),
			["Connected accounts"],
		);
		assert(state.documentWidth <= state.innerWidth + 1, JSON.stringify(state));

		// Hover paints a different step than the selected row (fine pointers).
		if (!phone) {
			const activeBackground = await background(page, "Connected accounts");
			await navigation
				.getByRole("link", { name: "Activity log", exact: true })
				.hover();
			const hoverBackground = await background(page, "Activity log");
			assert.notEqual(hoverBackground, "rgba(0, 0, 0, 0)");
			assert.notEqual(hoverBackground, activeBackground);
		}

		// Keyboard focus is visible on a row.
		await navigation
			.getByRole("link", { name: "My accounts", exact: true })
			.focus();
		await page.keyboard.press("Tab");
		assert.equal(
			await page.evaluate(() => document.activeElement?.textContent),
			"API keys",
		);
		const ring = await navigation
			.getByRole("link", { name: "API keys", exact: true })
			.evaluate((link) => getComputedStyle(link).boxShadow);
		assert.notEqual(ring, "none");
		if (shots)
			await page.screenshot({
				path: `${shots}/settings-sidebar-${width}-${theme}.png`,
			});

		await navigation
			.getByRole("link", { name: "Activity log", exact: true })
			.click();
		await page.waitForURL((url) => url.pathname === "/audit");
		if (phone) {
			// The sheet closes after a navigation and the row names the new page.
			const trigger = page.locator("[data-settings-menu]");
			await page.waitForFunction(
				() =>
					document
						.querySelector("[data-settings-menu]")
						?.getAttribute("aria-expanded") === "false",
			);
			assert.match((await trigger.textContent()) ?? "", /Activity log/);
		}
		// The closed phone sheet is aria-hidden, so read the link by its address.
		assert.equal(
			await navigation.locator('a[href="/audit"]').getAttribute("aria-current"),
			"page",
		);
		// Only the Billing link marks the page current.
		await page.goto(`${server.origin}/admin/billing`);
		await navigation.locator('a[href="/admin/billing"]').waitFor({
			state: "attached",
		});
		assert.deepEqual(
			await navigation.locator('a[aria-current="page"]').allTextContents(),
			["Billing"],
		);
		if (shots && !phone)
			await page.screenshot({
				path: `${shots}/settings-sidebar-${width}-${theme}-billing.png`,
			});
		console.log(`PASS settings-sidebar ${width} ${theme}`);
		await page.close();
	}

	const editor = await browser.newPage({
		viewport: { width: 1100, height: 800 },
	});
	await editor.goto(`${server.origin}/admin`);
	await editor
		.locator('nav[aria-label="Settings sections"]')
		.getByRole("link", { name: "Website chat", exact: true })
		.click();
	const nameField = editor.getByRole("textbox", { name: "Assistant name" });
	await nameField.waitFor();
	const toggle = editor.getByRole("button", { name: "Preview", exact: true });
	const preview = editor.getByRole("region", { name: "Preview", exact: true });
	assert.equal(await preview.isVisible(), false);
	assert(
		(await nameField.boundingBox())!.width > 200,
		"the preview leaves room for the form",
	);
	await toggle.click();
	await preview.waitFor();
	await editor
		.getByRole("button", { name: "Hide preview", exact: true })
		.click();
	await preview.waitFor({ state: "hidden" });
	await editor.setViewportSize({ width: 1600, height: 900 });
	await preview.waitFor();
	assert.equal(await toggle.isVisible(), false);
	await editor.close();
} finally {
	await browser?.close();
	await server.stop();
}
