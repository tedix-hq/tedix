/**
 * oRPC Cognitive Stack Router — skill workflow execution slice.
 * Skill-run/workflow handlers and their helpers; handlers are composed into
 * the exported router in cognitive.ts.
 */

import { ORPCError } from "@orpc/server";
import { SkillWorkflowConnectionRecoverySchema } from "@tedix/api-contract/schemas/cognitive";
import { getRunArtifact } from "@tedix/db/queries/skill-run-artifacts";
import { isMethodAllowed } from "@tedix/api-contract/utils/skill-manifest";
import { isServiceBinding } from "@tedix/worker-kit/request-auth";
import type { SkillWorkflowStep } from "@tedix/api-contract/contracts/cognitive";
import {
	parseCapabilityManifest,
	type RationaleMode,
} from "@tedix/api-contract/utils/skill-manifest";
import {
	getSkillEntry,
	getSkillEntryBySlug,
} from "@tedix/db/queries/cognitive/skill-crud";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { parseJevSettings } from "@tedix/api-contract/schemas/jev";
import {
	listSkillRunEffectObservations,
	recordSkillRunEffectObservation,
} from "@tedix/db/queries/skill-run-effects";
import {
	getSkillRun,
	listSkillRunSnapshotsForSkill,
	listSkillRunsForOrg,
	listSkillRunsForSkill,
	listSkillRunsForTedi,
	listSkillWorkflowRetryCandidateRuns,
	retireSkillRunForRevocation,
	type SkillRun,
	type SkillRunStatus,
	type SkillRunSummaryRow,
	setSkillRunCostSummary,
} from "@tedix/db/queries/skill-runs";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { listSkillSchedulesPage } from "@tedix/db/queries/skill-schedules";
import { getTediOrganizationId } from "@tedix/db/queries/tedis";
import {
	buildSurfaceUrl,
	platformDomainForEnvironment,
} from "@tedix/tenant-directory";
import { createWorkItem } from "@tedix/db/queries/work-items/crud";
import { workItemPurposeFor } from "@tedix/db/queries/work-items/purpose";
import {
	isPendingSkillWorkflowAdmission,
	kernelRunStatusToSubmissionOutcome,
	recordTediSubmissionStarted,
	requestRunAbort,
	restartTediSubmissionAttempt,
	settleTediSubmission,
} from "../../kernel/runtime-submission-bridge";
import { callSkillRuntime } from "../../services/skill-runtime-client";
import {
	aggregateSkillWorkflowReliability,
	computeSkillRunCostSummary,
	parseSkillWorkflowRecords,
	parseSkillWorkflowRecordsByRun,
	type ResolvedSkillRunArtifact,
	resolveSkillRunArtifactContents,
	summarizeSkillRunArtifact,
} from "../../services/skill-workflow-inspection";
import { episodeTraceId } from "../episode-trace";
import { AUTHZ, type BaseContext, createError, ErrorCodes } from "../orpc";
import { insertRuntimeEvent } from "./cognitive-runtime/events-policy";
import { requireOrgId } from "../org-scope";
import { authedSkills } from "./cognitive-shared";
import { verifiedActiveUserMembership } from "./work-items-principal";
import { assessSkillUtility } from "../../services/jev-skill-utility";
import {
	loadSkillWorkflowRuntimeProvenance,
	loadSkillWorkflowRuntimeVariants,
	parseSkillWorkflowRuntimeProvenance,
	parseSkillWorkflowRuntimeVariants,
	resolveArtifactText,
	skillWorkflowRevision,
	type SkillWorkflowRuntimeProvenance,
} from "./cognitive-skill-run-provenance";

// =============================================================================
// SKILL WORKFLOW EXECUTION
// =============================================================================

interface SkillRuntimeRunResponse {
	runId: string;
	workflowInstanceId: string;
	status?: SkillRunStatus;
	executionEpoch?: number;
	deduplicated?: boolean;
	idempotencyKey?: string | null;
}

interface SkillRuntimeStatusResponse {
	status: SkillRunStatus;
	result?: unknown;
	error?: string | null;
	completedAt?: string | null;
	pausedAt?: string | null;
	executionEpoch?: number;
	restartId?: string | null;
	engine?: Record<string, unknown> | null;
}

interface SkillRuntimeLifecycleResponse {
	runId: string;
	status: SkillRunStatus;
	executionEpoch?: number;
	restartId?: string;
	restartAborted?: boolean;
	engine?: Record<string, unknown> | null;
	engineStatus?: string;
	deduplicated?: boolean;
	operationAttempts?: number;
	statusChecks?: number;
}

function skillRuntimeLifecycleEngine(
	remote: SkillRuntimeLifecycleResponse,
): Record<string, unknown> | null {
	if (remote.engine) return remote.engine;
	if (!remote.engineStatus) return null;
	return {
		status: remote.engineStatus,
		deduplicated: remote.deduplicated ?? false,
		operationAttempts: remote.operationAttempts ?? null,
		statusChecks: remote.statusChecks ?? null,
	};
}

function isRecoverableSkillRuntimeCancelFailure(error: unknown): boolean {
	return (
		error instanceof ORPCError &&
		(error.code === ErrorCodes.BAD_GATEWAY ||
			error.code === ErrorCodes.SERVICE_UNAVAILABLE)
	);
}

type PublicSkillRun = Omit<
	SkillRun,
	| "workflowSource"
	| "skillDoc"
	| "skillRevision"
	| "skillSlug"
	| "restartCommandId"
	| "originTediRunId"
> & {
	engine?: Record<string, unknown> | null;
};

function mediaKindFromMimeType(
	mimeType: string | null | undefined,
): "image" | "video" | "audio" | "other" | null {
	if (!mimeType) return null;
	if (mimeType.startsWith("image/")) return "image";
	if (mimeType.startsWith("video/")) return "video";
	if (mimeType.startsWith("audio/")) return "audio";
	return "other";
}

const MEDIA_URL_METADATA_MAX_BYTES = 2 * 1024 * 1024;

function publicSkillRun(
	run: SkillRun,
	engine?: Record<string, unknown> | null,
): PublicSkillRun {
	const retired = Boolean(
		run.workflowRetiredAt ||
		run.error === "REVOKED" ||
		run.error?.startsWith("REVOKED:"),
	);
	return {
		id: run.id,
		organizationId: run.organizationId,
		skillId: run.skillId,
		tediId: run.tediId,
		workflowInstanceId: run.workflowInstanceId,
		// Cloudflare reconciliation evidence, already projected on the run
		// summary; operators inspecting one run need the same discriminator and
		// reconciler stamp without paging the whole history.
		runtimeEnvironment: run.runtimeEnvironment,
		lastReconciledAt: run.lastReconciledAt ?? null,
		executionEpoch: run.executionEpoch ?? 0,
		restartRequestedAt: run.restartRequestedAt ?? null,
		workflowRetiredAt: run.workflowRetiredAt ?? null,
		status: run.status,
		params: run.params,
		result: retired ? null : run.result,
		error: run.error,
		capabilityManifest: run.capabilityManifest,
		startedAt: run.startedAt,
		completedAt: run.completedAt,
		pausedAt: run.pausedAt,
		createdBy: run.createdBy,
		workItemId: run.workItemId ?? null,
		costSummary: retired ? null : (run.costSummary ?? null),
		engine: retired ? null : (engine ?? null),
	};
}

export async function requireOwnedTedi(
	context: BaseContext,
	tediId: string,
	organizationId: string,
): Promise<void> {
	const tediOrganizationId = await getTediOrganizationId(context.db, tediId);
	if (tediOrganizationId !== organizationId) {
		throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	}
}

function requireWorkflowRunTedi(
	run: Pick<SkillRun, "tediId">,
	requestedTediId: string | undefined,
): void {
	if (requestedTediId && run.tediId !== requestedTediId) {
		throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
	}
}

export function getSkillRunForEnvironment(
	context: BaseContext,
	runId: string,
	organizationId: string,
): Promise<SkillRun | undefined> {
	return getSkillRun(
		context.db,
		runId,
		organizationId,
		context.env.ENVIRONMENT,
	);
}

async function acceptedOutcomeForRun(
	context: BaseContext,
	run: SkillRun,
): Promise<{ workItemId: string; doneLooksLike: string } | null> {
	if (!run.workItemId) return null;
	const workItem = await getWorkItemById(context.db, run.workItemId);
	if (
		!workItem ||
		workItem.orgId !== run.organizationId ||
		!workItem.acceptedAt ||
		!workItem.acceptanceContract?.doneLooksLike?.trim()
	)
		return null;
	return {
		workItemId: workItem.id,
		doneLooksLike: workItem.acceptanceContract.doneLooksLike.trim(),
	};
}

const TERMINAL_SKILL_RUN_STATUSES = new Set([
	"completed",
	"failed",
	"canceled",
]);

/** A human reports an observed effect; neither the write nor the status proves it. */
export const skillsRecordRunEffectObservation =
	authedSkills.recordRunEffectObservation
		.use(AUTHZ.tedisWrite)
		.handler(async ({ input, context }) => {
			const orgId = requireOrgId(context);
			if (context.authType !== "user")
				throw createError(
					ErrorCodes.FORBIDDEN,
					"A signed-in organization user must observe the effect",
				);
			const membership = await verifiedActiveUserMembership(context, orgId);
			const run = await getSkillRunForEnvironment(context, input.runId, orgId);
			if (!run || run.organizationId !== orgId)
				throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
			if (!TERMINAL_SKILL_RUN_STATUSES.has(run.status))
				throw createError(ErrorCodes.CONFLICT, "Skill run is not terminal");
			const accepted = await acceptedOutcomeForRun(context, run);
			if (!accepted)
				throw createError(
					ErrorCodes.CONFLICT,
					"Skill run needs an accepted Work Item outcome",
				);
			const now = new Date().toISOString();
			const observation = await recordSkillRunEffectObservation(context.db, {
				id: crypto.randomUUID(),
				organizationId: orgId,
				skillRunId: run.id,
				workItemId: accepted.workItemId,
				source: "human_attestation",
				observerUserId: membership.userId,
				observedState: input.observedState,
				evidenceRef: input.evidenceRef,
				effectNote: input.effectNote,
				observedAt: now,
				createdAt: now,
			});
			return {
				id: observation.id,
				runId: run.id,
				workItemId: accepted.workItemId,
				observedState: observation.observedState,
				source: "human_attestation" as const,
				observedAt: observation.observedAt,
			};
		});

