import { getModelCatalogConfig } from "@tedix/db/queries/model-catalog";
import {
	creditRefusalReason,
	getCreditPoolSnapshot,
} from "@tedix/db/queries/billing/credit-pool";
import type {
	AuthorizeRuntimeInferenceInput,
	AuthorizeRuntimeInferenceResponse,
} from "@tedix/api-contract/schemas/runtime-entitlements";
import type { ProviderExecutionAdmissionGuard } from "@tedix/db/queries/provider-executions";
import type { NewProviderExecutionAttemptRow } from "@tedix/db/schema/provider-executions";
import type { DbClient } from "@tedix/db/client";
import { getInferenceAdmissionReads } from "@tedix/db/queries/billing/inference-admission";
import {
	estimateAiCredits,
	prepareAiCreditEstimate,
} from "@tedix/db/queries/billing/reservations";
import { runtimeEntitlementIsActive } from "@tedix/db/queries/runtime-entitlements";
import { buildProviderExecutionInsertStatement } from "@tedix/db/queries/provider-executions";
import type {
	WalletHoldInput,
	WalletHoldResult,
	WalletRpc,
} from "@tedix/api-contract/schemas/billing-wallet";
import { toJsonRecord } from "@tedix/db/utils/json";
import { resolveBillingSettlementMode } from "../lib/billing-settlement-mode";
import {
	aiGatewayModelTierAllowed,
	resolveAiGatewayAdmissionPolicy,
} from "./ai-gateway-admission-policy";

/**
 * Content-free phase timing for inference admission.
 *
 * The runtime's `inference_authorize` marker measured this RPC at 505-1469ms
 * per provider request, awaited before EVERY model round, and showed the cost
 * does not track payload size — so it is handler latency, not runtime work.
 * This names which part of it is responsible. Join to the runtime marker on
 * `runId`.
 *
 * `readMs` replaced the separate `entitlementMs`/`policyMs` spans when those
 * reads became one batch. Keeping two fields would have reported the whole
 * batch under whichever await was wrapped first and ~0 for the other, which
 * reads as "the policy cost vanished" when only the phase boundary moved.
 * Against the serial baseline (187ms entitlement + 713ms policies, totalMs
 * 1321-1388) the honest comparison is `readMs` against their sum, and `totalMs`
 * against `totalMs`.
 *
 * Identifiers and durations only; never the request body or its token estimates.
 */
function markAdmission(input: {
	runId: string | null;
	organizationId: string;
	mode: string;
	outcome: string;
	readMs: number;
	reserveMs: number;
	/** Inside reserveMs: the rate read still pending after the reads, the wallet hold, the fence write. */
	estimateMs: number;
	holdMs: number;
	fenceMs: number;
	totalMs: number;
}): void {
	try {
		console.log(JSON.stringify({ _tr: "authorize_inference_api", ...input }));
	} catch {
		/* marker is best-effort */
	}
}

