import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

// Gateway detail page: the organization's shared connection must lead with the
// jobs a non-engineer has (copy the address, connect an AI tool, see which
// apps it reaches, see whether it works) and keep technical settings behind
// one disclosure, at phone and desktop width in both themes. The fixture
// workspace has no gateway, so the spec turns the Storefront app into one
// through the same response envelopes the page already reads.
const GATEWAY_ID = "00000080-0000-4000-8000-000000000001";
const SUPPORT_ID = "00000080-0000-4000-8000-000000000002";
const FINANCE_ID = "00000080-0000-4000-8000-000000000003";
const GATEWAY = {
	id: GATEWAY_ID,
	name: "Sample Unified MCP",
	slug: "sample-unified",
};
const shots = process.env.GATEWAY_SHOTS_DIR;
const server = await startFixtureServer("/");

async function mockGateway(page: Page, theme: "light" | "dark") {
	await page.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== server.origin) return route.abort("blockedbyclient");
		const path = url.pathname;
		if (path.endsWith("/apps/getByIdWithTools")) {
			const response = await route.fetch();
			const body = await response.json();
			if (body.json.app.id === GATEWAY_ID) {
				Object.assign(body.json.app, {
					name: GATEWAY.name,
					slug: GATEWAY.slug,
					description: null,
					metadata: {
						mcpConfig: {
							authMode: "oauth",
							aggregateApps: [
								{ slug: "support-inbox", appId: SUPPORT_ID },
								{ slug: "finance-ledger", appId: FINANCE_ID },
							],
						},
					},
				});
			}
			return route.fulfill({ response, json: body });
		}
		if (path.endsWith("/apps/list")) {
			const response = await route.fetch();
			const body = await response.json();
			for (const app of body.json.data) {
				if (app.id === GATEWAY_ID) Object.assign(app, GATEWAY);
			}
			return route.fulfill({ response, json: body });
		}
		if (path.endsWith("/apps/getGatewayMembership")) {
			return route.fulfill({
				json: {
					json: { gateway: GATEWAY, enabled: false, unavailableReason: null },
				},
			});
		}
		if (path.endsWith("/apps/listGatewayMemberships")) {
			return route.fulfill({
				json: {
					json: {
						gateway: GATEWAY,
						memberships: [
							{ appId: GATEWAY_ID, enabled: false },
							{ appId: SUPPORT_ID, enabled: true },
							{ appId: FINANCE_ID, enabled: false },
						],
					},
				},
			});
		}
		if (path.endsWith("/userSettings/getPreferences")) {
			const response = await route.fetch();
			const body = await response.json();
			body.json.preferences.theme = theme;
			return route.fulfill({ response, json: body });
		}
		return route.continue();
	});
}