/** Assessment never changes the run, skill, Work Item, or usage ledger. */
export const skillsGetRunUsefulness = authedSkills.getRunUsefulness
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run || run.organizationId !== orgId)
			throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		const unknown = (
			reason:
				| "unlinked"
				| "not_terminal"
				| "no_accepted_outcome"
				| "no_observation"
				| "evidence_overflow"
				| "model_unavailable",
			observationIds: string[] = [],
		) => ({
			runId: run.id,
			workItemId: run.workItemId,
			alignment: "unknown" as const,
			reason,
			evidenceSource: observationIds.length
				? ("human_attestation" as const)
				: ("none" as const),
			observationIds,
		});
		if (!run.workItemId) return unknown("unlinked");
		if (!TERMINAL_SKILL_RUN_STATUSES.has(run.status))
			return unknown("not_terminal");
		const accepted = await acceptedOutcomeForRun(context, run);
		if (!accepted) return unknown("no_accepted_outcome");
		const evidence = await listSkillRunEffectObservations(context.db, {
			organizationId: orgId,
			skillRunId: run.id,
			limit: 5,
		});
		if (evidence.truncated) return unknown("evidence_overflow");
		const rows = evidence.rows.filter(
			(row) =>
				row.source === "human_attestation" &&
				row.workItemId === accepted.workItemId,
		);
		if (!rows.length) return unknown("no_observation");
		const ids = rows.map((row) => row.id);
		const organization = await getOrganizationById(context.db, orgId);
		const settings = parseJevSettings(organization?.metadata);
		if (!settings.enabled) return unknown("model_unavailable", ids);
		const alignment = await assessSkillUtility({
			db: context.db,
			env: context.env,
			context: {
				organizationId: orgId,
				tediId: run.tediId,
				runId: run.id,
				executionAttempts: [],
			},
			doneLooksLike: accepted.doneLooksLike,
			observations: rows.map((row) => ({
				id: row.id,
				observedState: row.observedState,
				effectNote: row.effectNote,
				evidenceRef: row.evidenceRef,
			})),
			transport: settings.transport,
			timeoutMs: settings.timeoutMs,
		});
		return alignment === "unknown"
			? unknown("model_unavailable", ids)
			: {
					...unknown("model_unavailable", ids),
					alignment,
					reason: "assessment" as const,
				};
	});

async function resolveSkillRunArtifacts(
	context: BaseContext,
	runId: string,
	includeArbitraryContent: boolean,
	operationalOnly = false,
	limit = 2_000,
	kind: "all" | "steps" | "calls" = "all",
	query?: {
		exhaustive?: boolean;
		offset?: number;
		stepName?: string;
		stepKind?: SkillWorkflowStep["kind"];
		attempt?: number;
	},
): Promise<{
	resolved: ResolvedSkillRunArtifact[];
	warnings: string[];
	truncated: boolean;
}> {
	const {
		listRunArtifactsPage,
		listRunOperationalArtifacts,
		listRunWorkflowCallArtifacts,
		listRunWorkflowStepArtifacts,
	} = await import("@tedix/db/queries/skill-run-artifacts");
	const requested = Math.min(Math.max(limit, 1), 2_000);
	const readPage = async (offset: number, pageLimit: number) =>
		kind === "steps"
			? listRunWorkflowStepArtifacts(context.db, runId, {
					limit: pageLimit,
					offset,
					stepName: query?.stepName,
					kind: query?.stepKind,
				})
			: kind === "calls"
				? listRunWorkflowCallArtifacts(context.db, runId, {
						limit: pageLimit,
						offset,
						stepName: query?.stepName,
						attempt: query?.attempt,
					})
				: operationalOnly
					? listRunOperationalArtifacts(context.db, runId, pageLimit)
					: listRunArtifactsPage(context.db, runId, {
							limit: pageLimit,
							offset,
						});
	let fetched: Awaited<ReturnType<typeof listRunArtifactsPage>> = [];
	if (query?.exhaustive && (kind === "steps" || kind === "calls")) {
		const scanPageSize = 500;
		for (let offset = 0; ; offset += scanPageSize) {
			const page = await readPage(offset, scanPageSize);
			fetched.push(...page);
			if (page.length < scanPageSize) break;
		}
	} else {
		fetched = await readPage(query?.offset ?? 0, requested + 1);
	}
	const truncated = !query?.exhaustive && fetched.length > requested;
	const artifacts = query?.exhaustive ? fetched : fetched.slice(0, requested);
	const warnings: string[] = [];
	if (truncated) {
		warnings.push(
			`Artifact inspection was truncated at ${requested} records; narrow the query or use paginated raw artifact inventory.`,
		);
	}

	const env = context.env as { SKILL_ARTIFACTS?: R2Bucket };
	const contentResolution = await resolveSkillRunArtifactContents({
		artifacts,
		includeArbitraryContent,
		loadR2: env.SKILL_ARTIFACTS
			? async (key) => env.SKILL_ARTIFACTS!.get(key)
			: undefined,
	});
	warnings.push(...contentResolution.warnings);
	const resolved = contentResolution.resolved;
	return { resolved, warnings, truncated };
}

async function resolveWorkflowSkillId(
	context: BaseContext,
	organizationId: string,
	input: { skillId?: string; slug?: string },
): Promise<string> {
	if (!input.skillId && !input.slug) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Either skillId or slug is required",
		);
	}
	const skill = input.skillId
		? await getSkillEntry(context.db, input.skillId, organizationId)
		: await getSkillEntryBySlug(context.db, organizationId, input.slug!);
	if (!skill) throw createError(ErrorCodes.NOT_FOUND, "Skill not found");
	return skill.id;
}

export const skillsRunWorkflow = authedSkills.runWorkflow
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		await requireOwnedTedi(context, input.tediId, orgId);
		if (input.workItemId) {
			const workItem = await getWorkItemById(context.db, input.workItemId);
			if (!workItem || workItem.orgId !== orgId) {
				throw createError(ErrorCodes.NOT_FOUND, "Work Item not found");
			}
		}

		if (!input.skillId && !input.slug) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Either skillId or slug is required",
			);
		}

		const skill = input.skillId
			? await getSkillEntry(context.db, input.skillId, orgId)
			: await getSkillEntryBySlug(context.db, orgId, input.slug!);
		if (!skill) throw createError(ErrorCodes.NOT_FOUND, "Skill not found");
		assertExpectedSkillRevision(input.expectedSkillRevision, skill.revision);

		const files = (skill.files ?? null) as Record<string, string> | null;
		const workflowSource = files?.["scripts/workflow.ts"];
		if (!workflowSource) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"SKILL_NOT_EXECUTABLE: skill has no files['scripts/workflow.ts']",
			);
		}

		// G hotfix — manifest lives in SKILL.md frontmatter, NOT workflow.ts.
		// Parsing workflow.ts always yielded EMPTY_MANIFEST (no leading
		// `---` block), which silently masked the rationale.mode flag at
		// the dispatch gate.
		//
		// SKILL.md is stored canonically in `skill_entries.content`. The
		// validator REJECTS files["SKILL.md"] (FILES_HAS_SKILL_MD) precisely
		// because content is the source of truth. Fall through to content
		// when files["SKILL.md"] is absent (which is the supported state).
		const skillDoc =
			files?.["SKILL.md"] ?? (skill.content as string | null) ?? "";
		const capabilityManifest = parseCapabilityManifest(skillDoc);

		// Dispatch to skill-runtime via service binding.
		// Pass the workflow source + SKILL.md + revision + slug so the
		// run row pins them at dispatch time. The factory in skill-runtime
		// reads from the snapshot, not from skill_entries, so subsequent
		// revisions don't bleed into in-flight runs across hibernation.
		// Starter provenance (95dff537): record WHO started this run so the
		// gateway can attest operator consent on tedi-bound workflow calls.
		// Only a real human wins the user: prefix — a direct OAuth caller or the
		// gateway-forwarded end user. Everything else records its own class and
		// therefore never attests as an operator (the fail-closed negative
		// control for agent/M2M-started runs).
		const createdBy =
			context.authType === "user" && context.user?.sub
				? `user:${context.user.sub}`
				: context.gatewayEndUserId
					? `user:${context.gatewayEndUserId}`
					: context.externalAgentPrincipalId
						? `agent:${context.externalAgentPrincipalId}`
						: context.tediId
							? `tedi:${context.tediId}`
							: (context.authType ?? "unknown");
		// The MCP edge forwards the turn binding as a header on its trusted
		// Worker-to-Worker hop. It is attribution only, never execution authority.
		// A direct API call or a different tedi cannot assign itself another
		// turn's origin. Analytics still requires a matching injection and tool
		// completion event before reporting verified retrieved→used.
		const claimedOrigin = context.headers.get("X-Tedix-Kernel-Run-Id");
		const originTediRunId =
			isServiceBinding(context.headers) &&
			context.tediId === input.tediId &&
			context.headers
				.get("X-Tedix-Mcp-Tool-Id")
				?.endsWith("run_skill_workflow") &&
			claimedOrigin &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
				claimedOrigin,
			)
				? claimedOrigin
				: null;

		const dispatched = await callSkillRuntime<SkillRuntimeRunResponse>(
			context,
			"/run",
			{
				runId: input.runId,
				createdBy,
				...(originTediRunId ? { originTediRunId } : {}),
				workItemId: input.workItemId,
				idempotencyKey: input.idempotencyKey,
				skillId: skill.id,
				skillSlug: skill.slug,
				skillRevision: skill.revision ?? null,
				orgId,
				tediId: input.tediId,
				params: input.params ?? {},
				workflowSource,
				skillDoc,
				capabilityManifest,
			},
		);

		// Durable submission ledger (tedi subject, skill_workflow source): admit at
		// dispatch, then immediately settle a fast terminal recovery response.
		// Later status reads retain the same exactly-once settlement path.
		await recordTediSubmissionStarted(context.db, {
			tediId: input.tediId,
			runId: dispatched.runId,
			organizationId: orgId,
			sourceKind: "skill_workflow",
		});
		const dispatchedOutcome = kernelRunStatusToSubmissionOutcome(
			dispatched.status ?? "queued",
		);
		const dispatchedRun = await getSkillRun(
			context.db,
			dispatched.runId,
			orgId,
			context.env.ENVIRONMENT,
		);
		if (
			dispatchedOutcome &&
			dispatchedRun &&
			!dispatchedRun.restartRequestedAt &&
			!isPendingSkillWorkflowAdmission(dispatchedRun)
		) {
			await settleTediSubmission(context.db, {
				runId: dispatched.runId,
				organizationId: orgId,
				outcome: dispatchedOutcome,
				error: null,
				expectedWorkflowExecutionEpoch: dispatched.executionEpoch ?? 0,
			});
		}

		// skill-runtime is the source of truth — it already inserted the
		// skill_runs row. Don't double-insert (workflow_instance_id has a
		// unique index).

		// G — gate 1: workflow dispatch rationale. The pause / resume /
		// failure gates fire inside the dispatch shim from skill-runtime;
		// dispatch is the only gate that's natively synchronous in this
		// router, so we emit it here. Honors the SKILL.md
		// `capabilities.rationale.mode` flag (off | important | all).
		const rationaleMode: RationaleMode = capabilityManifest.rationale.mode;
		if (rationaleMode !== "off" && !dispatched.deduplicated) {
			try {
				const {
					createRationaleRecord,
					reconcileSkillWorkflowDispatchRationale,
				} = await import("@tedix/db/queries/rationale-records");
				const id = crypto.randomUUID();
				const nowIso = new Date().toISOString();
				await createRationaleRecord(context.db, {
					id,
					tediId: input.tediId,
					orgId,
					action: `Skill workflow dispatched: ${skill.slug}`,
					rationale: `Started workflow ${skill.slug} run ${dispatched.runId} for tedi ${input.tediId}. Run-pinned source ensures the workflow loads exactly the code at dispatch time across hibernations.`,
					category: "optimization",
					confidence: 0.9,
					evidence: {
						kind: "skill_workflow_dispatch",
						skillId: skill.id,
						skillSlug: skill.slug,
						skillRevision: skill.revision ?? null,
						runId: dispatched.runId,
						runUri: `skill://runs/${dispatched.runId}`,
						tediId: input.tediId,
					},
					// Execution link: the dispatched skill run.
					runId: dispatched.runId,
					createdAt: nowIso,
				});
				// Admission is not execution success. Keep the dispatch decision open;
				// the skill-runtime terminal CAS reconciles it to completed/failed and
				// attaches canonical workflow MCP-call receipts. Re-read after creation
				// to close the race with a workflow that terminalized very quickly.
				const current = await getSkillRun(
					context.db,
					dispatched.runId,
					orgId,
					context.env.ENVIRONMENT,
				);
				if (
					current &&
					(current.status === "completed" ||
						current.status === "failed" ||
						current.status === "canceled")
				) {
					await reconcileSkillWorkflowDispatchRationale(context.db, {
						runId: current.id,
						status: current.status,
						error: current.error,
						completedAt: current.completedAt ?? undefined,
					});
				}
			} catch (err) {
				console.warn(
					"[skillsRunWorkflow] dispatch rationale emit failed",
					err instanceof Error ? err.message : err,
				);
			}
		}

		return {
			runId: dispatched.runId,
			workflowInstanceId: dispatched.workflowInstanceId,
			status: dispatched.status ?? "queued",
			idempotencyKey: dispatched.idempotencyKey ?? input.idempotencyKey ?? null,
			workItemId: input.workItemId ?? null,
			deduplicated: dispatched.deduplicated ?? false,
		};
	});

