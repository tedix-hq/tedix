/**
 * Sample tedis, skills, workflows, schedules, rationales, knowledge and
 * expertise.
 */

import type { SkillEntry } from "@tedix/api-contract/contracts/cognitive";
import {
	APP_STOREFRONT,
	CONVERSATION_HOME,
	fid,
	HOME_RUN_DONE,
	ORG_ID,
	RUN_CHURN_FAILED,
	RUN_REVENUE_LIVE,
	RUN_REVENUE_OK,
	SKILL_BRIEF,
	SKILL_CHURN,
	SKILL_REVENUE,
	SKILL_TRIAGE,
	type SkillRunRow,
	T0,
	T1,
	T2,
	T3,
	T4,
	T5,
	TEDI_JUNO,
	TEDI_MILES,
	TEDI_NOVA,
} from "./core";

// ---------------------------------------------------------------------------
// Read-only fixtures
// ---------------------------------------------------------------------------

const tediRow = (
	id: string,
	name: string,
	slug: string,
	displayName: string,
	personality: string,
) => ({
	id,
	organizationId: ORG_ID,
	ownerUserId: "dev-operator",
	scope: "organization" as const,
	name,
	slug,
	displayName,
	descopeUserId: null,
	descopeMcpResourceId: null,
	externalRef: null,
	tags: ["local-fixture"],
	personality,
	avatar: null,
	timezone: "America/Mexico_City",
	language: "en",
	installedSkills: null,
	installedPlugins: null,
	status: "active" as const,
	billingState: "active" as const,
	workerName: null,
	r2BucketName: null,
	runtimeState: "active" as const,
	lastActivityAt: T5,
	runtimeStatus: "running" as const,
	runtimeKind: "agent" as const,
	isolateAgentId: null,
	lastSeenAt: T5,
	lastSyncAt: T4,
	createdAt: T0,
	updatedAt: T5,
});

