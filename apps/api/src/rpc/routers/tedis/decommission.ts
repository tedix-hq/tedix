import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
import { deleteTedi, updateTedi } from "@tedix/db/queries/tedis";
import { invalidateKernelContextCache } from "../../../kernel/context-cache";
import { auditActor, emitAuditEvent } from "../../audit-helpers";
import { AUTHZ, authedTedisOs, createError, ErrorCodes } from "./helpers";
import {
	type TediCleanupResult,
	purgeTediExternalIdentity,
	requireTediDeleteAccess,
} from "./delete";
import { assertPlatformAdminOrServiceBinding } from "./rebind";
import { agentAdminFetch } from "./runtime-admin";

// =============================================================================
// Runtime admin transport
// =============================================================================

/** Retained decommission admin cleanup requests keep their original 10-second bound. */
const DECOMMISSION_ADMIN_TIMEOUT_MS = 10_000;

function requireSuccessfulAgentMemoryResponse(
	result: Awaited<ReturnType<typeof agentAdminFetch>>,
): Record<string, unknown> {
	if ("error" in result) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			`Agent Memory runtime unavailable: ${result.error}`,
		);
	}
	if (!result.ok || !result.json || typeof result.json !== "object") {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			`Agent Memory runtime returned status ${result.status}`,
		);
	}
	return result.json as Record<string, unknown>;
}

export const inspectAgentMemoryProcedure = authedTedisOs.inspectAgentMemory
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		assertPlatformAdminOrServiceBinding(context);
		const tedi = await requireTediDeleteAccess(context, input.tediId);
		return requireSuccessfulAgentMemoryResponse(
			await agentAdminFetch(context, tedi, "/__admin/agent-memory/inspect", {
				method: "GET",
				query: { sessionId: input.sessionId, query: input.query },
				timeoutMs: 30_000,
			}),
		) as {
			ok: true;
			sessionId: string;
			memories: Record<string, unknown>[];
			recall?: Record<string, unknown>;
		};
	});

// =============================================================================
// decommission / hard-purge
// =============================================================================

/** Outcome of the isolate DO armed-schedule cancellation (Stage 2). */
interface SchedulesStoppedResult {
	attempted: boolean;
	ok: boolean;
	canceledScheduleIds?: string[];
	detail?: string;
}

/** Manual residual step the operator must perform — no programmatic path. */
interface ResidualManualStep {
	step: string;
	reason: string;
	scope: string;
}

/** Structured body of a decommission/purge run (minus the caller-stamped id). */
interface TediDecommissionResult {
	decommissioned: boolean;
	schedulesStopped: SchedulesStoppedResult;
	purged: boolean;
	programmaticCleanups: TediCleanupResult[];
	residualManualSteps: ResidualManualStep[];
}

/**
 * Always-emitted audit payload for a decommission/purge run. `status: "failed"`
 * carries the partial stage outcomes captured up to the throwing stage so a
 * mid-orchestration destructive failure (e.g. identity teardown succeeded, then
 * the D1 delete threw) is never silently un-audited.
 */
interface TediDecommissionAudit {
	status: "completed" | "failed";
	/** Stage outcomes accumulated so far (complete on success, partial on failure). */
	result: TediDecommissionResult;
	/** The stage that threw, on `status: "failed"` only. */
	failedStage?: TediDecommissionStage;
	/** The thrown error's message, on `status: "failed"` only. */
	error?: string;
}

/** Ordered destructive stages, used to label a partial-failure audit. */
type TediDecommissionStage =
	| "decommission"
	| "stop_schedules"
	| "purge_external_identity"
	| "purge_agent_memory"
	| "d1_delete";

/**
 * Side-effecting dependencies of the decommission orchestration, injected so the
 * staged policy (decommission → stop-schedules → optional hard-purge) is unit
 * testable without a live D1/Descope/isolate-runtime context.
 */
