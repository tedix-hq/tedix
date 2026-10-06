import type { CallToolResult } from "@modelcontextprotocol/server";
import type { PaymentRequired as CorePaymentRequired } from "@x402/core/types";
import { convertToTokenAmount } from "@x402/core/utils";
import { createDbClient } from "@tedix/db/client";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import {
	getEffectiveMcpPaymentPolicy,
	getMcpPaymentEventByIdForOrg,
	insertMcpPaymentEvent,
	insertSettledMcpPaymentEventWithinBudget,
	type McpSettlementBudgetGuard,
	sumSettledMcpPaymentAmount,
	updateMcpPaymentReservationStatus,
	upsertMcpPaymentReservation,
} from "@tedix/db/queries/mcp-payments";
import {
	completeRationaleRecord,
	createRationaleRecord,
} from "@tedix/db/queries/rationale-records";
import { getToolById } from "@tedix/db/queries/tools";
import type {
	McpPaymentEventType,
	McpPaymentStatus,
	NewMcpPaymentEvent,
} from "@tedix/db/schema/mcp-payments";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	buildPaymentRequiredResult,
	type TedixPaymentRequiredResult,
	X402_PAYMENT_META_KEY,
	X402_PAYMENT_RESPONSE_META_KEY,
	type X402ExactPaymentRequirementsV2,
	type X402PaymentRequiredResponse,
	type X402PaymentRequirementsResponseV2,
} from "@tedix/mcp-shared/payment";
import type { AppTool, ServerContext } from "./server-context";
import {
	buildFacilitatorChallenge,
	decodeFacilitatorPaymentToken,
	settleFacilitatorPayment,
	type VerifiedFacilitatorPayment,
	verifyFacilitatorPayment,
} from "./x402-facilitator";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { contentFreeMcpException, createMcpLogger } from "../log";

const log = createMcpLogger("mcp.payments");
const PAYMENT_POLICY_META_KEY = "x-tedix/payment";
const DEFAULT_PAYMENT_TTL_SECONDS = 300;

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

interface MockPaymentProof {
	requirementId?: string;
	toolId?: string;
	mockPaid?: boolean;
	amount?: string;
	network?: string;
}

type PaymentProof = MockPaymentProof | string;