/** Inline marks so the fixture lane renders avatars without a network. */
export const svgAvatar = (background: string, glyph: string): string =>
	`data:image/svg+xml,${encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${background}"/><text x="32" y="42" font-family="sans-serif" font-size="30" font-weight="700" text-anchor="middle" fill="#fff">${glyph}</text></svg>`,
	)}`;
export const NOVA_AVATAR = svgAvatar("#4f46e5", "N");
/** A bare brand glyph with no background, as agent marks usually ship. */
export const AGENT_AVATAR = `data:image/svg+xml,${encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text x="32" y="50" font-family="serif" font-size="52" font-weight="700" text-anchor="middle" fill="#0a0a0a">I</text></svg>',
)}`;

export const TEDIS = [
	{
		...tediRow(TEDI_NOVA, "nova", "nova", "Nova", "Calm ops coordinator"),
		descopeUserId: "tedi-nova",
		avatar: NOVA_AVATAR,
	},
	tediRow(
		TEDI_MILES,
		"miles",
		"miles",
		"Miles",
		"Numbers-first revenue analyst",
	),
	tediRow(TEDI_JUNO, "juno", "juno", "Juno", "Warm support concierge"),
];

/**
 * One entrustable activity + the applied grant over it. Modeled with a real
 * grant (not an empty array) because the OS authority surface's whole job is
 * showing what a tedi may ACTUALLY do — a lane that only ever renders the
 * empty state never exercises the scope, expiry, or review evidence.
 */
const entrustableActivity = (tediId: string) => ({
	id: fid("74", 1),
	organizationId: ORG_ID,
	key: "publish_revenue_summary",
	version: 2,
	supersedesId: null,
	roleTemplateId: null,
	name: "Publish the weekly revenue summary",
	description:
		"Reconcile orders against the ledger and publish the weekly summary.",
	status: "active" as const,
	taskFamily: "reporting",
	riskLevel: "medium" as const,
	maximumLevel: "execute_reviewed" as const,
	actionPatterns: ["reports.publish", "orders.read"],
	toolIds: ["list_orders", "publish_report"],
	rubric: { criteria: ["ledger reconciled", "owner-readable summary"] },
	rubricHash: `rubric-${tediId.slice(0, 8)}`,
	evidencePolicy: {
		minimumVerifiedObservations: 3,
		minimumDistinctVerifierPrincipals: 2,
		maximumFailureRate: 0.2,
		maximumPolicyViolationSeverity: 0,
		maximumEvidenceAgeDays: 90,
		requireNonTrivialWork: true,
		minimumReliabilityLowerBound: 0.5,
		minimumMeanComplexity: 0.25,
		minimumTaskFamilies: 1,
		minimumCalibrationScore: 0.7,
		minimumEscalationQuality: 0.7,
		requireLearningTransfer: false,
	},
	evidencePolicyHash: `evidence-${tediId.slice(0, 8)}`,
	createdAt: T0,
	updatedAt: T4,
});

const roleAssignment = (tediId: string) => ({
	id: fid("75", 1),
	organizationId: ORG_ID,
	tediId,
	roleTemplateId: null,
	roleKey: "revenue_analyst",
	roleName: "Revenue analyst",
	status: "active" as const,
	// Non-shadow stages require an applied decision and an evidence hash
	// (TediRoleAssignmentSchema.superRefine) — omitting either fails the parse.
	careerStage: "operator" as const,
	assignedAt: T0,
	stageChangedAt: T2,
	endedAt: null,
	revision: 2,
	lastDecisionId: fid("76", 1),
	evidenceSnapshotHash: `evidence-snapshot-${tediId.slice(0, 8)}`,
	metadata: null,
	createdAt: T0,
	updatedAt: T2,
});

export const delegationProfile = (tediId: string) => ({
	tediId,
	activeRole: roleAssignment(tediId),
	roleHistory: [roleAssignment(tediId)],
	validatedExperience: {
		formulaVersion: "validated-experience-v1" as const,
		descriptiveOnly: true as const,
		authorityEffect: "none" as const,
		provisional: true as const,
		limitations: ["Descriptive career progress only — never task authority"],
		points: 700,
		maxPoints: 3000 as const,
		validatedUnits: 7,
		uncappedUnits: 8.5,
		creditedOpportunities: 21,
		negativeOpportunities: 1,
		maximumPolicyViolationSeverity: 0,
		standing: "clear" as const,
		observationsEvaluated: 40,
		truncated: false,
		saturated: false,
		lastValidatedAt: T4,
		taskFamilies: [
			{
				taskFamily: "reporting",
				points: 300,
				maxPoints: 500 as const,
				validatedUnits: 3,
				uncappedUnits: 3.5,
				creditedOpportunities: 9,
				saturated: false,
			},
		],
	},
	delegationYield: {
		metric: "verified_value_per_owner_review_hour" as const,
		authorityEffect: "none" as const,
		measurementStatus: "partial" as const,
		provisional: true as const,
		coverage: "observed_issued_work_items_only" as const,
		observedOpportunities: 12,
		issuedOpportunities: 15,
		reviewedOpportunities: 10,
		valueCertifiedOpportunities: 6,
		ownerReviewMinutes: 120,
		valueByCurrency: [
			{
				currency: "MXN",
				verifiedValueMinorUnits: 2_500_000,
				ownerReviewMinutes: 120,
				valuePerOwnerReviewHourMinorUnits: 1_250_000,
			},
		],
		costByCurrency: [{ currency: "USD", costMinorUnits: 4200 }],
		truncated: false,
		limitations: ["Coverage limited to observed issued Work Items"],
	},
	entrustments: [
		{
			id: fid("77", 1),
			organizationId: ORG_ID,
			tediId,
			roleAssignmentId: fid("75", 1),
			activityId: fid("74", 1),
			level: "execute_reviewed" as const,
			status: "active" as const,
			scope: {
				actions: ["reports.publish", "orders.read"],
				toolIds: ["list_orders", "publish_report"],
				environments: ["production"],
				// budgetPolicyId must be present exactly when spendPermission is
				// policy_bound (EntrustmentScopeSchema.superRefine).
				spendPermission: "none" as const,
				budgetPolicyId: null,
				constraints: { maxRowsPerRead: 500 },
			},
			revision: 3,
			lastCertifiedAt: T4,
			expiresAt: null,
			nextReviewAt: "2026-09-12T08:30:00.000Z",
			restrictedAt: null,
			reason: null,
			lastDecisionId: fid("76", 1),
			activityVersion: 2,
			rubricHash: `rubric-${tediId.slice(0, 8)}`,
			evidencePolicyHash: `evidence-${tediId.slice(0, 8)}`,
			evidenceSnapshotHash: `evidence-snapshot-${tediId.slice(0, 8)}`,
			grantedByType: "user" as const,
			grantedById: "owner@tedix.dev",
			createdAt: T2,
			updatedAt: T4,
			effectiveStatus: "active" as const,
			activity: entrustableActivity(tediId),
		},
	],
});

export const operationsSummary = (
	tediId: string,
	taskTitle: string,
	rationaleAction: string,
) => ({
	tediId,
	delegationProfile: delegationProfile(tediId),
	pulse: {
		lastRationale: {
			id: fid("72", 1),
			action: rationaleAction,
			category: "optimization",
			confidence: 0.82,
			outcomeStatus: "success",
			createdAt: T4,
		},
		lastFactLearned: {
			id: fid("73", 1),
			summary: "Wholesale renewals convert 2x better with a Monday follow-up",
			factType: "observation",
			confidence: 0.77,
			source: "run://" + RUN_REVENUE_OK,
			createdAt: T2,
		},
		lastToolCall: { toolName: "list_orders", success: true, createdAt: T5 },
		decisionsLast24h: 6,
		factsLearnedLast24h: 3,
	},
	activeTasks: [
		{
			id: nextIdStable(tediId, 1),
			title: taskTitle,
			status: "in_progress",
			blocker: null,
		},
	],
	objectives: [
		{ id: nextIdStable(tediId, 2), status: "active", gateConfig: null },
	],
	growthMetrics: {
		facts: 128,
		avgConfidence: 0.82,
		skills: 14,
		avgRevision: 2.1,
		muscles: 5,
		avgUsage: 11.4,
		domains: 6,
		autonomyRate: 0.64,
		expertiseLevels: { reporting: "operator", support: "apprentice" },
	},
	crons: [
		{
			name: "brain-reflection",
			mechanism: "scheduled_skill_workflow" as const,
			lastRunId: RUN_REVENUE_OK,
			lastExecutedAt: T2,
			lastSuccess: true,
			executionsLast24h: 1,
			expectedIntervalHours: 24,
			overdue: false,
			state: "healthy" as const,
			budgetBlockedAt: null,
			budgetBlockedReason: null,
			budgetResetAt: null,
			budgetBlockActive: false,
			budgetAdmissionClass: null,
		},
	],
	recentRationales: [
		{
			id: fid("72", 2),
			action: rationaleAction,
			category: "optimization",
			outcomeStatus: "success",
			createdAt: T4,
		},
	],
	muscleCount: 5,
	completedObjectives: 2,
	approvalFatigueSignal: null,
});

/** Stable pseudo-ids for nested summary rows (no state, still deterministic). */
function nextIdStable(tediId: string, n: number): string {
	return `${tediId.slice(0, 8)}-task-${n}`;
}

const skillEntry = (
	id: string,
	tediId: string | null,
	title: string,
	slug: string,
	summary: string,
	lifecycleState: "draft" | "active" | "proven" | "crystallized",
	successCount: number,
	failureCount: number,
) => ({
	id,
	organizationId: ORG_ID,
	tediId,
	proposedByTediId: tediId,
	domainId: null,
	title,
	slug,
	description: summary,
	content: `# ${title}\n\n${summary}\n\n## Steps\n1. Gather inputs\n2. Execute\n3. Record evidence`,
	files: null,
	inputSchema: null,
	successCount,
	failureCount,
	lastUsedAt: T4,
	avgDurationMs: 42_000,
	revision: 3,
	revisionReasoning: null,
	supersedesId: null,
	sourceSkillId: null,
	sourceRevision: null,
	visibility: "org" as const,
	agentSkillsFormat: null,
	r2Path: null,
	appId: null,
	toolIds: null,
	summary,
	tags: ["revenue"],
	audience: null,
	preconditions: null,
	lifecycleState,
	reviewFlaggedAt: null,
	reviewFlagReason: null,
	paceLayer:
		lifecycleState === "draft"
			? ("innovation" as const)
			: ("differentiation" as const),
	createdAt: T0,
	updatedAt: T4,
});