interface TediDecommissionDeps {
	/** Stage 1: persist status='paused' + runtime_state='archived'. */
	decommission: () => Promise<boolean>;
	/** Whether this tedi has an isolate DO whose schedules can be cancelled. */
	isIsolateBody: boolean;
	/** Stage 2: invoke the isolate admin dequeue with cancelSchedules. */
	stopSchedules: () => Promise<SchedulesStoppedResult>;
	/** Stage 3: tear down the external identity footprint (Descope/FGA/AIH). */
	purgeExternalIdentity: () => Promise<TediCleanupResult[]>;
	/** Stage 3: delete the supplemental managed-memory profile. */
	purgeAgentMemoryProfile: () => Promise<TediCleanupResult>;
	/** Stage 3: delete the D1 tedis row (cascades tediId-scoped child rows). */
	deleteRow: () => Promise<void>;
	/**
	 * Write the audit record. Invoked exactly once per run — on success with the
	 * full result, and on a thrown failure with the partial stage outcomes — so a
	 * partial destructive teardown is always audited. Must not throw (fail-soft).
	 */
	emitAudit: (audit: TediDecommissionAudit) => void;
}

/**
 * Residual sub-cleanups that have no programmatic path today. We do not fake
 * them — the purge reports them so the operator (or a follow-up automation) can
 * complete the teardown with the scope each requires.
 */
function purgeResidualManualSteps(
	tediId: string,
	orgId: string,
	agentMemoryDeleted: boolean,
): ResidualManualStep[] {
	const steps: ResidualManualStep[] = [
		{
			// Verified against the runtime R2 writers: the runtime keys per-tedi data
			// under `${tediId}/...` directly (not a `tedis/` wrapper). Each prefix
			// below is an actual write path; following the old `tedis/${tediId}/*`
			// instruction would leave all of this data behind.
			step:
				`Delete R2 objects for this tedi in the bucket configured by the TEDI_STORAGE binding. The runtime writes per-tedi data under the bare \`${tediId}/\` key prefix — delete every object under these prefixes: ` +
				[
					`${tediId}/objects/*  (object store)`,
					`${tediId}/tedi_shell_workspace/*  (shell/think workspace spillover)`,
					`${tediId}/harness/runs/*  (redacted trace bundles)`,
					`${tediId}/artifacts/turn_summary/*  (turn-summary artifacts)`,
					`${tediId}/SOUL.md, ${tediId}/IDENTITY.md, ${tediId}/USER.md, ${tediId}/AGENTS.md, ${tediId}/TOOLS.md, ${tediId}/memory/*  (R2 identity fallback)`,
				].join("; ") +
				`. Browser captures are the one exception and use a \`tedis/\` prefix: delete tedis/${tediId}/browser-* AND, for any org that ran this tedi, orgs/<orgId>/tedis/${tediId}/browser-* (browser-captures / browser-sessions / browser-actions).`,
			reason:
				"No programmatic delete-by-prefix exists for the per-tedi storage namespace; the D1 cascade does not touch R2. Runtime R2 keys are `<tediId>/...`, not `tedis/<tediId>/...` — only browser captures use the `tedis/`/`orgs/` prefix.",
			scope:
				"Cloudflare R2 object write/delete on the configured TEDI_STORAGE bucket",
		},
		{
			step: `Delete the tedi's artifacts repository in the namespace configured by the ARTIFACTS binding (one repo named after the tedi UUID ${tediId})`,
			reason:
				"No programmatic per-tedi artifact-repo teardown exists; the git-backed repo (SOUL/IDENTITY/MEMORY, daily logs, skills) is independent of R2 and D1.",
			scope: "Cloudflare Workers/Artifacts namespace admin",
		},
	];
	if (!agentMemoryDeleted) {
		steps.push({
			step: `Delete this tedi's Cloudflare Agent Memory profile \`org:${orgId}:tedi:${tediId}\` from the runtime AGENT_MEMORY namespace`,
			reason:
				"The authenticated programmatic profile deletion failed; Agent Memory is external to D1 and R2, so the hard purge cannot erase it through either storage cascade.",
			scope: "Cloudflare Agent Memory profile delete (account-level binding)",
		});
	}
	return steps;
}

/**
 * Pure-ish staged orchestration for decommission and optional hard-purge.
 *
 * Stage 1 (always, reversible): decommission to status='paused' +
 * runtime_state='archived'.
 * Stage 2 (`stopSchedules`, default true): cancel the isolate DO's armed
 * schedules so its self-perpetuating maintenance alarms actually stop. Skipped
 * (reported, not failed) for container/legacy bodies that have no isolate DO.
 * Stage 3 (`hardPurge`, irreversible): requires `confirmSlug === slug`; runs the
 * external-identity teardown + D1 cascade delete and reports residual manual
 * steps for R2/artifacts.
 *
 * Throws (fail-closed) on a hard-purge confirmSlug mismatch and on a failed
 * Stage-1 write. All injected side effects come from `deps`.
 */
