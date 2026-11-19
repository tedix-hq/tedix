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

// Connected sources as the overview shows them: one per kind of origin.
const source = (
	n: number,
	providerId: string,
	resourceType: string,
	name: string,
	providerResourceId = `source-${n}`,
) => ({
	id: `00000099-0000-4000-8000-${String(n).padStart(12, "0")}`,
	organizationId: "0000000a-0000-4000-8000-000000000001",
	workspaceId: workspacePath.split("/").pop(),
	slot: null,
	providerId,
	connectionScope: n === 2 ? "user" : "tenant",
	personalOwnerUserId: null,
	connectionInstanceId: null,
	providerAccess: null,
	requiredScopes: [],
	resourceType,
	providerResourceId,
	name,
	metadata: {},
	status: "active",
	createdByKind: "user",
	createdById: "dev-operator",
	createdAt: "2026-10-16T09:00:00.000Z",
	updatedAt: "2026-10-16T09:00:00.000Z",
	removedAt: null,
});
const sources = [
	source(
		1,
		"firecrawl",
		"research_account",
		"Firecrawl · Northwind research account",
	),
	source(
		2,
		"notion",
		"page",
		"Initial results · Alignment meeting · 16 October 2026",
		"0f8fad5b-d9cb-469f-a165-70867728950e",
	),
	source(3, "tedix", "output", "Opportunities sheet"),
	source(
		4,
		"google_sheets",
		"spreadsheet",
		"Opportunity insights · Google Sheet",
		"1AbCdEfGhIjKlMnOpQrStUvWxYz",
	),
	source(
		5,
		"notion",
		"page",
		"Opportunity rules and learnings with a much longer title that has to wrap",
	),
];

async function routeSources(page: Page, items: unknown[]) {
	await page.route("**/osWorkspaces/resources/list*", async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		body.json.items = items;
		return route.fulfill({ response, json: body });
	});
}