export const SKILLS = [
	{
		...skillEntry(
			SKILL_REVENUE,
			TEDI_MILES,
			"Weekly revenue report",
			"weekly-revenue-report",
			"Assemble the weekly revenue summary sheet and narrative from order data.",
			"proven",
			18,
			1,
		),
		appId: APP_STOREFRONT,
	},
	skillEntry(
		SKILL_TRIAGE,
		TEDI_JUNO,
		"Inbox triage",
		"inbox-triage",
		"Classify inbound support email by SLA risk and draft first responses.",
		"active",
		44,
		3,
	),
	skillEntry(
		SKILL_CHURN,
		TEDI_MILES,
		"Churn watch",
		"churn-watch",
		"Scan renewal cohorts daily and flag accounts likely to lapse.",
		"draft",
		2,
		2,
	),
	skillEntry(
		SKILL_BRIEF,
		TEDI_NOVA,
		"Meeting brief",
		"meeting-brief",
		"Prepare a one-page brief before each owner sync.",
		"active",
		9,
		0,
	),
];

export const localSkillReactivations = new Map<
	string,
	{ revision: number; revisionReasoning: string | null }
>();

export function fixtureSkillEntry(entry: (typeof SKILLS)[number]) {
	// The revenue skill is the fixture's executable example: its saved
	// workflow source and declared params drive the overview's anatomy
	// section, matched against the fixture's recorded runs.
	const executable =
		entry.id === SKILL_REVENUE
			? {
					files: { "scripts/workflow.ts": LOCAL_WORKFLOW_SOURCE },
					inputSchema: {
						type: "object",
						properties: {
							period: {
								type: "string",
								description: "Reporting period to summarize",
							},
						},
						required: ["period"],
					} as SkillEntry["inputSchema"],
				}
			: {};
	const withWorkflow = { ...entry, ...executable };
	const reactivation = localSkillReactivations.get(entry.id);
	return reactivation
		? {
				...withWorkflow,
				...reactivation,
				lifecycleState: "active" as const,
				paceLayer: "differentiation" as const,
			}
		: withWorkflow;
}

