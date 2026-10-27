import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { projects } from "@tedix/db/schema/projects";
import { workItems, workItemRelations } from "@tedix/db/schema/work-items";
import {
	workMilestones,
	workMilestoneItems,
} from "@tedix/db/schema/work-factory";
import {
	osOutputs,
	osOutputRevisions,
	osWorkspaceProjects,
	osWorkspaceResources,
	osWorkspaces,
	osBlueprints,
	osBlueprintRevisions,
	osGadgets,
	osGadgetRevisions,
} from "@tedix/db/schema/os-workspaces";
import { skillSchedules } from "@tedix/db/schema/cognitive";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { OsBlueprintDefinitionSchema } from "@tedix/api-contract/schemas/os-workspaces";
import type { BaseContext } from "../orpc";
import { osBlueprintApplyProcedures } from "./os-blueprint-apply";

const mocks = vi.hoisted(() => ({ skill: vi.fn(), tedi: vi.fn() }));
vi.mock("@tedix/db/queries/cognitive/skill-crud", () => ({
	getSkillEntry: mocks.skill,
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediByIdForOrganization: mocks.tedi,
}));

const blueprintId = "10000000-0000-4000-8000-000000000001";
const revisionId = "10000000-0000-4000-8000-000000000002";
function definition(count = 3) {
	return OsBlueprintDefinitionSchema.parse({
		gadgets: [
			{
				name: "Board",
				manifest: {
					entry: "tedix:app/work",
					capabilities: [],
					notes: "{{eventName}}",
				},
			},
		],
		provisioning: {
			version: 1,
			parameters: { eventName: { type: "string" } },
			project: { key: "demo", name: "{{eventName}}" },
			milestones: [
				{ key: "finish", title: "Finish", targetAt: "2030-01-01T12:00:00Z" },
			],
			workItems: Array.from({ length: count }, (_, i) => ({
				key: `card-${i}`,
				title: `Card ${i} for {{eventName}}`,
				description: "Build the fictional demonstration",
				doneWhen: "Fictional result has evidence",
				dependsOn: i ? [`card-${i - 1}`] : [],
				milestone: "finish",
				suggestedOwners: ["A fictional teammate"],
			})),
			documents: [
				{
					key: "guide",
					title: "Join {{eventName}}",
					text: "Open {{workspaceId}} for {{eventName}}",
				},
			],
			schedules: [
				{
					key: "digest",
					name: "Digest",
					cron: "7 9 * * *",
					procedure: "Summarize the fictional board",
				},
			],
		},
	});
}
function fixture(
	options: {
		count?: number;
		org?: string;
		scopes?: string[];
		definition?: unknown;
	} = {},
) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		"PRAGMA foreign_keys=ON; CREATE TABLE organizations(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('fictional-a'),('fictional-b'); CREATE TABLE tedis(id TEXT PRIMARY KEY); INSERT INTO tedis VALUES ('fictional-worker'); CREATE TABLE skill_entries(id TEXT PRIMARY KEY); INSERT INTO skill_entries VALUES ('fictional-skill'); CREATE TABLE tedi_objectives(id TEXT PRIMARY KEY);",
	);
	sqlite.exec(
		schemaDdl(
			skillSchedules,
			projects,
			workItems,
			workItemRelations,
			workMilestones,
			workMilestoneItems,
			osOutputs,
			osOutputRevisions,
			osWorkspaceProjects,
			osWorkspaceResources,
			osWorkspaces,
			osBlueprints,
			osBlueprintRevisions,
			osGadgets,
			osGadgetRevisions,
			auditEvents,
		),
	);
	const env = {
		DB: createD1Facade(sqlite, { maxBoundParams: 100 }),
		ENVIRONMENT: "test",
	} as unknown as CloudflareEnv;
	const context = {
		authType: "apikey",
		organizationId: options.org ?? "fictional-a",
		apiKey: {
			id: "fictional-key",
			scopes: options.scopes ?? [
				"apps:read",
				"apps:write",
				"mcp:memory.read",
				"mcp:memory.write",
				"mcp:work.write",
				"mcp:skills.write",
			],
		},
		env,
		db: createDbClient(env.DB),
		headers: new Headers(),
		url: new URL("https://fictional.test/rpc"),
	} as BaseContext;
	const blueprint = JSON.stringify(
		options.definition ?? definition(options.count),
	);
	sqlite
		.prepare(
			"INSERT INTO os_blueprints(id,organization_id,name,status,current_revision_id,created_by_kind,created_by_id,created_at,updated_at) VALUES (?, 'fictional-a','Example','published',?,'service','fixture','2030-01-01','2030-01-01')",
		)
		.run(blueprintId, revisionId);
	sqlite
		.prepare(
			"INSERT INTO os_blueprint_revisions(id,organization_id,blueprint_id,revision,definition,created_by_kind,created_by_id,created_at) VALUES (?,'fictional-a',?,1,?,'service','fixture','2030-01-01')",
		)
		.run(revisionId, blueprintId, blueprint);
	const client = createRouterClient(osBlueprintApplyProcedures, { context });
	const count = (table: string) =>
		Number(
			(
				sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
					n: number;
				}
			).n,
		);
	return { client, sqlite, count };
}
const input = {
	blueprintId,
	instanceKey: "fictional-instance",
	workspaceName: "Fictional team",
	parameters: { eventName: "Example day" },
};

