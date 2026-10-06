// Skill, Skill Workshop, and executable skill-workflow tool specs, plus the
// rpc-endpoint structured-output schema map consumed by buildTediTool.
import { skillsContract } from "@tedix/api-contract/contracts/cognitive";
import { cognitiveRuntimeContract } from "@tedix/api-contract/contracts/cognitive-runtime";
import { learningFeedbackContract } from "@tedix/api-contract/contracts/learning-feedback";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { RecordArtifactInputSchema } from "@tedix/api-contract/schemas/cognitive-runtime";
import type {
	ToolInputJsonSchema,
	ToolJsonSchema,
} from "@tedix/api-contract/schemas/tools";
import {
	procedureInputSchema,
	procedureOutputSchema,
} from "@tedix/api-contract/utils/procedure-schemas";
import {
	zodToStructuredOutputJsonSchema,
	zodToToolInputJsonSchema,
} from "@tedix/api-contract/utils/tool-json-schema";
import {
	DESTRUCTIVE,
	MUTATING,
	READ_ONLY,
	type TediToolSpec,
	withoutTediId,
} from "./aggregate-tedis-shared";

const RECORD_ARTIFACT_SCHEMA = zodToToolInputJsonSchema(
	RecordArtifactInputSchema.omit({ tediId: true }),
);

// Binds skills/runWorkflowHistory output: { runs: SkillRunSummary[] } with
// skillSlug/status/startedAt/completedAt per run. Status stays the raw enum
// (queued/running/paused/completed/failed/canceled); DataTable badge format
// humanizes and colors it.
const SKILL_WORKFLOW_HISTORY_LAYOUT_SPEC: Record<string, JsonValue> = {
	root: "shell",
	elements: {
		shell: {
			type: "Stack",
			props: { gap: 4 },
			children: ["summary", "runs"],
		},
		summary: {
			type: "KeyValuePanel",
			props: {
				variant: "plain",
				columns: 1,
				items: [
					{ label: "Runs shown", value: { $state: "/json/runs/length" } },
				],
			},
			children: [],
		},
		runs: {
			type: "DataTable",
			props: {
				data: { $state: "/json/runs" },
				columns: [
					{
						field: "skillSlug",
						header: "Skill",
						format: "text",
						sortable: true,
					},
					{
						field: "status",
						header: "Status",
						format: "badge",
						sortable: true,
					},
					{
						field: "startedAt",
						header: "Started",
						format: "date",
						sortable: true,
					},
					{
						field: "completedAt",
						header: "Finished",
						format: "date",
						sortable: true,
					},
				],
			},
			children: [],
		},
	},
};

// Binds skills/runWorkflowStatus output: one SkillRun. Leads with status and
// timing, then what the run produced (result.published.artifactId when the
// workflow published a deliverable) or the error text when it needs attention.
const SKILL_WORKFLOW_STATUS_LAYOUT_SPEC: Record<string, JsonValue> = {
	root: "shell",
	elements: {
		shell: {
			type: "Stack",
			props: { gap: 4 },
			children: ["summary", "outcome"],
		},
		summary: {
			type: "KeyValuePanel",
			props: {
				variant: "plain",
				columns: 3,
				items: [
					{ label: "Status", value: { $state: "/json/status" } },
					{ label: "Started", value: { $state: "/json/startedAt" } },
					{ label: "Finished", value: { $state: "/json/completedAt" } },
				],
			},
			children: [],
		},
		outcome: {
			type: "KeyValuePanel",
			props: {
				variant: "plain",
				columns: 1,
				items: [
					{
						label: "Published deliverable",
						value: { $state: "/json/result/published/artifactId" },
						description: "Filled in when the run published its result.",
					},
					{
						label: "What went wrong",
						value: { $state: "/json/error" },
						description: "Filled in when the run needs attention.",
					},
				],
			},
			children: [],
		},
	},
};

export const READ_SKILL_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		id: { type: "string" },
		slug: { type: "string" },
	},
	additionalProperties: false,
};