/** The skills the revenue workspace's fixture schedule list starts with. */
export const FIXTURE_SCHEDULED_SKILLS = new Set([SKILL_REVENUE, SKILL_CHURN]);

/** Per-workspace skill links people add or remove in the fixture session. */
const fixtureSkillLinkState = new Map<
	string,
	{ added: Set<string>; removed: Set<string> }
>();

export function fixtureSkillLinks(workspaceId: string) {
	let links = fixtureSkillLinkState.get(workspaceId);
	if (!links) {
		links = { added: new Set(), removed: new Set() };
		fixtureSkillLinkState.set(workspaceId, links);
	}
	return links;
}

export const skillRunSummary = (run: SkillRunRow) => ({
	id: run.id,
	organizationId: ORG_ID,
	skillId: run.skillId,
	tediId: run.tediId,
	workflowInstanceId: `wf-${run.id.slice(0, 8)}`,
	runtimeEnvironment: "development" as const,
	lastReconciledAt: T5,
	executionEpoch: run.executionEpoch,
	restartRequestedAt: null,
	workflowRetiredAt: null,
	status: run.status,
	skillSlug: run.skillSlug,
	skillRevision: 3,
	startedAt: run.startedAt,
	completedAt: run.completedAt,
	pausedAt: null,
	createdBy: run.createdBy,
	hasResult: run.status === "completed",
	hasError: run.error !== null,
	outcome: run.status === "completed" ? ("delivered" as const) : null,
	workItemId: null,
});

export const runtimeProvenanceNulls = {
	workerVersionId: null,
	workerVersionTag: null,
	workerVersionTimestamp: null,
	executionCompatibilityHash: null,
	dispatchShimVersion: null,
	compatibilityDate: null,
	dynamicWorkflowsVersion: null,
	loaderConfigHash: null,
	tenantCpuMs: null,
	tenantSubRequests: null,
};

