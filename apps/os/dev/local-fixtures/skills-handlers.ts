/**
 * Local fixture handlers: Skill, workflow, tedi, approval, memory and audit
 * procedures.
 */

import {
	runTimelineFixture,
	runTimelineArtifactFixture,
} from "../run-timeline-fixture";
import type { SkillEntry } from "@tedix/api-contract/contracts/cognitive";
import {
	memoryBrowseFixture,
	memoryDomainFixture,
} from "../memory-page-fixtures";
import {
	type ApprovalRow,
	fid,
	now,
	ORG_ID,
	RpcError,
	type SkillRunRow,
	T0,
	T2,
	T5,
	TEDI_JUNO,
	TEDI_MILES,
	TEDI_NOVA,
} from "./core";
import { findSkillRun, paginate, type Pagination } from "./lookups";
import {
	AUDIT_EVENTS,
	growthSnapshot,
	KNOWLEDGE_GRAPH,
	MEMORY_HEALTH,
	MEMORY_HEALTH_FINDINGS,
} from "./memory";
import { fixtureScheduleControl } from "./policies";
import { state } from "./state";
import {
	delegationProfile,
	EXPERTISE,
	fixtureSkillEntry,
	KNOWLEDGE,
	LOCAL_WORKFLOW_SOURCE,
	localSkillDrafts,
	localSkillReactivations,
	operationsSummary,
	RATIONALES,
	runtimeProvenanceNulls,
	SCHEDULES,
	skillRunSummary,
	SKILLS,
	TEDIS,
	WORKFLOW_DEFINITIONS,
	WORKFLOW_HEALTH,
} from "./tedis";