export const READ_RESOURCE_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		uri: { type: "string" },
	},
	required: ["uri"],
	additionalProperties: false,
};

export const LIST_SKILLS_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		limit: { type: "number", minimum: 1, maximum: 50 },
		appId: { type: "string" },
		appSlug: { type: "string" },
		lifecycleState: {
			type: "string",
			enum: ["draft", "active", "proven", "crystallized", "stale", "archived"],
		},
	},
	additionalProperties: false,
};

const RUN_SKILL_WORKFLOW_SCHEMA: ToolInputJsonSchema = withoutTediId(
	zodToToolInputJsonSchema(procedureInputSchema(skillsContract.runWorkflow)),
);

const DRAFT_SKILL_PROPERTIES: NonNullable<ToolInputJsonSchema["properties"]> = {
	title: { type: "string" },
	description: { type: "string" },
	content: { type: "string" },
	summary: { type: "string" },
	files: { type: "object", additionalProperties: { type: "string" } },
	appId: { type: "string" },
	appSlug: { type: "string" },
	toolSlugs: {
		type: "array",
		items: { type: "string" },
		description:
			"App tool slugs. SKILL.md metadata.io.modelcontextprotocol/tools is also parsed.",
	},
};

const VALIDATE_SKILL_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		id: { type: "string" },
		slug: { type: "string" },
		...DRAFT_SKILL_PROPERTIES,
	},
	additionalProperties: false,
};

const PREVIEW_SKILL_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		id: { type: "string" },
		slug: { type: "string" },
		domain: { type: "string" },
		inputSchema: { type: "object", additionalProperties: true },
		visibility: { type: "string", enum: ["private", "shared", "org"] },
		agentSkillsFormat: { type: "string" },
		r2Path: { type: "string" },
		toolIds: {
			anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }],
		},
		tags: {
			anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }],
		},
		audience: { type: "array", items: { type: "string" } },
		preconditions: {
			type: "object",
			properties: {
				requires: { type: "array", items: { type: "string" } },
				notWhen: { type: "array", items: { type: "string" } },
				validUntil: { type: "string" },
				staleSince: { type: "string" },
			},
			additionalProperties: false,
		},
		lifecycleState: {
			type: "string",
			enum: ["draft", "active", "proven", "crystallized", "stale", "archived"],
		},
		...DRAFT_SKILL_PROPERTIES,
	},
	additionalProperties: false,
};

const REPAIR_SKILL_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		id: { type: "string" },
		slug: { type: "string" },
		dryRun: { type: "boolean" },
	},
	additionalProperties: false,
};

const PROMOTE_SKILL_SCHEMA: ToolInputJsonSchema = zodToToolInputJsonSchema(
	procedureInputSchema(skillsContract.promote),
);

const LIST_PROMOTION_CANDIDATES_SCHEMA: ToolInputJsonSchema = (() => {
	const schema = zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.listPromotionCandidates),
	);
	return withoutTediId(schema);
})();

const PROPOSE_SKILL_SCHEMA: ToolInputJsonSchema = (() => {
	const schema = zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.proposeWorkshop),
	);
	return withoutTediId(schema);
})();

const MINE_SKILL_CANDIDATES_SCHEMA: ToolInputJsonSchema = (() => {
	const schema = zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.mineCandidates),
	);
	return withoutTediId(schema);
})();

const GET_SKILL_PORTFOLIO_BALANCE_SCHEMA: ToolInputJsonSchema = (() => {
	const schema = zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.portfolioBalance),
	);
	// Always org-wide through the aggregate: org-scoped skills have no tediId
	// and a tedi filter would silently miss them (see the WS6 portfolio metric).
	return withoutTediId(schema);
})();

const PROPOSE_SKILL_WORKFLOW_IMPROVEMENT_SCHEMA: ToolInputJsonSchema = (() => {
	const schema = zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.proposeWorkflowImprovement),
	);
	return withoutTediId(schema);
})();

