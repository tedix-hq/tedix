import {
	CONNECT_PAYMENT_DENIED,
	hasPaymentProof,
	isNonPayingConnection,
} from "./connect-payment-policy";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { PaymentRequired as CorePaymentRequired } from "@x402/core/types";
import {
	buildPaymentRequiredResult,
	type TedixPaymentRequiredResult,
	X402_PAYMENT_RESPONSE_META_KEY,
	type X402PaymentRequiredResponse,
} from "@tedix/mcp-shared/payment";
import type { AppTool, ServerContext } from "./server-context";
import {
	decodeFacilitatorPaymentToken,
	verifyFacilitatorPayment,
} from "./x402-facilitator";
import { contentFreeMcpException } from "../log";
import {
	log,
	getToolPaymentPolicy,
	resolveToolPaymentPolicy,
	paymentOrganizationId,
} from "./payments-policy";
import {
	buildRequirementId,
	buildPaymentRequirements,
	getPaymentProof,
	isMockPaymentValid,
} from "./payments-requirements";
import { evaluateBudget, buildBudgetGuard } from "./payments-budget";
import {
	recordPaymentEvent,
	reservePaymentRequirement,
} from "./payments-ledger";
import {
	type PendingFacilitatorSettlement,
	facilitatorReceiptId,
	loadFacilitatorReceipt,
} from "./payments-settlement";

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
	if (
		isNonPayingConnection(
			params.agent.connectionAppSlug ?? params.agent.appSlug,
		) &&
		(hasPaymentProof(undefined, params.extra?._meta) ||
			getToolPaymentPolicy(params.tool))
	) {
		return {
			paid: false,
			result: {
				isError: true,
				content: [{ type: "text", text: CONNECT_PAYMENT_DENIED }],
			},
		};
	}
	const resolved = await resolveToolPaymentPolicy({
		agent: params.agent,
		tool: params.tool,
	});
	if (resolved.kind === "unpriced") return { paid: true };
	if (
		isNonPayingConnection(
			params.agent.connectionAppSlug ?? params.agent.appSlug,
		)
	) {
		return {
			paid: false,
			result: {
				isError: true,
				content: [{ type: "text", text: CONNECT_PAYMENT_DENIED }],
			},
		};
	}
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