export const LOCAL_WORKFLOW_SOURCE = `export default {
	async run(event, step, env) {
		const period = event.payload?.period ?? "last_7_days";
		const orders = await step.do(
			"fetch-orders",
			{ retries: { limit: 2, delay: "1 second" }, timeout: "30 seconds" },
			async () => env.MCP.storefront.list_orders({ period }),
		);
		for (let i = 0; i < orders.items.length; i++) {
			await step.do(\`summarize-line-\${i}\`, async () => orders.items[i]);
		}
		await step.waitForEvent("publish-approval", {
			type: "approval",
			timeout: "24 hours",
		});
		await step.do(
			"publish-sheet",
			{ timeout: "1 minute" },
			async () => env.MCP.sheets.write_report({ orders }),
			{ rollback: async () => env.MCP.sheets.retract_report({}) },
		);
		return { published: true, certification: { passed: true }, orders };
	},
};
`;
type LocalSkillDraft = SkillEntry;
export const seedSkillDrafts = (): LocalSkillDraft[] => [
	{
		...SKILLS[0]!,
		id: fid("5d", 1),
		title: "weekly-revenue-report improvement 1",
		files: {
			"scripts/workflow.ts": LOCAL_WORKFLOW_SOURCE.replace(
				"published: true",
				"published: true, narrative: true",
			),
		},
		lifecycleState: "draft" as const,
		sourceSkillId: SKILLS[0]!.id,
		sourceRevision: SKILLS[0]!.revision,
		tags: ["workflow-improvement", `baseline-run:${RUN_REVENUE_OK}`],
		revisionReasoning: `Workflow improvement proposed from run ${RUN_REVENUE_OK} at baseline revision ${SKILLS[0]!.revision}. Add the narrative paragraph to the sheet.`,
	},
];
export let localSkillDrafts = seedSkillDrafts();

export function setLocalSkillDrafts(value: typeof localSkillDrafts): void {
	localSkillDrafts = value;
}

const workflowDefinitionOperatorSurface = {
	namespace: "skills" as const,
	runTool: "run_skill_workflow",
	statusTool: "run_workflow_status",
	historyTool: "run_workflow_history",
	revisionsTool: "list_workflow_revisions",
	mutationMode: "governed_skill_revision" as const,
	mutationTool: "improve_skills",
};

export const WORKFLOW_DEFINITIONS = [
	{
		kind: "static_platform" as const,
		id: "platform:memory_reflection",
		title: "Memory reflection",
		description: "Nightly brain reflection over the day's runtime evidence",
		engine: "cloudflare_workflows" as const,
		binding: "MEMORY_REFLECTION_WORKFLOW",
		entrypoint: "MemoryReflectionWorkflow",
		triggers: ["cron:0 7 * * *"],
		operatorSurface: {
			namespace: "workflows" as const,
			runTool: null,
			statusTool: "get_workflow_status",
			historyTool: "list_workflow_runs",
			revisionsTool: null,
			mutationMode: "deploy_main" as const,
			mutationTool: null,
		},
		scope: "platform" as const,
		ownerKind: "platform" as const,
		sourceKind: "deployed_entrypoint" as const,
		workflowType: "memory_reflection" as const,
		lifecycleState: "active" as const,
	},
	{
		kind: "dynamic_skill" as const,
		id: `skill:${SKILL_REVENUE}`,
		title: "Weekly revenue report",
		description: "Assembles the weekly revenue sheet and narrative",
		engine: "cloudflare_workflows" as const,
		binding: "SKILL_WORKFLOW",
		entrypoint: "SkillWorkflow",
		triggers: ["cron:0 13 * * 1"],
		operatorSurface: workflowDefinitionOperatorSurface,
		scope: "organization" as const,
		ownerKind: "tenant" as const,
		sourceKind: "revisioned_skill_source" as const,
		skillId: SKILL_REVENUE,
		skillSlug: "weekly-revenue-report",
		skillRevision: 3,
		tediId: TEDI_MILES,
		lifecycleState: "proven" as const,
		updatedAt: T4,
	},
	{
		kind: "dynamic_skill" as const,
		id: `skill:${SKILL_CHURN}`,
		title: "Churn watch",
		description: "Daily churn-cohort scan with account flags",
		engine: "cloudflare_workflows" as const,
		binding: "SKILL_WORKFLOW",
		entrypoint: "SkillWorkflow",
		triggers: ["cron:0 6 * * *"],
		operatorSurface: workflowDefinitionOperatorSurface,
		scope: "organization" as const,
		ownerKind: "tenant" as const,
		sourceKind: "revisioned_skill_source" as const,
		skillId: SKILL_CHURN,
		skillSlug: "churn-watch",
		skillRevision: 3,
		tediId: TEDI_MILES,
		lifecycleState: "draft" as const,
		updatedAt: T3,
	},
];