/**
 * Best-effort per-run cost/effort capture at the first terminal observation.
 * Rolls the run's durable step evidence into `skill_runs.cost_summary` the
 * first time a `completed`/`failed` run is reconciled with a null summary.
 * The DB write is guarded on `cost_summary IS NULL`, so concurrent observers
 * are idempotent and the first persisted rollup wins. Fail-soft by contract:
 * a compute or write failure must never block reconciliation.
 */
async function captureSkillRunCostSummary(
	context: BaseContext,
	orgId: string,
	run: SkillRun,
): Promise<SkillRun> {
	if (
		run.workflowRetiredAt ||
		run.error === "REVOKED" ||
		run.error?.startsWith("REVOKED:")
	) {
		return run;
	}
	if (run.costSummary != null) return run;
	if (run.status !== "completed" && run.status !== "failed") return run;
	try {
		const { resolved, truncated } = await resolveSkillRunArtifacts(
			context,
			run.id,
			false,
			true, // operational step/timeline evidence only
		);
		if (truncated) {
			console.warn(
				`[skills.costSummary] run ${run.id} exceeds the bounded evidence scan; leaving cost_summary null instead of persisting a partial first-write rollup`,
			);
			return run;
		}
		const parsed = parseSkillWorkflowRecords(resolved, {
			includeContent: false,
		});
		const summary = computeSkillRunCostSummary({
			steps: parsed.steps,
			toolCalls: parsed.toolCalls,
			executionEpoch: run.executionEpoch ?? 0,
			startedAt: run.startedAt,
			completedAt: run.completedAt,
		});
		const persisted = await setSkillRunCostSummary(
			context.db,
			run.id,
			orgId,
			context.env.ENVIRONMENT,
			run.executionEpoch ?? 0,
			summary,
		);
		if (persisted) return { ...run, costSummary: summary };
		// Another observer won the first-write race — surface its rollup.
		const refreshed = await getSkillRun(
			context.db,
			run.id,
			orgId,
			context.env.ENVIRONMENT,
		);
		return (refreshed ?? run) as SkillRun;
	} catch (error) {
		console.warn(
			`[skills.costSummary] capture failed for ${run.id}:`,
			error instanceof Error ? error.message : error,
		);
		return run;
	}
}

/** Provenance/metadata source tag for skill-run failure alert work items. */
const SKILL_RUN_FAILED_ALERT_SOURCE = "skills.reconcile.skillRunFailed";

/**
 * Conformance fixtures whose runs deliberately exercise failure paths (their
 * failures are expected test outcomes). Alerting on them would mint a false
 * high-severity work item per run, so their failed runs never mint one. Add other fail-on-purpose
 * fixtures here.
 */
const SKILL_RUN_ALERT_FIXTURE_SLUGS = new Set<string>([
	"workflow-kitchen-sink",
]);

/**
 * Collapse an error preview to a stable CLASS token so repeated same-error
 * failures of one skill dedup onto a single work item (vs one row per unique
 * message). Prefers a `*Error` type name; else the first alpha token.
 */
function skillRunErrorClass(errorPreview: string | null): string {
	if (!errorPreview) return "unknown";
	// A deliberate refusal is signalled by the error TYPE the skill runtime
	// throws for a permanent input/policy failure (`NonRetryableError`), never
	// by prose: "connect ECONNREFUSED ... connection refused" is a crash.
	if (/\bNonRetryableError\b/.test(errorPreview)) return "refusal";
	const typeName = errorPreview.match(/\b([A-Za-z]+Error)\b/)?.[1];
	if (typeName) return typeName.toLowerCase();
	const token = errorPreview
		.toLowerCase()
		.replace(/[^a-z]+/g, " ")
		.trim()
		.split(" ")[0];
	return (token || "unknown").slice(0, 40);
}

/**
 * Human-visible alert for an unattended skill-run failure (e.g. a cron
 * dispatch that failed at 3am): mint ONE work item per (skill, error-class).
 *
 * Why a work item and not another surface: Tedix OS's Activity rail is driven by
 * kernel runs and `kernel_runtime_events` — tedi runtime events such as the
 * `skill.failed` emit below are never projected into it, so the event alone is
 * invisible to humans. Work items are already human-visible with ZERO new UI:
 * Tedix OS's org-scoped board bucket `/board/work-items` lists the newest org work
 * items consumed by the browser workspace, and they
 * are actionable and attributable to the run's tedi.
 *
 * Idempotency/no-spam: the sourceIntentId is deterministic per
 * (skill, error-class), and
 * `uniq_work_items_org_source_intent` makes (orgId, sourceIntentId) unique —
 * `createWorkItem` upserts on that key, so even racing reconciles that both
 * observe the failed transition converge on ONE row, ever. A repeat
 * observation refreshes metadata via the conflict-set, which never touches
 * `status`, so an operator's triage survives and a resolved item is never
 * reopened.
 *
 * Fail-soft: runs inside waitUntil with a catch at the call site — alerting
 * must never break reconciliation.
 */
async function createSkillRunFailedWorkItem(
	context: BaseContext,
	input: {
		orgId: string;
		run: SkillRun;
		errorPreview: string | null;
		observedAt: string;
	},
): Promise<void> {
	// Conformance fixtures fail on purpose — never alert on them.
	if (
		input.run.skillSlug &&
		SKILL_RUN_ALERT_FIXTURE_SLUGS.has(input.run.skillSlug)
	) {
		return;
	}

	// Dedup key is per (skill, error-class), not per run: a skill that fails on a
	// cron cadence would otherwise mint one high-severity item per run.
	// createWorkItem upserts on (orgId, sourceIntentId) — the conflict-set refreshes
	// metadata + updatedAt on recurrence but never touches `status`, so all
	// same-class failures of one skill converge on ONE row and an operator's triage
	// survives. Precedent: upsertCronDarknessWorkItems (flywheel.ts). Dropping the
	// prior existence pre-check is what lets a recurrence refresh (not skip) the row.
	const errorClass = skillRunErrorClass(input.errorPreview);
	const sourceIntentId = `skill-run-failed:${input.run.skillId}:${errorClass}`;

	// Tedix OS is tenant-origin addressed while reconcile scope only has the org
	// UUID. Fail-soft on the slug lookup — the alert remains useful without the
	// deep link.
	let runUrl: string | null = null;
	try {
		const organization = await getOrganizationById(context.db, input.orgId);
		if (organization?.slug) {
			const osOrigin = buildSurfaceUrl("os", organization.slug, {
				platformDomain: platformDomainForEnvironment(context.env.ENVIRONMENT),
			});
			if (osOrigin) {
				runUrl = `${osOrigin.replace(/\/+$/, "")}/activity/runs/${input.run.id}`;
			}
		}
	} catch {
		// Keep runUrl null.
	}

	const skillLabel = input.run.skillSlug ?? input.run.skillId;
	const provenance = {
		source: SKILL_RUN_FAILED_ALERT_SOURCE,
		skillRunId: input.run.id,
		skillId: input.run.skillId,
		skillSlug: input.run.skillSlug ?? null,
		workflowInstanceId: input.run.workflowInstanceId ?? null,
	};
	await createWorkItem(context.db, {
		id: crypto.randomUUID(),
		orgId: input.orgId,
		title: `Skill run failed: ${skillLabel} (${errorClass})`,
		description: [
			`Skill workflow run ${input.run.id} failed unattended.`,
			...(input.errorPreview ? [`Error: ${input.errorPreview}`] : []),
			...(runUrl ? [`Run: ${runUrl}`] : []),
		].join("\n"),
		workKind: "incident",
		priority: "high",
		accountableOwnerType: input.run.tediId ? "tedi" : "system",
		accountableOwnerId: input.run.tediId ?? "skills",
		...workItemPurposeFor({
			workClass: "incident",
			now: new Date(input.observedAt),
		}),
		sourceIntentId,
		provenance,
		metadata: {
			...provenance,
			errorClass,
			errorPreview: input.errorPreview,
			// Refreshed each recurrence via the createWorkItem json_patch merge, so
			// the single row always reflects the latest failing run.
			lastRunId: input.run.id,
			lastFailedAt: input.observedAt,
			...(runUrl ? { runUrl } : {}),
		},
		createdAt: input.observedAt,
	});
}

/**
 * Reconcile one skill run's D1 row (and its tedi-submission ledger) against the
 * live Cloudflare Workflows engine state. This is the single reconcile core:
 * `runWorkflowStatus` runs it on every read, and `runWorkflowHistory` runs it
 * bounded over non-terminal rows so run lists never keep showing a stale
 * "running" for runs nobody individually inspected (e.g. unattended cron
 * dispatches). Fail-soft: an engine/read failure returns the original row with
 * engine null.
 */