export interface PendingFacilitatorSettlement {
	verified: VerifiedFacilitatorPayment;
	receiptId: string;
	requirementId: string;
	policy: TedixToolPaymentPolicy;
	tool: AppTool;
	args: Record<string, unknown>;
	budgetDecision?: Record<string, unknown>;
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

function optionalJsonRecord(
	value: unknown,
): ReturnType<typeof toJsonRecord> | undefined {
	return value === undefined ? undefined : toJsonRecord(value);
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

async function resolveToolPaymentPolicy(params: {
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

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

async function buildRequirementId(
	agent: ServerContext,
	tool: AppTool,
	args: Record<string, unknown>,
): Promise<string> {
	const hash = await sha256Hex(
		stableStringify({
			appId: agent.appId,
			toolId: tool.toolId,
			args,
		}),
	);
	return `tedix-x402-${hash.slice(0, 24)}`;
}

function buildMockRequirements(params: {
	agent: ServerContext;
	tool: AppTool;
	policy: TedixToolPaymentPolicy;
	requirementId: string;
	paymentRequestId?: string;
}): X402PaymentRequirementsResponseV2 {
	if (!/^\d+(?:\.\d{1,6})?$/.test(params.policy.amount)) {
		throw new Error("Mock x402 v2 amount must have at most six decimal places");
	}
	const resource = `mcp://${params.agent.appSlug}/tools/${params.tool.toolId}#${params.requirementId}`;
	const legacyNetworks: Record<string, string> = {
		"solana-devnet": "solana:devnet",
		"solana-mainnet": "solana:mainnet",
		"base-sepolia": "eip155:84532",
		base: "eip155:8453",
		ethereum: "eip155:1",
		sepolia: "eip155:11155111",
	};
	const requirement: X402ExactPaymentRequirementsV2 = {
		scheme: "exact",
		network:
			legacyNetworks[params.policy.network] ??
			(params.policy.network.includes(":")
				? params.policy.network
				: `mock:${params.policy.network}`),
		asset: params.policy.asset ?? params.policy.currency ?? "USDC",
		amount: convertToTokenAmount(params.policy.amount, 6),
		payTo: params.policy.recipient,
		maxTimeoutSeconds: params.policy.ttlSeconds ?? DEFAULT_PAYMENT_TTL_SECONDS,
		extra: {
			displayAmount: params.policy.amount,
			currency: params.policy.currency ?? "USDC",
			amountDecimals: 6,
			requirementId: params.requirementId,
			toolId: params.tool.toolId,
			appId: params.agent.appId,
			appSlug: params.agent.appSlug,
			mode: params.policy.mode ?? "mock",
			...(params.paymentRequestId
				? { paymentRequestId: params.paymentRequestId }
				: {}),
			...(params.policy.facilitatorUrl
				? { facilitatorUrl: params.policy.facilitatorUrl }
				: {}),
		},
	};
	return {
		x402Version: 2,
		resource: {
			url: resource,
			description:
				params.policy.description ??
				`Pay ${params.policy.amount} ${params.policy.currency ?? "USDC"} to call ${params.tool.toolId}`,
			mimeType: "application/json",
		},
		accepts: [requirement],
	};
}

async function buildPaymentRequirements(params: {
	agent: ServerContext;
	tool: AppTool;
	policy: TedixToolPaymentPolicy;
	requirementId: string;
	paymentRequestId: string;
}): Promise<X402PaymentRequiredResponse> {
	if (params.policy.mode !== "facilitator") {
		return buildMockRequirements(params);
	}
	if (!params.policy.facilitatorUrl) {
		throw new Error("Facilitator mode requires facilitatorUrl");
	}
	if ((params.policy.currency ?? "USDC").toUpperCase() !== "USDC") {
		throw new Error(
			"Facilitator mode currently supports USD-denominated USDC payments only",
		);
	}
	const resource = `mcp://${params.agent.appSlug}/tools/${params.tool.toolId}#${params.requirementId}`;
	const challenge = await buildFacilitatorChallenge({
		facilitatorUrl: params.policy.facilitatorUrl,
		network: params.policy.network,
		recipient: params.policy.recipient,
		amount: params.policy.amount,
		maxTimeoutSeconds: params.policy.ttlSeconds ?? DEFAULT_PAYMENT_TTL_SECONDS,
		resource,
		description:
			params.policy.description ??
			`Pay ${params.policy.amount} ${params.policy.currency ?? "USDC"} to call ${params.tool.toolId}`,
		extra: {
			requirementId: params.requirementId,
			toolId: params.tool.toolId,
			appId: params.agent.appId,
			appSlug: params.agent.appSlug,
			mode: "facilitator",
			paymentRequestId: params.paymentRequestId,
		},
	});
	if (challenge.x402Version !== 2) {
		throw new Error(
			`Facilitator negotiated unsupported x402 version ${challenge.x402Version}`,
		);
	}
	if (
		params.policy.asset &&
		params.policy.asset.toUpperCase() !== "USDC" &&
		!challenge.accepts.some(
			(requirement) =>
				requirement.asset.toLowerCase() === params.policy.asset?.toLowerCase(),
		)
	) {
		throw new Error(
			"Configured facilitator asset does not match the negotiated USDC asset",
		);
	}
	return challenge as X402PaymentRequiredResponse;
}

function getPaymentProof(
	extra: { _meta?: Record<string, unknown> } | undefined,
): PaymentProof | null {
	const proof = extra?._meta?.[X402_PAYMENT_META_KEY];
	if (typeof proof === "string" && proof.trim()) return proof;
	if (!isRecord(proof)) return null;
	return proof as MockPaymentProof;
}

function isMockPaymentValid(params: {
	proof: PaymentProof | null;
	tool: AppTool;
	policy: TedixToolPaymentPolicy;
	requirementId: string;
}): boolean {
	const { proof, tool, policy, requirementId } = params;
	if (!proof || typeof proof === "string") return false;
	if (!proof?.mockPaid) return false;
	if (proof.requirementId !== requirementId) return false;
	if (proof.toolId !== undefined && proof.toolId !== tool.toolId) return false;
	if (proof.amount !== undefined && proof.amount !== policy.amount)
		return false;
	if (proof.network !== undefined && proof.network !== policy.network) {
		return false;
	}
	return true;
}

function getRequirementsResource(
	requirements: X402PaymentRequiredResponse,
): string | null {
	if (requirements.x402Version === 2) return requirements.resource.url;
	const first = requirements.accepts[0];
	return typeof first?.resource === "string" ? first.resource : null;
}

async function redactedPaymentProof(
	proof: PaymentProof | null,
): Promise<Record<string, unknown> | null> {
	if (!proof) return null;
	if (typeof proof === "string") {
		let x402Version: number | undefined;
		try {
			x402Version = decodeFacilitatorPaymentToken(proof).x402Version;
		} catch {
			// The facilitator rejection path still records a non-sensitive hash.
		}
		return {
			format: "payment-signature",
			paymentPayloadHash: await sha256Hex(proof),
			...(x402Version ? { x402Version } : {}),
		};
	}
	return {
		requirementId: proof.requirementId,
		toolId: proof.toolId,
		mockPaid: proof.mockPaid === true,
		amount: proof.amount,
		network: proof.network,
	};
}

function paymentActor(params: { agent: ServerContext }): {
	actorId: string;
	actorType: "user" | "service" | "tedi" | "m2m" | "external_agent";
} {
	const identity = params.agent.callerIdentity;
	if (identity?.tediId) return { actorId: identity.tediId, actorType: "tedi" };
	if (identity?.externalAgentPrincipalId) {
		return {
			actorId: identity.externalAgentPrincipalId,
			actorType: "external_agent",
		};
	}
	if (identity?.userId) return { actorId: identity.userId, actorType: "user" };
	if (identity?.clientId)
		return { actorId: identity.clientId, actorType: "m2m" };
	if (identity?.authType === "apiKey")
		return { actorId: "api-key", actorType: "service" };
	if (identity?.authType === "service")
		return { actorId: "service", actorType: "service" };
	return { actorId: "anonymous", actorType: "service" };
}

function paymentDecisionRationale(params: {
	eventType: McpPaymentEventType;
	status: McpPaymentStatus;
	policy: TedixToolPaymentPolicy;
	tool: AppTool;
	budgetDecision?: Record<string, unknown>;
}): string {
	if (params.eventType === "payment_required") {
		return `Requested ${params.policy.amount} ${params.policy.currency ?? "USDC"} on ${params.policy.network} before executing paid MCP tool ${params.tool.toolId}.`;
	}
	if (params.eventType === "payment_rejected") {
		const reason =
			typeof params.budgetDecision?.reason === "string"
				? params.budgetDecision.reason
				: "payment_policy_rejected";
		return `Rejected paid MCP tool ${params.tool.toolId} because ${reason}.`;
	}
	return `Accepted ${params.policy.mode ?? "mock"} x402 proof and settled ${params.policy.amount} ${params.policy.currency ?? "USDC"} on ${params.policy.network} for paid MCP tool ${params.tool.toolId}.`;
}

function sqliteTimestamp(date: Date): string {
	return date.toISOString().replace("T", " ").slice(0, 19);
}

function paymentOrganizationId(agent: ServerContext): string | undefined {
	return agent.app?.organizationId ?? agent.callerIdentity?.organizationId;
}

function decimalAtomicUnits(value: string): bigint | null {
	const match = /^(0|[1-9]\d*)(?:\.(\d{1,18}))?$/.exec(value);
	if (!match) return null;
	return (
		BigInt(match[1]!) * 10n ** 18n + BigInt((match[2] ?? "").padEnd(18, "0"))
	);
}

async function evaluateBudget(params: {
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

function buildBudgetGuard(params: {
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

async function writeAuditAndRationale(params: {
	db: ReturnType<typeof createDbClient>;
	agent: ServerContext;
	tool: AppTool;
	policy: TedixToolPaymentPolicy;
	eventId: string;
	eventType: McpPaymentEventType;
	status: McpPaymentStatus;
	requirementId: string;
	paymentResponse?: Record<string, unknown>;
	budgetDecision?: Record<string, unknown>;
	decisionRationale: string;
}): Promise<{ auditEventId?: string; rationaleRecordId?: string }> {
	const orgId = paymentOrganizationId(params.agent);
	const ids: { auditEventId?: string; rationaleRecordId?: string } = {};
	if (!orgId) return ids;

	const actor = paymentActor({ agent: params.agent });
	try {
		const auditEventId = crypto.randomUUID();
		await insertAuditEvent(params.db, {
			id: auditEventId,
			organizationId: orgId,
			actorId: actor.actorId,
			actorType: actor.actorType,
			action: `mcp.payment.${params.status}`,
			resourceType: "mcp_payment_event",
			resourceId: params.eventId,
			metadata: toJsonRecord({
				eventId: params.eventId,
				eventType: params.eventType,
				requirementId: params.requirementId,
				appId: params.agent.appId,
				appSlug: params.agent.appSlug,
				toolId: params.tool.toolId,
				amount: params.policy.amount,
				currency: params.policy.currency ?? "USDC",
				network: params.policy.network,
				paymentResponse: params.paymentResponse,
				budgetDecision: params.budgetDecision,
				decisionRationale: params.decisionRationale,
			}),
		});
		ids.auditEventId = auditEventId;
	} catch (err) {
		log.warn("Payment audit event write failed", {
			event: "payments.audit_write_failed",
			appId: params.agent.appId,
			toolName: params.tool.toolId,
			paymentEventId: params.eventId,
			outcome: "unavailable",
			error: contentFreeMcpException(err),
		});
	}

	const tediId = params.agent.callerIdentity?.tediId;
	if (!tediId) return ids;

	try {
		const rationaleRecordId = crypto.randomUUID();
		// WS1 execution link: the paid tool call, span-checkable via the
		// mcp_payment_events row this episode settled under.
		const paymentToolCallRef = `mcp_payment_event:${params.eventId}:${params.tool.toolId}`;
		await createRationaleRecord(params.db, {
			id: rationaleRecordId,
			tediId,
			orgId,
			action: `mcp.payment.${params.status}`,
			rationale: params.decisionRationale,
			category: "custom",
			confidence: 0.9,
			evidence: toJsonRecord({
				eventId: params.eventId,
				requirementId: params.requirementId,
				appSlug: params.agent.appSlug,
				toolId: params.tool.toolId,
				paymentResponse: params.paymentResponse,
				budgetDecision: params.budgetDecision,
			}),
			toolCallRefs: [paymentToolCallRef],
			createdAt: new Date().toISOString(),
		});
		const receiptRef = params.paymentResponse?.receiptId ?? params.eventId;
		await completeRationaleRecord(params.db, rationaleRecordId, {
			outcome:
				params.status === "settled"
					? `Paid MCP tool ${params.tool.toolId} settled with receipt ${receiptRef}.`
					: params.status === "rejected"
						? `Paid MCP tool ${params.tool.toolId} was rejected by payment policy.`
						: `Paid MCP tool ${params.tool.toolId} returned x402 requirements.`,
			outcomeStatus:
				params.status === "settled"
					? "success"
					: params.status === "rejected"
						? "failure"
						: "partial",
			// Settled success is proven by the settlement receipt / payment event.
			...(params.status === "settled"
				? {
						proofRef: {
							kind: "tool_call" as const,
							ref: `${paymentToolCallRef}:receipt:${receiptRef}`,
						},
					}
				: {}),
			completedAt: new Date().toISOString(),
		});
		ids.rationaleRecordId = rationaleRecordId;
	} catch (err) {
		log.warn("Payment rationale record write failed", {
			event: "payments.rationale_write_failed",
			appId: params.agent.appId,
			toolName: params.tool.toolId,
			paymentEventId: params.eventId,
			outcome: "unavailable",
			error: contentFreeMcpException(err),
		});
	}

	return ids;
}

async function recordPaymentEvent(params: {
	agent: ServerContext;
	tool: AppTool;
	policy: TedixToolPaymentPolicy;
	args: Record<string, unknown>;
	requirementId: string;
	eventType: McpPaymentEventType;
	status: McpPaymentStatus;
	settled: boolean;
	eventId?: string;
	requirements?: X402PaymentRequiredResponse;
	paymentProof?: PaymentProof | null;
	paymentResponse?: Record<string, unknown>;
	budgetDecision?: Record<string, unknown>;
	/**
	 * When set, the event insert runs the atomic budget-window guard: the
	 * insert and the window SUM are one D1 statement, so concurrent
	 * settlements cannot both pass a stale read.
	 */
	budgetGuard?: McpSettlementBudgetGuard;
	/** Real-rail receipts must be durable before paid output is released. */
	requireDurable?: boolean;
}): Promise<{
	eventId: string;
	guardRejected: boolean;
	guardError: boolean;
	recorded: boolean;
}> {
	const eventId = params.eventId ?? crypto.randomUUID();
	const toolArgsHash = await sha256Hex(stableStringify(params.args));

	if (!params.agent.env.DB)
		return {
			eventId,
			guardRejected: false,
			guardError: false,
			recorded: false,
		};
	const db = createDbClient(params.agent.env.DB);
	const decisionRationale = paymentDecisionRationale({
		eventType: params.eventType,
		status: params.status,
		policy: params.policy,
		tool: params.tool,
		budgetDecision: params.budgetDecision,
	});
	const linkedEvidence = await writeAuditAndRationale({
		db,
		agent: params.agent,
		tool: params.tool,
		policy: params.policy,
		eventId,
		eventType: params.eventType,
		status: params.status,
		requirementId: params.requirementId,
		paymentResponse: params.paymentResponse,
		budgetDecision: params.budgetDecision,
		decisionRationale,
	});

	const row: NewMcpPaymentEvent = {
		id: eventId,
		requirementId: params.requirementId,
		eventType: params.eventType,
		status: params.status,
		protocol: "x402",
		mode: params.policy.mode ?? "mock",
		network: params.policy.network,
		asset: params.policy.asset ?? params.policy.currency ?? "USDC",
		currency: params.policy.currency ?? "USDC",
		amount: params.policy.amount,
		recipient: params.policy.recipient,
		resource: params.requirements
			? getRequirementsResource(params.requirements)
			: `mcp://${params.agent.appSlug}/tools/${params.tool.toolId}#${params.requirementId}`,
		appId: params.agent.appId,
		appSlug: params.agent.appSlug,
		organizationId: paymentOrganizationId(params.agent) ?? null,
		toolRowId: params.tool.id,
		toolId: params.tool.toolId,
		tediId: params.agent.callerIdentity?.tediId ?? null,
		userId: params.agent.callerIdentity?.userId ?? null,
		clientId: params.agent.callerIdentity?.clientId ?? null,
		authType: params.agent.callerIdentity?.authType ?? null,
		traceId: params.agent.traceId,
		toolArgsHash,
		settled: params.settled,
		requirements: optionalJsonRecord(params.requirements),
		paymentProof: optionalJsonRecord(
			(await redactedPaymentProof(params.paymentProof ?? null)) ?? undefined,
		),
		paymentResponse: optionalJsonRecord(params.paymentResponse),
		budgetPolicy: optionalJsonRecord(params.policy.budget),
		budgetDecision: optionalJsonRecord(params.budgetDecision),
		decisionRationale,
		auditEventId: linkedEvidence.auditEventId,
		rationaleRecordId: linkedEvidence.rationaleRecordId,
	};

	try {
		if (params.budgetGuard) {
			const inserted = await insertSettledMcpPaymentEventWithinBudget(
				db,
				row,
				params.budgetGuard,
			);
			if (!inserted)
				return {
					eventId,
					guardRejected: true,
					guardError: false,
					recorded: false,
				};
		} else {
			await insertMcpPaymentEvent(db, row);
		}
		await updatePaymentReservationForEvent({
			db,
			agent: params.agent,
			requirementId: params.requirementId,
			status: params.status,
			eventId,
			budgetDecision: params.budgetDecision,
		});
	} catch (err) {
		log.error("Payment event write failed", {
			event: "payments.event_write_failed",
			appId: params.agent.appId,
			toolName: params.tool.toolId,
			traceId: params.agent.traceId,
			paymentEventId: eventId,
			paymentRequirementId: params.requirementId,
			outcome: "unavailable",
			error: contentFreeMcpException(err),
		});
		// A guarded settlement that cannot reach the store must fail closed —
		// an unverifiable budget is not an approval.
		if (params.budgetGuard || params.requireDurable)
			return {
				eventId,
				guardRejected: false,
				guardError: true,
				recorded: false,
			};
		return {
			eventId,
			guardRejected: false,
			guardError: false,
			recorded: false,
		};
	}

	return { eventId, guardRejected: false, guardError: false, recorded: true };
}

async function reservePaymentRequirement(params: {
	agent: ServerContext;
	tool: AppTool;
	policy: TedixToolPaymentPolicy;
	requirementId: string;
	paymentRequestId: string;
	requirements: X402PaymentRequiredResponse;
}): Promise<void> {
	if (!params.agent.env.DB) return;
	const organizationId = paymentOrganizationId(params.agent);
	if (!organizationId) return;

	const db = createDbClient(params.agent.env.DB);
	const ttlSeconds = params.policy.ttlSeconds ?? DEFAULT_PAYMENT_TTL_SECONDS;
	const expiresAt = new Date(Date.now() + ttlSeconds * 1000)
		.toISOString()
		.slice(0, 19)
		.replace("T", " ");
	try {
		await upsertMcpPaymentReservation(db, {
			id: `mcp-payment-reservation:${params.requirementId}`,
			requirementId: params.requirementId,
			organizationId,
			tediId: params.agent.callerIdentity?.tediId ?? null,
			appSlug: params.agent.appSlug,
			toolId: params.tool.toolId,
			accountId: null,
			policyId: params.policy.budget?.id ?? null,
			status: "reserved",
			protocol: "x402",
			mode: params.policy.mode ?? "mock",
			network: params.policy.network,
			asset: params.policy.asset ?? params.policy.currency ?? "USDC",
			currency: params.policy.currency ?? "USDC",
			amount: params.policy.amount,
			recipient: params.policy.recipient,
			resource: getRequirementsResource(params.requirements),
			expiresAt,
			metadata: toJsonRecord({
				paymentRequestId: params.paymentRequestId,
				appId: params.agent.appId,
				toolRowId: params.tool.id,
				budgetPolicy: params.policy.budget,
			}),
		});
	} catch (err) {
		log.warn("Payment reservation failed", {
			event: "payments.reservation_failed",
			appId: params.agent.appId,
			toolName: params.tool.toolId,
			paymentRequirementId: params.requirementId,
			outcome: "unavailable",
			error: contentFreeMcpException(err),
		});
	}
}

async function updatePaymentReservationForEvent(params: {
	db: ReturnType<typeof createDbClient>;
	agent: ServerContext;
	requirementId: string;
	status: McpPaymentStatus;
	eventId: string;
	budgetDecision?: Record<string, unknown>;
}): Promise<void> {
	const organizationId = paymentOrganizationId(params.agent);
	if (!organizationId) return;
	const reservationStatus =
		params.status === "settled"
			? "settled"
			: params.status === "rejected"
				? "rejected"
				: null;
	if (!reservationStatus) return;

	try {
		await updateMcpPaymentReservationStatus(params.db, {
			requirementId: params.requirementId,
			organizationId,
			status: reservationStatus,
			settledEventId: params.status === "settled" ? params.eventId : null,
			metadata: params.budgetDecision
				? toJsonRecord({ budgetDecision: params.budgetDecision })
				: undefined,
		});
	} catch (err) {
		log.warn("Payment reservation update failed", {
			event: "payments.reservation_update_failed",
			appId: params.agent.appId,
			paymentRequirementId: params.requirementId,
			paymentEventId: params.eventId,
			outcome: "unavailable",
			error: contentFreeMcpException(err),
		});
	}
}

async function facilitatorReceiptId(paymentToken: string): Promise<string> {
	return `x402-facilitator-${(await sha256Hex(paymentToken)).slice(0, 40)}`;
}

async function loadFacilitatorReceipt(params: {
	agent: ServerContext;
	receiptId: string;
	requirementId: string;
	tool: AppTool;
	policy: TedixToolPaymentPolicy;
}): Promise<Record<string, unknown> | null> {
	const organizationId = paymentOrganizationId(params.agent);
	if (!params.agent.env.DB || !organizationId) return null;
	const event = await getMcpPaymentEventByIdForOrg(
		createDbClient(params.agent.env.DB),
		{ id: params.receiptId, organizationId },
	);
	if (
		!event ||
		event.status !== "settled" ||
		!event.settled ||
		event.requirementId !== params.requirementId ||
		event.toolId !== params.tool.toolId ||
		event.appSlug !== params.agent.appSlug ||
		event.mode !== "facilitator" ||
		event.amount !== params.policy.amount ||
		event.network !== params.policy.network ||
		event.recipient !== params.policy.recipient ||
		!isRecord(event.paymentResponse)
	) {
		return null;
	}
	return event.paymentResponse;
}

export async function settleToolPayment(
	agent: ServerContext,
	settlement: PendingFacilitatorSettlement | undefined,
): Promise<
	| { settled: true; paymentResponse?: Record<string, unknown> }
	| { settled: false; result: CallToolResult }
> {
	if (!settlement) return { settled: true };

	const cached = await loadFacilitatorReceipt({
		agent,
		receiptId: settlement.receiptId,
		requirementId: settlement.requirementId,
		tool: settlement.tool,
		policy: settlement.policy,
	});
	if (cached) return { settled: true, paymentResponse: cached };

	try {
		const providerReceipt = await settleFacilitatorPayment(settlement.verified);
		const paymentResponse = {
			protocol: "x402",
			mode: "facilitator",
			requirementId: settlement.requirementId,
			toolId: settlement.tool.toolId,
			amount: settlement.policy.amount,
			currency: settlement.policy.currency ?? "USDC",
			network: providerReceipt.network,
			settled: true,
			receiptId: settlement.receiptId,
			transaction: providerReceipt.transaction,
			...(providerReceipt.payer ? { payer: providerReceipt.payer } : {}),
			...(providerReceipt.amount
				? { settledAmountAtomic: providerReceipt.amount }
				: {}),
			ledger: {
				eventId: settlement.receiptId,
				table: "mcp_payment_events",
			},
			...(settlement.budgetDecision
				? { budgetDecision: settlement.budgetDecision }
				: {}),
		};
		const recorded = await recordPaymentEvent({
			agent,
			tool: settlement.tool,
			policy: settlement.policy,
			args: settlement.args,
			requirementId: settlement.requirementId,
			eventType: "payment_settled",
			status: "settled",
			settled: true,
			eventId: settlement.receiptId,
			paymentProof: settlement.verified.paymentToken,
			paymentResponse,
			budgetDecision: settlement.budgetDecision,
			budgetGuard: buildBudgetGuard({
				agent,
				tool: settlement.tool,
				policy: settlement.policy,
			}),
			requireDurable: true,
		});
		if (recorded.guardRejected || recorded.guardError) {
			const replay = await loadFacilitatorReceipt({
				agent,
				receiptId: settlement.receiptId,
				requirementId: settlement.requirementId,
				tool: settlement.tool,
				policy: settlement.policy,
			});
			if (replay) return { settled: true, paymentResponse: replay };
			throw new Error(
				recorded.guardRejected
					? "budget_exceeded_during_settlement"
					: "durable_receipt_write_failed",
			);
		}
		return { settled: true, paymentResponse };
	} catch (error) {
		log.error("Facilitator settlement failed", {
			event: "payments.facilitator_settlement_failed",
			appId: agent.appId,
			toolName: settlement.tool.toolId,
			traceId: agent.traceId,
			paymentReceiptId: settlement.receiptId,
			paymentRequirementId: settlement.requirementId,
			outcome: "unavailable",
			error: contentFreeMcpException(error),
		});
		return {
			settled: false,
			result: buildPaymentRequiredResult({
				protocol: "x402",
				toolId: settlement.tool.toolId,
				requirementId: settlement.requirementId,
				requirements: {
					...settlement.verified.challenge,
					x402Version: 2,
					error: "SETTLEMENT_FAILED",
				} as X402PaymentRequiredResponse,
			}),
		};
	}
}

export async function checkToolPayment(params: {
	agent: ServerContext;
	tool: AppTool;
	args: Record<string, unknown>;
	extra?: { _meta?: Record<string, unknown> };
}): Promise<
	| {
			paid: true;
			paymentResponse?: Record<string, unknown>;
			settlement?: PendingFacilitatorSettlement;
	  }
	| { paid: false; result: TedixPaymentRequiredResult | CallToolResult }
> {
	const resolved = await resolveToolPaymentPolicy({
		agent: params.agent,
		tool: params.tool,
	});
	if (resolved.kind === "unpriced") return { paid: true };
	const policy = resolved.policy;

	const requirementId = await buildRequirementId(
		params.agent,
		params.tool,
		params.args,
	);
	const proof = getPaymentProof(params.extra);

	const rejectForBudget = async (
		budgetDecision: Record<string, unknown>,
	): Promise<{ paid: false; result: CallToolResult }> => {
		const reason =
			typeof budgetDecision.reason === "string"
				? budgetDecision.reason
				: "budget_rejected";
		const detail =
			reason === "budget_paused"
				? "budget policy is paused; paid calls fail closed until it is re-enabled or removed"
				: reason === "budget_store_unavailable"
					? "budget store is unavailable; paid calls fail closed"
					: reason === "budget_load_failed"
						? "budget lookup failed; paid calls fail closed rather than run uncapped"
						: reason === "budget_exceeded"
							? `budget exceeded (${budgetDecision.projected} ${policy.currency ?? "USDC"} projected > ${budgetDecision.maxAmount} ${policy.currency ?? "USDC"} in ${budgetDecision.windowSeconds}s window)`
							: reason;
		const rejectedEvent = await recordPaymentEvent({
			agent: params.agent,
			tool: params.tool,
			policy,
			args: params.args,
			requirementId,
			eventType: "payment_rejected",
			status: "rejected",
			settled: false,
			paymentProof: proof,
			budgetDecision,
		});
		const budgetOverrideRequest =
			reason === "budget_exceeded" &&
			params.agent.callerIdentity?.tediId &&
			rejectedEvent.recorded
				? {
						operation: "mcp.request_budget_override",
						rejectedEventId: rejectedEvent.eventId,
					}
				: null;
		return {
			paid: false,
			result: {
				content: [
					{
						type: "text" as const,
						text: `Payment rejected for tool "${params.tool.toolId}": ${detail}.${budgetOverrideRequest ? ` Request human review with mcp.request_budget_override and rejectedEventId ${budgetOverrideRequest.rejectedEventId}; the budget policy must be raised before retry.` : ""}`,
					},
				],
				isError: true,
				_meta: {
					"x-tedix/paymentRejected": {
						reason,
						requirementId,
						toolId: params.tool.toolId,
						budgetDecision,
						...(budgetOverrideRequest ? { budgetOverrideRequest } : {}),
					},
				},
			},
		};
	};

	// A budget lookup that threw tells us nothing about the tenant's cap, so it
	// must deny. Absence is different and still allows: a paid tool with no
	// configured budget is a valid setup where the payment itself is the gate.
	// Collapsing the two is what let a transient D1 error run a capped tenant
	// uncapped.
	if (resolved.kind === "loadFailed") {
		return rejectForBudget({
			allowed: false,
			reason: "budget_load_failed",
			amount: policy.amount,
			currency: policy.currency ?? "USDC",
			network: policy.network,
			requirementId,
			error: resolved.error,
		});
	}

	// An exact retry of a proof that already has a durable, policy-matching
	// receipt is the same logical settlement. Return it before re-evaluating the
	// spend window so a response retry cannot be charged or budgeted twice.
	if (policy.mode === "facilitator" && typeof proof === "string") {
		const organizationId = paymentOrganizationId(params.agent);
		if (!params.agent.env.DB || !organizationId) {
			return rejectForBudget({
				allowed: false,
				reason: "durable_receipt_store_unavailable",
				amount: policy.amount,
				currency: policy.currency ?? "USDC",
				network: policy.network,
				requirementId,
			});
		}
		try {
			const replay = await loadFacilitatorReceipt({
				agent: params.agent,
				receiptId: await facilitatorReceiptId(proof),
				requirementId,
				tool: params.tool,
				policy,
			});
			if (replay) return { paid: true, paymentResponse: replay };
		} catch (error) {
			return rejectForBudget({
				allowed: false,
				reason: "durable_receipt_lookup_failed",
				amount: policy.amount,
				currency: policy.currency ?? "USDC",
				network: policy.network,
				requirementId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// The budget gate runs before every outcome — settlement and the
	// payment-required handshake — so no future settlement path (facilitator
	// or otherwise) can bypass it, and callers are never asked to pay an
	// amount the budget would reject on redemption.
	const budgetDecision = await evaluateBudget({
		agent: params.agent,
		tool: params.tool,
		policy,
		requirementId,
	});
	if (budgetDecision && budgetDecision.allowed === false) {
		return rejectForBudget(budgetDecision);
	}

	if (
		policy.mode === "mock" &&
		isMockPaymentValid({
			proof,
			tool: params.tool,
			policy,
			requirementId,
		})
	) {
		const settlementId = crypto.randomUUID();
		const paymentResponse = {
			protocol: "x402",
			mode: "mock",
			requirementId,
			toolId: params.tool.toolId,
			amount: policy.amount,
			currency: policy.currency ?? "USDC",
			network: policy.network,
			settled: true,
			receiptId: settlementId,
			ledger: {
				eventId: settlementId,
				table: "mcp_payment_events",
			},
			...(budgetDecision ? { budgetDecision } : {}),
		};
		// Enforce-mode settlements re-check the window atomically at write
		// time: the pre-read decision above can go stale under concurrency.
		const budgetGuard = buildBudgetGuard({
			agent: params.agent,
			tool: params.tool,
			policy,
		});
		const settlement = await recordPaymentEvent({
			agent: params.agent,
			tool: params.tool,
			policy,
			args: params.args,
			requirementId,
			eventType: "payment_settled",
			status: "settled",
			settled: true,
			eventId: settlementId,
			paymentProof: proof,
			paymentResponse,
			budgetDecision,
			budgetGuard,
		});
		if (settlement.guardRejected || settlement.guardError) {
			return rejectForBudget({
				...budgetDecision,
				allowed: false,
				reason: settlement.guardRejected
					? "budget_exceeded"
					: "budget_store_unavailable",
			});
		}
		return {
			paid: true,
			paymentResponse,
		};
	}

	if (policy.mode === "facilitator" && typeof proof === "string") {
		const organizationId = paymentOrganizationId(params.agent);
		if (!params.agent.env.DB || !organizationId) {
			return rejectForBudget({
				allowed: false,
				reason: "durable_receipt_store_unavailable",
				amount: policy.amount,
				currency: policy.currency ?? "USDC",
				network: policy.network,
				requirementId,
			});
		}
		if (!policy.facilitatorUrl) {
			return rejectForBudget({
				allowed: false,
				reason: "facilitator_not_configured",
				amount: policy.amount,
				currency: policy.currency ?? "USDC",
				network: policy.network,
				requirementId,
			});
		}

		const receiptId = await facilitatorReceiptId(proof);
		let challenge: X402PaymentRequiredResponse;
		try {
			const payload = decodeFacilitatorPaymentToken(proof);
			const paymentRequestId = payload.accepted.extra?.paymentRequestId;
			if (typeof paymentRequestId !== "string" || !paymentRequestId) {
				throw new Error("Payment payload is missing paymentRequestId");
			}
			challenge = await buildPaymentRequirements({
				agent: params.agent,
				tool: params.tool,
				policy,
				requirementId,
				paymentRequestId,
			});
			if (challenge.x402Version !== 2) {
				throw new Error("Facilitator challenge did not negotiate x402 v2");
			}
			const verified = await verifyFacilitatorPayment({
				challenge: challenge as CorePaymentRequired,
				facilitatorUrl: policy.facilitatorUrl,
				paymentToken: proof,
			});
			return {
				paid: true,
				settlement: {
					verified,
					receiptId,
					requirementId,
					policy,
					tool: params.tool,
					args: params.args,
					budgetDecision,
				},
			};
		} catch (error) {
			log.warn("Facilitator verification failed", {
				event: "payments.facilitator_verification_failed",
				appId: params.agent.appId,
				toolName: params.tool.toolId,
				traceId: params.agent.traceId,
				paymentReceiptId: receiptId,
				paymentRequirementId: requirementId,
				outcome: "denied",
				error: contentFreeMcpException(error),
			});
			await recordPaymentEvent({
				agent: params.agent,
				tool: params.tool,
				policy,
				args: params.args,
				requirementId,
				eventType: "payment_rejected",
				status: "rejected",
				settled: false,
				paymentProof: proof,
				budgetDecision: {
					allowed: false,
					reason: "facilitator_verification_failed",
				},
			});
		}
	}

	const paymentRequestId = crypto.randomUUID();
	let requirements: X402PaymentRequiredResponse;
	try {
		requirements = await buildPaymentRequirements({
			agent: params.agent,
			tool: params.tool,
			policy,
			requirementId,
			paymentRequestId,
		});
	} catch (error) {
		log.error("Payment requirements build failed", {
			event: "payments.requirements_build_failed",
			appId: params.agent.appId,
			toolName: params.tool.toolId,
			traceId: params.agent.traceId,
			paymentRequirementId: requirementId,
			outcome: "unavailable",
			error: contentFreeMcpException(error),
		});
		return rejectForBudget({
			allowed: false,
			reason: "payment_requirements_unavailable",
			amount: policy.amount,
			currency: policy.currency ?? "USDC",
			network: policy.network,
			requirementId,
		});
	}
	await reservePaymentRequirement({
		agent: params.agent,
		tool: params.tool,
		policy,
		requirementId,
		paymentRequestId,
		requirements,
	});
	await recordPaymentEvent({
		agent: params.agent,
		tool: params.tool,
		policy,
		args: params.args,
		requirementId,
		eventType: "payment_required",
		status: "required",
		settled: false,
		eventId: paymentRequestId,
		requirements,
		paymentProof: proof,
	});

	return {
		paid: false,
		result: buildPaymentRequiredResult({
			protocol: "x402",
			toolId: params.tool.toolId,
			requirementId,
			requirements,
		}),
	};
}

export function attachPaymentResponseMeta<
	T extends { _meta?: Record<string, unknown> },
>(result: T, paymentResponse: Record<string, unknown> | undefined): T {
	if (!paymentResponse) return result;
	return {
		...result,
		_meta: {
			...result._meta,
			[X402_PAYMENT_RESPONSE_META_KEY]: paymentResponse,
		},
	};
}
