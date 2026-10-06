import {
	WorkflowDefinitionHealthSchema,
	WorkflowDefinitionSchema,
	WorkflowTypeSchema,
	workflowsContract,
} from "@tedix/api-contract/contracts/workflows";
import { describe, expect, it } from "vite-plus/test";
import {
	deriveWorkflowDefinitionHealth,
	STATIC_WORKFLOW_DEFINITIONS,
} from "./workflows";

describe("workflow definition ownership catalog", () => {
	it("classifies every platform workflow type exactly once", () => {
		const catalogTypes = STATIC_WORKFLOW_DEFINITIONS.map(
			(definition) => definition.workflowType,
		);

		expect(new Set(catalogTypes).size).toBe(catalogTypes.length);
		expect([...catalogTypes].sort()).toEqual(
			[...WorkflowTypeSchema.options].sort(),
		);
		for (const definition of STATIC_WORKFLOW_DEFINITIONS) {
			expect(WorkflowDefinitionSchema.parse(definition)).toMatchObject({
				id: `static:${definition.workflowType}`,
				kind: "static_platform",
				ownerKind: "platform",
				sourceKind: "deployed_entrypoint",
				engine: "cloudflare_workflows",
				operatorSurface: {
					namespace: "workflows",
					mutationMode: "deploy_main",
				},
			});
		}
	});

	it("makes the dynamic definition ownership and mutation boundary explicit", () => {
		const parsed = WorkflowDefinitionSchema.parse({
			id: "dynamic-skill:skill-1",
			kind: "dynamic_skill",
			scope: "organization",
			ownerKind: "tenant",
			sourceKind: "revisioned_skill_source",
			engine: "cloudflare_workflows",
			skillId: "skill-1",
			skillSlug: "weekly-review",
			skillRevision: 7,
			tediId: "tedi-1",
			title: "Weekly review",
			description: null,
			binding: "WORKFLOWS",
			entrypoint: "SkillWorkflow",
			triggers: ["operator", "skill_schedule"],
			lifecycleState: "active",
			updatedAt: "2026-07-22T00:00:00.000Z",
			operatorSurface: {
				namespace: "skills",
				runTool: "run_skill_workflow",
				statusTool: "get_skill_workflow_status",
				historyTool: "list_skill_workflow_history",
				revisionsTool: "list_skill_workflow_revisions",
				mutationMode: "governed_skill_revision",
				mutationTool: "propose_skill_workflow_improvement",
			},
		});

		expect(parsed).toMatchObject({
			kind: "dynamic_skill",
			ownerKind: "tenant",
			sourceKind: "revisioned_skill_source",
			operatorSurface: {
				namespace: "skills",
				mutationMode: "governed_skill_revision",
			},
		});
	});
});

