import { buildSkillWorkflowTimeline } from "../../../services/skill-workflow-timeline";
import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
import { SkillWorkflowConnectionRecoverySchema } from "@tedix/api-contract/schemas/cognitive";
import {
	getRunArtifact,
	listRunTimelineArtifacts,
} from "@tedix/db/queries/skill-run-artifacts";
import {
	isMethodAllowed,
	parseCapabilityManifest,
} from "@tedix/api-contract/utils/skill-manifest";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import {
	getSkillRun,
	listSkillRunsForOrg,
	listSkillRunsForSkill,
	listSkillRunsForTedi,
	listSkillWorkflowRetryCandidateRuns,
	type SkillRun,
	type SkillRunSummaryRow,
} from "@tedix/db/queries/skill-runs";
import {
	isPendingSkillWorkflowAdmission,
	kernelRunStatusToSubmissionOutcome,
	requestRunAbort,
	settleTediSubmission,
} from "../../../kernel/runtime-submission-bridge";
import { callSkillRuntime } from "../../../services/skill-runtime-client";
import {
	parseSkillWorkflowRecords,
	summarizeSkillRunArtifact,
} from "../../../services/skill-workflow-inspection";
import { AUTHZ, createError, ErrorCodes } from "../../orpc";
import { requireOrgId } from "../../org-scope";
import { authedSkills } from "../cognitive-shared";
import {
	parseSkillWorkflowRuntimeProvenance,
	parseSkillWorkflowRuntimeVariants,
	skillWorkflowRevision,
} from "../cognitive-skill-run-provenance";
import {
	requireWorkflowRunTedi,
	publicSkillRun,
	type SkillRuntimeLifecycleResponse,
	isRecoverableSkillRuntimeCancelFailure,
	skillRuntimeLifecycleEngine,
	getSkillRunForEnvironment,
	resolveSkillRunArtifacts,
} from "./shared";
import { reconcileSkillRunWithEngine } from "./run-start";

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
				await import("../connections/policy-resolution");
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
						`[skills.runWorkflowHistory] reconcile failed for ${row.id}`,
						{ exception: safeExceptionTopology(error) },
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
							`[skills.listWorkflowRetryCandidates] reconcile failed for ${row.id}`,
							{ exception: safeExceptionTopology(error) },
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

export const skillsGetWorkflowRunTimeline = authedSkills.getWorkflowRunTimeline
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const run = await getSkillRunForEnvironment(context, input.runId, orgId);
		if (!run) throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		requireWorkflowRunTedi(run, input.tediId);
		if (
			run.workflowRetiredAt ||
			run.error === "REVOKED" ||
			run.error?.startsWith("REVOKED:")
		) {
			throw createError(ErrorCodes.NOT_FOUND, "Skill run not found");
		}
		const artifacts = await listRunTimelineArtifacts(
			context.db,
			run.id,
			run.executionEpoch ?? 0,
		);
		return buildSkillWorkflowTimeline(run, artifacts);
	});