async function reconcileSkillRunWithEngine(
	context: BaseContext,
	orgId: string,
	run: SkillRun,
	logPrefix = "skills.runWorkflowStatus",
): Promise<{ run: SkillRun; engine: Record<string, unknown> | null }> {
	if (
		run.workflowRetiredAt ||
		run.error === "REVOKED" ||
		run.error?.startsWith("REVOKED:")
	) {
		return { run, engine: null };
	}
	const existingOutcome =
		run.restartRequestedAt || isPendingSkillWorkflowAdmission(run)
			? null
			: kernelRunStatusToSubmissionOutcome(run.status);
	if (existingOutcome) {
		await settleTediSubmission(context.db, {
			runId: run.id,
			organizationId: orgId,
			outcome: existingOutcome,
			error: run.status === "failed" ? run.error : null,
			expectedWorkflowExecutionEpoch: run.executionEpoch ?? 0,
		});
	}

	try {
		const remote = await callSkillRuntime<SkillRuntimeStatusResponse>(
			context,
			"/status",
			{ workflowInstanceId: run.workflowInstanceId, runId: run.id },
		);
		if (remote.restartId && remote.executionEpoch != null) {
			await restartTediSubmissionAttempt(context.db, {
				runId: run.id,
				organizationId: orgId,
				tediId: run.tediId,
				restartId: remote.restartId,
				executionEpoch: remote.executionEpoch,
			});
		} else if (!kernelRunStatusToSubmissionOutcome(remote.status)) {
			try {
				await recordTediSubmissionStarted(context.db, {
					runId: run.id,
					organizationId: orgId,
					tediId: run.tediId,
					sourceKind: "skill_workflow",
				});
			} catch (error) {
				console.warn(
					`[${logPrefix}] active submission reconciliation failed for ${run.id}:`,
					error,
				);
			}
		}
		const remoteOutcome = kernelRunStatusToSubmissionOutcome(remote.status);
		const settlementRun = remoteOutcome
			? await getSkillRun(context.db, run.id, orgId, context.env.ENVIRONMENT)
			: null;
		if (
			remoteOutcome &&
			settlementRun &&
			!settlementRun.restartRequestedAt &&
			!isPendingSkillWorkflowAdmission(settlementRun)
		) {
			await settleTediSubmission(context.db, {
				runId: run.id,
				organizationId: orgId,
				outcome: remoteOutcome,
				error: remote.status === "failed" ? remote.error : null,
				expectedWorkflowExecutionEpoch:
					remote.executionEpoch ?? run.executionEpoch ?? 0,
			});
		}
		if (remote.status !== run.status) {
			// Cognitive-event bridge — a completed skill run is the tedi
			// "using" a skill; surface it on the runtime spine. Terminal success
			// only, tedi-scoped, best-effort.
			if (remote.status === "completed" && run.tediId) {
				const episodeTrace = episodeTraceId(context.headers);
				context.waitUntil?.(
					insertRuntimeEvent(context, {
						organizationId: orgId,
						tediId: run.tediId,
						kind: "skill.used",
						...(episodeTrace
							? { runtimeMetadata: { traceId: episodeTrace } }
							: {}),
						payload: {
							skillRunId: run.id,
							skillId: run.skillId,
							skillSlug: run.skillSlug ?? null,
							workflowInstanceId: run.workflowInstanceId ?? null,
						},
						createdAt: remote.completedAt ?? new Date().toISOString(),
					}).catch((err) =>
						console.warn("[CognitiveBridge] skill.used emit failed:", err),
					),
				);
			}
			// Emit the runtime event only on the first observed status transition.
			// The human-facing alert is reconciled separately below because the
			// runtime may have persisted the failed D1 status before this API read.
			if (remote.status === "failed" && run.tediId) {
				const episodeTrace = episodeTraceId(context.headers);
				const errorText =
					typeof remote.error === "string"
						? remote.error
						: remote.error != null
							? JSON.stringify(remote.error)
							: null;
				const errorPreview = errorText ? errorText.slice(0, 500) : null;
				const observedAt = remote.completedAt ?? new Date().toISOString();
				context.waitUntil?.(
					insertRuntimeEvent(context, {
						organizationId: orgId,
						tediId: run.tediId,
						kind: "skill.failed",
						...(episodeTrace
							? { runtimeMetadata: { traceId: episodeTrace } }
							: {}),
						payload: {
							skillRunId: run.id,
							skillId: run.skillId,
							skillSlug: run.skillSlug ?? null,
							workflowInstanceId: run.workflowInstanceId ?? null,
							error: errorPreview,
						},
						createdAt: observedAt,
					}).catch((err) =>
						console.warn("[CognitiveBridge] skill.failed emit failed:", err),
					),
				);
			}
		}
		// Reconcile the human alert on every failed observation, not only on a
		// status transition. The skill runtime writes the shared D1 row before an
		// API reader may observe it, so `remote.status === run.status === failed`
		// is normal. The deterministic sourceIntentId makes this safe to repeat.
		if (remote.status === "failed" && run.tediId) {
			const remoteErrorText =
				typeof remote.error === "string"
					? remote.error
					: remote.error != null
						? JSON.stringify(remote.error)
						: null;
			// The runtime may omit an error from a later status observation after
			// persisting it to the shared run row. Classify from that durable value
			// before falling back to the observation so competing readers retain the
			// same per-(skill, error-class) source intent.
			const errorText = run.error ?? remoteErrorText;
			const alert = createSkillRunFailedWorkItem(context, {
				orgId,
				run,
				errorPreview: errorText ? errorText.slice(0, 500) : null,
				observedAt: remote.completedAt ?? new Date().toISOString(),
			}).catch((err) =>
				console.warn(
					"[CognitiveBridge] skill.failed work-item alert failed:",
					err,
				),
			);
			if (context.waitUntil) context.waitUntil(alert);
			else await alert;
		}
		// Reconcile recovery on every completed observation, not only the first
		// status transition. The runtime may have persisted the terminal D1 row
		// before this API read, and existing successful runs must be able to heal
		// alerts minted before this lifecycle was deployed.
		// Even when the status string is unchanged, /status may have repaired an
		// accepted restart's provisional row or settled a fast new epoch. Re-read
		// the shared D1 row so stale terminal output/intent never leaks back.
		const refreshed = await getSkillRun(
			context.db,
			run.id,
			orgId,
			context.env.ENVIRONMENT,
		);
		const currentRun = (refreshed ?? run) as SkillRun;
		const retired = Boolean(
			currentRun.workflowRetiredAt ||
			currentRun.error === "REVOKED" ||
			currentRun.error?.startsWith("REVOKED:"),
		);
		return {
			run: await captureSkillRunCostSummary(context, orgId, currentRun),
			engine: retired ? null : (remote.engine ?? null),
		};
	} catch (err) {
		console.warn(`[${logPrefix}] refresh failed for ${run.id}:`, err);
	}

	// Engine refresh failed, but a terminal D1 row can still receive its
	// first-observation cost rollup from durable evidence (fail-soft inside).
	return {
		run: await captureSkillRunCostSummary(context, orgId, run),
		engine: null,
	};
}

export const skillsRunWorkflowStatus = authedSkills.runWorkflowStatus
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRun(
			context.db,
			input.runId,
			orgId,
			context.env.ENVIRONMENT,
		);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);

		const reconciled = await reconcileSkillRunWithEngine(
			context,
			orgId,
			run as SkillRun,
		);
		return publicSkillRun(reconciled.run, reconciled.engine);
	});

export const skillsRunWorkflowCancel = authedSkills.runWorkflowCancel
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRun(
			context.db,
			input.runId,
			orgId,
			context.env.ENVIRONMENT,
		);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		if (isPendingSkillWorkflowAdmission(run)) {
			throw createError(
				ErrorCodes.CONFLICT,
				"WORKFLOW_ADMISSION_PENDING: the engine admission result is still ambiguous; inspect status and retry cancellation once admission is reconciled",
			);
		}

		if (["completed", "failed", "canceled"].includes(run.status)) {
			const outcome = kernelRunStatusToSubmissionOutcome(run.status);
			if (outcome) {
				await settleTediSubmission(context.db, {
					runId: run.id,
					organizationId: orgId,
					outcome,
					expectedWorkflowExecutionEpoch: run.executionEpoch ?? 0,
				});
			}
			return { runId: run.id, status: run.status, engine: null };
		}

		// Durable abort intent BEFORE the runtime RPC: a failed
		// /cancel call no longer loses the operator's intent — recovery honors the
		// stamp. Fail-soft: never blocks the cancel.
		const abort = await requestRunAbort(context.db, {
			runId: run.id,
			organizationId: orgId,
			reason: "skill workflow cancel requested by operator",
		});
		let remote: SkillRuntimeLifecycleResponse;
		try {
			remote = await callSkillRuntime<SkillRuntimeLifecycleResponse>(
				context,
				"/cancel",
				{
					workflowInstanceId: run.workflowInstanceId,
					runId: run.id,
					expectedExecutionEpoch: run.executionEpoch ?? 0,
					rollback: input.rollback,
				},
			);
		} catch (error) {
			if (!abort.requested || !isRecoverableSkillRuntimeCancelFailure(error)) {
				throw error;
			}

			// The intent is durable even though this request did not reach (or get a
			// reply from) the runtime. Re-read first so a terminal engine projection
			// that won the race is never hidden behind a nonterminal acknowledgement.
			const refreshed = await getSkillRun(
				context.db,
				run.id,
				orgId,
				context.env.ENVIRONMENT,
			);
			const finalStatus = refreshed?.status ?? run.status;
			const outcome = kernelRunStatusToSubmissionOutcome(finalStatus);
			if (outcome) {
				await settleTediSubmission(context.db, {
					runId: run.id,
					organizationId: orgId,
					outcome,
					expectedWorkflowExecutionEpoch:
						refreshed?.executionEpoch ?? run.executionEpoch ?? 0,
				});
				return { runId: run.id, status: finalStatus, engine: null };
			}
			return {
				runId: run.id,
				status: finalStatus,
				engine: null,
				cancellation: { state: "stopping" as const, durable: true as const },
			};
		}
		const refreshed = await getSkillRun(
			context.db,
			run.id,
			orgId,
			context.env.ENVIRONMENT,
		);
		const finalStatus = refreshed?.status ?? remote.status;
		const outcome = kernelRunStatusToSubmissionOutcome(finalStatus);
		if (outcome) {
			await settleTediSubmission(context.db, {
				runId: run.id,
				organizationId: orgId,
				outcome,
				expectedWorkflowExecutionEpoch:
					refreshed?.executionEpoch ??
					remote.executionEpoch ??
					run.executionEpoch ??
					0,
			});
		}
		return {
			runId: run.id,
			status: finalStatus,
			engine: skillRuntimeLifecycleEngine(remote),
		};
	});