const INSPECT_SKILL_WORKFLOW_IMPROVEMENT_SCHEMA: ToolInputJsonSchema = (() => {
	const schema = zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.inspectWorkflowImprovement),
	);
	return withoutTediId(schema);
})();

const ACTIVATE_SKILL_WORKFLOW_IMPROVEMENT_SCHEMA: ToolInputJsonSchema =
	zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.activateWorkflowImprovement),
	);

const INSPECT_SKILL_PROPOSAL_SCHEMA: ToolInputJsonSchema =
	zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.inspectWorkshop),
	);

const REVISE_SKILL_PROPOSAL_SCHEMA: ToolInputJsonSchema =
	zodToToolInputJsonSchema(procedureInputSchema(skillsContract.reviseWorkshop));

const APPLY_SKILL_PROPOSAL_SCHEMA: ToolInputJsonSchema =
	zodToToolInputJsonSchema(procedureInputSchema(skillsContract.applyWorkshop));

const REJECT_SKILL_PROPOSAL_SCHEMA: ToolInputJsonSchema =
	zodToToolInputJsonSchema(procedureInputSchema(skillsContract.rejectWorkshop));

const QUARANTINE_SKILL_PROPOSAL_SCHEMA: ToolInputJsonSchema =
	zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.quarantineWorkshop),
	);

const AUDIT_LOW_QUALITY_SKILLS_SCHEMA: ToolInputJsonSchema = (() => {
	const schema = zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.auditLowQuality),
	);
	return withoutTediId(schema);
})();

const AUDIT_SKILL_TOOL_COVERAGE_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		appId: { type: "string" },
		appSlug: { type: "string" },
		limit: { type: "number", minimum: 1, maximum: 500 },
		summary: { type: "boolean" },
	},
	additionalProperties: false,
};

const SKILL_RUN_ID_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		runId: { type: "string" },
	},
	required: ["runId"],
	additionalProperties: false,
};

const SKILL_WORKFLOW_HISTORY_SCHEMA: ToolInputJsonSchema = withoutTediId(
	zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.runWorkflowHistory),
	),
);

const SKILL_WORKFLOW_RETRY_CANDIDATES_SCHEMA: ToolInputJsonSchema =
	zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.listWorkflowRetryCandidates),
	);

const SKILL_LIST_ORG_SCHEMA: ToolInputJsonSchema = withoutTediId(
	zodToToolInputJsonSchema(procedureInputSchema(skillsContract.listByOrg)),
);

const SKILL_WORKFLOW_CANCEL_SCHEMA: ToolInputJsonSchema = withoutTediId(
	zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.runWorkflowCancel),
	),
);

const SKILL_WORKFLOW_INSPECT_SCHEMA: ToolInputJsonSchema = withoutTediId(
	zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.inspectWorkflowRun),
	),
);

const SKILL_WORKFLOW_STEPS_SCHEMA: ToolInputJsonSchema = withoutTediId(
	zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.listWorkflowSteps),
	),
);

const SKILL_WORKFLOW_TOOL_CALLS_SCHEMA: ToolInputJsonSchema = withoutTediId(
	zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.listWorkflowToolCalls),
	),
);

const SKILL_WORKFLOW_REVISIONS_SCHEMA: ToolInputJsonSchema = withoutTediId(
	zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.listWorkflowRevisions),
	),
);

const SKILL_WORKFLOW_REVISION_SCHEMA: ToolInputJsonSchema = withoutTediId(
	zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.getWorkflowRevision),
	),
);

const SKILL_WORKFLOW_COMPARE_REVISIONS_SCHEMA: ToolInputJsonSchema =
	withoutTediId(
		zodToToolInputJsonSchema(
			procedureInputSchema(skillsContract.compareWorkflowRevisions),
		),
	);

const SKILL_WORKFLOW_RELIABILITY_SCHEMA: ToolInputJsonSchema = withoutTediId(
	zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.getWorkflowReliability),
	),
);
const SKILL_WORKFLOW_SCHEDULES_SCHEMA: ToolInputJsonSchema = withoutTediId(
	zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.listWorkflowSchedules),
	),
);

