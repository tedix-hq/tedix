import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

// The workspace Files panel: a right-side list on desktop, folded by the top
// bar's one toggle; phones reach the library from the bottom switcher.
const workspacePath = "/workspace/00000030-0000-4000-8000-000000000002";
const emptyCopy =
	"Nothing here yet. Apps and files made in this workspace will show up here.";
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ??
	join(tmpdir(), "tedix-workspace-outputs-panel");
await mkdir(evidence, { recursive: true });

const server = await startFixtureServer("/");
let browser: Browser | undefined;

async function routeFixture(
	page: Page,
	theme: "light" | "dark",
	empty = false,
) {
	await page.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== server.origin) return route.abort("blockedbyclient");
		if (url.pathname.endsWith("/userSettings/getPreferences")) {
			const response = await route.fetch();
			const body = await response.json();
			body.json.preferences.theme = theme;
			return route.fulfill({ response, json: body });
		}
		if (
			empty &&
			(url.pathname.endsWith("/osWorkspaces/outputs/list") ||
				url.pathname.endsWith("/osWorkspaces/gadgets/list") ||
				url.pathname.endsWith("/osWorkspaces/outputs/library"))
		) {
			const response = await route.fetch();
			const body = await response.json();
			body.json.items = [];
			return route.fulfill({ response, json: body });
		}
		return route.continue();
	});
}

async function noOverflow(page: Page, label: string) {
	assert(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth + 1,
		),
		`${label}: no horizontal page overflow`,
	);
}