export const skillsRunWorkflowSendEvent = authedSkills.runWorkflowSendEvent
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRun(
			context.db,
			input.runId,
			orgId,
			context.env.ENVIRONMENT,
		);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		let payload = input.payload ?? {};
		if (input.type.startsWith("connection_recovery_")) {
			if (
				!/^connection_recovery_[0-9a-f]{24}$/.test(input.type) ||
				!["queued", "running", "paused"].includes(run.status) ||
				run.restartRequestedAt
			) {
				throw createError(
					ErrorCodes.CONFLICT,
					"Connection recovery is stale or unavailable",
				);
			}
			const epoch = run.executionEpoch ?? 0;
			const artifact = await getRunArtifact(
				context.db,
				run.id,
				`epochs/${epoch}/controls/${input.type}.json`,
			);
			let value: unknown = null;
			try {
				value = JSON.parse(artifact?.contentInline ?? "null");
			} catch {
				/* fail closed */
			}
			const pending = validateConnectionRecoveryReceipt(
				value,
				epoch,
				input.type,
			);
			if (
				!isMethodAllowed(
					parseCapabilityManifest(run.skillDoc ?? ""),
					pending.namespace,
					pending.method,
				)
			) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Pending operation is outside the run-pinned skill capability manifest",
				);
			}
			const org = await getOrganizationById(context.db, orgId);
			if (!org?.descopeTenantId)
				throw createError(ErrorCodes.CONFLICT, "Connection tenant unavailable");
			const { fetchNamedConnection } =
				await import("./connections/policy-resolution");
			const actingUser = context.descopeUserId ?? context.user?.sub;
			if (
				pending.recovery.scope === "user" &&
				(!actingUser || run.createdBy !== `user:${actingUser}`)
			) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Only the run's original personal connection owner may continue it",
				);
			}
			const owner =
				pending.recovery.scope === "user"
					? { userId: actingUser! }
					: { organizationId: orgId, tenantId: org.descopeTenantId };
			const token = await fetchNamedConnection(
				context,
				owner,
				pending.recovery.providerId,
				pending.recovery.connectionInstanceId,
				pending.recovery.scopes,
			);
			if (
				!token ||
				(Number(token.expiresAt ?? 0) > 0 &&
					Number(token.expiresAt) <= Date.now() / 1000)
			) {
				throw createError(
					ErrorCodes.CONFLICT,
					"Reconnect the exact selected account with the required scopes before continuing",
				);
			}
			// Never trust connectionVerified or account selectors submitted by clients.
			payload = { connectionVerified: true, eventType: input.type };
		}
		const result = await callSkillRuntime<{ ok: boolean }>(context, "/event", {
			runId: run.id,
			expectedExecutionEpoch: run.executionEpoch ?? 0,
			type: input.type,
			payload,
		});
		return { ok: result.ok };
	});

export function assertExpectedSkillRevision(
	expected: number | undefined,
	actual: number,
) {
	if (expected !== undefined && expected !== actual) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Skill changed after trigger admission; review the current revision before running",
		);
	}
}

export function validateConnectionRecoveryReceipt(
	value: unknown,
	epoch: number,
	eventType: string,
) {
	const parsed = SkillWorkflowConnectionRecoverySchema.safeParse(value);
	if (
		!parsed.success ||
		parsed.data.status !== "waiting" ||
		parsed.data.executionEpoch !== epoch ||
		parsed.data.eventType !== eventType
	) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Connection recovery receipt is missing, resolved, or stale",
		);
	}
	return parsed.data;
}

function compactSkillRun(run: SkillRunSummaryRow) {
	// SkillRunSummaryRow carries params/capabilityManifest for internal
	// consumers (reliability expected-outcome policy) — they are NOT part of
	// the SkillRunSummary wire contract. This router skips oRPC output
	// validation, and the MCP edge validates structuredContent strictly
	// (additionalProperties: false), so leaking extra keys fails every
	// aggregate run_workflow_history call outright. Destructure them out.
	const {
		params: _params,
		capabilityManifest: _capabilityManifest,
		...summary
	} = run;
	return {
		...summary,
		hasResult: Boolean(run.hasResult),
		hasError: Boolean(run.hasError),
	};
}

export const skillsRunWorkflowHistory = authedSkills.runWorkflowHistory
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		let runs: SkillRunSummaryRow[];
		if (input.tediId) {
			runs = await listSkillRunsForTedi(
				context.db,
				orgId,
				input.tediId,
				context.env.ENVIRONMENT,
				{
					limit: input.limit,
					...(input.offset ? { offset: input.offset } : {}),
					...(input.reconcile === false ? { metadataOnly: true } : {}),
					status: input.status,
					skillId: input.skillId,
					skillTag: input.skillTag,
				},
			);
		} else if (input.skillId) {
			runs = await listSkillRunsForSkill(
				context.db,
				orgId,
				input.skillId,
				context.env.ENVIRONMENT,
				{
					limit: input.limit,
					...(input.offset ? { offset: input.offset } : {}),
					...(input.reconcile === false ? { metadataOnly: true } : {}),
					status: input.status,
					skillTag: input.skillTag,
				},
			);
		} else {
			// No filter — org-wide fleet view of recent runs across every tedi
			// and skill. Summary rows carry skillSlug/skillRevision, so the list
			// is self-describing for operators.
			runs = await listSkillRunsForOrg(
				context.db,
				orgId,
				context.env.ENVIRONMENT,
				{
					limit: input.limit,
					...(input.offset ? { offset: input.offset } : {}),
					...(input.reconcile === false ? { metadataOnly: true } : {}),
					status: input.status,
					skillTag: input.skillTag,
				},
			);
		}

		// Reconcile-on-list: without this, rows only advance when someone polls
		// runWorkflowStatus for that specific run, so unattended (cron) dispatches
		// stay "running" in every list forever. A crash-window restart can retain
		// the prior terminal projection while restartRequestedAt is open, so it is
		// repairable here too. Bounded to the most recent eligible rows per request;
		// repaired rows drop out of the bound on the next read.
		const repairable = (input.reconcile ? runs : [])
			.filter(
				(row) =>
					["queued", "running", "paused"].includes(row.status) ||
					row.restartRequestedAt != null,
			)
			.slice(0, 5);
		await Promise.all(
			repairable.map(async (row) => {
				try {
					const full = await getSkillRun(
						context.db,
						row.id,
						orgId,
						context.env.ENVIRONMENT,
					);
					if (!full) return;
					const { run: refreshed } = await reconcileSkillRunWithEngine(
						context,
						orgId,
						full as SkillRun,
						"skills.runWorkflowHistory",
					);
					row.status = refreshed.status;
					row.executionEpoch = refreshed.executionEpoch ?? row.executionEpoch;
					row.restartRequestedAt = refreshed.restartRequestedAt ?? null;
					row.workflowRetiredAt = refreshed.workflowRetiredAt ?? null;
					row.completedAt = refreshed.completedAt ?? null;
					row.pausedAt = refreshed.pausedAt ?? null;
					row.hasResult =
						!refreshed.workflowRetiredAt && refreshed.result != null;
					row.hasError = refreshed.error != null;
				} catch (error) {
					console.warn(
						`[skills.runWorkflowHistory] reconcile failed for ${row.id}:`,
						error,
					);
				}
			}),
		);

		// A reconciled row may no longer match an explicit status filter.
		const filtered = input.status
			? runs.filter((row) => row.status === input.status)
			: runs;
		return { runs: filtered.map(compactSkillRun) };
	});

export const skillsListWorkflowRetryCandidates =
	authedSkills.listWorkflowRetryCandidates
		.use(AUTHZ.tedisRead)
		.handler(async ({ input, context }) => {
			const orgId = requireOrgId(context);
			const rows = await listSkillWorkflowRetryCandidateRuns(
				context.db,
				orgId,
				context.env.ENVIRONMENT,
				input.limit,
			);
			const candidates = await Promise.all(
				rows.map(async (row) => {
					const stored = await getSkillRun(
						context.db,
						row.id,
						orgId,
						context.env.ENVIRONMENT,
					);
					if (
						!stored ||
						stored.workflowRetiredAt ||
						stored.restartRequestedAt
					) {
						return null;
					}
					try {
						const { run } = await reconcileSkillRunWithEngine(
							context,
							orgId,
							stored as SkillRun,
							"skills.listWorkflowRetryCandidates",
						);
						if (
							run.status !== "failed" ||
							run.workflowRetiredAt ||
							run.restartRequestedAt
						) {
							return null;
						}
						const executionEpoch = run.executionEpoch ?? 0;
						return {
							runId: run.id,
							tediId: run.tediId,
							skillId: run.skillId,
							skillSlug: row.skillSlug ?? null,
							status: "failed" as const,
							executionEpoch,
							restartId: `activity:${run.id}:${executionEpoch}`,
							failedAt: run.completedAt ?? null,
							error: run.error ?? null,
						};
					} catch (error) {
						console.warn(
							`[skills.listWorkflowRetryCandidates] reconcile failed for ${row.id}:`,
							error,
						);
						return null;
					}
				}),
			);
			return {
				candidates: candidates.filter((candidate) => candidate !== null),
			};
		});

export const skillsInspectWorkflowRun = authedSkills.inspectWorkflowRun
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const storedRun = await getSkillRunForEnvironment(
			context,
			input.runId,
			orgId,
		);
		if (!storedRun) {
			throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		}
		requireWorkflowRunTedi(storedRun, input.tediId);
		const reconciled = await reconcileSkillRunWithEngine(
			context,
			orgId,
			storedRun as SkillRun,
			"skills.inspectWorkflowRun",
		);
		const run = reconciled.run;

		const { resolved, warnings } = await resolveSkillRunArtifacts(
			context,
			run.id,
			input.includeArtifactContent,
		);
		const parsed = parseSkillWorkflowRecords(resolved, {
			includeContent: input.includeArtifactContent,
		});
		const inspectionRecordLimit = 1_000;
		if (
			parsed.steps.length > inspectionRecordLimit ||
			parsed.toolCalls.length > inspectionRecordLimit
		) {
			warnings.push(
				`Structured inspection was truncated at ${inspectionRecordLimit} step/call records; use the paginated step and tool-call tools for deeper review.`,
			);
		}
		if (run.workflowSource == null) {
			warnings.push(
				"This executed run has no pinned workflow source snapshot.",
			);
		}
		if (run.skillDoc == null) {
			warnings.push("This executed run has no pinned SKILL.md snapshot.");
		}
		const runtimeVariants =
			parseSkillWorkflowRuntimeVariants(resolved).get(run.id) ?? [];
		if (runtimeVariants.some((variant) => variant.observation === "blocked")) {
			warnings.push(
				"Runtime drift was detected and blocked before tenant code resumed. Restart this workflow to enter a new execution epoch under the new runtime.",
			);
		} else if (
			runtimeVariants.some((variant) => variant.observation === "compatible")
		) {
			warnings.push(
				"A fresh immutable Loader resumed this execution epoch under the same certified execution-compatibility surface.",
			);
		} else if (
			new Set(runtimeVariants.map((variant) => variant.loaderConfigHash)).size >
			1
		) {
			warnings.push(
				"Multiple immutable Loader/runtime variants were observed across this run's epochs or replays; review revision.runtimeVariants before attributing behavior to one deploy.",
			);
		}

		return {
			run: publicSkillRun(run, reconciled.engine),
			revision: await skillWorkflowRevision(
				run,
				parseSkillWorkflowRuntimeProvenance(
					resolved.find(({ artifact }) => artifact.path === "manifest.json")
						?.content ?? null,
				),
				runtimeVariants,
			),
			workflowSource: input.includeSource ? run.workflowSource : undefined,
			skillDoc: input.includeSource ? run.skillDoc : undefined,
			artifacts: resolved.map(({ artifact }) =>
				summarizeSkillRunArtifact(artifact),
			),
			steps: parsed.steps.slice(0, inspectionRecordLimit),
			toolCalls: parsed.toolCalls.slice(0, inspectionRecordLimit),
			warnings,
		};
	});

