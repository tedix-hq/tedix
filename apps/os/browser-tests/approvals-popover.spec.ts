import { startFixtureServer } from "./fixture-server";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit, type Browser, type Page } from "playwright";

// A disclosure mounts with data-starting-style and starts its transition a
// frame later, so "no running animation" alone can pass on the mount frame.
// Scroll-driven tab fades stay running at rest; only document-timed motion settles.
async function settle(page: Page) {
	await page.waitForFunction(
		() =>
			!document.querySelector("[data-starting-style], [data-ending-style]") &&
			document
				.getAnimations()
				.every(
					(a) => a.timeline !== document.timeline || a.playState !== "running",
				),
	);
}

async function capture(page: Page, name: string) {
	if (!evidenceDir) return;
	await settle(page);
	await page.screenshot({ path: `${evidenceDir}/${name}.png` });
}

async function fits(page: Page, width: number) {
	const panel = page.locator("[data-approvals-popover]");
	await settle(page);
	const box = await panel.boundingBox();
	assert(box && box.x >= 0 && box.x + box.width <= width, "Panel fits");
	const layout = await panel.evaluate((node) => ({
		width: node.clientWidth,
		scrollWidth: node.scrollWidth,
		tab: node.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
		overflow: Array.from(node.querySelectorAll<HTMLElement>("*"))
			.filter((child) => child.scrollWidth > child.clientWidth)
			.map((child) => ({
				tag: child.tagName,
				className: child.className,
				text: child.textContent?.slice(0, 120),
				width: child.clientWidth,
				scrollWidth: child.scrollWidth,
			})),
	}));
	assert.equal(
		layout.scrollWidth <= layout.width,
		true,
		`No horizontal overflow: ${JSON.stringify(layout)}`,
	);
}

