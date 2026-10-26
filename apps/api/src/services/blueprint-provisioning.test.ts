/**
 * The deterministic provisioning plan and row materialization behind
 * `blueprints.apply`.
 *
 * The load-bearing properties pinned here: every planned id is a digest of
 * (tenant, blueprint, instance key, resource kind, template key), so preview
 * and apply agree and a replayed apply is a no-op; `{{name}}` substitution
 * runs over the whole definition before it is re-validated; and
 * `buildBlueprintApplyRows` is a pure projection of the receipt's resource
 * list, so row coverage cannot drift from the receipt it stores.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	OsBlueprintDefinitionSchema,
	type OsBlueprintDefinition,
} from "@tedix/api-contract/schemas/os-workspaces";
import { describe, expect, it } from "vite-plus/test";
import { canonicalDigest } from "../lib/blueprint-digest";
import {
	buildBlueprintApplyRows,
	planBlueprintApply,
} from "./blueprint-provisioning";

const ORGANIZATION_ID = "org-fiction-tenant";
const BLUEPRINT_ID = "7b4c9a10-2d3e-4f50-8a6b-1c2d3e4f5a6b";
const REVISION_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const INSTANCE_KEY = "pod-1";
const NOW = "2026-10-22T00:00:00.000Z";

/** The module's private deterministic-id formula, restated so tests pin it. */
async function instanceId(parts: string[]): Promise<string> {
	const digest = await canonicalDigest(parts);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/**
 * A small fictional blueprint: one app, a project with a parameter-bound
 * target, one milestone, two linked Work templates, a document template and
 * an unbound schedule. `{{teamName}}` placeholders sit in a plain string, an
 * array element and a nested object; `seats` is optional and unreferenced.
 */
function definition(): OsBlueprintDefinition {
	return OsBlueprintDefinitionSchema.parse({
		gadgets: [
			{
				name: "Board",
				manifest: { entry: "board.ts", capabilities: ["work:read"] },
			},
		],
		requirements: null,
		provisioning: {
			version: 1,
			parameters: {
				teamName: { type: "string", required: true },
				kickoff: { type: "string", required: true },
				seats: { type: "number", required: false },
			},
			project: {
				key: "pod",
				name: "{{teamName}} pod",
				targetAt: { parameter: "kickoff", offsetMinutes: 60 },
			},
			milestones: [{ key: "launch", title: "Launch {{teamName}}" }],
			workItems: [
				{
					key: "setup",
					title: "Set up {{teamName}}",
					description: "Stand up the {{teamName}} workspace.",
					doneWhen: "Workspace is usable",
				},
				{
					key: "review",
					title: "Review setup",
					description: "Check the setup results.",
					doneWhen: "Setup is reviewed",
					dependsOn: ["setup"],
					milestone: "launch",
					suggestedOwners: ["tedi-review"],
				},
			],
			documents: [
				{
					key: "brief",
					title: "{{teamName}} brief",
					text: "Notes for {{teamName}}.",
				},
			],
			schedules: [
				{
					key: "digest",
					name: "Weekly digest",
					cron: "0 9 * * 1",
					procedure: "Summarize the week",
					params: {
						label: "{{teamName}}",
						tags: ["fixed", "{{teamName}}"],
						nested: { owner: "{{teamName}}" },
					},
				},
			],
		},
	});
}

function planInput(
	overrides: {
		parameters?: Record<string, JsonValue>;
		definition?: OsBlueprintDefinition;
		instanceKey?: string;
	} = {},
) {
	return {
		organizationId: ORGANIZATION_ID,
		blueprintId: BLUEPRINT_ID,
		revisionId: REVISION_ID,
		instanceKey: INSTANCE_KEY,
		workspaceName: "Quokka Workspace",
		parameters: {
			teamName: "Quokka",
			kickoff: "2026-11-02T09:00:00.000Z",
			seats: 3,
		},
		definition: definition(),
		...overrides,
	};
}

describe("planBlueprintApply parameter validation", () => {
	it("refuses a revision with no structured provisioning declaration", async () => {
		const bare = OsBlueprintDefinitionSchema.parse({
			gadgets: [],
			requirements: null,
		});
		await expect(
			planBlueprintApply(planInput({ definition: bare })),
		).rejects.toThrow("Blueprint has no structured provisioning declaration");
	});

	it("refuses when a required parameter is missing", async () => {
		await expect(
			planBlueprintApply(
				planInput({
					parameters: { kickoff: "2026-11-02T09:00:00.000Z" },
				}),
			),
		).rejects.toThrow("Missing blueprint parameter: teamName");
	});

	it("accepts a plan that omits an optional parameter", async () => {
		const plan = await planBlueprintApply(
			planInput({
				parameters: {
					teamName: "Quokka",
					kickoff: "2026-11-02T09:00:00.000Z",
				},
			}),
		);
		expect(plan.receipt.workspaceId).toBe(
			await instanceId([
				ORGANIZATION_ID,
				BLUEPRINT_ID,
				INSTANCE_KEY,
				"workspace",
			]),
		);
	});

	it("refuses a parameter whose value does not match its declared type", async () => {
		await expect(
			planBlueprintApply(
				planInput({
					parameters: {
						teamName: "Quokka",
						kickoff: "2026-11-02T09:00:00.000Z",
						seats: "three",
					},
				}),
			),
		).rejects.toThrow("Blueprint parameter seats must be number");
	});

	it("refuses a blank string for a declared string parameter", async () => {
		await expect(
			planBlueprintApply(
				planInput({
					parameters: {
						teamName: "   ",
						kickoff: "2026-11-02T09:00:00.000Z",
					},
				}),
			),
		).rejects.toThrow("Blueprint parameter teamName must not be empty");
	});

	it("refuses a parameter the blueprint does not declare", async () => {
		await expect(
			planBlueprintApply(
				planInput({
					parameters: {
						teamName: "Quokka",
						kickoff: "2026-11-02T09:00:00.000Z",
						extra: "surprise",
					},
				}),
			),
		).rejects.toThrow("Unknown blueprint parameter: extra");
	});

	it("refuses a parameter-bound target whose value is not a timezone-aware date", async () => {
		await expect(
			planBlueprintApply(
				planInput({
					parameters: { teamName: "Quokka", kickoff: "next monday" },
				}),
			),
		).rejects.toThrow("Invalid date parameter: kickoff");
	});

	it("refuses a literal target that has no timezone", async () => {
		const naive = OsBlueprintDefinitionSchema.parse({
			gadgets: [],
			requirements: null,
			provisioning: {
				version: 1,
				project: { key: "pod", name: "pod", targetAt: "2026-11-05" },
			},
		});
		await expect(
			planBlueprintApply(planInput({ definition: naive, parameters: {} })),
		).rejects.toThrow(
			"Blueprint target must be a timezone-aware date: 2026-11-05",
		);
	});
});

describe("planBlueprintApply substitution", () => {
	it("resolves placeholders in strings, array elements and nested objects", async () => {
		const plan = await planBlueprintApply(planInput());
		const provisioning = plan.definition.provisioning;
		expect(provisioning?.project?.name).toBe("Quokka pod");
		expect(provisioning?.milestones[0]?.title).toBe("Launch Quokka");
		expect(provisioning?.workItems[0]?.title).toBe("Set up Quokka");
		expect(provisioning?.documents[0]?.text).toBe("Notes for Quokka.");
		expect(provisioning?.schedules[0]?.params).toEqual({
			label: "Quokka",
			tags: ["fixed", "Quokka"],
			nested: { owner: "Quokka" },
		});
	});

	it("serializes non-string replacements into the placeholder position", async () => {
		const typed = OsBlueprintDefinitionSchema.parse({
			gadgets: [],
			requirements: null,
			provisioning: {
				version: 1,
				parameters: {
					seats: { type: "number", required: true },
					prefs: { type: "object", required: true },
				},
				documents: [
					{
						key: "brief",
						title: "Brief",
						text: "seats={{seats}} prefs={{prefs}}",
					},
				],
			},
		});
		const plan = await planBlueprintApply(
			planInput({
				definition: typed,
				parameters: { seats: 3, prefs: { theme: "dark" } },
			}),
		);
		expect(plan.definition.provisioning?.documents[0]?.text).toBe(
			'seats=3 prefs={"theme":"dark"}',
		);
	});

	it("still requires a parameter an optional declaration references", async () => {
		// A placeholder cannot be left unresolved, so an optional parameter is
		// effectively required wherever the definition actually uses it.
		const referenced = OsBlueprintDefinitionSchema.parse({
			gadgets: [],
			requirements: null,
			provisioning: {
				version: 1,
				parameters: {
					nickname: { type: "string", required: false },
				},
				documents: [{ key: "brief", title: "Brief", text: "For {{nickname}}" }],
			},
		});
		await expect(
			planBlueprintApply(planInput({ definition: referenced, parameters: {} })),
		).rejects.toThrow("Missing blueprint parameter: nickname");
	});
});

describe("planBlueprintApply plan", () => {
	it("derives every resource id deterministically and lists them in plan order", async () => {
		const plan = await planBlueprintApply(planInput());
		const prefix = [ORGANIZATION_ID, BLUEPRINT_ID, INSTANCE_KEY];
		expect(plan.receipt.workspaceId).toBe(
			await instanceId([...prefix, "workspace"]),
		);
		expect(plan.receipt.revisionId).toBe(REVISION_ID);
		expect(plan.receipt.instanceKey).toBe(INSTANCE_KEY);
		expect(plan.receipt.replayed).toBe(false);
		expect(plan.receipt.planSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(plan.receipt.resources).toEqual([
			{
				kind: "project",
				key: "pod",
				id: await instanceId([...prefix, "project", "pod"]),
			},
			{
				kind: "milestone",
				key: "launch",
				id: await instanceId([...prefix, "milestone", "launch"]),
			},
			{
				kind: "work_item",
				key: "setup",
				id: await instanceId([...prefix, "work_item", "setup"]),
			},
			{
				kind: "work_item",
				key: "review",
				id: await instanceId([...prefix, "work_item", "review"]),
			},
			{
				kind: "dependency",
				key: "review:setup",
				id: await instanceId([...prefix, "dependency", "review:setup"]),
			},
			{
				kind: "document",
				key: "brief",
				id: await instanceId([...prefix, "document", "brief"]),
			},
			{
				kind: "schedule",
				key: "digest",
				id: await instanceId([...prefix, "schedule", "digest"]),
			},
			{
				kind: "app",
				key: "Board",
				id: await instanceId([...prefix, "app", "Board"]),
			},
		]);
	});

	it("replays identically and isolates instances by instance key", async () => {
		const first = await planBlueprintApply(planInput());
		const replay = await planBlueprintApply(planInput());
		expect(replay.receipt).toEqual(first.receipt);

		const other = await planBlueprintApply(planInput({ instanceKey: "pod-2" }));
		expect(other.receipt.workspaceId).not.toBe(first.receipt.workspaceId);
		expect(other.receipt.planSha256).toBe(first.receipt.planSha256);
	});

	it("resolves a parameter-bound target into an absolute timestamp", async () => {
		const plan = await planBlueprintApply(planInput());
		expect(plan.definition.provisioning?.project?.targetAt).toBe(
			"2026-11-02T10:00:00.000Z",
		);
	});
});

describe("buildBlueprintApplyRows", () => {
	const BASE = {
		organizationId: ORGANIZATION_ID,
		blueprintId: BLUEPRINT_ID,
		revision: 4,
		workspaceName: "Quokka Workspace",
		createdByKind: "user" as const,
		createdById: "creator-fixture",
		now: NOW,
		preflight: '{"status":"ready"}',
	};

	const CREATOR = {
		organizationId: ORGANIZATION_ID,
		createdByKind: "user",
		createdById: "creator-fixture",
		createdAt: NOW,
	};

	function resourceId(
		plan: Awaited<ReturnType<typeof planBlueprintApply>>,
		kind: string,
		key: string,
	) {
		const row = plan.receipt.resources.find(
			(row) => row.kind === kind && row.key === key,
		);
		if (!row) throw new Error(`test fixture missing ${kind} ${key}`);
		return row.id;
	}

	it("materializes the workspace and stores the apply receipt as a resource", async () => {
		const plan = await planBlueprintApply(planInput());
		const params = await buildBlueprintApplyRows(plan, BASE);

		expect(params.workspace).toEqual({
			...CREATOR,
			id: plan.receipt.workspaceId,
			name: "Quokka Workspace",
			status: "active",
			sourceBlueprintId: BLUEPRINT_ID,
			sourceBlueprintRevisionId: REVISION_ID,
			sourceBlueprintRevisionNumber: 4,
			instantiationPreflight: '{"status":"ready"}',
			updatedAt: NOW,
		});

		const receiptRow = params.resources?.find(
			(row) => row.slot === "blueprint-apply-receipt",
		);
		expect(receiptRow).toMatchObject({
			...CREATOR,
			id: await instanceId([plan.receipt.workspaceId, "receipt"]),
			workspaceId: plan.receipt.workspaceId,
			providerId: "tedix",
			connectionScope: "tenant",
			resourceType: "blueprint_apply",
			providerResourceId: plan.receipt.workspaceId,
			name: "Blueprint apply receipt",
			updatedAt: NOW,
		});
		// The stored receipt is what replay compares, verbatim.
		expect(JSON.parse(receiptRow?.metadata ?? "")).toEqual(plan.receipt);
	});

	it("projects the project, its workspace link and the milestone", async () => {
		const plan = await planBlueprintApply(planInput());
		const params = await buildBlueprintApplyRows(plan, BASE);
		const projectId = resourceId(plan, "project", "pod");
		const provenance = {
			blueprintRevisionId: REVISION_ID,
			blueprintInstanceKey: INSTANCE_KEY,
		};

		expect(params.provisioning?.projects).toEqual([
			{
				id: projectId,
				orgId: ORGANIZATION_ID,
				key: `pod-${projectId.replaceAll("-", "")}`,
				name: "Quokka pod",
				targetDate: "2026-11-02T10:00:00.000Z",
				metadata: { ...provenance, templateKey: "pod" },
				createdAt: NOW,
				updatedAt: NOW,
			},
		]);
		expect(params.provisioning?.projectLinks).toEqual([
			{
				...CREATOR,
				id: await instanceId([plan.receipt.workspaceId, "project-link"]),
				workspaceId: plan.receipt.workspaceId,
				projectId,
				updatedAt: NOW,
			},
		]);
		expect(params.provisioning?.milestones).toEqual([
			{
				id: resourceId(plan, "milestone", "launch"),
				orgId: ORGANIZATION_ID,
				projectId,
				title: "Launch Quokka",
				sortOrder: 0,
				accountableOwnerType: "system",
				accountableOwnerId: `blueprint:${plan.receipt.workspaceId}`,
				metadata: { ...provenance, templateKey: "launch" },
				createdAt: NOW,
			},
		]);
	});

	it("projects work templates, their blocking edges and milestone links", async () => {
		const plan = await planBlueprintApply(planInput());
		const params = await buildBlueprintApplyRows(plan, BASE);
		const projectId = resourceId(plan, "project", "pod");
		const setupId = resourceId(plan, "work_item", "setup");
		const reviewId = resourceId(plan, "work_item", "review");
		const provenance = {
			blueprintRevisionId: REVISION_ID,
			blueprintInstanceKey: INSTANCE_KEY,
		};

		const items = params.provisioning?.items ?? [];
		expect(items.map((item) => item.id)).toEqual([setupId, reviewId]);
		expect(items[0]).toMatchObject({
			orgId: ORGANIZATION_ID,
			projectId,
			title: "Set up Quokka",
			disposition: "proposed",
			workKind: "operations",
			riskLevel: "medium",
			acceptanceContract: {
				version: 1,
				doneLooksLike: "Workspace is usable",
			},
			provenance: { ...provenance, templateKey: "setup" },
			metadata: { ...provenance, templateKey: "setup", suggestedOwners: [] },
			createdAt: NOW,
		});
		expect(items[1]?.metadata).toMatchObject({
			suggestedOwners: ["tedi-review"],
		});

		expect(params.provisioning?.relations).toEqual([
			{
				id: resourceId(plan, "dependency", "review:setup"),
				orgId: ORGANIZATION_ID,
				fromWorkItemId: setupId,
				toWorkItemId: reviewId,
				relationType: "blocks",
				metadata: { ...provenance, templateKey: "review:setup" },
				createdAt: NOW,
			},
		]);
		expect(params.provisioning?.milestoneItems).toEqual([
			{
				orgId: ORGANIZATION_ID,
				milestoneId: resourceId(plan, "milestone", "launch"),
				workItemId: reviewId,
				createdAt: NOW,
			},
		]);
	});

	it("materializes each document template as an output plus revision 1", async () => {
		const plan = await planBlueprintApply(planInput());
		const params = await buildBlueprintApplyRows(plan, BASE);
		const outputId = resourceId(plan, "document", "brief");
		const revisionId = await instanceId([outputId, "revision", "1"]);

		expect(params.provisioning?.outputs).toEqual([
			{
				...CREATOR,
				id: outputId,
				workspaceId: plan.receipt.workspaceId,
				kind: "document",
				title: "Quokka brief",
				currentRevisionId: revisionId,
				updatedAt: NOW,
			},
		]);
		expect(params.provisioning?.outputRevisions).toEqual([
			{
				...CREATOR,
				id: revisionId,
				outputId,
				revision: 1,
				content: JSON.stringify({
					kind: "document",
					blocks: [{ type: "paragraph", text: "Notes for Quokka." }],
				}),
				note: "Blueprint template: brief",
			},
		]);
	});

	it("materializes each app with its revision-1 pointer preset", async () => {
		const plan = await planBlueprintApply(planInput());
		const params = await buildBlueprintApplyRows(plan, BASE);
		const gadgetId = resourceId(plan, "app", "Board");
		const gadgetRevisionId = await instanceId([gadgetId, "revision", "1"]);

		expect(params.gadgets).toEqual([
			{
				...CREATOR,
				id: gadgetId,
				workspaceId: plan.receipt.workspaceId,
				name: "Board",
				currentRevisionId: gadgetRevisionId,
				sourceBlueprintRevisionId: REVISION_ID,
				updatedAt: NOW,
			},
		]);
		expect(params.revisions).toHaveLength(1);
		expect(params.revisions[0]).toMatchObject({
			...CREATOR,
			id: gadgetRevisionId,
			gadgetId,
			revision: 1,
		});
		expect(JSON.parse(params.revisions[0]?.manifest ?? "")).toEqual({
			entry: "board.ts",
			capabilities: ["work:read"],
		});
	});

	it("materializes each schedule as an unbound resource, never a schedule row", async () => {
		const plan = await planBlueprintApply(planInput());
		const params = await buildBlueprintApplyRows(plan, BASE);
		const scheduleId = resourceId(plan, "schedule", "digest");

		const scheduleRow = params.resources?.find(
			(row) => row.slot === "blueprint-schedule:digest",
		);
		expect(scheduleRow).toMatchObject({
			...CREATOR,
			id: scheduleId,
			workspaceId: plan.receipt.workspaceId,
			providerId: "tedix",
			connectionScope: "tenant",
			resourceType: "schedule_definition",
			// With no declared skill binding the row points at its own planned id.
			providerResourceId: scheduleId,
			name: "Weekly digest",
			updatedAt: NOW,
		});
		expect(JSON.parse(scheduleRow?.metadata ?? "")).toMatchObject({
			key: "digest",
			cron: "0 9 * * 1",
			blueprintRevisionId: REVISION_ID,
			blueprintInstanceKey: INSTANCE_KEY,
			templateKey: "digest",
			runtimeStatus: "unbound",
		});

		// Governed skill-schedule rows are appended by the router's binding
		// step, not here — the plan cannot know which org skill will bind.
		expect(params.provisioning?.schedules).toEqual([]);
	});
	it("materializes runtime files under the new app and revision identities", async () => {
		const input = planInput();
		const files = {
			"server.js": "export class App {}",
			"client.js": "render()",
		};
		input.definition.gadgets = [
			{
				name: "Counter",
				manifest: {
					entry: "tedix:runtime/v1",
					capabilities: [],
					config: { version: 1 },
				},
				files,
			},
		];
		const plan = await planBlueprintApply(input);
		const rows = await buildBlueprintApplyRows(plan, BASE);
		expect(rows.code).toEqual([
			{
				organizationId: ORGANIZATION_ID,
				gadgetId: rows.gadgets[0].id,
				revisionId: rows.revisions[0].id,
				files: JSON.stringify(files),
				codeLength: 27,
				createdAt: NOW,
			},
		]);
	});
});