export async function authorizeRuntimeBudget(input: {
	db: DbClient;
	env:
		| CloudflareEnv
		| { TEDIX_BILLING_SETTLEMENT_MODE?: string; MCP_SERVICE?: unknown };
	request: Omit<
		AuthorizeRuntimeInferenceInput,
		"execution" | "workItemId" | "originToken"
	> & {
		provider: string;
		model: string;
	};
	execution?: NewProviderExecutionAttemptRow;
	executionGuard?: ProviderExecutionAdmissionGuard;
	nowMs?: number;
	preflightOnly?: boolean;
}): Promise<RuntimeBudgetDecision> {
	const mode = resolveBillingSettlementMode(input.env);
	if (mode !== input.request.settlementMode) {
		throw new Error(
			`Runtime settlement mode mismatch: caller=${input.request.settlementMode} api=${mode}`,
		);
	}
	const nowMs = input.nowMs ?? Date.now();
	const admissionAt = Date.now();
	let readMs = 0;
	let reserveMs = 0;
	let estimateMs = 0;
	let holdMs = 0;
	let fenceMs = 0;
	const done = (outcome: string) =>
		markAdmission({
			runId: input.request.runId ?? null,
			organizationId: input.request.organizationId,
			mode,
			outcome,
			readMs,
			reserveMs,
			estimateMs,
			holdMs,
			fenceMs,
			totalMs: Date.now() - admissionAt,
		});
	// The reads are hoisted into one batch; the CHECKS below keep their original
	// order deliberately. Deciding the policy outcome before the entitlement
	// early-returns would turn a clean `entitlement_not_configured` denial into
	// the `policy_unresolved` throw, which the runtime maps to a
	// billing_service_error — a 500 class where a denial belongs.
	const readAt = Date.now();
	// Independent of the reads: the catalog, and the managed call's rate lookup
	// (the plan's FX rate is applied once the reads return it).
	const catalogRead = settle(getModelCatalogConfig(input.db));
	const estimateRead =
		mode === "managed" && !input.preflightOnly
			? settle(
					prepareAiCreditEstimate(input.db, {
						provider: input.request.provider,
						model: input.request.model,
						execution: input.execution,
						estimatedInputTokens: input.request.estimatedInputTokens,
						estimatedOutputTokens: input.request.estimatedOutputTokens,
						now: new Date(nowMs).toISOString(),
					}),
				)
			: null;
	const {
		entitlement,
		policies: policySources,
		reservationPreflight,
	} = await getInferenceAdmissionReads(
		input.db,
		input.request.organizationId,
		input.request.tediId,
		mode === "managed" && !input.preflightOnly
			? {
					idempotencyKey: input.request.idempotencyKey,
					executionGuard: input.executionGuard,
				}
			: undefined,
	);
	readMs = Date.now() - readAt;
	if (!entitlement) {
		done("entitlement_not_configured");
		return {
			allowed: false,
			code: "entitlement_not_configured",
			entitlement: null,
		};
	}
	if (entitlement.status !== "trial" && entitlement.status !== "active") {
		done("entitlement_inactive");
		return { allowed: false, code: "entitlement_inactive", entitlement };
	}
	if (!runtimeEntitlementIsActive(entitlement, nowMs)) {
		done("entitlement_period_inactive");
		return {
			allowed: false,
			code: "entitlement_period_inactive",
			entitlement,
		};
	}
	if (!policySources || !policySources.tediFound) {
		// A slow FAILING admission is exactly as interesting as a slow successful
		// one; emit before throwing so this path is not a hole in the timing.
		done("policy_unresolved");
		throw new Error("AI Gateway policy attribution does not resolve in D1");
	}
	const aiGatewayPolicy = resolveAiGatewayAdmissionPolicy(policySources);
	const catalog = unwrap(await catalogRead);
	if (
		!aiGatewayModelTierAllowed(
			input.request.provider,
			input.request.model,
			aiGatewayPolicy,
			catalog.entries,
		)
	) {
		done("model_tier_not_allowed");
		return {
			allowed: false,
			code: "model_tier_not_allowed",
			entitlement,
		};
	}
	if (mode !== "managed") {
		done("allowed_unmanaged");
		return {
			allowed: true,
			settlementMode: mode,

			reservationId: null,
			expiresAt: null,
			estimatedCredits: null,
		};
	}

	if (input.preflightOnly) {
		// Dispatch readiness only: the paid call still reserves its own credits.
		const now = new Date(nowMs).toISOString();
		const snapshot = await getCreditPoolSnapshot(input.db, {
			organizationId: input.request.organizationId,
			now,
			subject: {
				tediId: input.request.tediId,
				userId: input.request.userId,
			},
		});
		const credits = await estimateAiCredits(input.db, {
			creditFx: snapshot?.creditFx ?? null,
			provider: input.request.provider,
			model: input.request.model,
			execution: input.execution,
			estimatedInputTokens: input.request.estimatedInputTokens,
			estimatedOutputTokens: input.request.estimatedOutputTokens,
			now,
		});
		const refusal = creditRefusalReason(snapshot, {
			now,
			credits: credits ?? 1,
		});
		done(refusal ?? "allowed_preflight");
		if (refusal) return { allowed: false, code: refusal, entitlement };
		return {
			allowed: true,
			settlementMode: mode,
			reservationId: null,
			expiresAt: null,
			estimatedCredits: credits ?? 0,
		};
	}
	const reserveAt = Date.now();
	const now = new Date(nowMs).toISOString();
	const legacy = reservationPreflight?.existing;
	if (legacy) {
		// A D1 reservation from before the wallet: replay it, never renew it.
		reserveMs = Date.now() - reserveAt;
		const live =
			(legacy.status === "reserved" && legacy.expiresAt > now) ||
			legacy.status === "settled";
		done(live ? "allowed_replay" : "monthly_credit_limit_reached");
		if (!live)
			return {
				allowed: false,
				code: "monthly_credit_limit_reached",
				entitlement,
			};
		return {
			allowed: true,
			settlementMode: mode,
			reservationId: legacy.id,
			expiresAt: legacy.expiresAt,
			estimatedCredits: legacy.credits,
		};
	}
	const plan = reservationPreflight?.plan;
	if (!plan) {
		done("billing_not_configured");
		return { allowed: false, code: "billing_not_configured", entitlement };
	}
	const estimateAt = Date.now();
	const credits = unwrap(await estimateRead!)(plan.creditFx);
	estimateMs = Date.now() - estimateAt;
	if (credits === null || !Number.isSafeInteger(credits) || credits < 0) {
		done("pricing_unavailable");
		return { allowed: false, code: "pricing_unavailable", entitlement };
	}
	const wallet = walletRpc(input.env);
	const holdId = input.execution?.billingReservationId ?? crypto.randomUUID();
	const holdAt = Date.now();
	const hold = (await wallet.wallet(input.request.organizationId, "hold", {
		organizationId: input.request.organizationId,
		holdId,
		idempotencyKey: input.request.idempotencyKey,
		tediId: input.request.tediId ?? null,
		userId: input.request.userId ?? null,
		credits,
		runId: input.request.runId ?? null,
		metadata:
			input.request.metadata === undefined
				? undefined
				: toJsonRecord(input.request.metadata),
		expiresAt:
			input.execution?.sendBefore ??
			new Date(nowMs + 10 * 60 * 1_000).toISOString(),
	} satisfies WalletHoldInput)) as WalletHoldResult;
	holdMs = Date.now() - holdAt;
	if (!hold.allowed) {
		reserveMs = Date.now() - reserveAt;
		done(hold.code);
		return { allowed: false, code: hold.code, entitlement };
	}
	if (input.execution && !hold.replayed) {
		// The fence proves the dispatch identity; without it the held credits
		// have no call to settle against, so give them back.
		let fenced = false;
		const fenceAt = Date.now();
		try {
			const result = await buildProviderExecutionInsertStatement(
				input.db,
				input.execution,
				input.executionGuard,
			);
			fenced = (result.meta?.changes ?? 0) > 0;
		} finally {
			fenceMs = Date.now() - fenceAt;
			if (!fenced)
				await wallet
					.wallet(input.request.organizationId, "release", {
						holdId: hold.holdId,
					})
					.catch((error: unknown) =>
						// The hold expires on its own; keep the admission error.
						console.error("[runtime-budget] hold release failed", {
							exception: error instanceof Error ? error.name : typeof error,
						}),
					);
		}
		if (!fenced) {
			done("execution_refused");
			throw new Error("Execution admission refused by its dispatch guard");
		}
	}
	reserveMs = Date.now() - reserveAt;
	done(hold.replayed ? "allowed_replay" : "allowed");
	return {
		allowed: true,
		settlementMode: mode,
		reservationId: hold.holdId,
		expiresAt: hold.expiresAt,
		estimatedCredits: hold.credits,
	};
}

/** Start a read early without leaving an unhandled rejection if its result is never used. */
function settle<T>(
	promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
	return promise.then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error }),
	);
}

function unwrap<T>(
	result: { ok: true; value: T } | { ok: false; error: unknown },
): T {
	if (!result.ok) throw result.error;
	return result.value;
}

/** The MCP worker's wallet RPC over the existing internal service binding. */
function walletRpc(env: { MCP_SERVICE?: unknown }): WalletRpc {
	if (!env.MCP_SERVICE)
		throw new Error("Managed billing needs the MCP_SERVICE wallet binding");
	return env.MCP_SERVICE as WalletRpc;
}

export type RuntimeBudgetDecision =
	| Extract<AuthorizeRuntimeInferenceResponse, { allowed: false }>
	| Omit<
			Extract<AuthorizeRuntimeInferenceResponse, { allowed: true }>,
			"executionId" | "sendBefore" | "attributionVersion"
	  >;
