import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

/**
 * Admin › Organization › Outside apps at phone and desktop width: the
 * allowlist switch, allowing a seen app, the warning before enforcing, saving,
 * and no horizontal overflow.
 */
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ??
	new URL("../node_modules/.cache/outside-apps/", import.meta.url).pathname;
await mkdir(evidence, { recursive: true });
// Saves the organization's outside app list; keep that write off the shared fixture.
const server = await startFixtureServer("/", { shared: false });
const browser = await chromium.launch({ headless: true });
let checks = 0;
try {
	for (const width of [390, 1280])
		for (const theme of ["light", "dark"] as const) {
			const label = `${width}/${theme}`;
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.goto(`${server.origin}/admin/organization`);
			const seen = page.getByRole("list", { name: "Apps seen recently" });
			await seen.waitFor();
			await seen.scrollIntoViewIfNeeded();
			await page.evaluate(() => document.fonts.ready);
			assert.equal(
				await seen.getByRole("listitem").count(),
				2,
				`${label}: two seen apps`,
			);
			const toggle = page.getByRole("switch", {
				name: "Only allow apps on the list",
			});
			assert.equal(await toggle.isChecked(), false, `${label}: watch mode`);

			await page
				.getByRole("button", { name: "Allow Notes Helper", exact: true })
				.click();
			const allowed = page.getByRole("list", { name: "Allowed apps" });
			await allowed.getByText("dcr-fixture-client-7").waitFor();
			assert.ok(
				(await allowed.innerText()).includes("allowed until"),
				`${label}: temporary allowance shows its end date`,
			);

			await toggle.click();
			await page
				.getByText(
					"1 app people use now is not on the list and will be blocked: Agent Host.",
				)
				.waitFor();
			assert.ok(
				await seen.getByText("Blocked", { exact: true }).isVisible(),
				`${label}: unlisted app shows Blocked under enforce`,
			);

			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - innerWidth,
			);
			assert.equal(overflow, 0, `${label}: horizontal overflow`);
			await page.screenshot({
				path: `${evidence}outside-apps-${width}-${theme}.png`,
				fullPage: true,
			});

			await page
				.getByRole("button", { name: "Save outside app list", exact: true })
				.click();
			await page.getByText("Outside app list saved.").waitFor();
			// Restore watch mode so the next page starts from the same state.
			await page
				.getByRole("switch", { name: "Only allow apps on the list" })
				.click();
			await page
				.getByRole("button", { name: "Remove Notes Helper", exact: true })
				.click();
			await page
				.getByRole("button", { name: "Save outside app list", exact: true })
				.click();
			await page.getByText("Outside app list saved.").waitFor();
			assert.deepEqual(errors, [], `${label}: no page errors`);
			checks += 1;
			await page.close();
		}
	console.log(
		`PASS: outside apps ${checks} page states; screenshots in ${evidence}`,
	);
} finally {
	await browser.close();
	await server.stop();
}
