import { createDbClient } from "@tedix/db/client";
import { getEffectiveMcpPaymentPolicy } from "@tedix/db/queries/mcp-payments";
import { getToolById } from "@tedix/db/queries/tools";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { toJsonRecord } from "@tedix/db/utils/json";
import type { AppTool, ServerContext } from "./server-context";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { contentFreeMcpException, createMcpLogger } from "../log";

export const log = createMcpLogger("mcp.payments");

const PAYMENT_POLICY_META_KEY = "x-tedix/payment";

export const DEFAULT_PAYMENT_TTL_SECONDS = 300;

export interface TedixToolPaymentPolicy {
	enabled: boolean;
	protocol?: "x402";
	amount: string;
	currency?: string;
	network: string;
	recipient: string;
	asset?: string;
	description?: string;
	facilitatorUrl?: string;
	ttlSeconds?: number;
	mode?: "mock" | "facilitator";
	budget?: TedixPaymentBudgetPolicy;
}

export interface TedixPaymentBudgetPolicy {
	id?: string;
	enabled: boolean;
	maxAmount: string;
	maxTransactionAmount?: string | null;
	allowedRecipients?: string[] | null;
	/** Exact appSlug:toolId pairs; an empty list denies every paid tool. */
	allowedTools?: string[] | null;
	windowSeconds: number;
	scope: "tedi" | "user" | "organization" | "app" | "tool";
	mode: "enforce" | "warn";
}

function parseRecord(value: unknown): Record<string, JsonValue> | null {
	if (isRecord(value)) {
		try {
			return toJsonRecord(value);
		} catch {
			return null;
		}
	}
	if (typeof value !== "string" || !value.trim()) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? toJsonRecord(parsed) : null;
	} catch {
		return null;
	}
}

function parseOptionalAllowList(value: unknown): string[] | null {
	if (value == null) return null;
	return Array.isArray(value) &&
		value.every((entry) => typeof entry === "string")
		? value
		: [];
}

function parseBudgetPolicy(
	value: unknown,
): TedixPaymentBudgetPolicy | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.enabled !== "boolean") return undefined;
	const guardrails = {
		maxTransactionAmount:
			typeof value.maxTransactionAmount === "string"
				? value.maxTransactionAmount
				: value.maxTransactionAmount == null
					? null
					: "invalid",
		allowedRecipients: parseOptionalAllowList(value.allowedRecipients),
		allowedTools: parseOptionalAllowList(value.allowedTools),
	};
	// A configured-but-disabled budget is a paused control, not an absent one:
	// it must survive parsing so the gate can fail closed on it. Removing the
	// budget config entirely is the only way to lift the cap.
	if (value.enabled !== true) {
		return {
			enabled: false,
			...guardrails,
			maxAmount: typeof value.maxAmount === "string" ? value.maxAmount : "0",
			windowSeconds:
				typeof value.windowSeconds === "number" && value.windowSeconds > 0
					? value.windowSeconds
					: 86_400,
			scope:
				value.scope === "user" ||
				value.scope === "organization" ||
				value.scope === "app" ||
				value.scope === "tool"
					? value.scope
					: "tedi",
			mode: value.mode === "warn" ? "warn" : "enforce",
		};
	}
	if (typeof value.maxAmount !== "string" || !value.maxAmount) return undefined;
	return {
		enabled: true,
		...guardrails,
		maxAmount: value.maxAmount,
		windowSeconds:
			typeof value.windowSeconds === "number" && value.windowSeconds > 0
				? value.windowSeconds
				: 86_400,
		scope:
			value.scope === "user" ||
			value.scope === "organization" ||
			value.scope === "app" ||
			value.scope === "tool"
				? value.scope
				: "tedi",
		mode: value.mode === "warn" ? "warn" : "enforce",
	};
}

export function getToolPaymentPolicy(
	tool: AppTool,
): TedixToolPaymentPolicy | null {
	const meta = parseRecord(tool.meta);
	const config = parseRecord(tool.config);
	const metaPolicy = meta?.[PAYMENT_POLICY_META_KEY];
	const configPolicy = config?.[PAYMENT_POLICY_META_KEY] ?? config?.payment;
	const policy =
		isRecord(metaPolicy) && isRecord(configPolicy)
			? {
					...configPolicy,
					...metaPolicy,
					...(metaPolicy.budget === undefined &&
					configPolicy.budget !== undefined
						? { budget: configPolicy.budget }
						: {}),
				}
			: (metaPolicy ?? configPolicy);
	if (!isRecord(policy)) return null;
	if (policy.enabled !== true) return null;
	if (policy.protocol !== undefined && policy.protocol !== "x402") return null;
	if (typeof policy.amount !== "string" || !policy.amount) return null;
	if (typeof policy.network !== "string" || !policy.network) return null;
	if (typeof policy.recipient !== "string" || !policy.recipient) return null;

	return {
		enabled: true,
		protocol: "x402",
		amount: policy.amount,
		currency: typeof policy.currency === "string" ? policy.currency : "USDC",
		network: policy.network,
		recipient: policy.recipient,
		asset: typeof policy.asset === "string" ? policy.asset : undefined,
		description:
			typeof policy.description === "string" ? policy.description : undefined,
		facilitatorUrl:
			typeof policy.facilitatorUrl === "string"
				? policy.facilitatorUrl
				: undefined,
		ttlSeconds:
			typeof policy.ttlSeconds === "number"
				? policy.ttlSeconds
				: DEFAULT_PAYMENT_TTL_SECONDS,
		mode: policy.mode === "facilitator" ? "facilitator" : "mock",
		budget: parseBudgetPolicy(policy.budget),
	};
}