export const skillsListWorkflowSteps = authedSkills.listWorkflowSteps
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		const { resolved, truncated } = await resolveSkillRunArtifacts(
			context,
			run.id,
			false,
			true,
			input.limit,
			"steps",
			{
				offset: input.offset,
				stepName: input.name,
				stepKind: input.kind,
			},
		);
		let steps = parseSkillWorkflowRecords(resolved, {
			includeContent: input.includeContent,
		}).steps;
		if (input.name) steps = steps.filter((step) => step.name === input.name);
		if (input.kind) steps = steps.filter((step) => step.kind === input.kind);
		const projectionTruncated = truncated || steps.length > input.limit;
		return {
			steps: steps.slice(0, input.limit),
			truncated: projectionTruncated,
			nextOffset: projectionTruncated ? input.offset + input.limit : null,
		};
	});

export const skillsListWorkflowToolCalls = authedSkills.listWorkflowToolCalls
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		const { resolved, truncated } = await resolveSkillRunArtifacts(
			context,
			run.id,
			false,
			true,
			input.limit,
			"calls",
			{
				offset: input.offset,
				stepName: input.stepName,
				attempt: input.attempt,
			},
		);
		let toolCalls = parseSkillWorkflowRecords(resolved, {
			includeContent: input.includeContent,
		}).toolCalls;
		if (input.stepName) {
			toolCalls = toolCalls.filter((call) => call.name === input.stepName);
		}
		if (input.attempt) {
			toolCalls = toolCalls.filter((call) => call.attempt === input.attempt);
		}
		const projectionTruncated = truncated || toolCalls.length > input.limit;
		return {
			toolCalls: toolCalls.slice(0, input.limit),
			truncated: projectionTruncated,
			nextOffset: projectionTruncated ? input.offset + input.limit : null,
		};
	});

export const skillsListWorkflowRevisions = authedSkills.listWorkflowRevisions
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const skillId = await resolveWorkflowSkillId(context, orgId, input);
		if (input.tediId) await requireOwnedTedi(context, input.tediId, orgId);
		const runs = await listSkillRunSnapshotsForSkill(
			context.db,
			orgId,
			skillId,
			context.env.ENVIRONMENT,
			{
				tediId: input.tediId,
				limit: input.limit,
			},
		);
		const { listRunArtifactsForRunsByPath } =
			await import("@tedix/db/queries/skill-run-artifacts");
		const manifests = await listRunArtifactsForRunsByPath(
			context.db,
			runs.map((run) => run.id),
			"manifest.json",
		);
		const runtimes = new Map<string, SkillWorkflowRuntimeProvenance>();
		await Promise.all(
			manifests.map(async (manifest) => {
				runtimes.set(
					manifest.runId,
					parseSkillWorkflowRuntimeProvenance(
						await resolveArtifactText(context, manifest),
					),
				);
			}),
		);
		const runtimeVariants = await loadSkillWorkflowRuntimeVariants(
			context,
			runs.map((run) => run.id),
		);
		const observed = await Promise.all(
			runs.map((run) =>
				skillWorkflowRevision(
					run,
					runtimes.get(run.id),
					runtimeVariants.get(run.id),
				),
			),
		);
		const unique = new Map<string, (typeof observed)[number]>();
		for (const revision of observed) {
			const key = [
				revision.revision ?? "null",
				revision.workflowSourceSha256 ?? "missing",
				revision.skillDocSha256 ?? "missing",
				revision.workerVersionId ?? "legacy-worker",
				revision.executionCompatibilityHash ?? "legacy-execution-compatibility",
				revision.dispatchShimVersion ?? "legacy-shim",
				revision.compatibilityDate ?? "legacy-compatibility-date",
				revision.dynamicWorkflowsVersion ?? "legacy-dynamic-workflows",
				revision.loaderConfigHash ?? "legacy-loader-config",
				revision.tenantCpuMs ?? "legacy-cpu-limit",
				revision.tenantSubRequests ?? "legacy-subrequest-limit",
			].join(":");
			const current = unique.get(key);
			if (!current) {
				unique.set(key, revision);
				continue;
			}
			current.observedRunCount += 1;
			current.completedCount += revision.completedCount;
			current.failedCount += revision.failedCount;
			current.canceledCount += revision.canceledCount;
			if (
				revision.firstObservedAt &&
				(!current.firstObservedAt ||
					revision.firstObservedAt < current.firstObservedAt)
			) {
				current.firstObservedAt = revision.firstObservedAt;
			}
			if (
				revision.lastObservedAt &&
				(!current.lastObservedAt ||
					revision.lastObservedAt > current.lastObservedAt)
			) {
				current.lastObservedAt = revision.lastObservedAt;
			}
			current.workerVersionId ??= revision.workerVersionId;
			current.workerVersionTag ??= revision.workerVersionTag;
			current.workerVersionTimestamp ??= revision.workerVersionTimestamp;
			current.executionCompatibilityHash ??=
				revision.executionCompatibilityHash;
			current.dispatchShimVersion ??= revision.dispatchShimVersion;
			current.compatibilityDate ??= revision.compatibilityDate;
			current.dynamicWorkflowsVersion ??= revision.dynamicWorkflowsVersion;
			current.loaderConfigHash ??= revision.loaderConfigHash;
			current.tenantCpuMs ??= revision.tenantCpuMs;
			current.tenantSubRequests ??= revision.tenantSubRequests;
			const existingVariantPaths = new Set(
				current.runtimeVariants.map(
					(variant) => `${variant.runId}:${variant.manifestPath}`,
				),
			);
			for (const variant of revision.runtimeVariants) {
				const path = `${variant.runId}:${variant.manifestPath}`;
				if (!existingVariantPaths.has(path)) {
					current.runtimeVariants.push(variant);
					existingVariantPaths.add(path);
				}
			}
			current.runtimeDriftObserved =
				new Set(
					current.runtimeVariants.map((variant) =>
						JSON.stringify([
							variant.workerVersionId,
							variant.executionCompatibilityHash,
							variant.dispatchShimVersion,
							variant.compatibilityDate,
							variant.dynamicWorkflowsVersion,
							variant.loaderConfigHash,
							variant.tenantCpuMs,
							variant.tenantSubRequests,
						]),
					),
				).size > 1;
			current.runtimeDriftBlocked ||= revision.runtimeDriftBlocked;
		}
		return {
			provenance: "observed_executed_runs" as const,
			sampledRunCount: runs.length,
			mayBeTruncated: runs.length >= input.limit,
			revisions: [...unique.values()],
		};
	});

export const skillsGetWorkflowRevision = authedSkills.getWorkflowRevision
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		const [runtime, variants] = await Promise.all([
			loadSkillWorkflowRuntimeProvenance(context, run.id),
			loadSkillWorkflowRuntimeVariants(context, [run.id]),
		]);
		return {
			provenance: "observed_executed_run" as const,
			revision: await skillWorkflowRevision(run, runtime, variants.get(run.id)),
			workflowSource: input.includeSource ? run.workflowSource : undefined,
			skillDoc: input.includeSource ? run.skillDoc : undefined,
		};
	});

export const skillsCompareWorkflowRevisions =
	authedSkills.compareWorkflowRevisions
		.use(AUTHZ.tedisRead)
		.handler(async ({ input, context }) => {
			const orgId = requireOrgId(context);
			const [baselineRun, candidateRun] = await Promise.all([
				getSkillRunForEnvironment(context, input.baselineRunId, orgId),
				getSkillRunForEnvironment(context, input.candidateRunId, orgId),
			]);
			if (!baselineRun || !candidateRun) {
				throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
			}
			requireWorkflowRunTedi(baselineRun, input.tediId);
			requireWorkflowRunTedi(candidateRun, input.tediId);
			if (baselineRun.skillId !== candidateRun.skillId) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Workflow revision comparison requires runs from the same skill",
				);
			}
			const [baselineRuntime, candidateRuntime, variants] = await Promise.all([
				loadSkillWorkflowRuntimeProvenance(context, baselineRun.id),
				loadSkillWorkflowRuntimeProvenance(context, candidateRun.id),
				loadSkillWorkflowRuntimeVariants(context, [
					baselineRun.id,
					candidateRun.id,
				]),
			]);
			const [baseline, candidate] = await Promise.all([
				skillWorkflowRevision(
					baselineRun,
					baselineRuntime,
					variants.get(baselineRun.id),
				),
				skillWorkflowRevision(
					candidateRun,
					candidateRuntime,
					variants.get(candidateRun.id),
				),
			]);
			const lineCount = (value: string | null) =>
				value == null ? null : value.split(/\r?\n/).length;
			const baselineSourceLines = lineCount(baselineRun.workflowSource);
			const candidateSourceLines = lineCount(candidateRun.workflowSource);
			const baselineDocLines = lineCount(baselineRun.skillDoc);
			const candidateDocLines = lineCount(candidateRun.skillDoc);
			return {
				provenance: "observed_executed_runs" as const,
				baseline,
				candidate,
				changes: {
					revisionDelta:
						baseline.revision == null || candidate.revision == null
							? null
							: candidate.revision - baseline.revision,
					workflowSourceChanged:
						baseline.workflowSourceSha256 !== candidate.workflowSourceSha256,
					skillDocChanged: baseline.skillDocSha256 !== candidate.skillDocSha256,
					workerVersionChanged:
						baseline.workerVersionId !== candidate.workerVersionId,
					executionCompatibilityChanged:
						baseline.executionCompatibilityHash !==
						candidate.executionCompatibilityHash,
					compatibilityDateChanged:
						baseline.compatibilityDate !== candidate.compatibilityDate,
					dispatchShimVersionChanged:
						baseline.dispatchShimVersion !== candidate.dispatchShimVersion,
					dynamicWorkflowsVersionChanged:
						baseline.dynamicWorkflowsVersion !==
						candidate.dynamicWorkflowsVersion,
					loaderConfigChanged:
						baseline.loaderConfigHash !== candidate.loaderConfigHash,
					tenantLimitsChanged:
						baseline.tenantCpuMs !== candidate.tenantCpuMs ||
						baseline.tenantSubRequests !== candidate.tenantSubRequests,
					workflowSourceLineDelta:
						baselineSourceLines == null || candidateSourceLines == null
							? null
							: candidateSourceLines - baselineSourceLines,
					skillDocLineDelta:
						baselineDocLines == null || candidateDocLines == null
							? null
							: candidateDocLines - baselineDocLines,
				},
				baselineSource: input.includeSource
					? baselineRun.workflowSource
					: undefined,
				candidateSource: input.includeSource
					? candidateRun.workflowSource
					: undefined,
				baselineSkillDoc: input.includeSource
					? baselineRun.skillDoc
					: undefined,
				candidateSkillDoc: input.includeSource
					? candidateRun.skillDoc
					: undefined,
			};
		});

