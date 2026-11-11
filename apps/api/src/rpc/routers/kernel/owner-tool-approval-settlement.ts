/**
 * Owner tool approval settlement.
 *
 * A gateway call an owner or admin made directly (CLI, Code Mode, an app)
 * parks as an `mcp.tool_call` approval. Approving it used to do nothing until
 * the caller repeated the identical call with the request id; nobody did, so
 * approved deletions never ran. Now approval runs the stored call once, on
 * behalf of the requester, through the gateway that re-checks the target and
 * both members at apply time and consumes the approval. The result lands on
 * the request itself so the Approvals view can show "Done" or "Failed".
 *
 * Exactly-once: the pending→approved transition is the first latch, the
 * `$.execution` claim on the row is the second, and the gateway's
 * `consumedAt` is the third. A rejected, cancelled or expired request is
 * never claimed, so it never runs.
 *
 * One exception, for tools listed in `CONTINUABLE_OWNER_TOOL_ENDPOINTS`: a
 * bulk purge stops at a per-call budget, so after a run that made progress
 * but did not finish, the settlement stores narrowed arguments (only the
 * kinds left, resuming after the last item examined), queues the request and
 * clears the gateway's consumed mark, all in one conditional update owned by
 * that run. The approval-queue cron then runs it again, and the gateway admits
 * and consumes each run as before. It stops when the tool reports it is
 * complete, examined nothing, the run limit is reached or the approval expires.
 */

import {
	isRequesterOnlyOwnerToolFailure,
	isRetryableOwnerToolExecution,
	isStaleOwnerToolRun,
	STALE_OWNER_TOOL_RUN_MS,
} from "@tedix/api-contract/utils/owner-tool-execution";
import { recordApprovalExecutionReceipt } from "@tedix/db/queries/approval-simulations";
import {
	claimOwnerToolApprovalExecution,
	continueOwnerToolApprovalExecution,
	listDueOwnerToolApprovals,
	type OwnerToolApprovalExecution,
	reclaimOwnerToolApprovalExecution,
	recordOwnerToolApprovalExecution,
} from "@tedix/db/queries/approvals";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import type { tediApprovalRequests } from "@tedix/db/schema/approvals";
import { toJsonRecord } from "@tedix/db/utils/json";
import { canonicalDigest } from "../../../lib/blueprint-digest";
import { organizationGatewaySlug } from "../../../lib/organization-mcp-gateway";
import type { BaseContext } from "../../orpc";
import { errorMessage, nowIso } from "./runtime-shared";
import {
	approvingUserId,
	executeApprovedOwnerToolCall,
	type KernelWriteExecutorTimings,
	type WriteExecutorEnv,
} from "./write-executor";

export const OWNER_TOOL_CALL_KIND = "mcp_tool_call";

