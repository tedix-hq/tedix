import { expect, it } from "bun:test";
import { validateWorkflowSource } from "@tedix/db/queries/cognitive/skill-validation";
import {
	PlanningSyncConfigSchema,
	renderPlanningSync,
} from "./render-planning-board-sync";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";

const id = "11111111-1111-4111-8111-111111111111";
const config = {
	boardKey: "sample-planning",
	ownerTediId: id,
	objectiveId: id,
	decisionUserId: "sample-owner",
	stateOutputId: id,
	reportOutputId: "22222222-2222-4222-8222-222222222222",
	osBaseUrl: "https://example.test",
	projectsSource: `collection://${id}`,
	tasksSource: `collection://${id}`,
	meetingsSource: `collection://${id}`,
	projectFields: {
		name: "Name",
		status: "Status",
		due: "Due",
		start: "Start",
		type: "Type",
		next: "Next",
		tasks: "Tasks",
		meetings: "Meetings",
	},
	taskFields: {
		name: "Task",
		status: "Status",
		due: "Due",
		project: "Project",
	},
	meetingFields: { name: "Meeting", date: "Date", project: "Project" },
	projectStatuses: { Planning: "active" },
	activeStatuses: ["Planning"],
	exportProjectStatus: "Planning",
	exportTaskStatus: "Todo",
	exportSince: "2026-01-01T00:00:00.000Z",
	timeZone: "Europe/Berlin",
	workingDays: ["Mon"],
	workingHours: [9],
	nightlyHour: 3,
};
it("pins the configured provider namespace and uses the native Tedix conflict tool", async () => {
	const assets = await renderPlanningSync({
		...config,
		notionNamespace: "planning_notion",
	});
	const manifest = parseCapabilityManifest(assets.content);
	expect(manifest.mcp?.planning_notion).toContain("notion_fetch");
	expect(manifest.mcp?.notion).toBeUndefined();
	expect(manifest.mcp?.tedix).toContain("create_work_interaction");
	expect(manifest.mcp?.work).toBeUndefined();
	expect(assets.files["scripts/workflow.ts"]).toContain(
		'"notionNamespace":"planning_notion"',
	);
});
it("renders a pinned draft with its schedule disabled and no live calls", async () => {
	const assets = await renderPlanningSync(config);
	const manifest = parseCapabilityManifest(assets.content);
	expect(
		validateWorkflowSource(
			assets.files["scripts/workflow.ts"],
			"scripts/workflow.ts",
			{ network: manifest.network, mcp: manifest.mcp },
		),
	).toEqual([]);
	expect(assets.lifecycleState).toBe("draft");
	expect(assets.tediId).toBe(id);
	expect(parseCapabilityManifest(assets.content).schedule?.enabled).toBe(false);
	expect(assets.files["scripts/workflow.ts"]).toContain(
		'"boardKey":"sample-planning"',
	);
	expect(assets.files["scripts/workflow.ts"]).not.toContain(
		"PLANNING_SYNC_CONFIG",
	);
});
it("rejects arbitrary signal writers and embedded credentials", () => {
	expect(
		PlanningSyncConfigSchema.safeParse({
			...config,
			signalReaders: [{ namespace: "gmail", method: "send" }],
		}).success,
	).toBe(false);
	expect(
		PlanningSyncConfigSchema.safeParse({
			...config,
			osBaseUrl: "https://name:password@example.test",
		}).success,
	).toBe(false);
	expect(
		PlanningSyncConfigSchema.safeParse({ ...config, reportOutputId: id })
			.success,
	).toBe(false);
});