export const skillsGetWorkflowReliability = authedSkills.getWorkflowReliability
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		if (!input.skillId && !input.slug && !input.tediId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"At least one of skillId, slug, or tediId is required",
			);
		}
		const skillId =
			input.skillId || input.slug
				? await resolveWorkflowSkillId(context, orgId, input)
				: null;
		if (input.tediId) await requireOwnedTedi(context, input.tediId, orgId);
		const runs = input.tediId
			? await listSkillRunsForTedi(
					context.db,
					orgId,
					input.tediId,
					context.env.ENVIRONMENT,
					{
						limit: input.limit,
						skillId: skillId ?? undefined,
					},
				)
			: await listSkillRunsForSkill(
					context.db,
					orgId,
					skillId!,
					context.env.ENVIRONMENT,
					{
						limit: input.limit,
					},
				);
		const { listRunOperationalArtifactsForRuns } =
			await import("@tedix/db/queries/skill-run-artifacts");
		const artifacts = await listRunOperationalArtifactsForRuns(
			context.db,
			runs.map((run) => run.id),
			5_000,
		);
		const runsWithStepEvidence = new Set(
			artifacts
				.filter(
					(artifact) =>
						artifact.path.startsWith("steps/") ||
						/^epochs\/\d+\/steps\//.test(artifact.path),
				)
				.map((artifact) => artifact.runId),
		);
		const runsMissingStepEvidence = runs.filter(
			(run) => !runsWithStepEvidence.has(run.id),
		).length;
		const steps = parseSkillWorkflowRecordsByRun(
			artifacts.map((artifact) => ({ artifact, content: null })),
			{ includeContent: false },
		).steps;
		const warnings: string[] = [];
		if (runsMissingStepEvidence > 0) {
			warnings.push(
				`${runsMissingStepEvidence} of ${runs.length} selected runs have no steps/** evidence; retry, rollback, tool-call, and failed-step counts are lower bounds.`,
			);
		}
		if (artifacts.length >= 5_000) {
			warnings.push(
				"Step evidence hit the 5000-artifact inspection cap; retry and failure counts are lower bounds.",
			);
		}
		return aggregateSkillWorkflowReliability({
			runs,
			steps,
			skillId,
			tediId: input.tediId ?? null,
			warnings,
		});
	});

export const skillsListWorkflowSchedules = authedSkills.listWorkflowSchedules
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		if (input.tediId) await requireOwnedTedi(context, input.tediId, orgId);
		const skillId = input.slug
			? await resolveWorkflowSkillId(context, orgId, input)
			: input.skillId;
		const page = await listSkillSchedulesPage(context.db, orgId, {
			skillId,
			tediId: input.tediId,
			enabled: input.enabled,
			limit: input.limit,
			offset: input.offset,
			query: input.query,
		});
		const nextOffset = input.offset + page.schedules.length;
		return {
			...page,
			offset: input.offset,
			limit: input.limit,
			nextOffset: nextOffset < page.total ? nextOffset : null,
		};
	});

async function applySkillWorkflowLifecycleResponse(
	_context: BaseContext,
	run: SkillRun,
	remote: SkillRuntimeLifecycleResponse,
	_options?: { resetTerminalState?: boolean },
) {
	return {
		runId: run.id,
		status: remote.status,
		engine: skillRuntimeLifecycleEngine(remote),
		executionEpoch: remote.executionEpoch,
		restartId: remote.restartId,
		restartAborted: remote.restartAborted,
		deduplicated: remote.deduplicated,
	};
}

export const skillsPauseWorkflow = authedSkills.pauseWorkflow
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		const remote = await callSkillRuntime<SkillRuntimeLifecycleResponse>(
			context,
			"/pause",
			{
				runId: run.id,
				workflowInstanceId: run.workflowInstanceId,
				expectedExecutionEpoch: run.executionEpoch ?? 0,
			},
		);
		const outcome = kernelRunStatusToSubmissionOutcome(remote.status);
		if (outcome) {
			await settleTediSubmission(context.db, {
				runId: run.id,
				organizationId: orgId,
				outcome,
				expectedWorkflowExecutionEpoch:
					remote.executionEpoch ?? run.executionEpoch ?? 0,
			});
		}
		return applySkillWorkflowLifecycleResponse(context, run, remote);
	});

export const skillsResumeWorkflow = authedSkills.resumeWorkflow
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		const remote = await callSkillRuntime<SkillRuntimeLifecycleResponse>(
			context,
			"/resume",
			{
				runId: run.id,
				workflowInstanceId: run.workflowInstanceId,
				expectedExecutionEpoch: run.executionEpoch ?? 0,
			},
		);
		const outcome = kernelRunStatusToSubmissionOutcome(remote.status);
		if (outcome) {
			await settleTediSubmission(context.db, {
				runId: run.id,
				organizationId: orgId,
				outcome,
				expectedWorkflowExecutionEpoch:
					remote.executionEpoch ?? run.executionEpoch ?? 0,
			});
		}
		return applySkillWorkflowLifecycleResponse(context, run, remote);
	});

export const skillsRestartWorkflow = authedSkills.restartWorkflow
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		const remote = await callSkillRuntime<SkillRuntimeLifecycleResponse>(
			context,
			"/restart",
			{
				runId: run.id,
				workflowInstanceId: run.workflowInstanceId,
				expectedExecutionEpoch: run.executionEpoch ?? 0,
				restartId: input.restartId,
				abortUnknown: input.abortUnknown,
				reason: input.reason,
				from: input.from,
			},
		);
		if (!remote.restartAborted) {
			if (remote.executionEpoch == null) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					"Workflow runtime accepted restart without an execution epoch",
				);
			}
			// Reconcile the additive submission ledger on every confirmed restart,
			// not only when the pre-call skill_runs snapshot looked terminal. This
			// makes a retry repair an engine-first/ledger-second partial failure.
			const submission = await restartTediSubmissionAttempt(context.db, {
				runId: run.id,
				organizationId: orgId,
				tediId: run.tediId,
				restartId: input.restartId,
				executionEpoch: remote.executionEpoch,
			});
			if (!submission.restarted && !submission.alreadyRunning) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					"Workflow engine restarted but its durable submission attempt could not be reopened",
				);
			}
		}
		const result = await applySkillWorkflowLifecycleResponse(
			context,
			run,
			remote,
			{
				resetTerminalState: !["completed", "failed", "canceled"].includes(
					remote.status,
				),
			},
		);
		const outcome = kernelRunStatusToSubmissionOutcome(remote.status);
		if (outcome) {
			await settleTediSubmission(context.db, {
				runId: run.id,
				organizationId: orgId,
				outcome,
				expectedWorkflowExecutionEpoch:
					remote.executionEpoch ?? run.executionEpoch ?? 0,
			});
		}
		return result;
	});

export const skillsApproveWorkflow = authedSkills.approveWorkflow
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		const remote = await callSkillRuntime<SkillRuntimeLifecycleResponse>(
			context,
			"/approve",
			{
				runId: run.id,
				workflowInstanceId: run.workflowInstanceId,
				expectedExecutionEpoch: run.executionEpoch ?? 0,
				approvalId: input.approvalId,
				reason: input.reason,
				payload: input.payload ?? {},
			},
		);
		const outcome = kernelRunStatusToSubmissionOutcome(remote.status);
		if (outcome) {
			await settleTediSubmission(context.db, {
				runId: run.id,
				organizationId: orgId,
				outcome,
				expectedWorkflowExecutionEpoch:
					remote.executionEpoch ?? run.executionEpoch ?? 0,
			});
		}
		return applySkillWorkflowLifecycleResponse(context, run, remote);
	});

export const skillsRejectWorkflow = authedSkills.rejectWorkflow
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		const remote = await callSkillRuntime<SkillRuntimeLifecycleResponse>(
			context,
			"/reject",
			{
				runId: run.id,
				workflowInstanceId: run.workflowInstanceId,
				expectedExecutionEpoch: run.executionEpoch ?? 0,
				approvalId: input.approvalId,
				reason: input.reason,
				payload: input.payload ?? {},
			},
		);
		const outcome = kernelRunStatusToSubmissionOutcome(remote.status);
		if (outcome) {
			await settleTediSubmission(context.db, {
				runId: run.id,
				organizationId: orgId,
				outcome,
				expectedWorkflowExecutionEpoch:
					remote.executionEpoch ?? run.executionEpoch ?? 0,
			});
		}
		return applySkillWorkflowLifecycleResponse(context, run, remote);
	});

// =============================================================================
// SKILL RUN ARTIFACTS
// =============================================================================

const REVOCABLE_SKILL_RUN_STATUSES = new Set<SkillRunStatus>([
	"completed",
	"failed",
	"canceled",
]);
const TERMINAL_WORKFLOW_ENGINE_STATUSES = new Set([
	"complete",
	"errored",
	"terminated",
]);

function revokedSkillRunReason(error: string | null): string | undefined {
	if (error === "REVOKED") return undefined;
	if (!error?.startsWith("REVOKED:")) return undefined;
	return error.slice("REVOKED:".length).trim() || undefined;
}

function requireRevocableSkillRunProjection(run: SkillRun): void {
	if (isPendingSkillWorkflowAdmission(run)) {
		throw createError(
			ErrorCodes.CONFLICT,
			"WORKFLOW_ADMISSION_PENDING: revoke is blocked until engine admission is reconciled",
		);
	}
	if (run.restartRequestedAt) {
		throw createError(
			ErrorCodes.CONFLICT,
			"WORKFLOW_RESTART_IN_PROGRESS: revoke is blocked while a restart intent is unresolved",
		);
	}
	if (!REVOCABLE_SKILL_RUN_STATUSES.has(run.status)) {
		throw createError(
			ErrorCodes.CONFLICT,
			"WORKFLOW_NOT_TERMINAL: cancel the workflow and confirm a terminal engine state before revoking its artifacts",
		);
	}
}

