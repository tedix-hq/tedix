import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

// App Settings / Tedis on this gateway: the list and its add row fit a 375 px
// phone and a 1280 px desktop without page overflow, and adding a tedi saves
// and shows it in the list.
const GATEWAY_SETTINGS = "/apps/00000080-0000-4000-8000-000000000004/settings";
const server = await startFixtureServer("/");

let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	for (const theme of ["light", "dark"] as const) {
		for (const width of [375, 1280]) {
			const label = `${width}/${theme}`;
			const phone = width === 375;
			const page = await browser.newPage({
				viewport: { width, height: 812 },
				isMobile: phone,
				hasTouch: phone,
				colorScheme: theme,
			});
			page.setDefaultTimeout(20_000);
			await page.route("**/*", async (route) => {
				const url = new URL(route.request().url());
				if (url.origin !== server.origin) return route.abort("blockedbyclient");
				if (url.pathname.endsWith("/userSettings/getPreferences")) {
					const response = await route.fetch();
					const body = await response.json();
					body.json.preferences.theme = theme;
					return route.fulfill({ response, json: body });
				}
				return route.continue();
			});
			await page.goto(`${server.origin}${GATEWAY_SETTINGS}`);
			const section = page
				.locator("section, [data-slot='page-section']")
				.filter({ hasText: "Tedis on this gateway" })
				.last();
			await page.getByText("Tedis on this gateway", { exact: true }).waitFor();
			await section.scrollIntoViewIfNeeded();
			await page.evaluate(() => document.fonts.ready);

			const picker = page.getByRole("combobox", { name: "Tedi to add" });
			const add = page.getByRole("button", { name: "Add tedi" });
			await picker.waitFor();
			const geometry = await page.evaluate(() => ({
				clientWidth: document.documentElement.clientWidth,
				scrollWidth: document.documentElement.scrollWidth,
			}));
			assert(
				geometry.scrollWidth <= geometry.clientWidth + 1,
				`${label}: no horizontal page overflow ${JSON.stringify(geometry)}`,
			);
			for (const [name, control] of [
				["picker", picker],
				["add", add],
			] as const) {
				const box = await control.boundingBox();
				assert(box, `${label}: ${name} not rendered`);
				assert(
					box.x >= -1 && box.x + box.width <= geometry.clientWidth + 1,
					`${label}: ${name} stays inside the viewport ${JSON.stringify(box)}`,
				);
				if (phone)
					assert(box.height >= 43, `${label}: ${name} is a 44 px touch target`);
			}

			// The fixture server keeps saved state across pages: compare counts.
			const removeButtons = page.getByRole("button", {
				name: /from this gateway$/,
			});
			const before = await removeButtons.count();
			await picker.click();
			await page.getByRole("option").first().click();
			await add.click();
			await page.getByText("Gateway tedis saved").first().waitFor();
			await page.waitForFunction(
				(count) =>
					document.querySelectorAll('[aria-label$="from this gateway"]')
						.length === count,
				before + 1,
			);
			await page.close();
			console.log(`app gateway tedis ${label}: ok`);
		}
	}
} finally {
	await browser?.close();
	await server.stop();
}
