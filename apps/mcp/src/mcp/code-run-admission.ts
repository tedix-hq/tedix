/** Credit admission for stored code tools and metered gateway Worker loads. */

import { BillingSettlementModeSchema } from "@tedix/api-contract/schemas/runtime-entitlements";
import { CODE_RUN_CREDITS } from "@tedix/api-contract/utils/credit-pricing";

import { coreDb } from "@tedix/db/core-store/scope";
import type { CoreStoreEnv } from "@tedix/db/core-store/client";
import { coreStoreReady } from "../lib/core-store";
import { admitCodeRun } from "@tedix/db/queries/billing/credit-pool";
import type { ModelAuthoredLoaderCall } from "@tedix/tedi-codemode-core/model-authored-code-loader";
import {
	type WalletChargeInput,
	type WalletChargeResult,
	type WalletSettleInput,
	walletStub,
} from "../billing-wallet";
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
	work_budget_exhausted:
		"This Work's credit budget is used up. An owner can raise the budget on the Work Item, its project, case or objective.",
};

export function codeRunRefusalMessage(code: string): string {
	return `${REFUSAL_MESSAGES[code] ?? "This code run was not admitted."} (${code})`;
}

/** Admit and charge one code run before its dynamic Worker starts. */
export async function admitCodeModeRun(input: {
	env: CoreStoreEnv & { TEDIX_BILLING_SETTLEMENT_MODE?: string };
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
	if (!organizationId || !coreStoreReady(input.env))
		return refuse("billing_not_configured");
	const caller = input.caller;
	const tediId = caller?.authType === "tedi" ? (caller.tediId ?? null) : null;
	const userId =
		caller && caller.authType !== "tedi" ? (caller.userId ?? null) : null;
	const decision = await admitCodeRun(coreDb(input.env), {
		organizationId,
		executionId: input.executionId,
		tediId,
		userId,
		credits: CODE_RUN_CREDITS,
		now: new Date(input.nowMs ?? Date.now()).toISOString(),
	});
	return decision.allowed ? { allowed: true } : refuse(decision.code);
}

/** Charge the organization wallet before the SDK runs; settle returned loader calls even if user code fails. */
export async function executeMeteredCodeMode<T>(input: {
	env: CoreStoreEnv & {
		MCP_SUBSCRIPTIONS?: DurableObjectNamespace;
		TEDIX_BILLING_SETTLEMENT_MODE?: string;
	};
	organizationId: string | null | undefined;
	executionId: string;
	caller: CallerIdentity | undefined;
	/** The verified agent session this run acts in, when the caller named one. */
	agentSessionId?: string | null;
	execute: (onLoad: (call: ModelAuthoredLoaderCall) => void) => Promise<T>;
}): Promise<T> {
	const mode = BillingSettlementModeSchema.safeParse(
		input.env.TEDIX_BILLING_SETTLEMENT_MODE,
	);
	if (!mode.success)
		throw new Error(codeRunRefusalMessage("billing_settlement_mode_missing"));
	if (mode.data !== "managed") return input.execute(() => {});
	const organizationId = input.organizationId ?? input.caller?.organizationId;
	if (!organizationId || !input.env.MCP_SUBSCRIPTIONS)
		throw new Error(codeRunRefusalMessage("billing_not_configured"));
	const wallet = walletStub(input.env, organizationId);
	const eventId = `dynamic-worker:${input.executionId}`;
	const call = async <R>(route: string, body: unknown): Promise<R> => {
		const response = await wallet.fetch(
			`https://wallet.internal/wallet/${route}`,
			{
				method: "POST",
				body: JSON.stringify(body),
			},
		);
		if (!response.ok) throw new Error(`Wallet status ${response.status}`);
		return (await response.json()) as R;
	};
	const charge: WalletChargeInput = {
		organizationId,
		eventId,
		tediId:
			input.caller?.authType === "tedi" ? (input.caller.tediId ?? null) : null,
		userId:
			input.caller?.authType !== "tedi" ? (input.caller?.userId ?? null) : null,
		workItemId: input.caller?.requestWorkItemId ?? null,
		agentSessionId:
			input.agentSessionId ?? input.caller?.externalAgentSessionId ?? null,
	};
	const decision = await call<WalletChargeResult>("charge", charge);
	if (!decision.allowed) throw new Error(codeRunRefusalMessage(decision.code));
	const calls: ModelAuthoredLoaderCall[] = [];
	try {
		return await input.execute((loaded) => calls.push(loaded));
	} finally {
		const settle: WalletSettleInput = {
			eventId,
			anonymousLoads: calls.filter((c) => c.identity === "anonymous").length,
			namedLoads: calls.filter((c) => c.identity === "named").length,
		};
		// A finished run keeps its result when settlement fails: the wallet
		// flushes an unsettled charge as one load after its grace period.
		try {
			await call("settle", settle);
		} catch (error) {
			console.error("[code-run-admission] wallet settlement failed", {
				exception: error instanceof Error ? error.name : typeof error,
				loads: calls.length,
			});
		}
	}
}
