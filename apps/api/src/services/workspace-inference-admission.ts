import type { DbClient } from "@tedix/db/client";
import type {
	AuthorizeRuntimeInferenceResponse,
	AuthorizeWorkspaceInferenceInput,
	ReleaseInferenceReservationInput,
} from "@tedix/api-contract/schemas/runtime-entitlements";
import { releaseBillingReservation } from "@tedix/db/queries/billing/reservations";
import { resolveBillingSettlementMode } from "../lib/billing-settlement-mode";
import { authorizeRuntimeInference } from "./runtime-entitlement-admission";

/**
 * Admit one workspace chat model call through the same reservation path as
 * the kernel and the tedi runtime. The turn id is the run the AI Gateway log
 * must name, so settlement can match the log to this reservation.
 */
export function authorizeWorkspaceInference(input: {
	db: DbClient;
	env: Parameters<typeof authorizeRuntimeInference>[0]["env"];
	request: AuthorizeWorkspaceInferenceInput;
	nowMs?: number;
}): Promise<AuthorizeRuntimeInferenceResponse> {
	const { request } = input;
	return authorizeRuntimeInference({
		db: input.db,
		env: input.env,
		plane: "workspace_object",
		nowMs: input.nowMs,
		request: {
			organizationId: request.organizationId,
			tediId: request.tediId ?? null,
			userId: request.userId ?? null,
			settlementMode: resolveBillingSettlementMode(input.env),
			source: "operator",
			execution: request.execution,
			workItemId: null,
			estimatedInputTokens: request.estimatedInputTokens,
			estimatedOutputTokens: request.estimatedOutputTokens,
			runId: request.turnId,
			traceId: request.workspaceId,
			idempotencyKey: request.idempotencyKey,
			metadata: {
				source: "workspace_chat",
				workspaceId: request.workspaceId,
				residencyModality: request.residencyModality ?? "text",
			},
		},
	});
}

/** Return the held credits of a reservation whose call never used them. */
export async function releaseInferenceReservation(input: {
	db: DbClient;
	request: ReleaseInferenceReservationInput;
	nowMs?: number;
}): Promise<{ released: boolean }> {
	const row = await releaseBillingReservation(input.db, {
		reservationId: input.request.reservationId,
		organizationId: input.request.organizationId,
		reason: input.request.reason,
		now: new Date(input.nowMs ?? Date.now()).toISOString(),
	});
	return { released: row !== null };
}
