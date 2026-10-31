import assert from "node:assert/strict";
import { runShellSpec } from "./shell-harness";

// Match the crowded-library story with fictional skills and organizations.
const canonical = Array.from({ length: 48 }, (_, index) => ({
	id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
	organizationId: "fictional-org",
	tediId: null,
	title:
		index < 4 ? `Current skill ${index + 1}` : `Archived skill ${index - 3}`,
	slug: `skill-${index}`,
	content: "# Example",
	description: null,
	successCount: 0,
	failureCount: 0,
	lastUsedAt: null,
	revision: 1,
	visibility: "org",
	folderPath: [null, "reddit", "reddit/threads", "reports"][index] ?? null,
	lifecycleState:
		index < 4 ? ["draft", "active", "proven", "stale"][index] : "archived",
}));

const entries = [
	...canonical,
	...Array.from({ length: 44 }, (_, i) => ({
		...canonical[0],
		id: `10000000-0000-4000-8000-${String(100 + i).padStart(12, "0")}`,
		title: `Hidden improvement ${i}`,
		sourceSkillId: canonical[0].id,
		tags: ["workflow-improvement"],
		lifecycleState: i % 2 ? "archived" : "draft",
	})),
];

await runShellSpec(async ({ origin, newPage, capture, pageErrors }) => {
	for (const width of [390, 1280]) {
		for (const theme of ["light", "dark"] as const) {
			const page = await newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
			});
			await page.addInitScript(
				(value) => localStorage.setItem("tedix-os-theme", value),
				theme,
			);
			await page.route("**/api/rpc/skills/listByOrg**", async (route) => {
				const request = route.request();
				const input =
					request.method() === "GET"
						? (JSON.parse(
								new URL(request.url()).searchParams.get("data") ?? "{}",
							).json ?? {})
						: (request.postDataJSON()?.json ?? {});
				const matches = entries.filter(
					(entry) =>
						(!input.excludeImprovements ||
							!(
								"sourceSkillId" in entry &&
								entry.sourceSkillId &&
								"tags" in entry &&
								entry.tags?.includes("workflow-improvement")
							)) &&
						(!input.excludeArchived || entry.lifecycleState !== "archived") &&
						(!input.lifecycleState ||
							entry.lifecycleState === input.lifecycleState) &&
						(!input.query ||
							entry.title.toLowerCase().includes(input.query.toLowerCase())),
				);
				await route.fulfill({
					json: {
						json: {
							entries: matches.slice(
								input.offset ?? 0,
								(input.offset ?? 0) + (input.limit ?? 50),
							),
							total: matches.length,
						},
					},
				});
			});
			await page.goto(`${origin}/skills`);
			const rows = page.locator('main a[href^="/skills/10000000-"]');
			await page.getByLabel("4 results", { exact: true }).waitFor();
			assert.equal(await rows.count(), 4);
			const toggle = page.getByRole("button", {
				name: "Show archived (44)",
				exact: true,
			});
			assert.equal(await toggle.getAttribute("aria-pressed"), "false");
			assert.equal(
				await page.evaluate(
					() => document.documentElement.scrollWidth > innerWidth,
				),
				false,
			);
			const reddit = page.getByRole("button", {
				name: "reddit 2 skills",
				exact: true,
			});
			const threads = page.getByRole("button", {
				name: "threads 1 skill",
				exact: true,
			});
			const reports = page.getByRole("button", {
				name: "reports 1 skill",
				exact: true,
			});
			assert.equal(await reddit.getAttribute("aria-expanded"), "true");
			assert.equal(await threads.getAttribute("aria-expanded"), "true");
			assert.equal(await reports.getAttribute("aria-expanded"), "true");
			const geometry = await page.evaluate(() => {
				const ungrouped = document
					.querySelector<HTMLElement>('main a[href$="000000000000"]')!
					.closest("ul")!
					.getBoundingClientRect();
				const reddit = document.querySelector<HTMLElement>(
					'[data-folder-path="reddit"]',
				)!;
				const reports = document.querySelector<HTMLElement>(
					'[data-folder-path="reports"]',
				)!;
				const redditRow = reddit.querySelector("ul")!.getBoundingClientRect();
				const nestedRow = document
					.querySelector('[data-folder-path="reddit/threads"] ul')!
					.getBoundingClientRect();
				return {
					firstGap: reddit.getBoundingClientRect().top - ungrouped.bottom,
					nextGap:
						reports.getBoundingClientRect().top -
						reddit.getBoundingClientRect().bottom,
					rowOffsets: [
						redditRow.left - ungrouped.left,
						nestedRow.left - ungrouped.left,
					],
					label: reddit.querySelector("button")!.textContent,
				};
			});
			assert.ok(
				geometry.firstGap >= 16,
				"folder has a clear gap after ungrouped rows",
			);
			assert.ok(
				Math.abs(geometry.firstGap - geometry.nextGap) < 1,
				"group gaps match",
			);
			assert.deepEqual(geometry.rowOffsets, [0, 0], "all catalog rows align");
			assert.equal(
				geometry.label,
				"reddit2 skills",
				"folder name appears once",
			);
			await threads.focus();
			await page.keyboard.press("Space");
			assert.equal(await threads.getAttribute("aria-expanded"), "false");
			await page
				.getByRole("link", { name: /Current skill 3/ })
				.waitFor({ state: "hidden" });
			await reddit.focus();
			await page.keyboard.press("Enter");
			assert.equal(await reddit.getAttribute("aria-expanded"), "false");
			await reports.focus();
			await page.keyboard.press("Space");
			assert.equal(await reports.getAttribute("aria-expanded"), "false");
			await reddit.focus();
			await page.keyboard.press("Enter");
			assert.equal(await reddit.getAttribute("aria-expanded"), "true");
			assert.equal(
				await threads.getAttribute("aria-expanded"),
				"false",
				"nested state survives closing the parent",
			);
			await threads.click();
			await reports.click();
			await page.getByRole("link", { name: /Current skill 3/ }).waitFor();
			await page.getByRole("link", { name: /Current skill 4/ }).waitFor();
			await capture(page, `skills-default-${width}-${theme}`);
			await toggle.click();
			await page.getByLabel("48 results", { exact: true }).waitFor();
			assert.equal(await rows.count(), 20);
			assert.equal(
				new URL(page.url()).searchParams.get("showArchived"),
				"true",
			);
			await page.reload();
			await page
				.getByRole("button", { name: "Hide archived (44)", exact: true })
				.waitFor();
			await page
				.getByRole("searchbox", { name: "Search skills", exact: true })
				.fill("Archived skill");
			await page.getByLabel("44 results", { exact: true }).waitFor();
			assert.equal(await rows.count(), 20);
			await capture(page, `skills-archived-search-${width}-${theme}`);
			// A linked later page must reset when archived matches are hidden.
			const linked = new URL(page.url());
			linked.searchParams.set("page", "2");
			await page.goto(linked.href);
			await page
				.getByRole("button", { name: "Hide archived (44)", exact: true })
				.click();
			await page.getByLabel("0 results", { exact: true }).waitFor();
			assert.equal(await rows.count(), 0);
			assert.equal(new URL(page.url()).searchParams.get("page"), "1");
			await page
				.getByRole("button", { name: "Show archived (44)", exact: true })
				.click();
			await page.getByLabel("44 results", { exact: true }).waitFor();
			assert.equal(await rows.count(), 20);
			await page
				.getByRole("searchbox", { name: "Search skills", exact: true })
				.fill("Hidden improvement");
			await page.getByLabel("0 results", { exact: true }).waitFor();
			assert.equal(await rows.count(), 0);
			await page.close();
			console.log(
				`${width}/${theme}: folder spacing, alignment, keyboard/state, default, URL toggle/reload, counts, search and page reset passed`,
			);
		}
	}
	assert.deepEqual(pageErrors, []);
});