/** The overview's Connected sources: full-width cards, nothing scrolls sideways. */
async function checkSources(page: Page, label: string, columns: number) {
	const section = page.getByRole("region", { name: "Connected sources" });
	const cards = section.locator("[data-workspace-source]");
	await cards.first().waitFor();
	assert.equal(await cards.count(), sources.length, `${label}: one card each`);
	const files = page.locator(".canvas-resource-outputs");
	const [sectionBox, filesBox] = await Promise.all([
		section.boundingBox(),
		files.boundingBox(),
	]);
	assert(sectionBox && filesBox, `${label}: sections have boxes`);
	assert(
		Math.abs(sectionBox.width - filesBox.width) <= 1 &&
			Math.abs(sectionBox.x - filesBox.x) <= 1,
		`${label}: sources span the same width as Files`,
	);
	const lefts = new Set(
		await cards.evaluateAll((nodes) =>
			nodes.map((node) => Math.round(node.getBoundingClientRect().left)),
		),
	);
	assert.equal(lefts.size, columns, `${label}: ${columns} card columns`);
	for (const name of ["Account", "Page", "Output", "Spreadsheet"]) {
		assert(
			(await section.getByText(name, { exact: true }).count()) > 0,
			`${label}: ${name} chip`,
		);
	}
	assert.equal(
		(await section.getByRole("button", { name: /^Open / }).count()) +
			(await section.getByRole("link", { name: /^Open / }).count()),
		sources.length,
		`${label}: every card has Open`,
	);
	await noOverflow(page, label);
	await section.scrollIntoViewIfNeeded();
	await page.screenshot({
		path: `${evidence}/${label.replaceAll("/", "-")}-sources.png`,
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
			// Each row also has an "Actions for …" menu button; count the rows.
			const rows = panel
				.getByRole("list", { name: "Files" })
				.locator("button.workspace-outputs-row");
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
				name: /^(Hide|Show) files$/,
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
			await page.getByRole("button", { name: "Hide files" }).click();
			await page.getByRole("button", { name: "Show files" }).waitFor();
			assert(
				Math.abs(((await panel.boundingBox())?.width ?? 0) - 48) <= 1,
				`${label}: collapsed to the icon rail`,
			);
			await page.screenshot({
				path: `${evidence}/${label.replace("/", "-")}-collapsed.png`,
			});
			await page.reload();
			await page.getByRole("button", { name: "Show files" }).waitFor();
			assert.equal(
				await page.evaluate(() =>
					localStorage.getItem("tedix-os:workspace-outputs-panel"),
				),
				"collapsed",
				`${label}: collapsed state is remembered`,
			);
			await page.getByRole("button", { name: "Show files" }).click();
			await page.getByRole("button", { name: "Hide files" }).waitFor();

			// The footer opens the library and Work in the canvas; the open file
			// stays beside the chat on the way back.
			await panel.getByRole("button", { name: "Overview" }).click();
			await page.getByRole("heading", { name: "Overview" }).waitFor();
			await panel.getByRole("button", { name: "Work", exact: true }).click();
			await page
				.getByRole("region", { name: "Workspace work", exact: true })
				.waitFor();
			await page.screenshot({
				path: `${evidence}/${label.replace("/", "-")}-work.png`,
			});

			// Agents: this workspace links no skill and no agent has run in it.
			await panel.getByRole("button", { name: "Agents", exact: true }).click();
			await page
				.getByRole("region", { name: "Workspace agents" })
				.getByText("No agents work in this workspace yet")
				.waitFor();
			assert.equal(
				new URL(page.url()).searchParams.get("pane"),
				"agents",
				`${label}: the Agents view is in the address`,
			);

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

		// Agents in a workspace that links a skill: the tedi that owns the
		// skill is one row with its counts, and shows its latest runs and the
		// skill's run list when opened, wide and narrow.
		for (const [width, height] of [
			[1280, 800],
			[375, 740],
		] as const) {
			const label = `${width}/${theme}/agents`;
			const context = await browser.newContext({
				viewport: { width, height },
				colorScheme: theme,
				reducedMotion: "reduce",
				isMobile: width < 640,
				hasTouch: width < 640,
			});
			const page = await context.newPage();
			await routeFixture(page, theme);
			await page.goto(
				`${server.origin}/workspace/00000030-0000-4000-8000-000000000001?pane=agents`,
			);
			const agents = page.getByRole("region", { name: "Workspace agents" });
			const row = agents.locator(
				'[data-workspace-agent="tedi:00000010-0000-4000-8000-000000000001"]',
			);
			await row.waitFor();
			assert.match(
				(await row.textContent()) ?? "",
				/Reddit Scout/,
				`${label}: the tedi that owns the linked skill is an agent`,
			);
			await row
				.locator("[data-agent-counts]")
				.getByText(/today$/)
				.waitFor();
			assert.equal(
				await row.locator("[data-agent-run]").count(),
				0,
				`${label}: runs stay folded until asked for`,
			);
			await row.getByRole("button", { expanded: false }).click();
			await row.locator("[data-agent-run]").first().waitFor();
			await row
				.getByRole("link", { name: "Weekly revenue report · See all runs" })
				.waitFor();
			if (width < 640)
				await page
					.getByRole("group", { name: "Canvas pane" })
					.getByRole("button", { name: "Agents" })
					.waitFor();
			await page.evaluate(() => document.fonts.ready);
			await noOverflow(page, label);
			await page.screenshot({
				path: `${evidence}/${label.replaceAll("/", "-")}.png`,
			});
			await context.close();
			console.log(`outputs panel ${label}: ok`);
		}

		// The overview's Connected sources, wide and narrow.
		for (const [width, height, columns] of [
			[1280, 800, 3],
			[375, 740, 1],
		] as const) {
			const label = `${width}/${theme}/sources`;
			const context = await browser.newContext({
				viewport: { width, height },
				colorScheme: theme,
				reducedMotion: "reduce",
				isMobile: width < 640,
				hasTouch: width < 640,
			});
			const page = await context.newPage();
			await routeFixture(page, theme);
			await routeSources(page, sources);
			await page.goto(`${server.origin}${workspacePath}`);
			if (width < 640) {
				await page
					.getByRole("group", { name: "Canvas pane" })
					.getByRole("button", { name: "Files" })
					.click();
			} else {
				await page
					.getByRole("complementary", { name: "Workspace files" })
					.getByRole("button", { name: "Overview" })
					.click();
			}
			await page.evaluate(() => document.fonts.ready);
			await checkSources(page, label, columns);
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

		// Keep the original sheet hit test even though phones now use Files.
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
			await page.goto(
				`${server.origin}/browser-tests/dialogs.html?view=outputs&theme=${theme}`,
			);
			await page.getByRole("button", { name: "Outputs", exact: true }).tap();
			const sheet = page.getByRole("dialog", { name: "Outputs" });
			await sheet.waitFor();
			await sheet.getByRole("list", { name: "Files" }).waitFor();
			await page.waitForFunction(
				() => !document.querySelector("[data-starting-style]"),
			);
			const close = sheet.getByRole("button", { name: "Close", exact: true });
			assert(
				await close.evaluate((node) => {
					const box = node.getBoundingClientRect();
					const hit = document.elementFromPoint(
						box.x + box.width / 2,
						box.y + box.height / 2,
					);
					return hit !== null && node.contains(hit);
				}),
				`${label}: the sheet's close button is reachable`,
			);
			await page.screenshot({
				path: `${evidence}/${label.replace("/", "-")}-sheet.png`,
			});
			await close.tap();
			await sheet.waitFor({ state: "hidden" });
			await context.close();
			console.log(`outputs sheet ${label}: ok`);
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
				await page.getByRole("button", { name: /^(Hide|Show) files$/ }).count(),
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
	// File housekeeping from a row's menu: versions, restore, a copy, a move.
	// Last, because it changes the sample workspace's files.
	{
		const label = "1280/light/housekeeping";
		const context = await browser.newContext({
			viewport: { width: 1280, height: 800 },
			colorScheme: "light",
			reducedMotion: "reduce",
		});
		const page = await context.newPage();
		await routeFixture(page, "light");
		await page.goto(`${server.origin}${workspacePath}`);
		const files = page
			.getByRole("complementary", { name: "Workspace files" })
			.getByRole("list", { name: "Files" });
		const actions = files
			.getByRole("button", {
				name: /^Actions for Lindenquay: reconciliation note/,
			})
			.first();
		await actions.waitFor({ state: "attached" });
		const title = ((await actions.getAttribute("aria-label")) ?? "").replace(
			"Actions for ",
			"",
		);
		// Give the file a second version, as an editor save would.
		await page.evaluate(
			async ({ workspaceId, title }) => {
				const call = async (path: string, json: unknown) => {
					const response = await fetch(
						`/api/rpc/osWorkspaces/outputs/${path}`,
						{
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ json }),
						},
					);
					return (await response.json()).json;
				};
				const { items } = await call("list", { workspaceId });
				const outputId = items.find(
					(item: { title: string }) => item.title === title,
				).id;
				const { currentRevision } = await call("get", { outputId });
				await call("revise", {
					outputId,
					content: currentRevision.content,
					note: "Second save",
				});
			},
			{ workspaceId: workspacePath.split("/").pop()!, title },
		);
		const pick = async (entry: string, row = title) => {
			const more = files.getByRole("button", {
				name: `Actions for ${row}`,
				exact: true,
			});
			await more.locator("xpath=ancestor::li").hover();
			await more.click();
			await page.getByRole("menuitem", { name: entry }).click();
		};

		await pick("Version history");
		const history = page
			.getByRole("dialog")
			.filter({ hasText: "Version history" });
		await history.locator('[data-version="2"]').getByText("Current").waitFor();
		await history
			.locator('[data-version="2"]')
			.getByText("Second save")
			.waitFor();
		await history.locator('[data-version="1"]').waitFor();
		await page.screenshot({ path: `${evidence}/housekeeping-history.png` });
		await history.getByRole("button", { name: "View version 1" }).click();
		await page.locator("[data-version-content]").waitFor();
		await page.screenshot({ path: `${evidence}/housekeeping-version.png` });
		await page.getByRole("button", { name: "All versions" }).click();
		await history.getByRole("button", { name: "Restore version 1" }).click();
		const confirm = page.getByRole("alertdialog");
		await confirm.getByText("Nothing is deleted").waitFor();
		await confirm.getByRole("button", { name: "Restore", exact: true }).click();
		await confirm.waitFor({ state: "hidden" });
		// The restore is a third version; the two before it are still listed.
		const restored = history.locator('[data-version="3"]');
		await restored.getByText("Restored version 1").waitFor();
		await restored.getByText("Current").waitFor();
		assert.equal(
			await history.locator("[data-version]").count(),
			3,
			`${label}: restoring keeps every earlier version`,
		);
		await page.keyboard.press("Escape");
		await history.waitFor({ state: "hidden" });

		await pick("Duplicate");
		await files
			.getByRole("button", { name: `Actions for ${title} copy`, exact: true })
			.waitFor({ state: "attached" });

		await pick("Move to workspace…", `${title} copy`);
		const picker = page
			.getByRole("dialog")
			.filter({ hasText: "Move to workspace" });
		const choice = picker.getByRole("radio").first();
		const destination = (await choice.innerText()).trim();
		await choice.click();
		await page.screenshot({ path: `${evidence}/housekeeping-move.png` });
		await picker
			.getByRole("button", { name: `Move to ${destination}`, exact: true })
			.click();
		await picker.waitFor({ state: "hidden" });
		await files
			.getByRole("button", { name: `Actions for ${title} copy`, exact: true })
			.waitFor({ state: "detached" });
		await noOverflow(page, label);
		await context.close();
		console.log(`outputs panel ${label}: ok`);
	}
	console.log(`workspace outputs panel evidence: ${evidence}`);
} finally {
	await browser?.close();
	await server.stop();
}