export const WORKFLOW_HEALTH = [
	{
		definitionId: "platform:memory_reflection",
		title: "Memory reflection",
		kind: "static_platform" as const,
		lifecycleState: "active",
		currentRevision: null,
		healthStatus: "healthy" as const,
		driftStatus: "not_applicable" as const,
		executionSurface: {
			kind: "platform_workflow_binding" as const,
			binding: "MEMORY_REFLECTION_WORKFLOW",
			available: true,
			checkedAt: T5,
		},
		latestRun: {
			id: fid("22", 1),
			status: "completed" as const,
			startedAt: T2,
			completedAt: T2,
			observedRevision: null,
			lastReconciledAt: T5,
			source: "workflow_run_ledger" as const,
		},
		notes: [],
	},
	{
		// Literal, not the contract helper: this module is loaded by vite.config.ts
		// under raw Node, where package subpaths do not resolve. local-fixtures.test.ts
		// asserts these equal dynamicSkillDefinitionId(...) so they cannot drift.
		definitionId: `dynamic-skill:${SKILL_REVENUE}`,
		title: "Weekly revenue report",
		kind: "dynamic_skill" as const,
		lifecycleState: "proven",
		currentRevision: 3,
		healthStatus: "active" as const,
		driftStatus: "in_sync" as const,
		executionSurface: {
			kind: "skill_runtime_service" as const,
			binding: "SKILL_WORKFLOW",
			available: true,
			checkedAt: T5,
		},
		latestRun: {
			id: RUN_REVENUE_LIVE,
			status: "running" as const,
			startedAt: T4,
			completedAt: null,
			observedRevision: 3,
			lastReconciledAt: T5,
			source: "skill_runs_snapshot" as const,
		},
		notes: [],
	},
	{
		definitionId: `dynamic-skill:${SKILL_CHURN}`,
		title: "Churn watch",
		kind: "dynamic_skill" as const,
		lifecycleState: "draft",
		currentRevision: 3,
		healthStatus: "attention" as const,
		driftStatus: "in_sync" as const,
		executionSurface: {
			kind: "skill_runtime_service" as const,
			binding: "SKILL_WORKFLOW",
			available: true,
			checkedAt: T5,
		},
		latestRun: {
			id: RUN_CHURN_FAILED,
			status: "failed" as const,
			startedAt: T2,
			completedAt: T3,
			observedRevision: 3,
			lastReconciledAt: T5,
			source: "skill_runs_snapshot" as const,
		},
		notes: ["Last run failed: crm.list_accounts timed out"],
	},
];

export const SCHEDULES = [
	{
		id: fid("23", 1),
		organizationId: ORG_ID,
		skillId: SKILL_REVENUE,
		tediId: TEDI_MILES,
		cron: "0 13 * * 1",
		params: { period: "last_7_days" },
		enabled: true,
		nextFireAt: "2026-08-17T13:00:00.000Z",
		lastFireAt: T1,
		lastRunId: RUN_REVENUE_OK,
		lastError: null,
		lastBudgetBlockedAt: null,
		lastBudgetBlockedReason: null,
		lastBudgetResetAt: null,
		lastBudgetAdmissionClass: null,
		createdAt: T0,
		updatedAt: T4,
	},
	{
		id: fid("23", 2),
		organizationId: ORG_ID,
		skillId: SKILL_CHURN,
		tediId: TEDI_MILES,
		cron: "0 6 * * *",
		params: {},
		enabled: false,
		nextFireAt: "2026-08-13T06:00:00.000Z",
		lastFireAt: T2,
		lastRunId: RUN_CHURN_FAILED,
		lastError: "MCP call crm.list_accounts timed out after 15s",
		lastBudgetBlockedAt: null,
		lastBudgetBlockedReason: null,
		lastBudgetResetAt: null,
		lastBudgetAdmissionClass: null,
		createdAt: T0,
		updatedAt: T3,
	},
	// Budget governance suppressing a cadence: the schedule is enabled and
	// healthy, but admission denied the fire. This is a governed pause with its
	// own reset evidence, never a run failure.
	{
		id: fid("23", 3),
		organizationId: ORG_ID,
		skillId: SKILL_BRIEF,
		tediId: TEDI_NOVA,
		cron: "*/30 * * * *",
		params: {},
		enabled: true,
		nextFireAt: "2026-08-13T09:00:00.000Z",
		lastFireAt: T4,
		lastRunId: null,
		lastError: null,
		lastBudgetBlockedAt: T5,
		lastBudgetBlockedReason:
			"Daily background inference budget exhausted for this workspace",
		lastBudgetResetAt: "2099-01-01T00:00:00.000Z",
		lastBudgetAdmissionClass: "background" as const,
		createdAt: T0,
		updatedAt: T5,
	},
];

