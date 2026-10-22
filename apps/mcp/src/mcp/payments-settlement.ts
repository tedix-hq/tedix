import type { CallToolResult } from "@modelcontextprotocol/server";
import { createDbClient } from "@tedix/db/client";
import { getMcpPaymentEventByIdForOrg } from "@tedix/db/queries/mcp-payments";
import {
	buildPaymentRequiredResult,
	type X402PaymentRequiredResponse,
} from "@tedix/mcp-shared/payment";
import type { AppTool, ServerContext } from "./server-context";
import {
	settleFacilitatorPayment,
	type VerifiedFacilitatorPayment,
} from "./x402-facilitator";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { contentFreeMcpException } from "../log";
import {
	log,
	type TedixToolPaymentPolicy,
	paymentOrganizationId,
} from "./payments-policy";
import { buildBudgetGuard } from "./payments-budget";
import { recordPaymentEvent } from "./payments-ledger";

export interface PendingFacilitatorSettlement {
	verified: VerifiedFacilitatorPayment;
	receiptId: string;
	requirementId: string;
	policy: TedixToolPaymentPolicy;
	tool: AppTool;
	args: Record<string, unknown>;
	budgetDecision?: Record<string, unknown>;
}

export async function facilitatorReceiptId(
	paymentToken: string,
): Promise<string> {
	return `x402-facilitator-${(await sha256Hex(paymentToken)).slice(0, 40)}`;
}

export async function loadFacilitatorReceipt(params: {
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
