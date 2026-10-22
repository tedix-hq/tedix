import { createDbClient } from "@tedix/db/client";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import {
	insertMcpPaymentEvent,
	insertSettledMcpPaymentEventWithinBudget,
	type McpSettlementBudgetGuard,
	updateMcpPaymentReservationStatus,
	upsertMcpPaymentReservation,
} from "@tedix/db/queries/mcp-payments";
import {
	completeRationaleRecord,
	createRationaleRecord,
} from "@tedix/db/queries/rationale-records";
import type {
	McpPaymentEventType,
	McpPaymentStatus,
	NewMcpPaymentEvent,
} from "@tedix/db/schema/mcp-payments";
import { toJsonRecord } from "@tedix/db/utils/json";
import { type X402PaymentRequiredResponse } from "@tedix/mcp-shared/payment";
import type { AppTool, ServerContext } from "./server-context";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { contentFreeMcpException } from "../log";
import {
	log,
	DEFAULT_PAYMENT_TTL_SECONDS,
	type TedixToolPaymentPolicy,
	paymentOrganizationId,
} from "./payments-policy";
import {
	type PaymentProof,
	stableStringify,
	getRequirementsResource,
	redactedPaymentProof,
} from "./payments-requirements";

function optionalJsonRecord(
	value: unknown,
): ReturnType<typeof toJsonRecord> | undefined {
	return value === undefined ? undefined : toJsonRecord(value);
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

export async function recordPaymentEvent(params: {
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

export async function reservePaymentRequirement(params: {
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