let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	for (const theme of ["light", "dark"] as const) {
		for (const width of [375, 1280]) {
			const label = `${width}/${theme}`;
			const page = await browser.newPage({
				viewport: { width, height: shots ? 2400 : 900 },
				isMobile: width === 375,
				hasTouch: width === 375,
				colorScheme: theme,
			});
			page.setDefaultTimeout(20_000);
			await mockGateway(page, theme);
			await page.goto(`${server.origin}/apps/${GATEWAY_ID}`);
			await page
				.getByRole("heading", { level: 1, name: GATEWAY.name })
				.waitFor();
			await page.evaluate(() => document.fonts.ready);
			if (process.env.GATEWAY_SHOTS_ONLY) {
				await page.waitForTimeout(800);
				await page.screenshot({
					path: `${shots}/${width}-${theme}.png`,
					fullPage: true,
				});
				await page.close();
				continue;
			}

			// Job 1: the address, ready to copy, with plain-language framing.
			const address = page.getByText(
				"http://sample-unified.localhost:3000/mcp",
				{
					exact: true,
				},
			);
			await address.first().waitFor();
			await page.getByRole("button", { name: "Copy address" }).waitFor();

			// Job 2: step-by-step setup per AI tool; Claude is selected first.
			const tools = page.getByRole("group", { name: "AI tool" });
			for (const name of ["Claude", "ChatGPT", "Cursor", "Claude Code"]) {
				await tools.getByRole("button", { name, exact: true }).waitFor();
			}
			await page.getByText("Add custom connector", { exact: false }).waitFor();
			await tools.getByRole("button", { name: "Cursor", exact: true }).click();
			assert.equal(
				await tools
					.getByRole("button", { name: "Cursor", exact: true })
					.getAttribute("aria-pressed"),
				"true",
				`${label}: chosen AI tool is pressed`,
			);
			await page.getByText('"sample-unified"', { exact: false }).waitFor();

			// Job 3: which apps it reaches, with the on/off control per app.
			const apps = page.getByRole("region", { name: "Apps it reaches" });
			await apps.getByText("Support Inbox", { exact: true }).waitFor();
			await apps.getByText("Finance Ledger", { exact: true }).waitFor();
			assert.equal(
				await apps
					.getByRole("switch", { name: "Include Support Inbox" })
					.isChecked(),
				true,
				`${label}: included app switch on`,
			);
			assert.equal(
				await apps
					.getByRole("switch", { name: "Include Finance Ledger" })
					.isChecked(),
				false,
				`${label}: excluded app switch off`,
			);

			// Job 4: whether it works.
			await page.getByRole("button", { name: "Check connection" }).waitFor();

			// Jargon stays out of the lead; technical detail sits behind one disclosure.
			const lead = await page
				.locator('.route-content [data-slot="page"]')
				.evaluate((root) => {
					const advanced = root.querySelector("[data-gateway-advanced]");
					const clone = root.cloneNode(true) as HTMLElement;
					clone.querySelector("[data-gateway-advanced]")?.remove();
					return { text: clone.innerText, hasAdvanced: Boolean(advanced) };
				});
			assert(lead.hasAdvanced, `${label}: advanced disclosure present`);
			for (const jargon of ["MCP auth", "Unified gateway", "App lifecycle"]) {
				assert(
					!lead.text.includes(jargon),
					`${label}: lead copy avoids "${jargon}"`,
				);
			}
			const advanced = page.getByRole("button", { name: "Advanced" });
			assert.equal(
				await advanced.getAttribute("aria-expanded"),
				"false",
				`${label}: advanced starts closed`,
			);

			const geometry = await page.evaluate(() => {
				const root = document.querySelector<HTMLElement>(
					'.route-content [data-slot="page"]',
				);
				return {
					theme: document.documentElement.dataset.mode,
					clientWidth: document.documentElement.clientWidth,
					scrollWidth: document.documentElement.scrollWidth,
					root: root && {
						clientWidth: root.clientWidth,
						scrollWidth: root.scrollWidth,
					},
				};
			});
			assert.equal(geometry.theme, theme, `${label}: theme applied`);
			assert(
				geometry.scrollWidth <= geometry.clientWidth + 1,
				`${label}: no horizontal page overflow ${JSON.stringify(geometry)}`,
			);
			assert(geometry.root, `${label}: page scroll root missing`);
			assert(
				geometry.root.scrollWidth <= geometry.root.clientWidth + 1,
				`${label}: no horizontal content scroll ${JSON.stringify(geometry)}`,
			);
			const box = await address.first().boundingBox();
			assert(box, `${label}: address not rendered`);
			assert(
				box.x >= -1 && box.x + box.width <= geometry.clientWidth + 1,
				`${label}: address stays inside the viewport ${JSON.stringify(box)}`,
			);
			if (shots) {
				await page.screenshot({
					path: `${shots}/${width}-${theme}.png`,
					fullPage: true,
				});
			}
			await page.close();
			console.log(`app gateway detail ${label}: ok`);
		}
	}
} finally {
	await browser?.close();
	await server.stop();
}
