/** Credit admission for stored code tools and metered gateway Worker loads. */

import { BillingSettlementModeSchema } from "@tedix/api-contract/schemas/runtime-entitlements";
import {
	CODE_RUN_CREDITS,
	DYNAMIC_WORKER_COST_USD_MICROS,
	DYNAMIC_WORKER_PROVIDER,
	aiCreditsForProviderCost,
} from "@tedix/api-contract/utils/credit-pricing";
import { createDbClient } from "@tedix/db/client";
import {
	admitCodeRun,
	getCreditPoolSnapshot,
} from "@tedix/db/queries/billing/credit-pool";
import type { ModelAuthoredLoaderCall } from "@tedix/tedi-codemode-core/model-authored-code-loader";
import {
	reserveBillingUsage,
	releaseBillingReservation,
} from "@tedix/db/queries/billing/reservations";
import { recordBillingProviderUsage } from "@tedix/db/queries/billing/provider-usage";
import { settleBillingUsage } from "@tedix/db/queries/billing/settlement";
import type { CallerIdentity } from "./caller-identity";

export type CodeRunAdmission =
	| { allowed: true }
	| { allowed: false; code: string; message: string };

const REFUSAL_MESSAGES: Record<string, string> = {
	billing_settlement_mode_missing:
		"Code runs are unavailable: this installation has no billing settlement mode configured.",
	billing_not_configured:
		"Code runs are unavailable: billing is not configured for this organization.",
	subscription_inactive:
		"Code runs are paused: the organization's subscription needs attention.",
	billing_period_inactive:
		"Code runs are paused: the organization's billing period needs to be renewed.",
	monthly_credit_limit_reached:
		"This month's Tedix credits are used up. An admin can buy a top-up or turn on pay-as-you-go.",
	tedi_monthly_credit_cap_reached:
		"This tedi reached the monthly credit cap an admin set for it.",
	member_monthly_credit_cap_reached:
		"You reached the monthly credit cap an admin set for you.",
};

export function codeRunRefusalMessage(code: string): string {
	return `${REFUSAL_MESSAGES[code] ?? "This code run was not admitted."} (${code})`;
}

/** Admit and charge one code run before its dynamic Worker starts. */
export async function admitCodeModeRun(input: {
	env: { DB?: D1Database; TEDIX_BILLING_SETTLEMENT_MODE?: string };
	organizationId: string | null | undefined;
	executionId: string;
	caller: CallerIdentity | undefined;
	nowMs?: number;
}): Promise<CodeRunAdmission> {
	const organizationId =
		input.organizationId ?? input.caller?.organizationId ?? null;
	const refuse = (code: string): CodeRunAdmission => ({
		allowed: false,
		code,
		message: codeRunRefusalMessage(code),
	});
	const settlementMode = BillingSettlementModeSchema.safeParse(
		input.env.TEDIX_BILLING_SETTLEMENT_MODE,
	);
	if (!settlementMode.success) return refuse("billing_settlement_mode_missing");
	if (settlementMode.data !== "managed") return { allowed: true };
	if (!organizationId || !input.env.DB) return refuse("billing_not_configured");
	const caller = input.caller;
	const tediId = caller?.authType === "tedi" ? (caller.tediId ?? null) : null;
	const userId =
		caller && caller.authType !== "tedi" ? (caller.userId ?? null) : null;
	const decision = await admitCodeRun(createDbClient(input.env.DB), {
		organizationId,
		executionId: input.executionId,
		tediId,
		userId,
		credits: CODE_RUN_CREDITS,
		now: new Date(input.nowMs ?? Date.now()).toISOString(),
	});
	return decision.allowed ? { allowed: true } : refuse(decision.code);
}

