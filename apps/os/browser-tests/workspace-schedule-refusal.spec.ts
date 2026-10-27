import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

const path = "/workspace/00000030-0000-4000-8000-000000000001?pane=resources";
const refused =
	"Error: WorkflowToolsRefused: WORKFLOW_TOOLS_REFUSED: " +
	"a tool capability in step gather was wholly refused";
const plain =
	"Last run failed: The run could not read session activity because " +
	"access was refused. You can allow it below.";
const server = await startFixtureServer("/");
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	for (const theme of ["light", "dark"] as const) {
		for (const width of [375, 768, 1280]) {
			const label = `${width}/${theme}`;
			const page = await browser.newPage({
				viewport: { width, height: 844 },
				colorScheme: theme,
				hasTouch: width < 500,
			});
			await page.route("**/*", async (route) => {
				const url = new URL(route.request().url());
				if (url.origin !== server.origin) return route.abort("blockedbyclient");
				if (url.pathname.endsWith("/osWorkspaces/schedules/list")) {
					const response = await route.fetch();
					return route.fulfill({
						response,
						body: (await response.text())
							.replaceAll(
								"MCP call crm.list_accounts timed out after 15s",
								refused,
							)
							.replaceAll(
								'"providerId":"google-gmail","providerName":"Gmail","toolIds":["search_threads"]',
								'"providerId":"tedix-session-activity","providerName":"session activity","toolIds":["list_agent_session_activity"]',
							),
					});
				}
				if (url.pathname.endsWith("/userSettings/getPreferences")) {
					const response = await route.fetch();
					const body = await response.json();
					body.json.preferences.theme = theme;
					return route.fulfill({ response, json: body });
				}
				return route.continue();
			});
			await page.goto(`${server.origin}${path}`);
			const line = page.getByText(plain, { exact: true });
			await line.waitFor();
			const details = page.getByRole("button", {
				name: "Technical details",
				exact: true,
			});
			await details.waitFor();
			assert.equal(
				await details.getAttribute("aria-expanded"),
				"false",
				`${label}: details start closed`,
			);
			assert.equal(
				await page.getByText(refused, { exact: true }).isVisible(),
				false,
				`${label}: raw exception stays hidden until asked for`,
			);
			await details.click();
			await page.getByText(refused, { exact: true }).waitFor({
				state: "visible",
			});
			await page.evaluate(() => document.fonts.ready);
			assert.equal(
				await page.locator("html").getAttribute("data-mode"),
				theme,
				`${label}: theme applied`,
			);
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				`${label}: no page overflow`,
			);
			if (width < 500) {
				const box = await details.boundingBox();
				assert(
					box && box.height >= 44 && box.width >= 44,
					`${label}: disclosure is a touch-size target`,
				);
			}
			await page.close();
			console.log(`schedule refusal ${label}: ok`);
		}
	}
} finally {
	await browser?.close();
	await server.stop();
}
