import type { ApprovalFieldChange } from "@tedix/api-contract/schemas/approval-edits";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { applyApproverEditsToPayload } from "@tedix/api-contract/utils/approval-edits";
import { type BaseContext, ErrorCodes, createError } from "../rpc/orpc";

/** Human edits must accompany their own approval, with no change returning null. */
export function approverEditedPayload(
	context: Pick<BaseContext, "authType" | "tediId" | "user">,
	existing: { payload: Record<string, JsonValue> },
	input: {
		status: "approved" | "rejected";
		delegateRecommendation?: boolean;
		edits?: Record<string, JsonValue>;
	},
	editedBy: string,
): {
	payload: Record<string, JsonValue>;
	changes: ApprovalFieldChange[];
} | null {
	if (!input.edits || Object.keys(input.edits).length === 0) return null;
	if (input.status !== "approved" || input.delegateRecommendation)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Changes can only be sent with your own approval",
		);
	if (context.authType !== "user" || context.tediId || !context.user?.sub)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only a signed-in person can change an action before approving it",
		);
	const applied = applyApproverEditsToPayload({
		payload: existing.payload,
		edits: input.edits,
		editedBy,
		editedAt: new Date().toISOString(),
	});
	if (!applied.ok) throw createError(ErrorCodes.BAD_REQUEST, applied.error);
	return applied.changes.length ? applied : null;
}
