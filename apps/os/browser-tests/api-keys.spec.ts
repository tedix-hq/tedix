import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

// The API keys page backed by the local fixture lane's 60-key ledger: the
// section count is the API's total (25-row page ≠ 60-key organization),
// Next/Previous walk the URL ?page= state, and a delete refetches the
// smaller total. Owns its fixture server because the delete mutates shared
// state other specs would see.
const server = await startFixtureServer("/admin/api-keys", {
	shared: false,
});

async function atPage(page: Page, n: number) {
	await page.waitForURL((url) => url.searchParams.get("page") === String(n), {
		timeout: 10_000,
	});
}

let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	for (const width of [375, 1280] as const) {
		for (const colorScheme of ["light", "dark"] as const) {
			const label = `${width}-${colorScheme}`;
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme,
			});
			await page.goto(`${server.origin}/admin/api-keys`);

			const section = page.locator(
				'section[aria-labelledby="api-key-list-title"]',
			);
			// The header counts the organization's keys, not the visible page.
			const title = page.locator("#api-key-list-title");
			await title.waitFor();
			assert.equal(await title.innerText(), "Keys (60)", label);

			const rows =
				width < 1024
					? section.locator('ul[aria-label="API keys"] > li')
					: section.locator("table tbody tr");
			assert.equal(await rows.count(), 25, `${label}: full first page`);
			const pageOneNames = await rows.allInnerTexts();

			const next = page.getByRole("button", { name: "Next page" });
			assert.equal(await next.isEnabled(), true, `${label}: Next enabled`);
			await next.click();
			await atPage(page, 2);
			assert.equal(await title.innerText(), "Keys (60)", `${label} page 2`);
			assert.notDeepEqual(
				await rows.allInnerTexts(),
				pageOneNames,
				`${label}: page two shows different keys`,
			);

			await next.click();
			await atPage(page, 3);
			assert.equal(await rows.count(), 10, `${label}: partial last page`);
			assert.equal(
				await next.isEnabled(),
				false,
				`${label}: Next disabled on last page`,
			);

			const previous = page.getByRole("button", { name: "Previous page" });
			await previous.click();
			await atPage(page, 2);
			await previous.click();
			await atPage(page, 1);
			assert.equal(
				await previous.isEnabled(),
				false,
				`${label}: Previous disabled on first page`,
			);

			// Delete refreshes the count and the list. "Service key 60" sorts
			// last in the fixture order, so it only renders on page three.
			await next.click();
			await atPage(page, 2);
			await next.click();
			await atPage(page, 3);
			await page
				.getByRole("button", {
					name: "API key actions for Service key 60",
				})
				.click();
			await page.getByRole("menuitem", { name: "Delete" }).click();
			await page
				.getByRole("button", { name: "Delete key", exact: true })
				.click();
			await page
				.locator("#api-key-list-title", { hasText: "Keys (59)" })
				.waitFor();
			assert.equal(await title.innerText(), "Keys (59)", label);

			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - innerWidth,
			);
			assert.ok(overflow <= 1, `${label}: no horizontal overflow`);
			await page.close();
		}
	}
	console.log(
		"PASS: API keys count, ?page= navigation and delete refresh at 375/1280, light and dark",
	);
} finally {
	await browser?.close();
	await server.stop();
}
