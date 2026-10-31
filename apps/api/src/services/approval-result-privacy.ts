import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { TediApprovalRequest } from "@tedix/db/schema/approvals";
import type { BaseContext } from "../rpc/orpc";
import { parseOwnerToolCallPayload } from "../rpc/routers/kernel/owner-tool-approval-settlement";
import { parseHomeToolWritePayload } from "../rpc/routers/kernel/write-executor";

type Approval = Pick<
	TediApprovalRequest,
	"orgId" | "tediId" | "actionType" | "payload"
>;
const OUTPUT_KEYS = new Set([
	"executionResult",
	"execution_result",
	"executionError",
	"execution_error",
	"executionSummary",
	"result",
	"output",
	"response",
	"observedResult",
	"observedError",
]);
const EXECUTION_METADATA = new Set([
	"status",
	"startedAt",
	"finishedAt",
	"retryable",
	"attempt",
	"retriedBy",
]);
const REDACTED = { redacted: true } as const;
function record(value: unknown): value is Record<string, JsonValue> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Result access is distinct from permission to review or approve a request. */
export function canReadApprovalResult(
	context: BaseContext,
	approval: Approval | null | undefined,
): boolean {
	if (
		!approval ||
		!context.organizationId ||
		context.organizationId !== approval.orgId
	)
		return false;
	const userId = context.authType === "user" ? context.user?.sub : undefined;
	const ownerCall = parseOwnerToolCallPayload(approval.payload);
	if (
		approval.actionType === "mcp.tool_call" ||
		approval.payload.kind === "mcp_tool_call"
	)
		return (
			approval.actionType === "mcp.tool_call" &&
			!!userId &&
			!!ownerCall &&
			userId === ownerCall.initiatedByUserId
		);
	const homeCall = parseHomeToolWritePayload(approval.payload);
	if (
		approval.actionType === "home.tool_write" ||
		approval.payload.kind === "home_tool_write"
	) {
		if (
			approval.actionType !== "home.tool_write" ||
			!homeCall ||
			homeCall.organizationId !== approval.orgId
		)
			return false;
		return homeCall.initiatedByUserId
			? !!userId && userId === homeCall.initiatedByUserId
			: !!homeCall.initiatedByAgentPrincipalId &&
					context.externalAgentPrincipalId ===
						homeCall.initiatedByAgentPrincipalId;
	}
	// A routing tedi on an owner/Home call never establishes result ownership.
	if (context.authType === "tedi" && context.tediId === approval.tediId)
		return true;
	// A current human owner may differ from the original requester after a
	// transfer. Missing original identity grants no access to historical results.
	return false;
}

export function redactApprovalResultPayload(
	payload: Record<string, JsonValue>,
): Record<string, JsonValue> {
	const visible: Record<string, JsonValue> = {};
	for (const [key, value] of Object.entries(payload)) {
		if (OUTPUT_KEYS.has(key)) {
			visible[key] = REDACTED;
			continue;
		}
		if (key !== "execution") {
			visible[key] = value;
			continue;
		}
		if (!record(value)) {
			visible[key] = REDACTED;
			continue;
		}
		const execution: Record<string, JsonValue> = {};
		for (const field of EXECUTION_METADATA)
			if (value[field] !== undefined) execution[field] = value[field]!;
		if (value.summary !== undefined)
			execution.summary = "Execution details are available to the requester";
		if (value.error !== undefined)
			execution.error = "Execution details are available to the requester";
		execution.redacted = true;
		visible[key] = execution;
	}
	return visible;
}

/** Apply on reads too: historical stored results may already contain credentials. */
export function approvalPayloadForViewer(
	context: BaseContext,
	approval: Approval,
): Record<string, JsonValue> {
	const payload = approval.payload;
	if (
		!Object.keys(payload).some(
			(key) => key === "execution" || OUTPUT_KEYS.has(key),
		)
	)
		return payload;
	return canReadApprovalResult(context, approval)
		? payload
		: redactApprovalResultPayload(payload);
}

export function approvalReceiptForViewer<
	T extends { observedResult: unknown; observedError: unknown },
>(receipt: T, mayReadResult: boolean): T {
	if (mayReadResult) return receipt;
	return {
		...receipt,
		observedResult: receipt.observedResult === null ? null : REDACTED,
		observedError:
			receipt.observedError === null
				? null
				: {
						code: "result_redacted",
						message: "Execution details are available to the requester",
					},
	};
}