const rationaleRecord = (
	n: number,
	tediId: string,
	action: string,
	rationale: string,
	category: string,
	outcomeStatus: "pending" | "success" | "failure" | "partial" | "unverified",
	runId: string | null,
	createdAt: string,
) => ({
	id: fid("72", n),
	tediId,
	orgId: ORG_ID,
	action,
	rationale,
	category,
	confidence: 0.5 + (n % 5) * 0.1,
	evidence: { source: "local-fixture" },
	outcome:
		outcomeStatus === "pending"
			? null
			: outcomeStatus === "failure"
				? "Did not complete as planned"
				: "Completed as planned",
	outcomeStatus,
	approvalRequestId: null,
	objectiveId: null,
	runId,
	workItemId: null,
	toolCallRefs: null,
	proofRef:
		outcomeStatus === "success"
			? { kind: "run" as const, ref: runId ?? RUN_REVENUE_OK }
			: null,
	createdAt,
	completedAt: outcomeStatus === "pending" ? null : createdAt,
	blameChain: null,
});

export const RATIONALES = [
	rationaleRecord(
		1,
		TEDI_MILES,
		"Publish week-32 revenue summary",
		"Weekly cadence hit; order data reconciled against the ledger before publishing.",
		"content",
		"success",
		RUN_REVENUE_OK,
		T2,
	),
	rationaleRecord(
		2,
		TEDI_MILES,
		"Retry churn scan with a smaller account page",
		"CRM listing timed out at 500 accounts; halving the page should fit the tool budget.",
		"recovery",
		"pending",
		RUN_CHURN_FAILED,
		T3,
	),
	rationaleRecord(
		3,
		TEDI_JUNO,
		"Escalate ticket #4821 to a goodwill credit",
		"Second delay on the same order; policy allows credits under 200 MXN with approval.",
		"custom",
		"pending",
		null,
		T4,
	),
	rationaleRecord(
		4,
		TEDI_NOVA,
		"Move owner sync brief to Monday 08:00",
		"Owner reads briefs before the revenue check-in; earlier delivery doubles read rate.",
		"optimization",
		"success",
		HOME_RUN_DONE,
		T4,
	),
	rationaleRecord(
		5,
		TEDI_MILES,
		"Skip wholesale discount adjustment",
		"Churn cohort still unstable; changing pricing now would confound the win-back test.",
		"config_change",
		"unverified",
		null,
		T4,
	),
	rationaleRecord(
		6,
		TEDI_JUNO,
		"Auto-close stale duplicate tickets",
		"Duplicate detector confidence exceeded 0.9 on 6 threads.",
		"health_check",
		"failure",
		null,
		T5,
	),
];

const knowledgeEntry = (
	n: number,
	title: string,
	content: string,
	entryType: "insight" | "pattern" | "anti_pattern" | "convention" | "decision",
	tediId: string | null,
) => ({
	id: fid("73", n),
	organizationId: ORG_ID,
	tediId,
	domainId: null,
	title,
	content,
	entryType,
	sourceFactIds: null,
	sourceCount: 3 + n,
	confidence: 0.7 + (n % 3) * 0.08,
	revision: 1,
	revisionReasoning: null,
	supersedesId: null,
	visibility: "org" as const,
	tags: ["local-fixture"],
	lastValidatedAt: T4,
	createdAt: T0,
	updatedAt: T4,
});