/** The server-stored call behind an owner tool approval, as the gateway parked it. */
export interface OwnerToolCallPayload {
	kind: typeof OWNER_TOOL_CALL_KIND;
	initiatedByUserId: string;
	appSlug: string;
	toolId: string;
	target: Record<string, unknown>;
	args: Record<string, unknown>;
	fingerprint: string;
	execution?: OwnerToolApprovalExecution;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Structural guard. Policy rows (`resolvedBy: "policy"`) share the kind but
 * carry no fingerprint or target: they recorded a call that already ran.
 */
export function parseOwnerToolCallPayload(
	value: unknown,
): OwnerToolCallPayload | null {
	if (!isRecord(value) || value.kind !== OWNER_TOOL_CALL_KIND) return null;
	const {
		initiatedByUserId,
		appSlug,
		toolId,
		target,
		args,
		fingerprint,
		execution,
	} = value;
	if (
		typeof initiatedByUserId !== "string" ||
		!initiatedByUserId ||
		typeof appSlug !== "string" ||
		!appSlug ||
		typeof toolId !== "string" ||
		!toolId ||
		typeof fingerprint !== "string" ||
		!fingerprint ||
		!isRecord(target) ||
		!isRecord(args)
	)
		return null;
	return {
		kind: OWNER_TOOL_CALL_KIND,
		initiatedByUserId,
		appSlug,
		toolId,
		target,
		args,
		fingerprint,
		...(isRecord(execution) &&
		(execution.status === "queued" ||
			execution.status === "running" ||
			execution.status === "executed" ||
			execution.status === "failed") &&
		typeof execution.startedAt === "string"
			? { execution: execution as unknown as OwnerToolApprovalExecution }
			: {}),
	};
}

/** The gateway a deferred replay uses: `connect` has no tenant surface for a service caller. */
export function ownerToolReplayAppSlug(input: {
	appSlug: string;
	organizationId: string;
	organizationSlug: string;
}): string {
	return input.appSlug === "connect"
		? organizationGatewaySlug(input.organizationSlug, input.organizationId)
		: input.appSlug;
}

/** A short sentence for people, from the tool's result. */
export function ownerToolExecutionSummary(
	toolId: string,
	data: unknown,
): string {
	const action = toolId.split("__").at(-1)!.replace(/[_-]+/g, " ").trim();
	const record = isRecord(data) ? data : undefined;
	const detail =
		record && typeof record.message === "string"
			? record.message
			: record && typeof record.id === "string"
				? `id ${record.id}`
				: null;
	const sentence = action.charAt(0).toUpperCase() + action.slice(1);
	return (detail ? `${sentence}: ${detail}` : sentence).slice(0, 200);
}

/**
 * Gateway RPC endpoints whose approved call continues under the same approval
 * until the tool reports it is complete. Each must accept `resumeAfter` and
 * report `complete`, `dryRun` and, per kind, `examined`, `remaining`,
 * `nextAfterId`, `deleted` and `skipped`, and must only narrow what it does
 * when given `resumeAfter`.
 */
export const CONTINUABLE_OWNER_TOOL_ENDPOINTS: ReadonlySet<string> = new Set([
	"osWorkspaces/workspaces/purgeArchived",
]);
/** Runs one approval may make, the first included. */
export const MAX_OWNER_TOOL_CONTINUATION_RUNS = 100;
/** Purge ids kept on the request; every run's id is also on its receipt and audit rows. */
const CONTINUATION_PURGE_ID_LIMIT = 100;

interface KindTotals {
	deleted: number;
	skipped: number;
}

/** What `$.continuation` holds on a continuing request. */
export interface OwnerToolContinuation {
	/** Runs finished so far. */
	runs: number;
	/** The arguments the owner approved; `$.args` holds the narrowed ones. */
	approvedArgs: Record<string, unknown>;
	totals: Record<string, KindTotals>;
	purgeIds: string[];
}

function isContinuableCall(payload: OwnerToolCallPayload): boolean {
	return (
		payload.target.transport === "rpc" &&
		typeof payload.target.endpoint === "string" &&
		CONTINUABLE_OWNER_TOOL_ENDPOINTS.has(payload.target.endpoint) &&
		payload.args.dryRun === false
	);
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

export function parseOwnerToolContinuation(
	value: unknown,
): OwnerToolContinuation | null {
	if (
		!isRecord(value) ||
		typeof value.runs !== "number" ||
		!isRecord(value.approvedArgs)
	)
		return null;
	const totals: Record<string, KindTotals> = {};
	if (isRecord(value.totals))
		for (const [kind, total] of Object.entries(value.totals))
			if (isRecord(total))
				totals[kind] = {
					deleted: count(total.deleted),
					skipped: count(total.skipped),
				};
	return {
		runs: value.runs,
		approvedArgs: value.approvedArgs,
		totals,
		purgeIds: Array.isArray(value.purgeIds)
			? value.purgeIds.filter((id): id is string => typeof id === "string")
			: [],
	};
}

type ContinuationStep =
	| { kind: "continue"; args: Record<string, unknown> }
	| { kind: "done"; reason: string | null };

/**
 * The state after one run of a continuable call, and whether and with which
 * arguments it runs again. Arguments only ever narrow: kinds that finished
 * are dropped and each kind left resumes after the last item it examined.
 */
export function nextOwnerToolContinuation(input: {
	args: Record<string, unknown>;
	prior: OwnerToolContinuation | null;
	data: unknown;
	approvalExpiresAt: string;
	now: number;
}): { state: OwnerToolContinuation; step: ContinuationStep } {
	const { args, prior, data } = input;
	const runs = (prior?.runs ?? 0) + 1;
	const totals = { ...(prior?.totals ?? {}) };
	const purgeIds = [...(prior?.purgeIds ?? [])];
	const record = isRecord(data) ? data : {};
	if (
		typeof record.purgeId === "string" &&
		purgeIds.length < CONTINUATION_PURGE_ID_LIMIT
	)
		purgeIds.push(record.purgeId);
	const kinds = Array.isArray(args.kinds)
		? args.kinds.filter((kind): kind is string => typeof kind === "string")
		: [];
	const priorResume = isRecord(args.resumeAfter) ? args.resumeAfter : {};
	const left: string[] = [];
	const resumeAfter: Record<string, string> = {};
	let examined = 0;
	for (const kind of kinds) {
		const result = isRecord(record[kind]) ? record[kind] : null;
		if (result) {
			const total = totals[kind] ?? { deleted: 0, skipped: 0 };
			totals[kind] = {
				deleted: total.deleted + count(result.deleted),
				skipped: total.skipped + count(result.skipped),
			};
			examined += count(result.examined);
		}
		if (result && count(result.remaining) === 0) continue;
		left.push(kind);
		const after =
			result && typeof result.nextAfterId === "string"
				? result.nextAfterId
				: priorResume[kind];
		if (typeof after === "string" && after) resumeAfter[kind] = after;
	}
	const state: OwnerToolContinuation = {
		runs,
		approvedArgs: prior?.approvedArgs ?? args,
		totals,
		purgeIds,
	};
	const reason =
		record.dryRun !== false
			? "not a deleting run"
			: record.complete === true || left.length === 0
				? null
				: examined === 0
					? "stopped: the last run could not check any item"
					: runs >= MAX_OWNER_TOOL_CONTINUATION_RUNS
						? `stopped after ${runs} runs; approve a new purge for the rest`
						: Date.parse(input.approvalExpiresAt) <= input.now
							? "stopped: the approval expired; approve a new purge for the rest"
							: undefined;
	if (reason !== undefined) return { state, step: { kind: "done", reason } };
	return {
		state,
		step: {
			kind: "continue",
			args: {
				...args,
				kinds: left,
				...(Object.keys(resumeAfter).length > 0 ? { resumeAfter } : {}),
			},
		},
	};
}

/** "Deleted 34 workspaces, 120 outputs over 3 runs", for the request and Activity. */
export function ownerToolContinuationSummary(
	state: OwnerToolContinuation,
	note: string | null,
): string {
	const parts = Object.entries(state.totals).map(
		([kind, total]) =>
			`${total.deleted} ${kind}${total.skipped ? ` (${total.skipped} skipped)` : ""}`,
	);
	const runs = `${state.runs} run${state.runs === 1 ? "" : "s"}`;
	return `Deleted ${parts.join(", ") || "nothing"} over ${runs}${note ? `; ${note}` : ""}`.slice(
		0,
		200,
	);
}

let activeOwnerToolExecutor: typeof executeApprovedOwnerToolCall =
	executeApprovedOwnerToolCall;

export function setOwnerToolExecutorForTest(
	fn: typeof executeApprovedOwnerToolCall | null,
): void {
	activeOwnerToolExecutor = fn ?? executeApprovedOwnerToolCall;
}

async function activeOwnerOrAdmin(
	context: BaseContext,
	organizationId: string,
	userId: string,
): Promise<boolean> {
	const member = await getMemberByUserId(context.db, organizationId, userId);
	return (
		member?.status === "active" && ["owner", "admin"].includes(member.role)
	);
}

type OwnerToolRunOutcome = "succeeded" | "failed" | "queued";

/**
 * A connection-transport call runs only under the requester's own verified
 * `connections.execute` grant. An owner's session in Tedix OS does not carry
 * it, so such a call can only be sent again by the requester.
 */
function hasVerifiedRequesterGrant(
	context: BaseContext,
	payload: OwnerToolCallPayload,
): boolean {
	return (
		payload.target.transport === "mcp" &&
		context.authType === "user" &&
		context.user?.sub === payload.initiatedByUserId &&
		Array.isArray(context.user.scopes) &&
		context.user.scopes.includes("connections.execute")
	);
}

/**
 * One claimed run of the stored call: apply-time access checks, the gateway
 * replay, and the record on the request, the receipt and the audit event.
 */
async function runOwnerToolCall(
	context: BaseContext,
	input: {
		approval: typeof tediApprovalRequests.$inferSelect;
		payload: OwnerToolCallPayload;
		startedAt: string;
		retry?: { retriedBy: string; attempt: number };
	},
): Promise<OwnerToolRunOutcome> {
	const { approval, payload, startedAt } = input;
	const organizationId = approval.orgId;
	const attempt: Pick<OwnerToolApprovalExecution, "attempt" | "retriedBy"> =
		input.retry
			? { attempt: input.retry.attempt, retriedBy: input.retry.retriedBy }
			: {};

	const continuable = isContinuableCall(payload);
	const priorContinuation = parseOwnerToolContinuation(
		(approval.payload as Record<string, unknown>).continuation,
	);
	const finish = async (
		execution: Omit<
			OwnerToolApprovalExecution,
			"startedAt" | "attempt" | "retriedBy"
		>,
		observed:
			| { outcome: "succeeded"; data: unknown }
			| { outcome: "failed"; error: string },
	): Promise<OwnerToolRunOutcome> => {
		const finishedAt = nowIso();
		let record: OwnerToolApprovalExecution = {
			...execution,
			...attempt,
			startedAt,
			finishedAt,
		};
		const progress = continuable
			? nextOwnerToolContinuation({
					args: payload.args,
					prior: priorContinuation,
					data: observed.outcome === "succeeded" ? observed.data : null,
					approvalExpiresAt: approval.expiresAt,
					now: Date.parse(finishedAt),
				})
			: null;
		let continued = false;
		if (progress && observed.outcome === "succeeded") {
			const note =
				progress.step.kind === "continue" ? "continuing" : progress.step.reason;
			record = {
				...record,
				summary: ownerToolContinuationSummary(progress.state, note),
			};
			if (progress.step.kind === "continue") {
				const queued: OwnerToolApprovalExecution = {
					status: "queued",
					startedAt,
					nextAttemptAt: finishedAt,
					summary: record.summary,
				};
				continued = await continueOwnerToolApprovalExecution(context.db, {
					id: approval.id,
					organizationId,
					startedAt,
					now: finishedAt,
					args: progress.step.args,
					execution: queued,
					continuation: { ...progress.state },
				});
				if (continued) record = queued;
				else
					record = {
						...record,
						summary: ownerToolContinuationSummary(
							progress.state,
							"stopped: the next run could not be queued",
						),
					};
			}
		}
		if (!continued) {
			const recorded = await recordOwnerToolApprovalExecution(context.db, {
				id: approval.id,
				organizationId,
				execution: record,
			});
			if (!recorded)
				throw new Error("Approval execution outcome could not be recorded");
			record = recorded;
		}
		const runNumber = (priorContinuation?.runs ?? 0) + 1;
		const canonicalInputHash = `sha256:${await canonicalDigest({
			appSlug: payload.appSlug,
			toolId: payload.toolId,
			args: payload.args,
		})}`;
		const receiptFields = {
			approvalRequestId: approval.id,
			canonicalInputHash,
			baselineFenceOutcome: "not_checked" as const,
			...(observed.outcome === "succeeded"
				? {
						outcome: "succeeded" as const,
						observedResult: toJsonRecord({
							summary: record.summary ?? null,
							result: observed.data ?? null,
						}),
					}
				: {
						outcome: "failed" as const,
						observedError: {
							code: "owner_tool_call_failed",
							message: observed.error.slice(0, 500),
							retryable: isRetryableOwnerToolExecution(record),
						},
					}),
			providerReceiptRefs: [],
			executedAt: finishedAt,
		};
		try {
			await recordApprovalExecutionReceipt(context.db, {
				id: crypto.randomUUID(),
				organizationId,
				idempotencyKey:
					runNumber > 1
						? `owner-tool-call:${approval.id}:run-${runNumber}`
						: `owner-tool-call:${approval.id}${input.retry ? ":retry" : ""}`,
				recordHash: `sha256:${await canonicalDigest(receiptFields)}`,
				createdAt: finishedAt,
				...receiptFields,
			});
		} catch (error) {
			console.warn("[approvals] owner tool call receipt failed", {
				approvalRequestId: approval.id,
				error: errorMessage(error),
			});
		}
		await insertAuditEvent(context.db, {
			organizationId,
			actorId: payload.initiatedByUserId,
			actorType: "user",
			action:
				observed.outcome === "succeeded"
					? "approval.executed"
					: "approval.execution_failed",
			resourceType: "approval_request",
			resourceId: approval.id,
			metadata: toJsonRecord({
				source: "approvals.settleOwnerToolCallApproval",
				appSlug: payload.appSlug,
				toolId: payload.toolId,
				approvedBy: approval.resolvedBy,
				...attempt,
				...(record.summary
					? { summary: ownerToolExecutionSummary(payload.toolId, null) }
					: {}),
				...(record.error ? { error: "Approved tool execution failed" } : {}),
				...(progress
					? {
							run: runNumber,
							continued,
							totals: progress.state.totals,
							...(observed.outcome === "succeeded" &&
							isRecord(observed.data) &&
							typeof observed.data.purgeId === "string"
								? { purgeId: observed.data.purgeId }
								: {}),
						}
					: {}),
			}),
		}).catch((error) => {
			console.warn("[approvals] owner tool call audit failed", {
				approvalRequestId: approval.id,
				error: errorMessage(error),
			});
		});
		return continued ? "queued" : observed.outcome;
	};
	const fail = (
		error: string,
		retryable = false,
		actionBy?: OwnerToolApprovalExecution["actionBy"],
	) =>
		finish(
			{ status: "failed", error, retryable, ...(actionBy ? { actionBy } : {}) },
			{ outcome: "failed", error },
		);

	try {
		if (Date.parse(approval.expiresAt) <= Date.now())
			return fail(
				"The approval expired before the call could run. Request a new approval.",
			);
		// Apply-time access: the requester still holds the authority that parked
		// the call, and the person who approved it still may approve. The
		// gateway repeats both checks when it consumes the approval.
		if (
			!(await activeOwnerOrAdmin(
				context,
				organizationId,
				payload.initiatedByUserId,
			))
		)
			return fail("The requester is no longer an active owner or admin");
		const approvedBy = approvingUserId(approval.resolvedBy);
		if (
			!approvedBy ||
			!(await activeOwnerOrAdmin(context, organizationId, approvedBy))
		)
			return fail("The approver is no longer an active owner or admin");
		const organization = await getOrganizationById(context.db, organizationId);
		if (!organization) return fail("Organization not found");
		const verifiedConnectionExecute = hasVerifiedRequesterGrant(
			context,
			payload,
		);
		const verifiedConnectionAdmin =
			verifiedConnectionExecute &&
			Array.isArray(context.user?.scopes) &&
			context.user.scopes.includes("connections.admin");
		if (payload.target.transport === "mcp" && !verifiedConnectionExecute)
			return fail(
				"The requester must retry with a verified connections.execute grant; no provider call was made",
				false,
				"requester",
			);
		const timings: KernelWriteExecutorTimings = {};
		const result = await activeOwnerToolExecutor({
			env: context.env as unknown as WriteExecutorEnv,
			payload: {
				appSlug: ownerToolReplayAppSlug({
					appSlug: payload.appSlug,
					organizationId,
					organizationSlug: organization.slug,
				}),
				toolId: payload.toolId,
				target: payload.target,
				args: payload.args,
				organizationId,
				initiatedByUserId: payload.initiatedByUserId,
			},
			approvalRequestId: approval.id,
			verifiedConnectionExecute,
			verifiedConnectionAdmin,
			timings,
		});
		if (result.ok)
			return finish(
				{
					status: "executed",
					summary: ownerToolExecutionSummary(payload.toolId, result.data),
				},
				{ outcome: "succeeded", data: result.data },
			);
		// Only the gateway's pre-dispatch rate refusal is safe to redrive automatically.
		const rateWait = result.rateLimitRetryAfterSeconds;
		if (rateWait) {
			const nextAttemptAt = new Date(
				Date.now() + rateWait * 1000,
			).toISOString();
			if (Date.parse(nextAttemptAt) >= Date.parse(approval.expiresAt))
				return fail(
					"The tool limit could not clear before this approval expires. Request a new approval.",
				);
			const queued = await recordOwnerToolApprovalExecution(context.db, {
				id: approval.id,
				organizationId,
				execution: { status: "queued", startedAt, nextAttemptAt, ...attempt },
			});
			if (!queued)
				throw new Error("Approval queue position could not be recorded");
			return "queued";
		}
		return fail(result.error.slice(0, 500), result.retryable === true);
	} catch (error) {
		const message = errorMessage(error);
		console.warn("[approvals] owner tool call settle failed", {
			approvalRequestId: approval.id,
			error: message,
		});
		return fail(message.slice(0, 500), true);
	}
}

/**
 * Run the stored call once after approval. Returns `not_applicable` for every
 * other payload kind and for a non-approving decision; `unknown` when the
 * claim was lost or the record could not be read.
 */
export async function settleOwnerToolCallApproval(
	context: BaseContext,
	input: {
		approval: typeof tediApprovalRequests.$inferSelect;
		status: "approved" | "rejected" | "cancelled";
	},
): Promise<OwnerToolRunOutcome | "unknown" | "not_applicable"> {
	if (input.approval.actionType !== "mcp.tool_call") return "not_applicable";
	const payload = parseOwnerToolCallPayload(input.approval.payload);
	if (!payload || input.status !== "approved") return "not_applicable";
	if (payload.execution)
		return payload.execution.status === "executed"
			? "succeeded"
			: payload.execution.status === "failed"
				? "failed"
				: payload.execution.status === "queued"
					? "queued"
					: "unknown";
	const startedAt = nowIso();
	const claimed = await claimOwnerToolApprovalExecution(context.db, {
		id: input.approval.id,
		organizationId: input.approval.orgId,
		now: startedAt,
	});
	if (!claimed) return "unknown";
	return runOwnerToolCall(context, {
		approval: input.approval,
		payload,
		startedAt,
	});
}

export type OwnerToolRetryRefusal =
	| "not_owner_tool_call"
	| "not_failed"
	| "still_running"
	| "not_retryable"
	| "expired"
	| "requester_must_retry"
	| "outcome_unknown"
	| "dismissed"
	| "claim_lost";

/**
 * Try a failed platform-side execution once more, for an owner or admin. The
 * same re-check-then-run-once rules apply: the request must still be approved
 * and unexpired, requester and approver must still hold authority, and the
 * gateway re-matches and consumes the approval. A run that never finished
 * (cut off before the gateway consumed the approval) counts as a failed run.
 * Returns the claimed run, or why the retry was refused without running
 * anything. The caller decides whether to await the run or let it finish
 * after the response.
 */
export async function retryOwnerToolCallExecution(
	context: BaseContext,
	input: {
		approval: typeof tediApprovalRequests.$inferSelect;
		retriedBy: string;
	},
): Promise<{ run: Promise<OwnerToolRunOutcome> } | OwnerToolRetryRefusal> {
	if (input.approval.actionType !== "mcp.tool_call")
		return "not_owner_tool_call";
	const payload = parseOwnerToolCallPayload(input.approval.payload);
	if (!payload || input.approval.status !== "approved")
		return "not_owner_tool_call";
	const execution = payload.execution;
	if (!execution || execution.status === "executed") return "not_failed";
	const recorded = input.approval.payload as Record<string, unknown>;
	const dismissed =
		recorded.execution &&
		typeof recorded.execution === "object" &&
		typeof (recorded.execution as Record<string, unknown>).dismissedAt ===
			"string";
	if (dismissed) return "dismissed";
	const now = Date.now();
	if (execution.status === "running" && !isStaleOwnerToolRun(execution, now))
		return "still_running";
	// The gateway consumed the approval before the run was cut off: the target
	// may already have changed, so the call is never run a second time.
	if (typeof recorded.consumedAt === "string") return "outcome_unknown";
	const requesterOnly = isRequesterOnlyOwnerToolFailure(execution);
	if (requesterOnly && !hasVerifiedRequesterGrant(context, payload))
		return "requester_must_retry";
	if (!requesterOnly && !isRetryableOwnerToolExecution(execution, now))
		return "not_retryable";
	if (Date.parse(input.approval.expiresAt) <= now) return "expired";
	const startedAt = new Date(now).toISOString();
	const attempt = (execution.attempt ?? 1) + 1;
	const claimed = await reclaimOwnerToolApprovalExecution(context.db, {
		id: input.approval.id,
		organizationId: input.approval.orgId,
		now: startedAt,
		retriedBy: input.retriedBy,
		attempt,
		staleBefore: new Date(now - STALE_OWNER_TOOL_RUN_MS).toISOString(),
	});
	if (!claimed) return "claim_lost";
	return {
		run: runOwnerToolCall(context, {
			approval: input.approval,
			payload,
			startedAt,
			retry: { retriedBy: input.retriedBy, attempt },
		}),
	};
}

/** How long one approval-queue tick keeps running continuing calls back to back. */
export const OWNER_TOOL_QUEUE_TICK_BUDGET_MS = 30_000;

/**
 * Runs due queued calls: those a tool limit deferred, and those continuing
 * under their approval (which run again in the same tick while time allows).
 * Reuses the stored call and gateway fences; never manufactures a connection grant.
 */
export async function runQueuedOwnerToolApprovals(
	context: BaseContext,
	options: { budgetMs?: number; now?: () => number } = {},
) {
	const now = options.now ?? Date.now;
	const deadline =
		now() + (options.budgetMs ?? OWNER_TOOL_QUEUE_TICK_BUDGET_MS);
	const tick = { executed: 0 };
	// The first due call always runs; later ones only while time is left.
	const mayStart = () => tick.executed === 0 || now() < deadline;
	while (mayStart()) {
		const before = tick.executed;
		await runDueOwnerToolApprovals(context, tick, mayStart);
		if (tick.executed === before) break;
	}
	return tick.executed;
}

async function runDueOwnerToolApprovals(
	context: BaseContext,
	tick: { executed: number },
	mayStart: () => boolean,
) {
	const rows = await listDueOwnerToolApprovals(context.db, nowIso());
	for (const approval of rows) {
		// Expired requests are always closed; new runs start only while time is left.
		const payload = parseOwnerToolCallPayload(approval.payload);
		if (!payload?.execution) continue;
		const continuing =
			parseOwnerToolContinuation(
				(approval.payload as Record<string, unknown>).continuation,
			) !== null;
		if (Date.parse(approval.expiresAt) <= Date.now()) {
			await recordOwnerToolApprovalExecution(context.db, {
				id: approval.id,
				organizationId: approval.orgId,
				execution: {
					status: "failed",
					startedAt: payload.execution.startedAt,
					finishedAt: nowIso(),
					error: continuing
						? "The approval expired before the call finished. Request a new approval for the rest."
						: "The approval expired while waiting for the tool limit. Request a new approval.",
					retryable: false,
				},
			});
			continue;
		}
		if (!mayStart()) continue;
		const startedAt = nowIso();
		const attempt = continuing ? 1 : (payload.execution.attempt ?? 1) + 1;
		const claimed = await reclaimOwnerToolApprovalExecution(context.db, {
			id: approval.id,
			organizationId: approval.orgId,
			now: startedAt,
			retriedBy: continuing ? "approval-continuation" : "approval-queue",
			attempt,
			staleBefore: new Date(Date.now() - STALE_OWNER_TOOL_RUN_MS).toISOString(),
		});
		if (!claimed) continue;
		await runOwnerToolCall(context, {
			approval,
			payload,
			startedAt,
			// A continuing run is the next step of the approved call, not a retry.
			...(continuing
				? {}
				: { retry: { retriedBy: "approval-queue", attempt } }),
		});
		tick.executed++;
	}
}
