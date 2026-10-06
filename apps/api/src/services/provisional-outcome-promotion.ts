import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	recordApprovalExecutionReceipt,
	type RecordApprovalExecutionReceiptParams,
} from "@tedix/db/queries/approval-simulations";
import {
	getProvisionalOutcomeById,
	promoteProvisionalOutcome,
} from "@tedix/db/queries/approvals";
import type { DbClient } from "@tedix/db/client";
import type {
	TediApprovalRequest,
	TediProvisionalOutcome,
} from "@tedix/db/schema/approvals";

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
		.join(",")}}`;
}

async function sha256(value: unknown): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(stableStringify(value)),
	);
	return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")}`;
}

async function deterministicUuid(value: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
	).slice(0, 16);
	digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
	digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(digest, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Hash only the immutable proposal fields; lifecycle columns are excluded. */
export async function provisionalOutcomeRecordHash(
	outcome: Pick<
		TediProvisionalOutcome,
		| "id"
		| "tediId"
		| "orgId"
		| "conversationId"
		| "runId"
		| "kind"
		| "title"
		| "payload"
		| "createdAt"
	>,
): Promise<string> {
	return sha256({
		id: outcome.id,
		tediId: outcome.tediId,
		orgId: outcome.orgId,
		conversationId: outcome.conversationId,
		runId: outcome.runId,
		kind: outcome.kind,
		title: outcome.title,
		payload: outcome.payload,
		createdAt: outcome.createdAt,
	});
}

export async function provisionalPromotionApprovalRequestId(
	provisionalOutcomeId: string,
): Promise<string> {
	return deterministicUuid(
		`provisional-outcome-promotion:v2:${provisionalOutcomeId}`,
	);
}

export function isApprovedProvisionalPromotion(
	approval: Pick<
		TediApprovalRequest,
		"actionType" | "orgId" | "tediId" | "status" | "payload"
	>,
	outcome: Pick<TediProvisionalOutcome, "id" | "orgId" | "tediId">,
	expectedRecordHash: string,
): boolean {
	const exactScope =
		approval.status === "approved" &&
		approval.actionType === "provisional_outcome_promotion" &&
		approval.orgId === outcome.orgId &&
		approval.tediId === outcome.tediId &&
		approval.payload.provisionalOutcomeId === outcome.id;
	if (!exactScope) return false;
	return (
		approval.payload.kind === "provisional_outcome_promotion_v2" &&
		approval.payload.provisionalOutcomeHash === expectedRecordHash
	);
}

export interface ExecuteProvisionalPromotionResult {
	outcome: TediProvisionalOutcome;
	receiptId: string;
	replayed: boolean;
}

/**
 * Executes only Tedix's reversible ledger promotion. The arbitrary proposal
 * payload is never dispatched to a provider or interpreted as a tool call.
 */
export async function executeApprovedProvisionalPromotion(
	db: DbClient,
	input: {
		approval: TediApprovalRequest;
		actorId: string;
	},
): Promise<ExecuteProvisionalPromotionResult | null> {
	const current = await getProvisionalOutcomeById(
		db,
		String(input.approval.payload.provisionalOutcomeId ?? ""),
	);
	if (!current) return null;
	const canonicalInputHash = await provisionalOutcomeRecordHash(current);
	if (
		!isApprovedProvisionalPromotion(input.approval, current, canonicalInputHash)
	) {
		return null;
	}
	if (!input.approval.resolvedAt) {
		throw new Error("Approved promotion is missing its resolution timestamp");
	}

	let promoted: TediProvisionalOutcome | undefined;
	let replayed = false;
	if (current.state === "provisional") {
		promoted = await promoteProvisionalOutcome(db, {
			id: current.id,
			orgId: current.orgId,
			actorId: input.actorId,
			at: input.approval.resolvedAt,
			approvalRequestId: input.approval.id,
		});
	} else if (
		current.state === "promoted" &&
		current.promotionApprovalRequestId === input.approval.id
	) {
		promoted = current;
		replayed = true;
	}
	if (!promoted) return null;

	const observedResult: Record<string, JsonValue> = {
		provisionalOutcomeId: promoted.id,
		state: "promoted",
	};
	const receiptId = await deterministicUuid(
		`provisional-promotion-receipt:v1:${input.approval.id}`,
	);
	const receiptBase = {
		id: receiptId,
		organizationId: promoted.orgId,
		approvalRequestId: input.approval.id,
		idempotencyKey: "provisional-outcome-promotion:v1",
		canonicalInputHash,
		baselineFenceOutcome: "matched" as const,
		outcome: "succeeded" as const,
		observedResult,
		providerReceiptRefs: [],
		executedAt: promoted.promotedAt ?? input.approval.resolvedAt,
		createdAt: promoted.promotedAt ?? input.approval.resolvedAt,
	};
	const receiptInput: RecordApprovalExecutionReceiptParams = {
		...receiptBase,
		recordHash: await sha256(receiptBase),
	};
	await recordApprovalExecutionReceipt(db, receiptInput);
	return { outcome: promoted, receiptId, replayed };
}
