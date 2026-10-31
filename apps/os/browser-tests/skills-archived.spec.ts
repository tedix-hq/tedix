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
				`${width}/${theme}: default, URL toggle/reload, counts, search and page reset passed`,
			);
		}
	}
	assert.deepEqual(pageErrors, []);
});