// The topbar Activity panel against the app's real CSS: WebKit at 320, 375 and
// 1280 px, light and dark, with three held delegations, with mixed action
// requests and history, and with nothing.
const fixturePath = "/browser-tests/approvals-popover.html";
const server = await startFixtureServer(fixturePath);
const evidenceDir = process.env.APPROVALS_POPOVER_EVIDENCE_DIR;
if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
// The overflow menu once raced its disclosure in WebKit only; cover both engines.
const browsers: Browser[] = [];
try {
	for (const engine of [webkit, chromium]) {
		const browser = await engine.launch();
		browsers.push(browser);
		for (const theme of ["light", "dark"] as const)
			for (const [width, height] of [
				[320, 812],
				[375, 812],
				[1280, 900],
			] as const) {
				const page = await browser.newPage({
					viewport: { width, height },
					colorScheme: theme,
					hasTouch: width < 820,
				});
				await page.goto(`${server.origin}${fixturePath}?theme=${theme}`);
				// The shared dev server can still be re-bundling fixture
				// dependencies when the first page connects, and Vite then
				// reloads every connected page mid-run. Load once so the whole
				// module graph is discovered, then restart from a settled
				// navigation: no optimizer reload can land inside an open menu.
				await page
					.getByRole("button", { name: /^Action approvals: / })
					.waitFor();
				await page.reload();
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
					.evaluateAll((nodes) =>
						nodes.map((n) => n.getAttribute("aria-label")),
					);
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
				// The expanding panel slides the action row down; a press spanning
				// the motion releases outside the moved trigger and Base UI cancels
				// the menu it just opened. Settle the disclosure before pressing.
				await settle(page);
				// Overflow carries the secondary choices.
				const moreActions = panel
					.getByRole("button", { name: /^More actions for / })
					.first();
				await moreActions.focus();
				await page.keyboard.press("Enter");
				await page
					.getByRole("menuitem", {
						name: "Follow the suggestion (reject)",
						exact: true,
					})
					.waitFor();
				const menuBox = await page.getByRole("menu").boundingBox();
				assert(
					menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= width,
					"Menu fits",
				);
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
				const emptyPanel = page.locator("[data-approvals-popover]");
				await emptyPanel.getByRole("tab", { name: "Auto-approval" }).click();
				await emptyPanel.getByText("No saved rules", { exact: true }).waitFor();
				await emptyPanel.getByText("Reading data", { exact: true }).waitFor();
				await fits(page, width);
				await capture(page, `activity-auto-empty-${width}-${theme}`);
				await emptyPanel.getByRole("tab", { name: "History" }).click();
				await emptyPanel
					.getByText("No activity yet", { exact: true })
					.waitFor();
				await capture(page, `activity-history-empty-${width}-${theme}`);

				// Needs review: raw tool slugs read as plain titles, and identical
				// requests from one tedi are one row decided together.
				await page.goto(
					`${server.origin}${fixturePath}?theme=${theme}&activity`,
				);
				await page
					.getByRole("button", {
						name: "Action approvals: 6 waiting",
						exact: true,
					})
					.click();
				const activity = page.locator("[data-approvals-popover]");
				await activity
					.getByText("Run skill: Weekly sales report in Example", {
						exact: true,
					})
					.waitFor();
				assert.equal(
					await activity
						.getByRole("button", { name: "Approve all 2", exact: true })
						.count(),
					1,
				);
				await activity
					.getByText("Create draft in Google Gmail", { exact: true })
					.waitFor();
				await activity
					.getByRole("region", { name: "Ops: 3 waiting" })
					.getByText("High risk", { exact: true })
					.waitFor();
				assert.equal(
					await activity.getByText(/tedi_146194|google_gmail/).count(),
					0,
					"No raw tool slug is shown",
				);
				await fits(page, width);
				await capture(page, `activity-review-${width}-${theme}`);

				// Auto-approval: the policy in plain words, what it covered, saved rules.
				await activity.getByRole("tab", { name: "Auto-approval" }).click();
				await activity.getByText("Reading data", { exact: true }).waitFor();
				await activity.getByText("Deleting data", { exact: true }).waitFor();
				await activity
					.getByText("Create work items", { exact: true })
					.waitFor();
				await activity
					.getByText("Always approve: Add note in Example Crm", { exact: true })
					.waitFor();
				await fits(page, width);
				await capture(page, `activity-auto-${width}-${theme}`);

				// A rule turns off with its switch, then deletes after one confirm.
				const rule = {
					id: "00000000-0000-4000-8000-0000000000e1",
					organizationId: "org",
					actionKind: "home.tool_write",
					toolSlug: "example-crm.crm.add_note",
					verb: "add",
					decision: "approve",
					enabled: true,
					createdByKind: "user",
					createdById: "person",
					createdAt: new Date().toISOString(),
					disabledAt: null as string | null,
				};
				let rules = [rule];
				const ruleCalls: string[] = [];
				await page.route("**/api/rpc/osApprovalRules/**", (route) => {
					const call = new URL(route.request().url()).pathname
						.split("/")
						.pop()!;
					ruleCalls.push(call);
					if (call === "setEnabled") {
						rule.enabled = false;
						rule.disabledAt = new Date().toISOString();
						return route.fulfill({ json: { json: { rule } } });
					}
					if (call === "delete") {
						rules = [];
						return route.fulfill({ json: { json: { deleted: true } } });
					}
					return route.fulfill({ json: { json: { items: rules } } });
				});
				await activity
					.getByRole("switch", {
						name: "Always approve Add note in Example Crm",
					})
					.click();
				await activity
					.getByText("Off: this action asks a person again.", {
						exact: false,
					})
					.waitFor();
				await activity.getByRole("button", { name: "Delete rule" }).click();
				await activity
					.getByText("Delete this rule? Past approvals keep a record of it.")
					.waitFor();
				await fits(page, width);
				await capture(page, `activity-rule-delete-${width}-${theme}`);
				await activity
					.getByRole("button", { name: "Delete", exact: true })
					.click();
				await activity.getByText("No saved rules", { exact: true }).waitFor();
				assert.deepEqual(
					ruleCalls.filter((call) => call !== "list"),
					["setEnabled", "delete"],
				);

				// History: decisions and tool calls, newest first, with filters.
				await activity.getByRole("tab", { name: "History" }).click();
				const history = activity.getByRole("list", {
					name: "Activity history",
				});
				await history.waitFor();
				assert.equal(await history.locator(":scope > li").count(), 4);
				for (const label of ["Auto-approved", "Rejected", "Expired", "Failed"])
					await history.getByText(label, { exact: true }).waitFor();
				await fits(page, width);
				await capture(page, `activity-history-${width}-${theme}`);
				await activity
					.getByRole("button", { name: "Automatic", exact: true })
					.click();
				await activity.getByText("1 shown", { exact: true }).waitFor();
				assert.equal(await history.locator(":scope > li").count(), 1);
				await activity
					.getByRole("button", { name: "Actions", exact: true })
					.click();
				await history.getByText("Add note", { exact: true }).waitFor();
				await page.close();
			}
	}
	console.log(
		"PASS: Activity panel review groups, plain titles, identical-request rows, auto-approval policy, history filters, overflow, focus return and empty states; WebKit and Chromium × 320/375/1280 × light/dark",
	);
} finally {
	await Promise.all(browsers.map((browser) => browser.close()));
	await server.stop();
}
