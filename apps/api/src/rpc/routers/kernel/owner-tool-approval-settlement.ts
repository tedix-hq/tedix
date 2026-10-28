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
 */

import { recordApprovalExecutionReceipt } from "@tedix/db/queries/approval-simulations";
import {
	claimOwnerToolApprovalExecution,
	type OwnerToolApprovalExecution,
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
		(execution.status === "running" ||
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
): Promise<"succeeded" | "failed" | "unknown" | "not_applicable"> {
	if (input.approval.actionType !== "mcp.tool_call") return "not_applicable";
	const payload = parseOwnerToolCallPayload(input.approval.payload);
	if (!payload || input.status !== "approved") return "not_applicable";
	if (payload.execution)
		return payload.execution.status === "executed"
			? "succeeded"
			: payload.execution.status === "failed"
				? "failed"
				: "unknown";
	const organizationId = input.approval.orgId;
	const startedAt = nowIso();
	const claimed = await claimOwnerToolApprovalExecution(context.db, {
		id: input.approval.id,
		organizationId,
		now: startedAt,
	});
	if (!claimed) return "unknown";

	const finish = async (
		execution: Omit<OwnerToolApprovalExecution, "startedAt">,
		observed:
			| { outcome: "succeeded"; data: unknown }
			| { outcome: "failed"; error: string },
	): Promise<"succeeded" | "failed"> => {
		const finishedAt = nowIso();
		const record: OwnerToolApprovalExecution = {
			...execution,
			startedAt,
			finishedAt,
		};
		await recordOwnerToolApprovalExecution(context.db, {
			id: input.approval.id,
			organizationId,
			execution: record,
		});
		const canonicalInputHash = `sha256:${await canonicalDigest({
			appSlug: payload.appSlug,
			toolId: payload.toolId,
			args: payload.args,
		})}`;
		const receiptFields = {
			approvalRequestId: input.approval.id,
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
							retryable: false,
						},
					}),
			providerReceiptRefs: [],
			executedAt: finishedAt,
		};
		try {
			await recordApprovalExecutionReceipt(context.db, {
				id: crypto.randomUUID(),
				organizationId,
				idempotencyKey: `owner-tool-call:${input.approval.id}`,
				recordHash: `sha256:${await canonicalDigest(receiptFields)}`,
				createdAt: finishedAt,
				...receiptFields,
			});
		} catch (error) {
			console.warn("[approvals] owner tool call receipt failed", {
				approvalRequestId: input.approval.id,
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
			resourceId: input.approval.id,
			metadata: toJsonRecord({
				source: "approvals.settleOwnerToolCallApproval",
				appSlug: payload.appSlug,
				toolId: payload.toolId,
				approvedBy: input.approval.resolvedBy,
				...(record.summary ? { summary: record.summary } : {}),
				...(record.error ? { error: record.error } : {}),
			}),
		}).catch((error) => {
			console.warn("[approvals] owner tool call audit failed", {
				approvalRequestId: input.approval.id,
				error: errorMessage(error),
			});
		});
		return observed.outcome;
	};

	try {
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
			return finish(
				{
					status: "failed",
					error: "The requester is no longer an active owner or admin",
				},
				{
					outcome: "failed",
					error: "The requester is no longer an active owner or admin",
				},
			);
		const approvedBy = approvingUserId(input.approval.resolvedBy);
		if (
			!approvedBy ||
			!(await activeOwnerOrAdmin(context, organizationId, approvedBy))
		)
			return finish(
				{
					status: "failed",
					error: "The approver is no longer an active owner or admin",
				},
				{
					outcome: "failed",
					error: "The approver is no longer an active owner or admin",
				},
			);
		const organization = await getOrganizationById(context.db, organizationId);
		if (!organization)
			return finish(
				{ status: "failed", error: "Organization not found" },
				{ outcome: "failed", error: "Organization not found" },
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
				args: payload.args,
				organizationId,
				initiatedByUserId: payload.initiatedByUserId,
			},
			approvalRequestId: input.approval.id,
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
		return finish(
			{ status: "failed", error: result.error.slice(0, 500) },
			{ outcome: "failed", error: result.error },
		);
	} catch (error) {
		const message = errorMessage(error);
		console.warn("[approvals] owner tool call settle failed", {
			approvalRequestId: input.approval.id,
			error: message,
		});
		return finish(
			{ status: "failed", error: message.slice(0, 500) },
			{ outcome: "failed", error: message },
		);
	}
}
