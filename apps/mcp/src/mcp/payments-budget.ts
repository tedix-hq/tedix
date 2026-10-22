import { createDbClient } from "@tedix/db/client";
import {
	type McpSettlementBudgetGuard,
	sumSettledMcpPaymentAmount,
} from "@tedix/db/queries/mcp-payments";
import type { AppTool, ServerContext } from "./server-context";
import {
	type TedixToolPaymentPolicy,
	paymentOrganizationId,
} from "./payments-policy";

function sqliteTimestamp(date: Date): string {
	return date.toISOString().replace("T", " ").slice(0, 19);
}

function decimalAtomicUnits(value: string): bigint | null {
	const match = /^(0|[1-9]\d*)(?:\.(\d{1,18}))?$/.exec(value);
	if (!match) return null;
	return (
		BigInt(match[1]!) * 10n ** 18n + BigInt((match[2] ?? "").padEnd(18, "0"))
	);
}

export async function evaluateBudget(params: {
	agent: ServerContext;
	tool: AppTool;
	policy: TedixToolPaymentPolicy;
	requirementId: string;
}): Promise<Record<string, unknown> | undefined> {
	const budget = params.policy.budget;
	if (!budget) return undefined;

	const denial = (reason: string): Record<string, unknown> => {
		const amount = Number(params.policy.amount);
		return {
			allowed: false,
			mode: budget.mode,
			scope: budget.scope,
			spent: "0",
			amount: params.policy.amount,
			projected: Number.isFinite(amount)
				? amount.toFixed(6).replace(/\.?0+$/, "")
				: params.policy.amount,
			maxAmount: budget.maxAmount,
			windowSeconds: budget.windowSeconds,
			currency: params.policy.currency ?? "USDC",
			network: params.policy.network,
			requirementId: params.requirementId,
			reason,
		};
	};

	// Fail closed: a paused budget or an unreachable budget store must deny
	// paid calls, never exempt them.
	if (!budget.enabled) return denial("budget_paused");
	const amountUnits = decimalAtomicUnits(params.policy.amount);
	const transactionLimitUnits = budget.maxTransactionAmount
		? decimalAtomicUnits(budget.maxTransactionAmount)
		: null;
	let guardrailViolation: string | null = null;
	if (
		budget.maxTransactionAmount != null &&
		(amountUnits === null ||
			transactionLimitUnits === null ||
			amountUnits > transactionLimitUnits)
	) {
		guardrailViolation = "transaction_limit_exceeded";
	} else if (
		budget.allowedRecipients != null &&
		!budget.allowedRecipients.includes(params.policy.recipient)
	) {
		guardrailViolation = "recipient_not_allowed";
	} else if (
		budget.allowedTools != null &&
		!budget.allowedTools.includes(
			`${params.agent.appSlug}:${params.tool.toolId}`,
		)
	) {
		guardrailViolation = "tool_not_allowed";
	}
	if (guardrailViolation && budget.mode === "enforce") {
		return denial(guardrailViolation);
	}
	if (!params.agent.env.DB) return denial("budget_store_unavailable");

	const organizationId = paymentOrganizationId(params.agent);
	if (!organizationId) return denial("missing_organization_id");

	const db = createDbClient(params.agent.env.DB);
	const cutoff = sqliteTimestamp(
		new Date(Date.now() - budget.windowSeconds * 1000),
	);
	const sumOptions: Parameters<typeof sumSettledMcpPaymentAmount>[1] = {
		organizationId,
		appSlug: params.agent.appSlug,
		currency: params.policy.currency ?? "USDC",
		network: params.policy.network,
		since: cutoff,
	};

	if (budget.scope === "tool") {
		sumOptions.toolId = params.tool.toolId;
	} else if (budget.scope === "tedi") {
		const tediId = params.agent.callerIdentity?.tediId;
		if (tediId) sumOptions.tediId = tediId;
	} else if (budget.scope === "user") {
		const userId = params.agent.callerIdentity?.userId;
		if (userId) sumOptions.userId = userId;
	}

	const spent = await sumSettledMcpPaymentAmount(db, sumOptions);
	const amount = Number(params.policy.amount);
	const maxAmount = Number(budget.maxAmount);
	const projected = spent + amount;
	const allowed =
		Number.isFinite(amount) &&
		Number.isFinite(maxAmount) &&
		Number.isFinite(spent) &&
		(projected <= maxAmount || budget.mode === "warn");

	return {
		allowed,
		mode: budget.mode,
		scope: budget.scope,
		spent: spent.toFixed(6).replace(/\.?0+$/, ""),
		amount: params.policy.amount,
		projected: projected.toFixed(6).replace(/\.?0+$/, ""),
		maxAmount: budget.maxAmount,
		maxTransactionAmount: budget.maxTransactionAmount ?? null,
		allowedRecipients: budget.allowedRecipients ?? null,
		allowedTools: budget.allowedTools ?? null,
		windowSeconds: budget.windowSeconds,
		currency: params.policy.currency ?? "USDC",
		network: params.policy.network,
		organizationId,
		requirementId: params.requirementId,
		...(allowed ? {} : { reason: "budget_exceeded" }),
		...(guardrailViolation ? { warning: guardrailViolation } : {}),
	};
}

export function buildBudgetGuard(params: {
	agent: ServerContext;
	tool: AppTool;
	policy: TedixToolPaymentPolicy;
}): McpSettlementBudgetGuard | undefined {
	const budget = params.policy.budget;
	if (!budget?.enabled || budget.mode !== "enforce" || !params.agent.env.DB) {
		return undefined;
	}
	return {
		maxAmount: budget.maxAmount,
		since: sqliteTimestamp(new Date(Date.now() - budget.windowSeconds * 1000)),
		...(budget.scope === "tool" ? { toolId: params.tool.toolId } : {}),
		...(budget.scope === "tedi" && params.agent.callerIdentity?.tediId
			? { tediId: params.agent.callerIdentity.tediId }
			: {}),
		...(budget.scope === "user" && params.agent.callerIdentity?.userId
			? { userId: params.agent.callerIdentity.userId }
			: {}),
	};
}