try {
	browser = await chromium.launch({ headless: true });
	for (const theme of ["light", "dark"] as const) {
		// Desktop: the panel sits on the right edge of the workbench.
		{
			const label = `1280/${theme}`;
			const context = await browser.newContext({
				viewport: { width: 1280, height: 800 },
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			const page = await context.newPage();
			await routeFixture(page, theme);
			await page.goto(`${server.origin}${workspacePath}`);
			const panel = page.getByRole("complementary", {
				name: "Workspace files",
			});
			await panel.waitFor();
			const rows = panel
				.getByRole("list", { name: "Files" })
				.getByRole("button");
			await rows.first().waitFor();
			await page.evaluate(() => document.fonts.ready);
			assert.equal(
				await page.locator("html").getAttribute("data-mode"),
				theme,
				`${label}: theme applied`,
			);
			const box = await panel.boundingBox();
			assert(box, `${label}: panel has a box`);
			assert(
				Math.abs(box.x + box.width - 1280) <= 1,
				`${label}: panel is on the right edge`,
			);
			assert(Math.abs(box.width - 240) <= 1, `${label}: expanded width`);
			const rowCount = await rows.count();
			assert(rowCount > 0, `${label}: lists outputs`);
			assert.equal(
				await panel.locator("[data-output-kind]").count(),
				rowCount,
				`${label}: every row has a type icon`,
			);
			await page.screenshot({
				path: `${evidence}/${label.replace("/", "-")}-expanded.png`,
			});

			// Opening a row puts it in the stage beside the chat.
			const target = rows.nth(rowCount - 1);
			await target.click();
			await page.waitForFunction(() =>
				new URLSearchParams(location.search).get("workpiece"),
			);
			await page
				.locator('ul[aria-label="Files"] [aria-current="true"]')
				.waitFor();
			assert(
				await page
					.getByRole("complementary", { name: "Workspace chat" })
					.isVisible(),
				`${label}: chat stays beside the opened output`,
			);

			// One toggle, in the top bar: collapse, and the choice survives a reload.
			const toggles = page.getByRole("button", {
				name: /^(Collapse|Expand) files$/,
			});
			assert.equal(
				await toggles.count(),
				1,
				`${label}: exactly one Files toggle`,
			);
			assert.equal(
				await panel.getByRole("button", { name: /files/i }).count(),
				0,
				`${label}: the panel carries no toggle of its own`,
			);
			await page.getByRole("button", { name: "Collapse files" }).click();
			await page.getByRole("button", { name: "Expand files" }).waitFor();
			assert(
				Math.abs(((await panel.boundingBox())?.width ?? 0) - 48) <= 1,
				`${label}: collapsed to the icon rail`,
			);
			await page.screenshot({
				path: `${evidence}/${label.replace("/", "-")}-collapsed.png`,
			});
			await page.reload();
			await page.getByRole("button", { name: "Expand files" }).waitFor();
			assert.equal(
				await page.evaluate(() =>
					localStorage.getItem("tedix-os:workspace-outputs-panel"),
				),
				"collapsed",
				`${label}: collapsed state is remembered`,
			);
			await page.getByRole("button", { name: "Expand files" }).click();
			await page.getByRole("button", { name: "Collapse files" }).waitFor();

			// The footer opens the library and Work in the canvas; the open file
			// stays beside the chat on the way back.
			await panel.getByRole("button", { name: "Everything here" }).click();
			await page
				.getByRole("heading", { name: "Everything in this workspace" })
				.waitFor();
			await panel.getByRole("button", { name: "Work", exact: true }).click();
			await page
				.getByRole("region", { name: "Workspace work", exact: true })
				.waitFor();
			await page.screenshot({
				path: `${evidence}/${label.replace("/", "-")}-work.png`,
			});

			// The Approvals row opens the workspace's activity control.
			await panel.getByRole("button", { name: "Approvals" }).click();
			await page.locator("[data-approvals-popover]").waitFor();
			await page.waitForTimeout(250);
			await page.screenshot({
				path: `${evidence}/${label.replace("/", "-")}-activity.png`,
			});
			await page.keyboard.press("Escape");
			await noOverflow(page, label);
			await context.close();
			console.log(`outputs panel ${label}: ok`);
		}

		// Empty workspace: the panel explains what will appear.
		{
			const label = `1280/${theme}/empty`;
			const context = await browser.newContext({
				viewport: { width: 1280, height: 800 },
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			const page = await context.newPage();
			await routeFixture(page, theme, true);
			await page.goto(`${server.origin}${workspacePath}`);
			const empty = page.locator("[data-workspace-outputs-empty]");
			await empty.waitFor();
			assert.equal((await empty.innerText()).trim(), emptyCopy, label);
			await noOverflow(page, label);
			await page.screenshot({
				path: `${evidence}/${label.replaceAll("/", "-")}.png`,
			});
			await context.close();
			console.log(`outputs panel ${label}: ok`);
		}

		// Phone: no side panel and no toggle; the bottom switcher shows one pane
		// at a time and Files is the whole library.
		{
			const label = `375/${theme}`;
			const context = await browser.newContext({
				viewport: { width: 375, height: 740 },
				colorScheme: theme,
				reducedMotion: "reduce",
				isMobile: true,
				hasTouch: true,
			});
			const page = await context.newPage();
			await routeFixture(page, theme);
			await page.goto(`${server.origin}${workspacePath}`);
			const switcher = page.getByRole("group", { name: "Canvas pane" });
			await switcher.waitFor();
			assert(
				!(await page
					.getByRole("complementary", { name: "Workspace files" })
					.isVisible()),
				`${label}: side panel is hidden on a phone`,
			);
			assert.equal(
				await page
					.getByRole("button", { name: /^(Collapse|Expand) files$/ })
					.count(),
				0,
				`${label}: no panel toggle on a phone`,
			);
			const switcherBox = await switcher.boundingBox();
			assert(
				switcherBox && Math.abs(switcherBox.y + switcherBox.height - 740) <= 1,
				`${label}: the switcher sits at the bottom`,
			);
			assert.deepEqual(
				await switcher.getByRole("button").allInnerTexts(),
				["Chat", "Canvas", "Files"],
				`${label}: Chat · Canvas · Files`,
			);
			await switcher.getByRole("button", { name: "Files" }).click();
			const library = page.getByRole("complementary", {
				name: "Workspace library",
			});
			await library.waitFor();
			assert(
				!(await page
					.getByRole("complementary", { name: "Workspace chat" })
					.isVisible()),
				`${label}: one pane at a time`,
			);
			await noOverflow(page, label);
			await page.screenshot({
				path: `${evidence}/${label.replace("/", "-")}-files.png`,
			});
			await library
				.getByRole("button", { name: /Lindenquay: reconciliation note/ })
				.first()
				.click();
			await page.waitForFunction(() =>
				new URLSearchParams(location.search).get("workpiece"),
			);
			await page.getByRole("tab").first().waitFor();
			await noOverflow(page, label);
			await page.screenshot({
				path: `${evidence}/${label.replace("/", "-")}-opened.png`,
			});
			await context.close();
			console.log(`outputs panel ${label}: ok`);
		}
	}
	console.log(`workspace outputs panel evidence: ${evidence}`);
} finally {
	await browser?.close();
	await server.stop();
}