const SKILL_WORKFLOW_PAUSE_SCHEMA: ToolInputJsonSchema = withoutTediId(
	zodToToolInputJsonSchema(procedureInputSchema(skillsContract.pauseWorkflow)),
);

const SKILL_WORKFLOW_RESUME_SCHEMA: ToolInputJsonSchema = withoutTediId(
	zodToToolInputJsonSchema(procedureInputSchema(skillsContract.resumeWorkflow)),
);

const SKILL_WORKFLOW_RESTART_SCHEMA: ToolInputJsonSchema = withoutTediId(
	zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.restartWorkflow),
	),
);

const SKILL_WORKFLOW_APPROVE_SCHEMA: ToolInputJsonSchema = withoutTediId(
	zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.approveWorkflow),
	),
);

const SKILL_WORKFLOW_REJECT_SCHEMA: ToolInputJsonSchema = withoutTediId(
	zodToToolInputJsonSchema(procedureInputSchema(skillsContract.rejectWorkflow)),
);

const SKILL_WORKFLOW_EVENT_SCHEMA: ToolInputJsonSchema = withoutTediId(
	zodToToolInputJsonSchema(
		procedureInputSchema(skillsContract.runWorkflowSendEvent),
	),
);

const SKILL_RUN_ARTIFACT_LIST_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		runId: { type: "string" },
		skillId: { type: "string" },
		limit: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
		offset: { type: "integer", minimum: 0, default: 0 },
	},
	required: ["runId"],
	additionalProperties: false,
};

const SKILL_RUN_ARTIFACT_GET_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		runId: { type: "string" },
		path: { type: "string" },
		skillId: { type: "string" },
		mediaUrl: {
			type: "boolean",
			description:
				"Return a short-lived signed URL serving the decoded media (browser-viewable image/video) instead of raw base64-in-JSON content.",
		},
		mediaInline: {
			type: "boolean",
			description:
				"Return decoded media as mediaBase64 plus mediaMimeType for session-authenticated in-app rendering.",
		},
	},
	required: ["runId", "path"],
	additionalProperties: false,
};

export const SKILL_WORKFLOW_OUTPUT_SCHEMAS: Record<
	string,
	ToolJsonSchema | null
> = {
	"cognitiveRuntime/recordArtifact": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(cognitiveRuntimeContract.recordArtifact),
	),
	"learningFeedback/recordInteraction": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(learningFeedbackContract.recordInteraction),
	),
	"learningFeedback/listInteractions": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(learningFeedbackContract.listInteractions),
	),
	"learningFeedback/attributeFeedback": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(learningFeedbackContract.attributeFeedback),
	),
	"learningFeedback/recordMeasurement": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(learningFeedbackContract.recordMeasurement),
	),
	"learningFeedback/getSummary": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(learningFeedbackContract.getSummary),
	),
	"learningFeedback/analyzeRecurringIssues": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(learningFeedbackContract.analyzeRecurringIssues),
	),
	"learningFeedback/proposeImprovement": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(learningFeedbackContract.proposeImprovement),
	),
	"learningFeedback/listImprovements": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(learningFeedbackContract.listImprovements),
	),
	"learningFeedback/evaluateImprovement": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(learningFeedbackContract.evaluateImprovement),
	),
	"skills/runWorkflow": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.runWorkflow),
	),
	"skills/runWorkflowStatus": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.runWorkflowStatus),
	),
	"skills/runWorkflowHistory": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.runWorkflowHistory),
	),
	"skills/listWorkflowRetryCandidates": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.listWorkflowRetryCandidates),
	),
	"skills/listByOrg": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.listByOrg),
	),
	"skills/inspectWorkflowRun": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.inspectWorkflowRun),
	),
	"skills/listWorkflowSteps": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.listWorkflowSteps),
	),
	"skills/listWorkflowToolCalls": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.listWorkflowToolCalls),
	),
	"skills/listWorkflowRevisions": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.listWorkflowRevisions),
	),
	"skills/getWorkflowRevision": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.getWorkflowRevision),
	),
	"skills/compareWorkflowRevisions": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.compareWorkflowRevisions),
	),
	"skills/getWorkflowReliability": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.getWorkflowReliability),
	),
	"skills/listWorkflowSchedules": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.listWorkflowSchedules),
	),
	"skills/runWorkflowCancel": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.runWorkflowCancel),
	),
	"skills/pauseWorkflow": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.pauseWorkflow),
	),
	"skills/resumeWorkflow": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.resumeWorkflow),
	),
	"skills/restartWorkflow": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.restartWorkflow),
	),
	"skills/approveWorkflow": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.approveWorkflow),
	),
	"skills/rejectWorkflow": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.rejectWorkflow),
	),
	"skills/runWorkflowSendEvent": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.runWorkflowSendEvent),
	),
	"skills/listRunArtifacts": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.listRunArtifacts),
	),
	"skills/getRunArtifact": zodToStructuredOutputJsonSchema(
		procedureOutputSchema(skillsContract.getRunArtifact),
	),
};