export const KNOWLEDGE = [
	knowledgeEntry(
		1,
		"Monday follow-ups double wholesale renewals",
		"Wholesale accounts contacted on Monday renew at 2x the baseline rate across 8 observed cycles.",
		"insight",
		TEDI_MILES,
	),
	knowledgeEntry(
		2,
		"Answer refunds before shipping questions",
		"Refund threads escalate within 4 hours when unanswered; shipping questions tolerate a day.",
		"pattern",
		TEDI_JUNO,
	),
	knowledgeEntry(
		3,
		"Never adjust pricing during an active cohort test",
		"Price changes mid-test confounded two prior churn experiments.",
		"anti_pattern",
		TEDI_MILES,
	),
	knowledgeEntry(
		4,
		"Owner briefs are one page, metrics first",
		"Briefs longer than one page go unread; lead with the three headline metrics.",
		"convention",
		TEDI_NOVA,
	),
	knowledgeEntry(
		5,
		"Hold wholesale discount at 12%",
		"Decided 2026-08-11: keep the wholesale discount until the churn cohort stabilizes.",
		"decision",
		null,
	),
];

/**
 * Tool telemetry source rows. `cognitiveRuntime.listEvents` filters by ONE
 * kind, so the OS issues a completed read and a failed read and merges them;
 * a fixture that ignored `kind` would make that union meaningless and hide a
 * real filter bug.
 */
const toolEvent = (
	n: number,
	tediId: string,
	kind: "tool.completed" | "tool.failed",
	name: string,
	latencyMs: number,
	createdAt: string,
	error: string | null,
) => ({
	id: fid("78", n),
	tediId,
	kind,
	conversationId: CONVERSATION_HOME,
	runId: RUN_REVENUE_OK,
	toolCallId: `call-${n}`,
	sequence: n,
	payload: {
		name,
		latencyMs,
		...(error === null ? {} : { error }),
	},
	createdAt,
});

export const TOOL_EVENTS = [
	toolEvent(1, TEDI_MILES, "tool.completed", "list_orders", 840, T2, null),
	toolEvent(2, TEDI_MILES, "tool.completed", "list_orders", 1240, T3, null),
	toolEvent(3, TEDI_MILES, "tool.completed", "publish_report", 2100, T4, null),
	toolEvent(
		4,
		TEDI_MILES,
		"tool.failed",
		"list_accounts",
		15_020,
		T3,
		"Upstream CRM timed out after 15s",
	),
	toolEvent(5, TEDI_NOVA, "tool.completed", "get_owner_brief", 410, T4, null),
	toolEvent(6, TEDI_NOVA, "tool.completed", "list_work_items", 620, T5, null),
	toolEvent(
		7,
		TEDI_JUNO,
		"tool.failed",
		"send_credit",
		980,
		T5,
		"Approval required before issuing a goodwill credit",
	),
	toolEvent(8, TEDI_JUNO, "tool.completed", "list_tickets", 730, T5, null),
];

/** Per-domain expertise, keyed by tedi. Unnamed domains are modeled too. */
const expertiseEntry = (
	n: number,
	tediId: string,
	domainName: string | null,
	factCount: number,
	avgConfidence: number,
	competenceScore: number,
	expertiseLevel: "novice" | "familiar" | "proficient" | "expert",
) => ({
	id: fid("79", n),
	tediId,
	domainId: fid("7a", n),
	domainName,
	factCount,
	avgConfidence,
	competenceScore,
	expertiseLevel,
	lastActivityAt: T4,
	createdAt: T0,
	updatedAt: T4,
});

export const EXPERTISE = [
	expertiseEntry(1, TEDI_MILES, "revenue-reporting", 84, 0.86, 0.79, "expert"),
	expertiseEntry(2, TEDI_MILES, "churn-analysis", 41, 0.71, 0.58, "proficient"),
	expertiseEntry(3, TEDI_MILES, null, 6, 0.52, 0.24, "novice"),
	expertiseEntry(4, TEDI_NOVA, "owner-briefing", 62, 0.83, 0.72, "proficient"),
	expertiseEntry(5, TEDI_JUNO, "support-triage", 55, 0.78, 0.66, "proficient"),
];
