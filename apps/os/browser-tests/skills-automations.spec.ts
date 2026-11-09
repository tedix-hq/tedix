import assert from "node:assert/strict";
import type { Page, Route } from "playwright";
import { runShellSpec } from "./shell-harness";

// The Automations list must show canonical automations only: skill
// improvement draft copies belong on the parent skill's Versions tab. The
// mock below mirrors the API predicate and drops improvement copies only
// when the page sends excludeImprovements, so a regression that stops
// sending the flag makes the copies reappear here.
const real = [
	{
		skillId: "20000000-0000-4000-8000-000000000001",
		title: "Weekly revenue report",
		slug: "weekly-revenue-report",
	},
	{
		skillId: "20000000-0000-4000-8000-000000000002",
		title: "Churn watch",
		slug: "churn-watch",
	},
];
const improvements = [
	{
		skillId: "20000000-0000-4000-8000-000000000011",
		title: "Weekly revenue report improvement 9f2b1c",
		slug: "weekly-revenue-report-improvement-9f2b1c",
	},
	{
		skillId: "20000000-0000-4000-8000-000000000012",
		title: "Churn watch improvement bdee6ac5",
		slug: "churn-watch-improvement-bdee6ac5",
	},
];

const operatorSurface = {
	namespace: "skills",
	runTool: "run_skill_workflow",
	statusTool: "get_skill_workflow_status",
	historyTool: "list_skill_workflow_history",
	revisionsTool: "list_skill_workflow_revisions",
	mutationMode: "governed_skill_revision",
	mutationTool: "propose_skill_workflow_improvement",
};

const dynamicDefinition = (skill: {
	skillId: string;
	title: string;
	slug: string;
}) => ({
	id: `dynamic-skill:${skill.skillId}`,
	kind: "dynamic_skill",
	scope: "organization",
	ownerKind: "tenant",
	sourceKind: "revisioned_skill_source",
	engine: "cloudflare_workflows",
	skillId: skill.skillId,
	skillSlug: skill.slug,
	skillRevision: 3,
	tediId: null,
	title: skill.title,
	description: `${skill.title} description`,
	binding: "WORKFLOWS",
	entrypoint: "SkillWorkflow",
	triggers: ["operator", "skill_schedule"],
	lifecycleState: "active",
	updatedAt: "2026-11-08T09:00:00.000Z",
	operatorSurface,
});

const catalog = [...real, ...improvements].map(dynamicDefinition);
const improvementIds = new Set(
	improvements.map((skill) => `dynamic-skill:${skill.skillId}`),
);

function readInput(route: Route) {
	const request = route.request();
	return request.method() === "GET"
		? (JSON.parse(new URL(request.url()).searchParams.get("data") ?? "{}")
				.json ?? {})
		: (request.postDataJSON()?.json ?? {});
}

async function fulfillJson(route: Route, json: unknown) {
	await route.fulfill({ json: { json } });
}

const requested: Record<string, unknown>[] = [];

async function mockWorkflowApis(page: Page) {
	await page.route("**/api/rpc/workflows/listDefinitions**", async (route) => {
		const input = readInput(route);
		requested.push(input);
		const matches = catalog.filter(
			(definition) =>
				!input.excludeImprovements || !improvementIds.has(definition.id),
		);
		const offset = input.offset ?? 0;
		const limit = input.limit ?? 50;
		const definitions = matches.slice(offset, offset + limit);
		await fulfillJson(route, {
			definitions,
			counts: {
				staticPlatform: 0,
				dynamicSkill: matches.length,
				total: matches.length,
			},
			offset,
			limit,
			truncated: offset + definitions.length < matches.length,
			nextOffset:
				offset + definitions.length < matches.length
					? offset + definitions.length
					: null,
		});
	});
	await page.route(
		"**/api/rpc/workflows/listDefinitionHealth**",
		async (route) => {
			const input = readInput(route);
			requested.push(input);
			const matches = catalog.filter(
				(definition) =>
					!input.excludeImprovements || !improvementIds.has(definition.id),
			);
			await fulfillJson(route, {
				health: matches.map((definition) => ({
					definitionId: definition.id,
					title: definition.title,
					kind: definition.kind,
					lifecycleState: definition.lifecycleState,
					currentRevision: definition.skillRevision,
					healthStatus: "unknown",
					driftStatus: "unobserved",
					executionSurface: {
						kind: "skill_runtime_service",
						binding: "SKILL_RUNTIME",
						available: true,
						checkedAt: "2026-11-09T00:00:00.000Z",
					},
					latestRun: null,
					notes: ["no_durable_run_evidence"],
				})),
				definitionCounts: {
					staticPlatform: 0,
					dynamicSkill: matches.length,
					total: matches.length,
				},
				pageCounts: {
					healthy: 0,
					active: 0,
					attention: 0,
					unknown: matches.length,
					degraded: 0,
					dormant: 0,
				},
				evaluatedAt: "2026-11-09T00:00:00.000Z",
				offset: input.offset ?? 0,
				limit: input.limit ?? 50,
				truncated: false,
				nextOffset: null,
			});
		},
	);
	await page.route(
		"**/api/rpc/skills/listWorkflowSchedules**",
		async (route) => {
			const input = readInput(route);
			await fulfillJson(route, {
				schedules: [],
				total: 0,
				offset: input.offset ?? 0,
				limit: input.limit ?? 50,
				nextOffset: null,
			});
		},
	);
}

await runShellSpec(async ({ origin, newPage, capture, pageErrors }) => {
	for (const width of [390, 1280]) {
		for (const theme of ["light", "dark"] as const) {
			requested.length = 0;
			const page = await newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
			});
			await page.addInitScript(
				(value) => localStorage.setItem("tedix-os-theme", value),
				theme,
			);
			await mockWorkflowApis(page);
			await page.goto(`${origin}/skills?section=workflows`);
			await page.getByLabel("2 results", { exact: true }).waitFor();
			for (const skill of real) {
				await page.getByText(skill.title, { exact: true }).first().waitFor();
			}
			for (const skill of improvements) {
				assert.equal(
					await page.getByText(skill.title).count(),
					0,
					`${skill.title} must not appear in Automations`,
				);
			}
			assert.ok(requested.length > 0, "workflow APIs were requested");
			for (const input of requested) {
				assert.equal(
					input.excludeImprovements,
					true,
					"workflow definition reads must exclude improvement copies",
				);
			}
			assert.equal(
				await page.evaluate(
					() => document.documentElement.scrollWidth > innerWidth,
				),
				false,
			);
			await capture(page, `skills-automations-${width}-${theme}`);
			await page.close();
			console.log(
				`${width}/${theme}: only canonical automations listed, improvement copies hidden, flag sent`,
			);
		}
	}
	assert.deepEqual(pageErrors, []);
});
