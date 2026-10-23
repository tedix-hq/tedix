import { startFixtureServer } from "./fixture-server";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { webkit, type Page } from "playwright";

async function capture(page: Page, name: string) {
	if (!evidenceDir) return;
	await page.waitForFunction(() =>
		document.getAnimations().every((a) => a.playState !== "running"),
	);
	await page.screenshot({ path: `${evidenceDir}/${name}.png` });
}

// The topbar approvals popover against the app's real CSS: WebKit at 390 and
// 1280 px, light and dark, with three held delegations and with none.
const fixturePath = "/browser-tests/approvals-popover.html";
const server = await startFixtureServer(fixturePath);
const evidenceDir = process.env.APPROVALS_POPOVER_EVIDENCE_DIR;
if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
const browser = await webkit.launch();
try {
	for (const theme of ["light", "dark"] as const)
		for (const [width, height] of [
			[390, 844],
			[1280, 900],
		] as const) {
			const page = await browser.newPage({
				viewport: { width, height },
				colorScheme: theme,
				hasTouch: width < 820,
			});
			await page.goto(`${server.origin}${fixturePath}?theme=${theme}`);
			const trigger = page.getByRole("button", {
				name: "Action approvals: 3 waiting",
				exact: true,
			});
			await trigger.click();
			const panel = page.locator("[data-approvals-popover]");
			await panel.waitFor();
			await page.evaluate(() => document.fonts.ready);
			const box = await panel.boundingBox();
			assert(box && box.x >= 0 && box.x + box.width <= width, "Panel fits");
			assert.equal(
				await panel.evaluate((node) => node.scrollWidth <= node.clientWidth),
				true,
				"No horizontal overflow",
			);
			// Grouped by tedi with counts, largest first.
			const groups = await panel
				.locator("section")
				.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")));
			assert.deepEqual(groups, ["CTO: 2 waiting", "CFO: 1 waiting"]);
			assert.equal(
				await panel
					.getByRole("button", { name: "Approve", exact: true })
					.count(),
				3,
			);
			assert.equal(await panel.getByText(/^Suggested:/).isVisible(), false);
			await panel
				.getByText(/^expires in /)
				.first()
				.waitFor();
			await capture(page, `approvals-list-${width}-${theme}`);
			// The recommendation is a hint inside the expanded details only.
			const firstTitle = panel
				.getByRole("button", { name: /Show details$/ })
				.first();
			await firstTitle.focus();
			await page.keyboard.press("Enter");
			await panel.getByText("Suggested: Reject", { exact: true }).waitFor();
			assert.equal(
				await panel.getByRole("button", { name: /Hide details$/ }).count(),
				1,
			);
			// Overflow carries the secondary choices.
			await panel
				.getByRole("button", { name: /^More actions for / })
				.first()
				.click();
			await page
				.getByRole("menuitem", { name: "Decide for me (reject)", exact: true })
				.waitFor();
			await page.keyboard.press("Escape");
			await page.getByRole("menu").waitFor({ state: "hidden" });
			await capture(page, `approvals-details-${width}-${theme}`);
			await page.keyboard.press("Escape");
			await panel.waitFor({ state: "hidden" });
			assert.equal(
				await page.evaluate(() =>
					document.activeElement?.getAttribute("aria-label"),
				),
				"Action approvals: 3 waiting",
				"Focus returns to the trigger",
			);

			await page.goto(`${server.origin}${fixturePath}?theme=${theme}&empty`);
			await page
				.getByRole("button", {
					name: "Action approvals: none waiting",
					exact: true,
				})
				.click();
			await page.getByText("No approvals waiting", { exact: true }).waitFor();
			await capture(page, `approvals-empty-${width}-${theme}`);
			await page.close();
		}
	console.log(
		"PASS: approvals popover groups, expiry, details, overflow, focus return and empty state; 390/1280 × light/dark",
	);
} finally {
	await browser.close();
	await server.stop();
}
