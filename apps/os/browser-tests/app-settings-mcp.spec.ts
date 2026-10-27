import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

// App Settings / Connection: an unbroken MCP server name must wrap inside its
// row instead of widening the page or clipping against .route-content's
// overflow:hidden edge. The fixture app carries no mcpConfig, so the spec
// injects one through the same response envelope the page already reads.
const APP_SETTINGS = "/apps/00000080-0000-4000-8000-000000000001/settings";
const SERVER_NAME =
	"samplewarehousetelemetrymcpserverwithanunreasonablylongunbrokenname0123456789abcdef";
const server = await startFixtureServer("/");

let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	for (const theme of ["light", "dark"] as const) {
		for (const width of [390, 1280]) {
			const label = `${width}/${theme}`;
			const page = await browser.newPage({
				viewport: { width, height: 844 },
				isMobile: width === 390,
				hasTouch: width === 390,
				colorScheme: theme,
			});
			page.setDefaultTimeout(20_000);
			await page.route("**/*", async (route) => {
				const url = new URL(route.request().url());
				if (url.origin !== server.origin) return route.abort("blockedbyclient");
				if (url.pathname.endsWith("/apps/getByIdWithTools")) {
					const response = await route.fetch();
					const body = await response.json();
					body.json.app.metadata = {
						mcpConfig: {
							serverName: SERVER_NAME,
							authMode: "public",
							toolTimeout: 30000,
						},
					};
					return route.fulfill({ response, json: body });
				}
				if (url.pathname.endsWith("/userSettings/getPreferences")) {
					const response = await route.fetch();
					const body = await response.json();
					body.json.preferences.theme = theme;
					return route.fulfill({ response, json: body });
				}
				return route.continue();
			});
			await page.goto(`${server.origin}${APP_SETTINGS}`);
			const name = page.getByText(SERVER_NAME, { exact: true });
			await name.waitFor();
			await page.evaluate(() => document.fonts.ready);
			const geometry = await page.evaluate(() => {
				const root = document.querySelector<HTMLElement>(
					'.route-content [data-slot="page"]',
				);
				return {
					theme: document.documentElement.dataset.mode,
					viewport: innerWidth,
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
			const box = await name.boundingBox();
			assert(box, `${label}: server name not rendered`);
			assert(
				box.x >= -1 && box.x + box.width <= geometry.clientWidth + 1,
				`${label}: server name stays inside the viewport ${JSON.stringify(box)}`,
			);
			// Drop route handlers first: a request still in flight must not
			// reach route.fetch() after the context is gone.
			await page.unrouteAll({ behavior: "ignoreErrors" });
			await page.close();
			console.log(`app settings mcp ${label}: ok`);
		}
	}
} finally {
	await browser?.close();
	await server.stop();
}
