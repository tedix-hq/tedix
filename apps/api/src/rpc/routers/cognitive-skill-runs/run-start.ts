import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import { validatePersonalRunSources } from "../../../services/personal-resource-delegation-authority";
import { isServiceBinding } from "@tedix/worker-kit/request-auth";
import {
	parseCapabilityManifest,
	type RationaleMode,
} from "@tedix/api-contract/utils/skill-manifest";
import {
	getSkillEntry,
	getSkillEntryBySlug,
} from "@tedix/db/queries/cognitive/skill-crud";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import {
	getSkillRun,
	type SkillRun,
	setSkillRunCostSummary,
} from "@tedix/db/queries/skill-runs";
import {
	getWorkItemById,
	createWorkItem,
} from "@tedix/db/queries/work-items/crud";
import {
	buildSurfaceUrl,
	platformDomainForEnvironment,
} from "@tedix/tenant-directory";
import { workItemPurposeFor } from "@tedix/db/queries/work-items/purpose";
import {
	isPendingSkillWorkflowAdmission,
	kernelRunStatusToSubmissionOutcome,
	recordTediSubmissionStarted,
	restartTediSubmissionAttempt,
	settleTediSubmission,
} from "../../../kernel/runtime-submission-bridge";
import { callSkillRuntime } from "../../../services/skill-runtime-client";
import {
	computeSkillRunCostSummary,
	parseSkillWorkflowRecords,
} from "../../../services/skill-workflow-inspection";
import { episodeTraceId } from "../../episode-trace";
import { AUTHZ, type BaseContext, createError, ErrorCodes } from "../../orpc";
import { insertRuntimeEvent } from "../cognitive-runtime/events-policy";
import { requireOrgId } from "../../org-scope";
import { authedSkills } from "../cognitive-shared";
import {
	requireOwnedTedi,
	assertExpectedSkillRevision,
	type SkillRuntimeRunResponse,
	resolveSkillRunArtifacts,
	type SkillRuntimeStatusResponse,
} from "./shared";

export const skillsRunWorkflow = authedSkills.runWorkflow
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		if (
			input.certification &&
			(context.authType !== "user" ||
				!context.user?.sub ||
				context.tediId ||
				context.externalAgentPrincipalId ||
				!["owner", "admin"].includes(context.userRole ?? ""))
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Certification runs require a signed-in organization owner or admin",
			);
		}
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
		if (
			skill.lifecycleState === "draft" &&
			skill.sourceSkillId &&
			skill.tags?.includes("workflow-improvement") &&
			!input.certification
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Draft workflow improvement proposals require certification=true from a signed-in organization owner or admin. Ask that person to run the reviewed proposal revision with the intended probe params, then share the completed run ID. Work admission and params.probe do not grant certification authority.",
			);
		}

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
		const resourceAccessEnvelope = input.resourceAccessEnvelope
			? await validatePersonalRunSources(context, {
					tediId: input.tediId,
					skillId: skill.id,
					resourceAccessEnvelope: input.resourceAccessEnvelope,
				})
			: undefined;

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
				certification: input.certification ?? false,
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
				resourceAccessEnvelope,
			},
		);

		if (input.certification) {
			await insertAuditEvent(context.db, {
				id: `skill-certification:${dispatched.runId}`,
				ignoreDuplicates: true,
				organizationId: orgId,
				actorId: context.user!.sub!,
				actorType: "user",
				action: "skill.certification.started",
				resourceType: "skill_run",
				resourceId: dispatched.runId,
				metadata: {
					skillId: skill.id,
					revision: skill.revision,
					certification: true,
					reason: input.reason ?? null,
				},
			});
		}

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
				console.warn("[skillsRunWorkflow] dispatch rationale emit failed", {
					exception: safeExceptionTopology(err),
				});
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
		console.warn(`[skills.costSummary] capture failed for ${run.id}`, {
			exception: safeExceptionTopology(error),
		});
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
export async function reconcileSkillRunWithEngine(
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
					`[${logPrefix}] active submission reconciliation failed for ${run.id}`,
					{ exception: safeExceptionTopology(error) },
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
						console.warn("[CognitiveBridge] skill.used emit failed", {
							exception: safeExceptionTopology(err),
						}),
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
						console.warn("[CognitiveBridge] skill.failed emit failed", {
							exception: safeExceptionTopology(err),
						}),
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
				console.warn("[CognitiveBridge] skill.failed work-item alert failed", {
					exception: safeExceptionTopology(err),
				}),
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
		console.warn(`[${logPrefix}] refresh failed for ${run.id}`, {
			exception: safeExceptionTopology(err),
		});
	}

	// Engine refresh failed, but a terminal D1 row can still receive its
	// first-observation cost rollup from durable evidence (fail-soft inside).
	return {
		run: await captureSkillRunCostSummary(context, orgId, run),
		engine: null,
	};
}