export async function orchestrateTediDecommission(args: {
	tediId: string;
	orgId: string;
	slug: string | null;
	input: { stopSchedules?: boolean; hardPurge?: boolean; confirmSlug?: string };
	deps: TediDecommissionDeps;
}): Promise<TediDecommissionResult> {
	const { tediId, orgId, slug, input, deps } = args;

	// Fail-closed before any mutation if a hard-purge is requested without a
	// matching slug confirmation.
	if (input.hardPurge && input.confirmSlug !== slug) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`hardPurge requires confirmSlug to exactly match the tedi slug "${slug ?? ""}"`,
		);
	}

	// Accumulate stage outcomes as we go so a mid-orchestration throw can still
	// be audited with the completed-vs-failed stages (blocking: audit on partial
	// failure). The audit fires exactly once — on success below, or in `catch`.
	const result: TediDecommissionResult = {
		decommissioned: false,
		schedulesStopped: { attempted: false, ok: true, detail: "not started" },
		purged: false,
		programmaticCleanups: [],
		residualManualSteps: [],
	};
	let stage: TediDecommissionStage = "decommission";

	try {
		// Stage 1 — decommission (reversible).
		result.decommissioned = await deps.decommission();
		if (!result.decommissioned) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to decommission tedi (status/runtime_state update returned no row)",
			);
		}

		// Stage 2 — stop the isolate DO's armed schedules.
		stage = "stop_schedules";
		const wantStopSchedules = input.stopSchedules ?? true;
		if (!wantStopSchedules) {
			result.schedulesStopped = {
				attempted: false,
				ok: true,
				detail: "not requested",
			};
		} else if (!deps.isIsolateBody) {
			result.schedulesStopped = {
				attempted: false,
				ok: true,
				detail:
					"skipped — container/legacy body has no isolate Durable Object schedules",
			};
		} else {
			result.schedulesStopped = await deps.stopSchedules();
		}

		// Stage 3 — hard purge (irreversible).
		if (input.hardPurge) {
			stage = "purge_external_identity";
			result.programmaticCleanups.push(...(await deps.purgeExternalIdentity()));
			const failedCleanup = result.programmaticCleanups.find(
				(cleanup) => !cleanup.ok,
			);
			if (failedCleanup)
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					`${failedCleanup.step}: ${failedCleanup.detail ?? "External identity cleanup failed; retry purge"}`,
				);
			stage = "purge_agent_memory";
			const agentMemoryCleanup = await deps.purgeAgentMemoryProfile();
			result.programmaticCleanups.push(agentMemoryCleanup);
			stage = "d1_delete";
			await deps.deleteRow();
			result.programmaticCleanups.push({
				step: "d1_cascade_delete",
				ok: true,
				detail:
					"deleted tedis row; FK ON DELETE CASCADE DESTROYED this worker's customer-owned cognitive state — memory_facts (and their memory_edges), tedi_expertise, knowledge_entries, skill_entries, skill_runs (and skill_run_artifacts), tedi_muscle_memory, tedi_rationale_records, tedi_artifacts, tedi_runtime_events, tedi_growth_snapshots, tedi_entrustment_grants and competency_observations — alongside tedi_secrets, tedi_session_states, tedi_objectives/tasks, tedi_email_* and every other tediId-scoped child row. This is irreversible and is NOT what `tedis.delete` does; that path retires the tedi and keeps all of the above.",
			});
			result.purged = true;
			result.residualManualSteps.push(
				...purgeResidualManualSteps(tediId, orgId, agentMemoryCleanup.ok),
			);
		}

		deps.emitAudit({ status: "completed", result });
		return result;
	} catch (err) {
		// Always audit the partial destructive outcome before re-throwing.
		deps.emitAudit({
			status: "failed",
			result,
			failedStage: stage,
			error: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
}

/**
 * Decommission (and optionally hard-purge) a tedi — the supported, audited,
 * platform-admin-gated encapsulation of the manual multi-system removal cascade
 * (D1 row + tedi_secrets + runtime events + sessions, isolate DO armed
 * schedules, Descope identity, FGA grants, AIH MCP server). R2/artifacts have no
 * programmatic path and are returned as residual manual steps.
 *
 * Auth: platform-admin authority (user role `platform-admin`, or API-key/M2M
 * scope `platform:admin`) or a trusted service binding only. Fail-closed for
 * ordinary org users. Safe by default: omitting `hardPurge` only decommissions.
 */
export const decommissionTediProcedure = authedTedisOs.decommission
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		assertPlatformAdminOrServiceBinding(context);

		// Decommission (hard purge) is the teardown half of offboarding, so it needs
		// the same cross-org reach as delete. It used `requireTediAccess`, whose only
		// cross-org escape hatch is `isPlatformAdmin(context.user)` — a user-JWT
		// role check. API-key/M2M automation and the `platform:admin` CTO tedi carry
		// scopes, not roles, so they passed the platform assertion on the line above
		// and were then 403'd here. `requireTediDeleteAccess` checks the principal
		// (`isPlatformPrincipal`) instead, and still refuses a `standard` tedi — its
		// service-binding transport confers no authority.
		const tedi = await requireTediDeleteAccess(context, input.tediId);
		const orgId = tedi.organizationId;
		const { actorId, actorType } = auditActor(context);

		const result = await orchestrateTediDecommission({
			tediId: tedi.id,
			orgId,
			slug: tedi.slug,
			input,
			deps: {
				decommission: async () => {
					const updated = await updateTedi(context.db, tedi.id, {
						status: "paused",
						runtimeState: "archived",
					});
					return Boolean(updated);
				},
				isIsolateBody: true,
				stopSchedules: async () => {
					const res = await agentAdminFetch(context, tedi, "/__admin/dequeue", {
						method: "POST",
						body: { cancelSchedules: true },
						timeoutMs: DECOMMISSION_ADMIN_TIMEOUT_MS,
					});
					if ("error" in res) {
						return { attempted: true, ok: false, detail: res.error };
					}
					const json = res.json as {
						canceledScheduleIds?: string[];
					} | null;
					return {
						attempted: true,
						ok: res.ok,
						canceledScheduleIds: json?.canceledScheduleIds ?? [],
						detail: res.ok
							? undefined
							: `dequeue returned status ${res.status}`,
					};
				},
				purgeExternalIdentity: () => purgeTediExternalIdentity(context, tedi),
				purgeAgentMemoryProfile: async () => {
					const res = await agentAdminFetch(
						context,
						tedi,
						"/__admin/agent-memory/delete-profile",
						{ method: "POST", timeoutMs: DECOMMISSION_ADMIN_TIMEOUT_MS },
					);
					if ("error" in res) {
						return {
							step: "agent_memory_profile_delete",
							ok: false,
							detail: res.error,
						};
					}
					const json = res.json as { profile?: string } | null;
					return {
						step: "agent_memory_profile_delete",
						ok: res.ok,
						detail: json?.profile ?? `runtime returned status ${res.status}`,
					};
				},
				deleteRow: async () => {
					await deleteTedi(context.db, tedi.id);
					invalidateKernelContextCache(context, orgId, "tedi.deleted");
				},
				// Always-emit audit hook: fires on success and on a mid-orchestration
				// thrown failure (with the partial stage outcomes) before the throw
				// propagates. Fail-soft — never let audit I/O mask the real outcome.
				emitAudit: ({ status, result: outcome, failedStage, error }) => {
					emitAuditEvent(context.db, {
						organizationId: orgId,
						actorId,
						actorType,
						action: input.hardPurge ? "tedi.purge" : "tedi.decommission",
						resourceType: "tedi",
						resourceId: tedi.id,
						metadata: {
							name: tedi.name,
							slug: tedi.slug,
							status,
							...(failedStage ? { failedStage } : {}),
							...(error ? { error } : {}),
							stopSchedules: input.stopSchedules ?? true,
							schedulesStopped: outcome.schedulesStopped,
							hardPurge: Boolean(input.hardPurge),
							decommissioned: outcome.decommissioned,
							purged: outcome.purged,
							programmaticCleanups: outcome.programmaticCleanups,
							residualManualSteps: outcome.residualManualSteps,
						},
					}).catch((err) => {
						console.error(
							`[Tedis] Failed to emit audit event for tedi.${input.hardPurge ? "purge" : "decommission"}`,
							{ exception: safeExceptionTopology(err) },
						);
					});
				},
			},
		});

		console.log(
			`[Tedis] ${input.hardPurge ? "Hard-purged" : "Decommissioned"} tedi ${tedi.name} (${tedi.id})`,
		);

		return {
			ok: true as const,
			tediId: tedi.id,
			slug: tedi.slug,
			...result,
		};
	});