/**
 * Outcome of resolving a tool's payment policy and its spend budget.
 *
 * `loadFailed` is the load-leg counterpart to the settlement-leg fail-closed
 * rule. Before this existed, a thrown budget lookup was indistinguishable from
 * a tool that legitimately has no budget configured: both fell through to a
 * policy with `budget` undefined, and `evaluateBudget` returns undefined —
 * i.e. allowed — for that shape. A transient D1 error therefore removed the
 * cap entirely for any tenant whose limit lives only in the managed-budget
 * table, which is the normal case for org- and tedi-scoped budgets.
 *
 * Absence must still allow (an uncapped paid tool is a valid configuration —
 * the payment itself is the gate). Only a failed lookup denies.
 */

export type ResolvedToolPaymentPolicy =
	| { kind: "unpriced" }
	| { kind: "resolved"; policy: TedixToolPaymentPolicy }
	| { kind: "loadFailed"; policy: TedixToolPaymentPolicy; error: string };

export async function resolveToolPaymentPolicy(params: {
	agent: ServerContext;
	tool: AppTool;
}): Promise<ResolvedToolPaymentPolicy> {
	const policy = getToolPaymentPolicy(params.tool);
	if (!policy) return { kind: "unpriced" };
	if (!params.agent.env.DB) return { kind: "resolved", policy };

	const orgId = paymentOrganizationId(params.agent);
	if (orgId) {
		try {
			const db = createDbClient(params.agent.env.DB);
			const managedBudget = await getEffectiveMcpPaymentPolicy(db, {
				organizationId: orgId,
				tediId: params.agent.callerIdentity?.tediId ?? null,
				appSlug: params.agent.appSlug,
				toolId: params.tool.toolId,
				currency: policy.currency ?? "USDC",
				network: policy.network,
			});
			if (managedBudget) {
				return {
					kind: "resolved",
					policy: {
						...policy,
						budget: {
							id: managedBudget.id,
							enabled: managedBudget.enabled,
							maxAmount: managedBudget.maxAmount,
							maxTransactionAmount: managedBudget.maxTransactionAmount,
							allowedRecipients: managedBudget.allowedRecipients,
							allowedTools: managedBudget.allowedTools,
							windowSeconds: managedBudget.windowSeconds,
							scope: managedBudget.tediId ? "tedi" : "organization",
							mode: managedBudget.mode,
						},
					},
				};
			}
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			log.warn("Managed payment budget load failed", {
				event: "payments.managed_budget_load_failed",
				appId: params.agent.appId,
				toolName: params.tool.toolId,
				traceId: params.agent.traceId,
				outcome: "unavailable",
				error: contentFreeMcpException(err),
			});
			return { kind: "loadFailed", policy, error };
		}
	}

	if (policy.budget) return { kind: "resolved", policy };

	try {
		const persisted = await getToolById(
			createDbClient(params.agent.env.DB),
			params.tool.id,
		);
		if (!persisted) return { kind: "resolved", policy };

		const persistedPolicy = getToolPaymentPolicy({
			...params.tool,
			config: parseRecord(persisted.config),
			meta: parseRecord(persisted.meta),
		});
		if (!persistedPolicy?.budget) return { kind: "resolved", policy };

		return {
			kind: "resolved",
			policy: { ...policy, budget: persistedPolicy.budget },
		};
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		log.warn("Persisted payment budget refresh failed", {
			event: "payments.persisted_budget_refresh_failed",
			appId: params.agent.appId,
			toolName: params.tool.toolId,
			traceId: params.agent.traceId,
			outcome: "unavailable",
			error: contentFreeMcpException(err),
		});
		return { kind: "loadFailed", policy, error };
	}
}

export function paymentOrganizationId(
	agent: ServerContext,
): string | undefined {
	return agent.app?.organizationId ?? agent.callerIdentity?.organizationId;
}