export const skillHandlers: Record<string, (input: never) => unknown> = {
	"tedis/list": (input: Pagination | undefined) => paginate(TEDIS, input),
	"tedis/get": (input: { tediId: string }) => {
		const tedi = TEDIS.find((row) => row.id === input.tediId);
		if (!tedi) throw new RpcError("NOT_FOUND", "Tedi not found");
		return tedi;
	},
	"tedis/getSetup": (input: { tediId: string }) => ({
		tediId: input.tediId,
		observedAt: T5,
		items: [],
	}),
	"tedis/listOperationsSummaries": () => ({
		data: [
			operationsSummary(
				TEDI_NOVA,
				"Prepare Monday owner brief",
				"Move owner sync brief to Monday 08:00",
			),
			operationsSummary(
				TEDI_MILES,
				"Rebuild churn cohort query",
				"Publish week-32 revenue summary",
			),
			operationsSummary(
				TEDI_JUNO,
				"Clear SLA-risk ticket queue",
				"Escalate ticket #4821 to a goodwill credit",
			),
		],
	}),

	// --- skills + workflows ---
	"skills/listByOrg": (
		input:
			| {
					lifecycleState?: string;
					excludeArchived?: boolean;
					excludeImprovements?: boolean;
					improvementsOf?: string;
					query?: string;
					limit?: number;
					offset?: number;
			  }
			| undefined,
	) => {
		const query = input?.query?.trim().toLowerCase();
		const catalog: SkillEntry[] = [
			...SKILLS.map(fixtureSkillEntry),
			...localSkillDrafts,
		];
		const entries = catalog.filter(
			(skill) =>
				(!input?.lifecycleState ||
					skill.lifecycleState === input.lifecycleState) &&
				(!input?.excludeArchived || skill.lifecycleState !== "archived") &&
				(!input?.excludeImprovements ||
					!(
						skill.sourceSkillId && skill.tags?.includes("workflow-improvement")
					)) &&
				(!input?.improvementsOf ||
					(skill.sourceSkillId === input.improvementsOf &&
						skill.tags?.includes("workflow-improvement"))) &&
				(!query ||
					[skill.title, skill.slug, skill.description, skill.folderPath].some(
						(value) => value?.toLowerCase().includes(query),
					)),
		);
		const offset = input?.offset ?? 0;
		return {
			entries: entries.slice(
				offset,
				offset + Math.min(input?.limit ?? 50, 200),
			),
			total: entries.length,
		};
	},
	"skills/get": (input: { id: string }) => ({
		entry:
			SKILLS.map(fixtureSkillEntry).find((entry) => entry.id === input.id) ??
			null,
	}),
	"skills/improve": (input: {
		id: string;
		lifecycleState?: string;
		revisionReasoning?: string;
	}) => {
		const entry = SKILLS.find((entry) => entry.id === input.id);
		if (!entry) throw new RpcError("NOT_FOUND", "Skill not found");
		if (input.lifecycleState !== "active")
			throw new RpcError(
				"BAD_REQUEST",
				"Sample data supports turning a skill back on only",
			);
		localSkillReactivations.set(entry.id, {
			revision: fixtureSkillEntry(entry).revision + 1,
			revisionReasoning: input.revisionReasoning ?? null,
		});
		return { entry: fixtureSkillEntry(entry) };
	},
	"skills/getWorkflowReliability": (input: {
		skillId?: string;
		slug?: string;
		tediId?: string;
		limit?: number;
	}) => {
		const runs = state.skillRuns
			.filter(
				(run) =>
					(!input.skillId || run.skillId === input.skillId) &&
					(!input.slug || run.skillSlug === input.slug) &&
					(!input.tediId || run.tediId === input.tediId),
			)
			.slice(0, input.limit ?? 100);
		const completed = runs.filter((run) => run.status === "completed").length;
		const failed = runs.filter((run) => run.status === "failed").length;
		const canceled = runs.filter((run) => run.status === "canceled").length;
		const terminal = completed + failed + canceled;
		return {
			scope: { skillId: input.skillId ?? null, tediId: input.tediId ?? null },
			runCount: runs.length,
			completedCount: completed,
			failedCount: failed,
			canceledCount: canceled,
			activeCount: runs.length - terminal,
			successRate: null,
			completionRate: terminal ? completed / terminal : null,
			expectedOutcomes: {
				evaluatedCount: 0,
				matchedCount: 0,
				unexpectedCount: 0,
				expectedCompletedCount: 0,
				expectedFailedCount: 0,
				expectedCanceledCount: 0,
				unexpectedRuns: [],
			},
			averageDurationMs: null,
			retryAttemptCount: runs.reduce((sum, run) => sum + run.executionEpoch, 0),
			rollbackCount: 0,
			toolCallCount: 0,
			failedSteps: [],
			warnings: [
				"Sample run statuses only; outcome policies and step evidence are not modeled.",
			],
		};
	},
	"skills/listWorkflowSchedules": () => ({
		schedules: SCHEDULES.map((schedule) => ({
			...schedule,
			enabled:
				localSkillReactivations.has(schedule.skillId) || schedule.enabled,
		})),
		total: SCHEDULES.length,
		offset: 0,
		limit: 100,
		nextOffset: null,
	}),
	"skills/pauseSchedule": (input: { id: string }) =>
		fixtureScheduleControl(input, "paused"),
	"skills/resumeSchedule": (input: { id: string }) =>
		fixtureScheduleControl(input, "resumed"),
	"skills/updateSchedule": (input: {
		id: string;
		cron?: string;
		enabled?: boolean;
	}) => {
		const row = SCHEDULES.find((schedule) => schedule.skillId === input.id);
		if (!row) throw new RpcError("NOT_FOUND", "Skill has no schedule");
		const cronChanged = input.cron !== undefined && input.cron !== row.cron;
		const enabledChanged =
			input.enabled !== undefined && input.enabled !== row.enabled;
		const changed = cronChanged || enabledChanged;
		if (cronChanged) row.cron = input.cron!;
		if (enabledChanged) row.enabled = input.enabled!;
		return {
			skillId: row.skillId,
			slug: SKILLS.find((skill) => skill.id === row.skillId)?.slug ?? null,
			action: "updated" as const,
			changed,
			cron: row.cron,
			scheduleEnabled: row.enabled,
			nextFireAt: row.enabled ? row.nextFireAt : null,
		};
	},
	"skills/runWorkflowHistory": (
		input: { status?: SkillRunRow["status"]; limit?: number } | undefined,
	) => {
		const rows = state.skillRuns.filter(
			(run) => input?.status === undefined || run.status === input.status,
		);
		return { runs: rows.map(skillRunSummary) };
	},
	"skills/listWorkflowRetryCandidates": () => ({
		candidates: state.skillRuns
			.filter((run) => run.status === "failed")
			.map((run) => ({
				runId: run.id,
				tediId: run.tediId,
				skillId: run.skillId,
				skillSlug: run.skillSlug,
				status: "failed" as const,
				executionEpoch: run.executionEpoch,
				restartId: `restart-${run.id.slice(0, 8)}-epoch-${run.executionEpoch}`,
				failedAt: run.completedAt,
				error: run.error,
			})),
	}),
	"skills/getWorkflowRunTimeline": (input: { runId: string }) => {
		const run = findSkillRun(input.runId);
		return runTimelineFixture({
			id: run.id,
			status: run.status,
			startedAt: run.startedAt,
			completedAt: run.completedAt,
			executionEpoch: run.executionEpoch,
		});
	},
	"skills/getWorkflowStepTediActivity": (input: { runId: string }) => {
		findSkillRun(input.runId);
		return {
			status: "unavailable" as const,
			actions: [],
			finalResult: { status: "unavailable" as const },
			truncated: false,
		};
	},
	"skills/getRunArtifact": (input: { runId: string; path: string }) => {
		findSkillRun(input.runId);
		return runTimelineArtifactFixture(input.path);
	},
	"skills/inspectWorkflowRun": (input: { runId: string }) => {
		const run = findSkillRun(input.runId);
		return {
			run: {
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
				params: { period: "last_7_days" },
				result: run.status === "completed" ? { published: true } : null,
				error: run.error,
				capabilityManifest: null,
				startedAt: run.startedAt,
				completedAt: run.completedAt,
				pausedAt: null,
				createdBy: run.createdBy,
				workItemId: null,
				costSummary: null,
				engine: null,
			},
			revision: {
				runId: run.id,
				skillId: run.skillId,
				tediId: run.tediId,
				skillSlug: run.skillSlug,
				revision: 3,
				status: run.status,
				observedAt: run.startedAt,
				observedRunCount: 4,
				firstObservedAt: T0,
				lastObservedAt: run.startedAt,
				completedCount: 3,
				failedCount: run.status === "failed" ? 1 : 0,
				canceledCount: 0,
				workflowSourceSha256: null,
				skillDocSha256: null,
				runtimeVariants: [],
				runtimeDriftObserved: false,
				runtimeDriftBlocked: false,
				...runtimeProvenanceNulls,
			},
			workflowSource: null,
			skillDoc: null,
			artifacts: [
				{
					path: "reports/revenue-week-32.md",
					mimeType: "text/markdown",
					sizeBytes: 4821,
					outcome: "success" as const,
					attempt: 1,
					storage: "r2" as const,
					createdAt: run.startedAt,
					sha256: null,
				},
			],
			steps: [
				{
					path: "steps/fetch-orders/attempt-1.json",
					name: "fetch-orders",
					count: 1,
					executionEpoch: run.executionEpoch,
					stepId: null,
					kind: "attempt" as const,
					attempt: 1,
					ordinal: 1,
					outcome: "success" as const,
					status: "succeeded" as const,
					durationMs: 1840,
					retryable: null,
					sensitiveOutput: null,
					outputArtifactPath: null,
					error: null,
					provenance: "step_artifact" as const,
					legacy: false,
					mimeType: "application/json",
					sizeBytes: 512,
					createdAt: run.startedAt,
					data: null,
				},
				{
					path: "calls/storefront/list_orders/1.json",
					name: "fetch-orders",
					count: 1,
					executionEpoch: run.executionEpoch,
					stepId: null,
					kind: "tool_call" as const,
					attempt: 1,
					ordinal: 2,
					outcome:
						run.status === "failed"
							? ("failure" as const)
							: ("success" as const),
					status:
						run.status === "failed"
							? ("failed" as const)
							: ("succeeded" as const),
					durationMs: 940,
					retryable: null,
					sensitiveOutput: null,
					outputArtifactPath: null,
					error: run.error,
					provenance: "step_artifact" as const,
					legacy: false,
					mimeType: "application/json",
					sizeBytes: 2048,
					createdAt: run.startedAt,
					data: null,
					phase: "execute",
					namespace: "storefront",
					method: "list_orders",
					callId: `call-${run.id.slice(0, 8)}`,
					idempotencyKey: `idem-${run.id.slice(0, 8)}-1`,
					idempotencyRequested: true,
					providerConfirmation: "storefront-ack-8812",
				},
				// waitForEvent evidence: one gate this run already answered, plus a
				// live gate while the run is still in flight so the governed
				// approve/reject controls render in the zero-account lane.
				{
					path: "events/publish-approval/1.json",
					name: "publish-approval",
					count: 1,
					executionEpoch: run.executionEpoch,
					stepId: null,
					kind: "wait_for_event" as const,
					attempt: 1,
					ordinal: 3,
					outcome: "success" as const,
					status: "resolved" as const,
					durationMs: 412_000,
					retryable: null,
					sensitiveOutput: null,
					outputArtifactPath: null,
					error: null,
					provenance: "step_artifact" as const,
					legacy: false,
					mimeType: "application/json",
					sizeBytes: 256,
					createdAt: run.startedAt,
					data: {
						eventType: "approval",
						approvalId: `apr-${run.id.slice(0, 8)}-1`,
						payload: { decision: "approved", by: "dev-operator" },
					},
				},
				...(run.status === "running"
					? [
							{
								path: "events/spend-approval/1.json",
								name: "spend-approval",
								count: 1,
								executionEpoch: run.executionEpoch,
								stepId: null,
								kind: "wait_for_event" as const,
								attempt: 1,
								ordinal: 4,
								outcome: "pending" as const,
								status: "waiting" as const,
								durationMs: 96_000,
								retryable: null,
								sensitiveOutput: null,
								outputArtifactPath: null,
								error: null,
								provenance: "step_artifact" as const,
								legacy: false,
								mimeType: "application/json",
								sizeBytes: 192,
								createdAt: run.startedAt,
								data: {
									eventType: "approval",
									approvalId: `apr-${run.id.slice(0, 8)}-2`,
								},
							},
						]
					: []),
			],
			toolCalls: [
				{
					path: "calls/storefront/list_orders/1.json",
					name: "fetch-orders",
					count: 1,
					executionEpoch: run.executionEpoch,
					stepId: null,
					kind: "tool_call" as const,
					attempt: 1,
					ordinal: 2,
					outcome:
						run.status === "failed"
							? ("failure" as const)
							: ("success" as const),
					status:
						run.status === "failed"
							? ("failed" as const)
							: ("succeeded" as const),
					durationMs: 940,
					retryable: null,
					sensitiveOutput: null,
					outputArtifactPath: null,
					error: run.error,
					provenance: "step_artifact" as const,
					legacy: false,
					mimeType: "application/json",
					sizeBytes: 2048,
					createdAt: run.startedAt,
					data: null,
					phase: "execute",
					namespace: "storefront",
					method: "list_orders",
					callId: `call-${run.id.slice(0, 8)}`,
					idempotencyKey: `idem-${run.id.slice(0, 8)}-1`,
					idempotencyRequested: true,
					providerConfirmation: "storefront-ack-8812",
				},
			],
			warnings: [],
		};
	},
	"skills/listRunArtifacts": (input: { runId: string }) => {
		findSkillRun(input.runId);
		return {
			artifacts: [
				{
					path: "reports/revenue-week-32.md",
					mimeType: "text/markdown",
					sizeBytes: 4821,
					outcome: "success" as const,
					attempt: 1,
					storage: "r2" as const,
					createdAt: T2,
					sha256: null,
				},
				{
					path: "steps/fetch-orders/attempt-1.json",
					mimeType: "application/json",
					sizeBytes: 512,
					outcome: "success" as const,
					attempt: 1,
					storage: "inline" as const,
					createdAt: T2,
					sha256: null,
				},
			],
			truncated: false,
			nextOffset: null,
		};
	},
	"skills/listWorkflowToolCalls": (input: { runId: string }) => {
		const run = findSkillRun(input.runId);
		return {
			toolCalls: [
				{
					path: "calls/run/1.json",
					name: "fetch-orders",
					count: 1,
					executionEpoch: run.executionEpoch,
					stepId: "fetch-orders",
					kind: "tool_call" as const,
					attempt: 1,
					ordinal: 1,
					outcome:
						run.status === "failed"
							? ("failure" as const)
							: ("success" as const),
					status:
						run.status === "failed"
							? ("failed" as const)
							: ("succeeded" as const),
					durationMs: 840,
					retryable: null,
					sensitiveOutput: false,
					outputArtifactPath: null,
					error: run.status === "failed" ? run.error : null,
					provenance: "step_artifact" as const,
					mimeType: "application/json",
					sizeBytes: 512,
					createdAt: run.startedAt,
					phase: "run",
					namespace: "storefront",
					method: "list_orders",
					callId: `call-${run.id.slice(0, 8)}`,
					idempotencyKey: null,
					idempotencyRequested: false,
					providerConfirmation: null,
				},
			],
			truncated: false,
			nextOffset: null,
		};
	},
	"skills/getWorkflowRevision": (input: { runId: string }) => {
		const run = findSkillRun(input.runId);
		const skill = SKILLS.find((entry) => entry.id === run.skillId);
		return {
			provenance: "observed_executed_run" as const,
			revision: {
				runId: run.id,
				skillId: run.skillId,
				tediId: run.tediId,
				skillSlug: run.skillSlug,
				revision: 3,
				status: run.status,
				observedAt: run.startedAt,
				observedRunCount: 4,
				firstObservedAt: T0,
				lastObservedAt: run.startedAt,
				completedCount: 3,
				failedCount: run.status === "failed" ? 1 : 0,
				canceledCount: 0,
				workflowSourceSha256: null,
				skillDocSha256: null,
				runtimeVariants: [],
				runtimeDriftObserved: false,
				runtimeDriftBlocked: false,
				...runtimeProvenanceNulls,
			},
			workflowSource: LOCAL_WORKFLOW_SOURCE,
			skillDoc: skill?.content ?? null,
		};
	},
	"skills/proposeWorkflowImprovement": (input: {
		baselineRunId: string;
		reason: string;
		content: string;
		files: Record<string, string>;
	}) => {
		const run = findSkillRun(input.baselineRunId);
		const baseline = SKILLS.find((entry) => entry.id === run.skillId);
		if (!baseline) throw new RpcError("NOT_FOUND", "Baseline skill not found");
		const proposal = {
			...baseline,
			id: fid("5d", localSkillDrafts.length + 1),
			title: `${baseline.slug} improvement ${localSkillDrafts.length + 1}`,
			content: input.content,
			files: input.files,
			lifecycleState: "draft" as const,
			sourceSkillId: baseline.id,
			sourceRevision: baseline.revision,
			tags: ["workflow-improvement", `baseline-run:${run.id}`],
			revisionReasoning: `Workflow improvement proposed from run ${run.id} at baseline revision ${baseline.revision}. ${input.reason}`,
		};
		localSkillDrafts.push(proposal);
		return {
			proposal,
			validation: { valid: true, errors: [], warnings: [] },
			governance: {
				state: "pending_activation" as const,
				baselineRunId: run.id,
				baselineSkillId: baseline.id,
				baselineRevision: baseline.revision,
				baselineWorkflowSha256: "a".repeat(64),
				candidateWorkflowSha256: "b".repeat(64),
				certificationRunId: null,
				certificationPassed: false,
			},
		};
	},
	"skills/activateWorkflowImprovement": (input: {
		id: string;
		certificationRunId: string;
		reason: string;
	}) => {
		const proposal = localSkillDrafts.find((draft) => draft.id === input.id);
		if (!proposal) throw new RpcError("NOT_FOUND", "Skill not found");
		const run = findSkillRun(input.certificationRunId);
		const baseline = SKILLS.find(
			(entry) => entry.id === proposal.sourceSkillId,
		);
		if (!baseline) throw new RpcError("NOT_FOUND", "Baseline skill not found");
		proposal.lifecycleState = "archived";
		proposal.improvementAdoption = {
			activatedIntoRevision: baseline.revision + 1,
			certificationRunId: run.id,
			adoptedAt: new Date().toISOString(),
			reason: input.reason,
		};
		return {
			baseline: {
				...baseline,
				content: proposal.content,
				files: proposal.files,
				revision: baseline.revision + 1,
				revisionReasoning: `Workflow improvement ${proposal.id} activated after certified run ${run.id}: ${input.reason}`,
			},
			proposal: { ...proposal, lifecycleState: "archived" as const },
			governance: {
				state: "activated" as const,
				baselineRunId: run.id,
				baselineSkillId: baseline.id,
				baselineRevision: baseline.revision,
				baselineWorkflowSha256: "a".repeat(64),
				candidateWorkflowSha256: "b".repeat(64),
				certificationRunId: run.id,
				certificationPassed: true,
			},
		};
	},
	"skills/rejectWorkshop": (input: { id: string; reason: string }) => {
		const proposal = localSkillDrafts.find((draft) => draft.id === input.id);
		if (!proposal) throw new RpcError("NOT_FOUND", "Skill not found");
		proposal.lifecycleState = "archived";
		proposal.revisionReasoning = input.reason;
		return { entry: proposal };
	},
	"skills/restartWorkflow": (input: { runId: string; restartId: string }) => {
		const run = findSkillRun(input.runId);
		run.status = "queued";
		run.executionEpoch += 1;
		run.error = null;
		run.completedAt = null;
		return {
			runId: run.id,
			status: run.status,
			executionEpoch: run.executionEpoch,
			restartId: input.restartId,
		};
	},
	"skills/runWorkflowCancel": (input: { runId: string }) => {
		const run = findSkillRun(input.runId);
		run.status = "canceled";
		run.completedAt = now();
		return { runId: run.id, status: run.status };
	},
	"skills/approveWorkflow": (input: { runId: string }) => {
		const run = findSkillRun(input.runId);
		run.status = "running";
		return { runId: run.id, status: run.status };
	},
	"skills/rejectWorkflow": (input: { runId: string }) => {
		const run = findSkillRun(input.runId);
		run.status = "canceled";
		run.completedAt = now();
		return { runId: run.id, status: run.status };
	},
	"workflows/listDefinitions": () => ({
		definitions: WORKFLOW_DEFINITIONS,
		counts: { staticPlatform: 1, dynamicSkill: 2, total: 3 },
		offset: 0,
		limit: 50,
		truncated: false,
		nextOffset: null,
	}),
	"workflows/listDefinitionHealth": () => ({
		health: WORKFLOW_HEALTH,
		definitionCounts: { staticPlatform: 1, dynamicSkill: 2, total: 3 },
		pageCounts: {
			healthy: 1,
			active: 1,
			attention: 1,
			unknown: 0,
			degraded: 0,
			dormant: 0,
		},
		evaluatedAt: T5,
		offset: 0,
		limit: 50,
		truncated: false,
		nextOffset: null,
	}),

	// --- brain ---
	"memoryGraph/browse": memoryBrowseFixture,
	"memoryGraph/listDomains": () => memoryDomainFixture,
	"memoryGraph/optimize/backlog": () => ({
		curiosityItems: [],
		optimizationSignals: [],
	}),
	"memoryGraph/health": () => MEMORY_HEALTH,
	"memoryGraph/healthFindings": () => MEMORY_HEALTH_FINDINGS,
	"rationaleRecords/list": (
		input:
			| {
					tediId?: string;
					outcomeStatus?: string;
					limit?: number;
					offset?: number;
			  }
			| undefined,
	) =>
		paginate(
			RATIONALES.filter(
				(row) =>
					(input?.tediId === undefined || row.tediId === input.tediId) &&
					(input?.outcomeStatus === undefined ||
						row.outcomeStatus === input.outcomeStatus),
			),
			input,
		),
	"knowledge/list": () => ({ entries: KNOWLEDGE }),
	"memoryGraph/expertise": (input: { tediId?: string } | undefined) => ({
		expertise: EXPERTISE.filter(
			(row) => input?.tediId === undefined || row.tediId === input.tediId,
		),
	}),
	"memoryGraph/graph/visualization": () => KNOWLEDGE_GRAPH,
	"earnedDelegation/getProfile": (input: { tediId: string }) =>
		delegationProfile(input.tediId),
	"growthSnapshots/latest": (input: { tediId: string }) =>
		growthSnapshot(input.tediId),

	// --- audit ---
	"audit/search": (
		input:
			| { resourceType?: string; limit?: number; offset?: number }
			| undefined,
	) =>
		paginate(
			AUDIT_EVENTS.filter(
				(row) =>
					input?.resourceType === undefined ||
					row.resourceType === input.resourceType,
			),
			input,
		),
	"tediApprovals/list": (
		input:
			| { status?: ApprovalRow["status"]; limit?: number; offset?: number }
			| undefined,
	) =>
		paginate(
			state.approvals.filter(
				(row) => input?.status === undefined || row.status === input.status,
			),
			input,
		),
	"tediApprovals/clearExpired": () => {
		let cleared = 0;
		for (const approval of state.approvals) {
			if (
				approval.status !== "pending" ||
				Date.parse(approval.expiresAt) > Date.now()
			)
				continue;
			approval.status = "expired";
			approval.resolvedAt = now();
			approval.resolvedBy = "dev-operator";
			approval.resolution =
				"Expired: no one answered in time, so it did not run.";
			cleared += 1;
		}
		return { cleared };
	},
	"osApprovalRules/list": () => ({ items: state.approvalRules }),
	"osApprovalRules/setEnabled": (input: {
		ruleId: string;
		enabled: boolean;
	}) => {
		const rule = state.approvalRules.find((row) => row.id === input.ruleId);
		if (!rule) throw new RpcError("NOT_FOUND", "Approval rule not found");
		rule.enabled = input.enabled;
		rule.disabledAt = input.enabled ? null : now();
		return { rule };
	},
	"osApprovalRules/delete": (input: { ruleId: string }) => {
		const rule = state.approvalRules.find((row) => row.id === input.ruleId);
		if (!rule) throw new RpcError("NOT_FOUND", "Approval rule not found");
		if (rule.enabled)
			throw new RpcError("BAD_REQUEST", "Turn the rule off before deleting it");
		state.approvalRules = state.approvalRules.filter((row) => row !== rule);
		return { deleted: true as const };
	},
	"tediApprovals/getById": (input: { id: string }) => {
		const approval = state.approvals.find((row) => row.id === input.id);
		if (!approval)
			throw new RpcError("NOT_FOUND", "Approval request not found");
		return approval;
	},
	"tediApprovals/resolve": (input: {
		id: string;
		status: "approved" | "rejected";
		resolution?: string;
	}) => {
		const approval = state.approvals.find((row) => row.id === input.id);
		if (!approval)
			throw new RpcError("NOT_FOUND", "Approval request not found");
		if (approval.status !== "pending") {
			throw new RpcError("CONFLICT", "Approval request already resolved");
		}
		approval.status = input.status;
		approval.resolvedAt = now();
		approval.resolvedBy = "dev-operator";
		approval.resolution = input.resolution ?? null;
		approval.review = {
			...approval.review,
			state: "resolved",
			outcome: input.status,
		};
		return approval;
	},
	// An approved owner tool call the platform failed to run is tried once
	// more; fixture mode records the second attempt as done.
	"tediApprovals/retryExecution": (input: { id: string }) => {
		const approval = state.approvals.find((row) => row.id === input.id);
		if (!approval)
			throw new RpcError("NOT_FOUND", "Approval request not found");
		approval.payload = {
			...approval.payload,
			execution: {
				status: "executed",
				startedAt: now(),
				finishedAt: now(),
				summary: "Done in fixture mode",
				attempt: 2,
				retriedBy: "dev-operator",
			},
		};
		return approval;
	},
	// Dismissing clears the failed or cut-off run from the waiting list.
	"tediApprovals/dismissExecution": (input: { id: string }) => {
		const approval = state.approvals.find((row) => row.id === input.id);
		if (!approval)
			throw new RpcError("NOT_FOUND", "Approval request not found");
		const execution = (approval.payload as Record<string, unknown>).execution;
		approval.payload = {
			...approval.payload,
			execution: {
				...(execution && typeof execution === "object" ? execution : {}),
				dismissedAt: now(),
				dismissedBy: "dev-operator",
			},
		};
		return approval;
	},
};