/** Reserve before the SDK runs; settle returned loader calls even if user code fails. */
export async function executeMeteredCodeMode<T>(input: {
	env: { DB?: D1Database; TEDIX_BILLING_SETTLEMENT_MODE?: string };
	organizationId: string | null | undefined;
	executionId: string;
	caller: CallerIdentity | undefined;
	timeoutMs: number;
	execute: (onLoad: (call: ModelAuthoredLoaderCall) => void) => Promise<T>;
}): Promise<T> {
	const mode = BillingSettlementModeSchema.safeParse(
		input.env.TEDIX_BILLING_SETTLEMENT_MODE,
	);
	if (!mode.success)
		throw new Error(codeRunRefusalMessage("billing_settlement_mode_missing"));
	if (mode.data !== "managed") return input.execute(() => {});
	const organizationId = input.organizationId ?? input.caller?.organizationId;
	if (!organizationId || !input.env.DB)
		throw new Error(codeRunRefusalMessage("billing_not_configured"));
	const db = createDbClient(input.env.DB);
	const now = new Date().toISOString();
	const tediId = input.caller?.authType === "tedi" ? input.caller.tediId : null;
	const userId =
		input.caller?.authType !== "tedi" ? input.caller?.userId : null;
	const pool = await getCreditPoolSnapshot(db, {
		organizationId,
		now,
		subject: { tediId, userId },
	});
	if (!pool?.creditFx)
		throw new Error(codeRunRefusalMessage("billing_not_configured"));
	const decision = await reserveBillingUsage(db, {
		id: crypto.randomUUID(),
		organizationId,
		tediId,
		userId,
		source: "system",
		provider: DYNAMIC_WORKER_PROVIDER,
		model: "dynamic-worker",
		estimatedInputTokens: 0,
		estimatedOutputTokens: 0,
		credits: aiCreditsForProviderCost(
			DYNAMIC_WORKER_COST_USD_MICROS,
			pool.creditFx.microUsdPerEur,
		),
		idempotencyKey: `dynamic-worker:${input.executionId}`,
		expiresAt: new Date(Date.now() + input.timeoutMs + 60_000).toISOString(),
		now,
	});
	if (!decision.allowed) throw new Error(codeRunRefusalMessage(decision.code));
	const calls: (ModelAuthoredLoaderCall & { occurredAt: string })[] = [];
	const reservationId = decision.reservation.id;
	const settledOrganizationId = organizationId;
	const settleCodeRun = async () => {
		const settledAt = new Date().toISOString();
		if (calls.length === 0) {
			await releaseBillingReservation(db, {
				reservationId,
				organizationId: settledOrganizationId,
				reason: "no_worker_loaded",
				now: settledAt,
			});
		} else {
			for (const [index, call] of calls.entries()) {
				await recordBillingProviderUsage(db, {
					id: crypto.randomUUID(),
					organizationId: settledOrganizationId,
					tediId,
					reservationId,
					providerUsageId: `dynamic-worker:${input.executionId}:${index}`,
					provider: DYNAMIC_WORKER_PROVIDER,
					model: "dynamic-worker",
					usageKind: "other",
					unit: "units",
					quantity: 1,
					providerCostMicros: DYNAMIC_WORKER_COST_USD_MICROS,
					providerCostQuality: "estimated",
					occurredAt: call.occurredAt,
					now: settledAt,
					metadata: {
						surface: "gateway_model_code",
						identity: call.identity,
						method: call.method,
					},
				});
			}
			await settleBillingUsage(db, {
				id: `dynamic-worker:${input.executionId}`,
				organizationId: settledOrganizationId,
				tediId,
				reservationId,
				providerUsageId: `dynamic-worker:${input.executionId}`,
				provider: DYNAMIC_WORKER_PROVIDER,
				model: "dynamic-worker",
				source: "system",
				inputTokens: 0,
				outputTokens: 0,
				providerCostMicros: calls.length * DYNAMIC_WORKER_COST_USD_MICROS,
				usageQuality: "gateway_reported",
				providerCostQuality: "estimated",
				meteringReady: true,
				occurredAt: calls[0]!.occurredAt,
				now: settledAt,
				metadata: { surface: "gateway_model_code", loads: calls.length },
			});
		}
	};
	try {
		return await input.execute((call) =>
			calls.push({ ...call, occurredAt: new Date().toISOString() }),
		);
	} finally {
		// A finished run keeps its result when this bookkeeping write hits a
		// busy database: every write is idempotent, so retry once, then let the
		// hold expire uncharged rather than replace the result with the error.
		try {
			await settleCodeRun();
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 500));
			try {
				await settleCodeRun();
			} catch (error) {
				console.error("[code-run-admission] settlement failed", {
					exception: error instanceof Error ? error.name : typeof error,
					loads: calls.length,
				});
			}
		}
	}
}