describe("generic blueprint apply", () => {
	it("creates declared native outputs once and preserves edits on instance-key retry", async () => {
		const declared = definition();
		declared.requirements = OsBlueprintDefinitionSchema.parse({
			requirements: {
				version: 1,
				outputs: [
					{ gadget: "Board", kind: "document", title: "Notes", slot: "notes" },
					{ gadget: "Board", kind: "sheet", title: "Data", slot: "data" },
					{
						gadget: "Board",
						kind: "presentation",
						title: "Slides",
						slot: "slides",
					},
				],
			},
		}).requirements;
		const f = fixture({ definition: declared });
		const first = await f.client.apply(input);
		expect(f.count("os_outputs")).toBe(4);
		const bindings = f.sqlite
			.prepare(
				"SELECT slot, provider_resource_id FROM os_workspace_resources WHERE resource_type = 'output' ORDER BY slot",
			)
			.all();
		expect(bindings.map((row) => row.slot)).toEqual([
			"data",
			"notes",
			"slides",
		]);
		f.sqlite
			.prepare("UPDATE os_outputs SET title = 'Edited title' WHERE id = ?")
			.run(String(bindings[0]!.provider_resource_id));
		const second = await f.client.apply(input);
		expect(second.receipt).toEqual({ ...first.receipt, replayed: true });
		expect(f.count("os_outputs")).toBe(4);
		expect(f.count("os_output_revisions")).toBe(4);
		expect(
			f.sqlite
				.prepare("SELECT title FROM os_outputs WHERE id = ?")
				.get(String(bindings[0]!.provider_resource_id))?.title,
		).toBe("Edited title");
		expect(
			f.sqlite
				.prepare(
					"SELECT slot, provider_resource_id FROM os_workspace_resources WHERE resource_type = 'output' ORDER BY slot",
				)
				.all(),
		).toEqual(bindings);
	});

	it("previews exact identities and content with no provisioning writes, then writes all rows in one batch", async () => {
		const f = fixture({ count: 110 });
		const preview = await f.client.previewApply(input);
		expect(f.count("os_workspaces")).toBe(0);
		expect(f.count("projects")).toBe(0);
		expect(f.count("audit_events")).toBe(0);
		await expect(
			f.client.apply({ ...input, expectedPlanSha256: "0".repeat(64) }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const applied = await f.client.apply(input);
		expect(applied.receipt).toEqual(preview.receipt);
		expect(f.count("work_items")).toBe(110);
		expect(f.count("os_gadgets")).toBe(1);
		expect(f.count("os_gadget_revisions")).toBe(1);
		expect(f.count("work_item_relations")).toBe(109);
		expect(f.count("work_milestone_items")).toBe(110);
		expect(f.count("work_milestones")).toBe(1);
		expect(f.count("os_outputs")).toBe(1);
		expect(f.count("os_workspace_projects")).toBe(1);
		const item = f.sqlite.prepare("SELECT * FROM work_items LIMIT 1").get()!;
		expect(item).toMatchObject({
			accountable_owner_id: null,
			accepted_at: null,
			disposition: "proposed",
		});
		expect(JSON.parse(String(item.acceptance_contract)).doneLooksLike).toBe(
			"Fictional result has evidence",
		);
		expect(JSON.parse(String(item.metadata)).suggestedOwners).toEqual([
			"A fictional teammate",
		]);
		const doc = f.sqlite
			.prepare("SELECT content FROM os_output_revisions")
			.get()!;
		expect(String(doc.content)).toContain(preview.receipt.workspaceId);
		expect(String(doc.content)).toContain("Example day");
		const schedule = f.sqlite
			.prepare(
				"SELECT metadata FROM os_workspace_resources WHERE resource_type='schedule_definition'",
			)
			.get()!;
		expect(JSON.parse(String(schedule.metadata))).toMatchObject({
			enabled: false,
			runtimeStatus: "unbound",
		});
	});
	it("replays without duplicates or overwriting subsequent member edits", async () => {
		const f = fixture();
		const first = await f.client.apply(input);
		f.sqlite.exec("UPDATE work_items SET title='Member edit'");
		const second = await f.client.apply(input);
		expect(second.receipt).toEqual({ ...first.receipt, replayed: true });
		expect(f.count("projects")).toBe(1);
		expect(f.count("work_items")).toBe(3);
		expect(f.count("os_output_revisions")).toBe(1);
		expect(
			f.sqlite.prepare("SELECT title FROM work_items LIMIT 1").get()?.title,
		).toBe("Member edit");
		await expect(
			f.client.apply({ ...input, parameters: { eventName: "Different" } }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it("handles concurrent identical applies and separates second instances", async () => {
		const f = fixture();
		const [a, b] = await Promise.all([
			f.client.apply(input),
			f.client.apply(input),
		]);
		expect(a.receipt.workspaceId).toBe(b.receipt.workspaceId);
		expect(f.count("projects")).toBe(1);
		const second = await f.client.apply({
			...input,
			instanceKey: "second",
			workspaceName: "Another fictional team",
		});
		expect(second.receipt.workspaceId).not.toBe(a.receipt.workspaceId);
		expect(f.count("projects")).toBe(2);
	});
	it("rolls the complete batch back on a late insert failure", async () => {
		const f = fixture();
		f.sqlite.exec(
			"CREATE TRIGGER deny_document BEFORE INSERT ON os_output_revisions BEGIN SELECT RAISE(ABORT,'fictional failure'); END",
		);
		await expect(f.client.apply(input)).rejects.toThrow();
		for (const table of [
			"os_workspaces",
			"projects",
			"work_items",
			"os_outputs",
			"work_item_relations",
			"os_workspace_resources",
		])
			expect(f.count(table)).toBe(0);
	});
	it("rejects another tenant's blueprint and incomplete machine scopes", async () => {
		await expect(
			fixture({ org: "fictional-b" }).client.apply(input),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			fixture({ scopes: ["apps:read", "apps:write"] }).client.apply(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("rejects missing inputs, bad references and enabled unbound schedules before writes", async () => {
		const f = fixture();
		await expect(
			f.client.previewApply({ ...input, parameters: {} }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		const bad = definition();
		bad.provisioning!.schedules[0]!.enabled = true;
		const g = fixture({ definition: bad });
		await expect(g.client.apply(input)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(g.count("os_workspaces")).toBe(0);
		const cycle = definition();
		cycle.provisioning!.workItems[0]!.dependsOn = ["card-2"];
		expect(() => OsBlueprintDefinitionSchema.parse(cycle)).toThrow();
	});
	it("creates bound schedules only when the approved executable policy matches", async () => {
		for (const enabled of [false, true]) {
			const d = definition();
			d.provisioning!.schedules[0]!.skillId = "fictional-skill";
			d.provisioning!.schedules[0]!.enabled = enabled;
			const skill = {
				id: "fictional-skill",
				organizationId: "fictional-a",
				lifecycleState: "active",
				tediId: "fictional-worker",
				files: {
					"scripts/workflow.ts":
						"export default async () => ({status:'no_work'})",
				},
				content: `---\ncapabilities:\n  schedule:\n    cron: "7 9 * * *"\n    enabled: ${enabled}\n    params: {}\n---\nFictional scheduled work`,
			};
			mocks.skill.mockResolvedValue(skill);
			mocks.tedi.mockResolvedValue({ id: "fictional-worker" });
			const f = fixture({ definition: d });
			await f.client.apply(input);
			expect(f.count("skill_schedules")).toBe(1);
			expect(
				f.sqlite.prepare("SELECT enabled FROM skill_schedules").get()?.enabled,
			).toBe(enabled ? 1 : 0);
			await f.client.apply(input);
			expect(f.count("skill_schedules")).toBe(1);
			mocks.skill.mockResolvedValue({ ...skill, lifecycleState: "draft" });
			const g = fixture({ definition: d });
			await expect(g.client.apply(input)).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
			expect(g.count("os_workspaces")).toBe(0);
			mocks.skill.mockResolvedValue({
				...skill,
				content: skill.content.replace("7 9", "8 9"),
			});
			await expect(g.client.previewApply(input)).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
			mocks.skill.mockResolvedValue(undefined);
			await expect(g.client.apply(input)).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		}
	});
	it("resolves date offsets and rejects unresolved dates and template keys", async () => {
		const d = definition();
		d.provisioning!.parameters.deadline = { type: "string", required: true };
		d.provisioning!.milestones[0]!.targetAt = {
			parameter: "deadline",
			offsetMinutes: -30,
		};
		const f = fixture({ definition: d });
		const plan = await f.client.previewApply({
			...input,
			parameters: {
				...input.parameters,
				deadline: "2030-02-01T14:00:00+02:00",
			},
		});
		expect(plan.definition.provisioning!.milestones[0]!.targetAt).toBe(
			"2030-02-01T11:30:00.000Z",
		);
		await expect(
			f.client.apply({
				...input,
				parameters: { ...input.parameters, deadline: "yesterday" },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		d.provisioning!.documents.push({ ...d.provisioning!.documents[0]! });
		expect(() => OsBlueprintDefinitionSchema.parse(d)).toThrow();
	});
	it("keeps Work acceptance limits and forwards the selected runtime target", async () => {
		const d = definition();
		d.provisioning!.workItems[0]!.doneWhen = "x".repeat(2001);
		expect(() => OsBlueprintDefinitionSchema.parse(d)).toThrow();
		const target = "10000000-0000-4000-8000-000000000099";
		const f = fixture();
		const preview = await f.client.previewApply({ ...input, tediId: target });
		expect(preview.preflight.targetTediId).toBe(target);
		const applied = await f.client.apply({ ...input, tediId: target });
		expect(applied.preflight.targetTediId).toBe(target);
	});
});