export const skillsRevokeSkillRun = authedSkills.revokeSkillRun
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		if (input.skillId && run.skillId !== input.skillId) {
			throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		}

		const alreadyRevoked =
			run.error === "REVOKED" || run.error?.startsWith("REVOKED:") === true;
		// Legacy REVOKED rows predate the durable workflow tombstone. Their
		// destructive cleanup already ran under the old contract, so retain the
		// historical no-op behavior without trying to recreate deleted evidence.
		if (alreadyRevoked && !run.workflowRetiredAt) {
			return {
				runId: run.id,
				revoked: true,
				artifactsDeleted: 0,
				r2ObjectsDeleted: 0,
				factsDeleted: 0,
				musclesDeleted: 0,
				reason: revokedSkillRunReason(run.error),
			};
		}

		const reasonText = input.reason?.trim() ?? "";
		const durableClaimed = Boolean(alreadyRevoked && run.workflowRetiredAt);
		let effectiveReasonText = durableClaimed
			? (revokedSkillRunReason(run.error) ?? "")
			: reasonText;
		if (durableClaimed) {
			if (reasonText && reasonText !== effectiveReasonText) {
				throw createError(
					ErrorCodes.CONFLICT,
					"WORKFLOW_REVOKE_CONFLICT: this run was already claimed with a different audit reason",
				);
			}
		} else {
			requireRevocableSkillRunProjection(run);

			// An operator-abort tombstone is itself durable proof that factory
			// entry lost the start/abort race; the runtime intentionally hides its
			// stale prior engine snapshot. All other first claims require a live
			// terminal engine read because D1 terminal state alone may be stale.
			if (!run.workflowRetiredAt) {
				const remote = await callSkillRuntime<SkillRuntimeStatusResponse>(
					context,
					"/status",
					{ workflowInstanceId: run.workflowInstanceId, runId: run.id },
				);
				const engineStatus =
					typeof remote.engine?.status === "string"
						? remote.engine.status
						: null;
				if (
					remote.executionEpoch != null &&
					remote.executionEpoch !== (run.executionEpoch ?? 0)
				) {
					throw createError(
						ErrorCodes.CONFLICT,
						"WORKFLOW_EXECUTION_EPOCH_CONFLICT: the run advanced while revoke was checking engine state",
					);
				}
				if (
					!REVOCABLE_SKILL_RUN_STATUSES.has(remote.status) ||
					!engineStatus ||
					!TERMINAL_WORKFLOW_ENGINE_STATUSES.has(engineStatus)
				) {
					throw createError(
						ErrorCodes.CONFLICT,
						`WORKFLOW_ENGINE_NOT_TERMINAL: observed ${engineStatus ?? "unavailable"}; cancel and confirm terminal status before revoking`,
					);
				}
			}

			const retired = await retireSkillRunForRevocation(context.db, {
				runId: run.id,
				organizationId: orgId,
				runtimeEnvironment: context.env.ENVIRONMENT,
				expectedExecutionEpoch: run.executionEpoch ?? 0,
				reason: reasonText,
			});
			if (!retired) {
				const current = await getSkillRunForEnvironment(context, run.id, orgId);
				const concurrentRevoke = Boolean(
					current?.workflowRetiredAt &&
					(current.error === "REVOKED" ||
						current.error?.startsWith("REVOKED:") === true),
				);
				if (!concurrentRevoke) {
					throw createError(
						ErrorCodes.CONFLICT,
						"WORKFLOW_REVOKE_CONFLICT: run lifecycle changed before the retirement claim; inspect status and retry",
					);
				}
				const storedReason =
					revokedSkillRunReason(current?.error ?? null) ?? "";
				if (reasonText && reasonText !== storedReason) {
					throw createError(
						ErrorCodes.CONFLICT,
						"WORKFLOW_REVOKE_CONFLICT: this run was already claimed with a different audit reason",
					);
				}
				effectiveReasonText = storedReason;
			}
		}

		// The workflow tombstone and REVOKED audit marker are now durable. Only
		// after that CAS may source-keyed cleanup begin. Repeating this section is
		// safe and repairs a prior partial D1/R2/fact deletion.
		// 1) D1 artifact rows. The (run_id, path) UNIQUE index handles
		//    dupes; cascade FK takes care of any future child tables.
		const { listRunArtifacts, deleteRunArtifacts } =
			await import("@tedix/db/queries/skill-run-artifacts");
		const beforeArtifacts = await listRunArtifacts(context.db, run.id);
		const artifactsDeleted = await deleteRunArtifacts(context.db, run.id);

		// 2) R2 objects under `{runId}/` prefix. List then delete in batch.
		//    Skipped if the binding isn't configured (test envs).
		const env = context.env as { SKILL_ARTIFACTS?: R2Bucket };
		let r2ObjectsDeleted = 0;
		if (env.SKILL_ARTIFACTS) {
			let cursor: string | undefined;
			const keysToDelete: string[] = [];
			do {
				const list = await env.SKILL_ARTIFACTS.list({
					prefix: `${run.id}/`,
					cursor,
				});
				for (const obj of list.objects) keysToDelete.push(obj.key);
				cursor = list.truncated ? list.cursor : undefined;
			} while (cursor);

			// R2 batch delete supports up to 1000 keys per call.
			for (let i = 0; i < keysToDelete.length; i += 1000) {
				const batch = keysToDelete.slice(i, i + 1000);
				await env.SKILL_ARTIFACTS.delete(batch);
			}
			r2ObjectsDeleted = keysToDelete.length;

			// Sanity check: if D1 said we had R2-spilled artifacts but R2
			// returned zero objects, the bucket got cleared out-of-band.
			// Surface as a warning in the log; revoke still succeeds.
			const expectedR2 = beforeArtifacts.filter((a) => a.contentR2Key).length;
			if (expectedR2 > 0 && r2ObjectsDeleted < expectedR2) {
				console.warn(
					`[revokeSkillRun] R2 objects deleted (${r2ObjectsDeleted}) < expected (${expectedR2}) for run ${run.id} — bucket may be out of sync with D1`,
				);
			}
		}

		// 3) Source-keyed brain memory facts. Workflow learns default their
		//    `source` to `skill://runs/{runId}` (see memoryGraph.learn — the
		//    X-Tedix-Skill-Run-Id header is the trigger). Hard delete here is
		//    symmetric with the artifact cascade: revoke means gone. Edges
		//    cascade via schema FK; vector embeddings become orphans and get
		//    cleaned by the periodic reindex.
		const { deleteFactsByRunId } =
			await import("@tedix/db/queries/memory-graph/fact-search");
		const factsDeleted = await deleteFactsByRunId(context.db, orgId, run.id);

		// Muscle memory cascade still deferred — muscle entries don't yet
		// carry a run-source link.
		const musclesDeleted = 0;

		return {
			runId: run.id,
			revoked: true,
			artifactsDeleted,
			r2ObjectsDeleted,
			factsDeleted,
			musclesDeleted,
			reason: effectiveReasonText || undefined,
		};
	});

export const skillsGetRunArtifact = authedSkills.getRunArtifact
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		if (input.skillId && run.skillId !== input.skillId) {
			throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		}
		const { getRunArtifact } =
			await import("@tedix/db/queries/skill-run-artifacts");
		const artifact = await getRunArtifact(context.db, input.runId, input.path);
		if (!artifact) {
			throw createError(ErrorCodes.NOT_FOUND, "Artifact not found");
		}
		const artifactRecord = artifact;

		let resolvedContent: string | null | undefined;
		async function resolveContent(): Promise<string | null> {
			if (resolvedContent !== undefined) return resolvedContent;
			if (artifactRecord.contentInline != null) {
				resolvedContent = artifactRecord.contentInline;
				return resolvedContent;
			}
			if (!artifactRecord.contentR2Key) {
				resolvedContent = null;
				return resolvedContent;
			}
			const env = context.env as { SKILL_ARTIFACTS?: R2Bucket };
			if (!env.SKILL_ARTIFACTS) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					"SKILL_ARTIFACTS R2 binding not configured",
				);
			}
			const obj = await env.SKILL_ARTIFACTS.get(artifactRecord.contentR2Key);
			if (!obj) {
				throw createError(
					ErrorCodes.NOT_FOUND,
					`Artifact R2 object missing: ${artifactRecord.contentR2Key}`,
				);
			}
			resolvedContent = await obj.text();
			return resolvedContent;
		}

		let resolvedMedia: { base64: string; mimeType: string } | null | undefined;
		async function resolveMedia(): Promise<{
			base64: string;
			mimeType: string;
		} | null> {
			if (resolvedMedia !== undefined) return resolvedMedia;
			if (
				input.mediaUrl &&
				!input.mediaInline &&
				artifactRecord.sizeBytes > MEDIA_URL_METADATA_MAX_BYTES
			) {
				resolvedMedia = null;
				return resolvedMedia;
			}
			const content = await resolveContent();
			if (!content) {
				resolvedMedia = null;
				return resolvedMedia;
			}
			const { extractMediaBase64 } = await import("../../lib/skill-media-url");
			resolvedMedia = extractMediaBase64(content);
			return resolvedMedia;
		}

		// Optional signed media URL (browser-viewable, short-lived). Minted with
		// SECRETS_MASTER_KEY as the HMAC key; served by the public
		// GET /skill-media/:runId/*path route.
		let url: string | null = null;
		let urlExpiresAt: string | null = null;
		if (input.mediaUrl) {
			const { signMediaUrl } = await import("../../lib/skill-media-url");
			const { untrustedContentBaseUrl } =
				await import("../../lib/untrusted-origin");
			const signed = await signMediaUrl({
				// See events-artifacts.ts: the untrusted-content origin when one is
				// provisioned, the shared API origin (sandbox-CSP mitigated) when not.
				baseUrl: untrustedContentBaseUrl(context.env, context.env.API_URL),
				secret: context.env.SECRETS_MASTER_KEY,
				runId: input.runId,
				path: input.path,
				nowMs: Date.now(),
			});
			url = signed.url;
			urlExpiresAt = signed.expiresAt;
		}

		const media =
			input.mediaUrl || input.mediaInline ? await resolveMedia() : null;
		const mediaKind = mediaKindFromMimeType(media?.mimeType);
		const meta = {
			path: artifactRecord.path,
			mimeType: artifactRecord.mimeType,
			sizeBytes: artifactRecord.sizeBytes,
			outcome: artifactRecord.outcome,
			attempt: artifactRecord.attempt,
			createdAt: artifactRecord.createdAt ?? null,
			sha256: artifactRecord.sha256 ?? null,
			url,
			urlExpiresAt,
			mediaMimeType: media?.mimeType ?? null,
			mediaPath: mediaKind
				? `/skill-runs/${input.runId}/media/${input.path}?kind=${mediaKind}`
				: null,
			mediaKind,
		};

		// Session-authed inline media: resolve content (inline or R2), extract the
		// base64 + mime, and return them ready for a `data:` URL. No expiring token,
		// so the reference survives transcript scrollback (unlike `mediaUrl`). The
		// decode-from-base64 happens client-side, not here — we pass the base64
		// through, avoiding any in-handler decode work.
		if (input.mediaInline) {
			return {
				...meta,
				content: null,
				r2Available:
					artifactRecord.contentInline == null && !!artifactRecord.contentR2Key,
				mediaBase64: media?.base64 ?? null,
			};
		}

		if (artifactRecord.contentInline != null) {
			// When a URL was requested, skip echoing the (possibly large) inline body.
			return {
				...meta,
				content: input.mediaUrl ? null : artifactRecord.contentInline,
				r2Available: false,
			};
		}
		if (!artifactRecord.contentR2Key) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Artifact has neither inline content nor R2 key",
			);
		}
		// With a signed URL the route streams the bytes; no need to pull the
		// large R2 object back through this RPC.
		if (input.mediaUrl) {
			return { ...meta, content: null, r2Available: true };
		}
		const text = await resolveContent();
		return { ...meta, content: text, r2Available: true };
	});

export const skillsListRunArtifacts = authedSkills.listRunArtifacts
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		if (input.skillId && run.skillId !== input.skillId) {
			throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		}
		const { listRunArtifactsPage } =
			await import("@tedix/db/queries/skill-run-artifacts");
		const fetched = await listRunArtifactsPage(context.db, input.runId, {
			limit: input.limit + 1,
			offset: input.offset,
		});
		const truncated = fetched.length > input.limit;
		const artifacts = fetched.slice(0, input.limit);
		return {
			artifacts: artifacts.map((a) => ({
				path: a.path,
				mimeType: a.mimeType,
				sizeBytes: a.sizeBytes,
				outcome: a.outcome,
				attempt: a.attempt,
				storage: (a.contentR2Key ? "r2" : "inline") as "inline" | "r2",
				createdAt: a.createdAt ?? null,
				sha256: a.sha256 ?? null,
			})),
			truncated,
			nextOffset: truncated ? input.offset + artifacts.length : null,
		};
	});