export const SKILL_WORKFLOW_TOOLS: TediToolSpec[] = [
	{
		name: "record_artifact",
		remoteName: "record_artifact",
		description:
			"Publish an openable, tedi-owned artifact with an optional inline body. Ownership is injected from this tedi namespace.",
		inputSchema: RECORD_ARTIFACT_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "cognitiveRuntime/recordArtifact",
		allowExplicitTediId: false,
	},
	{
		name: "propose_skill_workflow_improvement",
		remoteName: "propose_skill_workflow_improvement",
		description:
			"Create a validated draft workflow revision grounded in an observed terminal run. The tedi may test it but cannot activate it.",
		inputSchema: PROPOSE_SKILL_WORKFLOW_IMPROVEMENT_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "skills/proposeWorkflowImprovement",
		// Validates the full workflow source at write time — a large source can
		// exceed the silent 15s rpc default.
		timeout: 120000,
	},
	{
		name: "inspect_skill_workflow_improvement",
		remoteName: "inspect_skill_workflow_improvement",
		description:
			"Inspect workflow improvement provenance, validation, baseline drift, and activation requirements.",
		inputSchema: INSPECT_SKILL_WORKFLOW_IMPROVEMENT_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/inspectWorkflowImprovement",
	},
	{
		name: "activate_skill_workflow_improvement",
		remoteName: "activate_skill_workflow_improvement",
		description:
			"Human-only activation of a workflow revision after a completed candidate run reports passing correctness certification.",
		inputSchema: ACTIVATE_SKILL_WORKFLOW_IMPROVEMENT_SCHEMA,
		annotations: DESTRUCTIVE,
		rpcEndpoint: "skills/activateWorkflowImprovement",
	},
	{
		name: "propose_skill",
		remoteName: "propose_skill",
		description:
			"Create a tedi-scoped Skill Workshop proposal. Stored as draft until applied.",
		inputSchema: PROPOSE_SKILL_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "skills/proposeWorkshop",
	},
	{
		name: "mine_skill_candidates",
		remoteName: "mine_skill_candidates",
		description:
			"Deterministically mine recurring successful tool-call routines from evidence-linked episodes into draft Skill Workshop proposals (never auto-applied).",
		inputSchema: MINE_SKILL_CANDIDATES_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "skills/mineCandidates",
		// Mining scans a bounded evidence window and routinely exceeds the generic
		// 15s RPC deadline even when its indexed query completes successfully.
		timeout: 120000,
	},
	{
		name: "get_skill_portfolio_balance",
		remoteName: "get_skill_portfolio_balance",
		description:
			"Pace-layer distribution of the skill portfolio (innovation/differentiation/record) vs the ~75/20/5 healthy envelope, with a mechanical stagnation flag (all-innovation or all-record). Org-wide.",
		inputSchema: GET_SKILL_PORTFOLIO_BALANCE_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/portfolioBalance",
		// Org-wide read: injecting the selected tedi's id would silently drop
		// org-scoped skills (tediId NULL) from the distribution.
		includeTediIdParam: false,
	},
	{
		name: "inspect_skill_proposal",
		remoteName: "inspect_skill_proposal",
		description:
			"Inspect a Skill Workshop proposal without mutation, including validation and promotion blockers.",
		inputSchema: INSPECT_SKILL_PROPOSAL_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/inspectWorkshop",
	},
	{
		name: "revise_skill_proposal",
		remoteName: "revise_skill_proposal",
		description:
			"Revise a pending Skill Workshop proposal in place while keeping it draft.",
		inputSchema: REVISE_SKILL_PROPOSAL_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "skills/reviseWorkshop",
	},
	{
		name: "apply_skill_proposal",
		remoteName: "apply_skill_proposal",
		description:
			"Disposer-separated: apply a general Skill Workshop proposal into the baseline org skill library. Passes for a human/operator API key, or for a tedi that is NOT the proposal's authoring identity; self-approval by the proposer is mechanically rejected.",
		inputSchema: APPLY_SKILL_PROPOSAL_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "skills/applyWorkshop",
	},
	{
		name: "reject_skill_proposal",
		remoteName: "reject_skill_proposal",
		description:
			"Reject a Skill Workshop proposal and archive it with an explicit reason.",
		inputSchema: REJECT_SKILL_PROPOSAL_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "skills/rejectWorkshop",
	},
	{
		name: "quarantine_skill_proposal",
		remoteName: "quarantine_skill_proposal",
		description:
			"Quarantine a risky Skill Workshop proposal by marking it stale with an explicit reason.",
		inputSchema: QUARANTINE_SKILL_PROPOSAL_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "skills/quarantineWorkshop",
	},
	{
		name: "validate_skill",
		remoteName: "validate_skill",
		description:
			"Validate an existing or draft skill without mutating stored skills.",
		inputSchema: VALIDATE_SKILL_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/validate",
	},
	{
		name: "preview_skill",
		remoteName: "preview_skill",
		description:
			"Preview rendered skill metadata, URI, index entry, and diagnostics without writing.",
		inputSchema: PREVIEW_SKILL_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/preview",
	},
	{
		name: "audit_skill_tool_coverage",
		remoteName: "audit_skill_tool_coverage",
		description:
			"Audit whether skills cover app tools, MCP tool metadata resolves, and read-only tools have outputSchema.",
		inputSchema: AUDIT_SKILL_TOOL_COVERAGE_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/auditToolCoverage",
	},
	{
		name: "audit_low_quality_skills",
		remoteName: "audit_low_quality_skills",
		description:
			"Audit low-quality or auto-crystallized skills. Defaults to this tedi's tedi-scoped working set; archive mode requires explicit input.",
		inputSchema: AUDIT_LOW_QUALITY_SKILLS_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "skills/auditLowQuality",
	},
	{
		name: "repair_skill",
		remoteName: "repair_skill",
		description:
			"Repair one stored skill. Defaults to dryRun=true for non-mutating diagnostics.",
		inputSchema: REPAIR_SKILL_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "skills/repair",
	},
	{
		name: "promote_skill",
		remoteName: "promote_skill",
		description:
			"Human-only when applying: promote a tedi-scoped candidate into the baseline org skill library. Defaults to dryRun=true.",
		inputSchema: PROMOTE_SKILL_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "skills/promote",
	},
	{
		name: "list_promotion_candidates",
		remoteName: "list_promotion_candidates",
		description:
			"List tedi-scoped skill candidates for org-library promotion review.",
		inputSchema: LIST_PROMOTION_CANDIDATES_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/listPromotionCandidates",
	},
	{
		name: "run_skill_workflow",
		remoteName: "run_skill_workflow",
		description:
			"Start an executable workflow attached to one of this tedi's skills.",
		inputSchema: RUN_SKILL_WORKFLOW_SCHEMA,
		annotations: DESTRUCTIVE,
		rpcEndpoint: "skills/runWorkflow",
	},
	{
		name: "get_skill_workflow_status",
		remoteName: "get_skill_workflow_status",
		description: "Read status, output, and error information for a skill run.",
		inputSchema: SKILL_RUN_ID_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/runWorkflowStatus",
		layoutId: "skill-workflow-run-status",
		layoutSpec: SKILL_WORKFLOW_STATUS_LAYOUT_SPEC,
		widgetDescription:
			"Where one skill run stands: its current status, when it started and finished, what it published, and anything that needs attention.",
	},
	{
		name: "list_skill_workflow_history",
		remoteName: "list_skill_workflow_history",
		description:
			"List recent executable skill workflow runs for this tedi as compact timeline summaries.",
		inputSchema: SKILL_WORKFLOW_HISTORY_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/runWorkflowHistory",
		layoutId: "skill-workflow-history",
		layoutSpec: SKILL_WORKFLOW_HISTORY_LAYOUT_SPEC,
		widgetDescription:
			"Recent skill workflow runs for this tedi, showing which skill ran, how each run went, and when it started and finished.",
	},
	{
		name: "list_skill_workflow_retry_candidates",
		remoteName: "list_skill_workflow_retry_candidates",
		description:
			"List failed workflow runs whose canonical engine state was reconciled and is eligible for an epoch-bound restart. Use this inbox instead of inferring retries from generic history.",
		inputSchema: SKILL_WORKFLOW_RETRY_CANDIDATES_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/listWorkflowRetryCandidates",
	},
	{
		name: "list_org_skills",
		remoteName: "list_org_skills",
		description:
			"List ALL of this organization's skills — including org-scoped rows (tediId null) that list_skills cannot see. Built for workflow-sandbox analytics: the flow-ephemeral adoption cohort is org-scoped, so it is countable only through this org-wide lens. Pass summary:true for compact rows (content becomes a marked preview, files null) and filter tags client-side.",
		inputSchema: SKILL_LIST_ORG_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/listByOrg",
	},
	{
		name: "inspect_skill_workflow_run",
		remoteName: "inspect_skill_workflow_run",
		description:
			"Inspect one workflow run with pinned revision hashes, artifact inventory, durable step attempts, and MCP tool-call receipts.",
		inputSchema: SKILL_WORKFLOW_INSPECT_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/inspectWorkflowRun",
	},
	{
		name: "list_skill_workflow_steps",
		remoteName: "list_skill_workflow_steps",
		description:
			"List durable workflow step attempts, retries, rollbacks, sleeps, and event waits for one run.",
		inputSchema: SKILL_WORKFLOW_STEPS_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/listWorkflowSteps",
	},
	{
		name: "list_skill_workflow_tool_calls",
		remoteName: "list_skill_workflow_tool_calls",
		description:
			"List MCP tool-call receipts, stable step identity, attempts, and idempotency keys for one workflow run.",
		inputSchema: SKILL_WORKFLOW_TOOL_CALLS_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/listWorkflowToolCalls",
	},
	{
		name: "list_skill_workflow_revisions",
		remoteName: "list_skill_workflow_revisions",
		description:
			"List distinct workflow revisions observed on executed runs, including pinned workflow and SKILL.md SHA-256 digests.",
		inputSchema: SKILL_WORKFLOW_REVISIONS_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/listWorkflowRevisions",
	},
	{
		name: "get_skill_workflow_revision",
		remoteName: "get_skill_workflow_revision",
		description:
			"Read the pinned workflow source and SKILL.md revision from one executed run.",
		inputSchema: SKILL_WORKFLOW_REVISION_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/getWorkflowRevision",
	},
	{
		name: "compare_skill_workflow_revisions",
		remoteName: "compare_skill_workflow_revisions",
		description:
			"Compare pinned workflow and SKILL.md revisions from two executed runs.",
		inputSchema: SKILL_WORKFLOW_COMPARE_REVISIONS_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/compareWorkflowRevisions",
	},
	{
		name: "get_skill_workflow_reliability",
		remoteName: "get_skill_workflow_reliability",
		description:
			"Aggregate bounded recent run outcomes, durations, retries, rollbacks, tool calls, and failing steps.",
		inputSchema: SKILL_WORKFLOW_RELIABILITY_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/getWorkflowReliability",
	},
	{
		name: "list_skill_workflow_schedules",
		remoteName: "list_skill_workflow_schedules",
		description:
			"List this tedi's manifest-owned automation schedules, optionally narrowed by skill id or slug.",
		inputSchema: SKILL_WORKFLOW_SCHEDULES_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/listWorkflowSchedules",
	},
	{
		name: "cancel_skill_workflow",
		remoteName: "cancel_skill_workflow",
		description: "Cancel an active skill run.",
		inputSchema: SKILL_WORKFLOW_CANCEL_SCHEMA,
		annotations: DESTRUCTIVE,
		rpcEndpoint: "skills/runWorkflowCancel",
	},
	{
		name: "pause_skill_workflow",
		remoteName: "pause_skill_workflow",
		description: "Pause an active skill run at a durable boundary.",
		inputSchema: SKILL_WORKFLOW_PAUSE_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "skills/pauseWorkflow",
	},
	{
		name: "resume_skill_workflow",
		remoteName: "resume_skill_workflow",
		description: "Resume a paused skill run.",
		inputSchema: SKILL_WORKFLOW_RESUME_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "skills/resumeWorkflow",
	},
	{
		name: "restart_skill_workflow",
		remoteName: "restart_skill_workflow",
		description:
			"Restart a skill run from the beginning or a named execution-engine step occurrence. For an ambiguous pending/unknown receipt, an operator may set abortUnknown=true with a reason after verifying its reserved epoch never started; Tedix burns that exact epoch as a canceled submission/run without invoking the engine, retries must reuse the exact restartId/from/reason, and the retired engine instance cannot be restarted again—start a new runId.",
		inputSchema: SKILL_WORKFLOW_RESTART_SCHEMA,
		annotations: DESTRUCTIVE,
		rpcEndpoint: "skills/restartWorkflow",
	},
	{
		name: "approve_skill_workflow",
		remoteName: "approve_skill_workflow",
		description: "Approve a skill run human-in-the-loop checkpoint.",
		inputSchema: SKILL_WORKFLOW_APPROVE_SCHEMA,
		annotations: DESTRUCTIVE,
		rpcEndpoint: "skills/approveWorkflow",
	},
	{
		name: "reject_skill_workflow",
		remoteName: "reject_skill_workflow",
		description: "Reject a skill run human-in-the-loop checkpoint.",
		inputSchema: SKILL_WORKFLOW_REJECT_SCHEMA,
		annotations: DESTRUCTIVE,
		rpcEndpoint: "skills/rejectWorkflow",
	},
	{
		name: "send_skill_workflow_event",
		remoteName: "send_skill_workflow_event",
		description:
			"Deliver a typed event to an executable skill workflow awaiting step.waitForEvent.",
		inputSchema: SKILL_WORKFLOW_EVENT_SCHEMA,
		annotations: DESTRUCTIVE,
		rpcEndpoint: "skills/runWorkflowSendEvent",
	},
	{
		name: "list_skill_run_artifacts",
		remoteName: "list_skill_run_artifacts",
		description: "List artifacts produced by an executable skill workflow run.",
		inputSchema: SKILL_RUN_ARTIFACT_LIST_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/listRunArtifacts",
	},
	{
		name: "get_skill_run_artifact",
		remoteName: "get_skill_run_artifact",
		description:
			"Read one artifact produced by an executable skill workflow run.",
		inputSchema: SKILL_RUN_ARTIFACT_GET_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "skills/getRunArtifact",
	},
];