describe("workflow definition health classification", () => {
	const staticDefinition = STATIC_WORKFLOW_DEFINITIONS.find(
		(definition) => definition.workflowType === "catalog_sync",
	)!;
	const dynamicDefinition = WorkflowDefinitionSchema.parse({
		id: "dynamic-skill:skill-1",
		kind: "dynamic_skill",
		scope: "organization",
		ownerKind: "tenant",
		sourceKind: "revisioned_skill_source",
		engine: "cloudflare_workflows",
		skillId: "skill-1",
		skillSlug: "workflow-kitchen-sink",
		skillRevision: 12,
		tediId: "tedi-1",
		title: "Workflow kitchen sink",
		description: null,
		binding: "WORKFLOWS",
		entrypoint: "SkillWorkflow",
		triggers: ["operator", "skill_schedule"],
		lifecycleState: "active",
		updatedAt: "2026-07-24T00:00:00.000Z",
		operatorSurface: {
			namespace: "skills",
			runTool: "run_skill_workflow",
			statusTool: "get_skill_workflow_status",
			historyTool: "list_skill_workflow_history",
			revisionsTool: "list_skill_workflow_revisions",
			mutationMode: "governed_skill_revision",
			mutationTool: "propose_skill_workflow_improvement",
		},
	});
	const checkedAt = "2026-07-24T01:00:00.000Z";

	it("keeps missing history unknown instead of inventing a failure", () => {
		const health = deriveWorkflowDefinitionHealth(dynamicDefinition, {
			surfaceAvailable: true,
			checkedAt,
			latestRun: null,
		});

		expect(WorkflowDefinitionHealthSchema.parse(health)).toMatchObject({
			healthStatus: "unknown",
			driftStatus: "unobserved",
			notes: ["no_durable_run_evidence"],
		});
	});

	it("marks a completed current revision healthy", () => {
		const health = deriveWorkflowDefinitionHealth(dynamicDefinition, {
			surfaceAvailable: true,
			checkedAt,
			latestRun: {
				id: "run-12",
				status: "completed",
				startedAt: "2026-07-24T00:30:00.000Z",
				completedAt: "2026-07-24T00:31:00.000Z",
				observedRevision: 12,
				lastReconciledAt: "2026-07-24T00:31:01.000Z",
				source: "skill_runs_snapshot",
			},
		});

		expect(health).toMatchObject({
			healthStatus: "healthy",
			driftStatus: "in_sync",
		});
	});

	it("surfaces an edited but unexecuted revision as attention", () => {
		const health = deriveWorkflowDefinitionHealth(dynamicDefinition, {
			surfaceAvailable: true,
			checkedAt,
			latestRun: {
				id: "run-11",
				status: "completed",
				startedAt: "2026-07-23T00:00:00.000Z",
				completedAt: "2026-07-23T00:01:00.000Z",
				observedRevision: 11,
				lastReconciledAt: null,
				source: "skill_runs_snapshot",
			},
		});

		expect(health).toMatchObject({
			healthStatus: "attention",
			driftStatus: "unexecuted_revision",
			notes: ["current_revision_not_yet_observed"],
		});
	});

	it("treats an unavailable binding as degraded with direct evidence", () => {
		const health = deriveWorkflowDefinitionHealth(staticDefinition, {
			surfaceAvailable: false,
			checkedAt,
			latestRun: null,
		});

		expect(health).toMatchObject({
			healthStatus: "degraded",
			driftStatus: "missing_execution_surface",
			executionSurface: {
				kind: "platform_workflow_binding",
				available: false,
			},
		});
	});

	it("requests outcome inspection for failed evidence instead of claiming incorrectness", () => {
		const health = deriveWorkflowDefinitionHealth(dynamicDefinition, {
			surfaceAvailable: true,
			checkedAt,
			latestRun: {
				id: "run-failed",
				status: "failed",
				startedAt: "2026-07-24T00:00:00.000Z",
				completedAt: "2026-07-24T00:01:00.000Z",
				observedRevision: 12,
				lastReconciledAt: null,
				source: "skill_runs_snapshot",
			},
		});

		expect(health).toMatchObject({
			healthStatus: "attention",
			driftStatus: "in_sync",
			notes: ["latest_terminal_outcome_needs_inspection"],
		});
	});
});

describe("workflow ledger history", () => {
	it("reads and filters historical types without exposing a retired executable", async () => {
		const historicalType = "retired_fixture_workflow";
		const contract = workflowsContract.listRuns["~orpc"];
		const input = await contract.inputSchemas[0]!["~standard"].validate({
			workflowType: historicalType,
		});
		expect(input.issues).toBeUndefined();
		const output = await contract.outputSchemas[0]!["~standard"].validate({
			runs: [
				{
					id: "historical-receipt",
					workflowType: historicalType,
					workflowId: "historical-instance",
					trigger: "operator",
					target: null,
					status: "completed",
					startedAt: "2026-01-01T00:00:00.000Z",
					completedAt: "2026-01-01T00:01:00.000Z",
					totalCount: 1,
					successCount: 1,
					errorCount: 0,
					output: null,
					error: null,
				},
			],
		});
		expect(output.issues).toBeUndefined();
		expect(WorkflowTypeSchema.safeParse(historicalType).success).toBe(false);
		const empty = await contract.inputSchemas[0]!["~standard"].validate({
			workflowType: "",
		});
		expect(empty.issues).toBeDefined();
	});
});
