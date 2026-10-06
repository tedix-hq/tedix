import "@orpc/openapi/extensions/route";
/**
 * MCP Payments Contract
 *
 * Read-only ledger API for x402-style MCP payment requirements and settlements.
 */

import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	McpPaymentDisablePolicyInputSchema,
	McpPaymentDisablePolicyOutputSchema,
	McpPaymentGetEffectivePolicyInputSchema,
	McpPaymentGetEffectivePolicyOutputSchema,
	McpPaymentGetReceiptInputSchema,
	McpPaymentGetReceiptOutputSchema,
	McpPaymentListAccountsInputSchema,
	McpPaymentListAccountsOutputSchema,
	McpPaymentListEventsInputSchema,
	McpPaymentListEventsOutputSchema,
	McpPaymentListPoliciesInputSchema,
	McpPaymentListPoliciesOutputSchema,
	McpPaymentListReservationsInputSchema,
	McpPaymentListReservationsOutputSchema,
	McpPaymentRegisterAccountInputSchema,
	McpPaymentRegisterAccountOutputSchema,
	McpPaymentRequestBudgetOverrideInputSchema,
	McpPaymentRequestBudgetOverrideOutputSchema,
	McpPaymentSetBudgetPolicyInputSchema,
	McpPaymentSetBudgetPolicyOutputSchema,
	McpPaymentSpendSummaryInputSchema,
	McpPaymentSpendSummaryOutputSchema,
} from "../schemas/mcp-payments";

export const mcpPaymentsContract = oc
	.route({ tags: ["mcp-payments"], prefix: "/mcp-payments" })
	.errors(baseErrors)
	.router({
		listEvents: oc
			.route({
				method: "GET",
				path: "/events",
				summary: "List MCP payment ledger events",
				description:
					"Returns recent organization-scoped MCP payment requirement and settlement events with optional app, tool, requirement, tedi, and status filters.",
			})
			.input(McpPaymentListEventsInputSchema)
			.output(McpPaymentListEventsOutputSchema),

		requestBudgetOverride: oc
			.route({
				method: "POST",
				path: "/budget-override-requests",
				summary: "Request a human increase to a rejected MCP payment budget",
				description:
					"A tedi requests human review of its own recorded budget_exceeded event. Approval does not alter payment policy; an authorized operator must raise the matching limit before the tedi retries.",
			})
			.input(McpPaymentRequestBudgetOverrideInputSchema)
			.output(McpPaymentRequestBudgetOverrideOutputSchema),

		getReceipt: oc
			.route({
				method: "GET",
				path: "/receipts/{id}",
				summary: "Get MCP payment receipt",
				description:
					"Returns a settled MCP payment event by receipt id, plus related events for the same requirement.",
			})
			.input(McpPaymentGetReceiptInputSchema)
			.output(McpPaymentGetReceiptOutputSchema),

		spendSummary: oc
			.route({
				method: "GET",
				path: "/spend-summary",
				summary: "Get settled MCP payment spend summary",
				description:
					"Groups settled MCP payment spend by app, tool, currency, asset, and network for the caller's organization, optionally narrowed to a tedi and recent time window.",
			})
			.input(McpPaymentSpendSummaryInputSchema)
			.output(McpPaymentSpendSummaryOutputSchema),

		listPolicies: oc
			.route({
				method: "GET",
				path: "/policies",
				summary: "List MCP payment policies",
				description:
					"Returns first-class TedixPay/x402 budget policies for the caller's organization.",
			})
			.input(McpPaymentListPoliciesInputSchema)
			.output(McpPaymentListPoliciesOutputSchema),

		setBudgetPolicy: oc
			.route({
				method: "POST",
				path: "/policies/budget",
				summary: "Set MCP payment budget policy",
				description:
					"Creates or updates a first-class TedixPay/x402 budget policy. This controls whether future mock settlements are allowed for matching paid MCP tools.",
			})
			.input(McpPaymentSetBudgetPolicyInputSchema)
			.output(McpPaymentSetBudgetPolicyOutputSchema),

		getEffectivePolicy: oc
			.route({
				method: "GET",
				path: "/policies/effective",
				summary: "Get effective MCP payment policy",
				description:
					"Returns the most specific active TedixPay/x402 budget policy for an app/tool/tedi target.",
			})
			.input(McpPaymentGetEffectivePolicyInputSchema)
			.output(McpPaymentGetEffectivePolicyOutputSchema),

		disablePolicy: oc
			.route({
				method: "PATCH",
				path: "/policies/{id}",
				summary: "Disable MCP payment policy",
				description:
					"Disables a TedixPay/x402 budget policy without deleting audit history.",
			})
			.input(McpPaymentDisablePolicyInputSchema)
			.output(McpPaymentDisablePolicyOutputSchema),

		listAccounts: oc
			.route({
				method: "GET",
				path: "/accounts",
				summary: "List MCP payment accounts",
				description:
					"Returns non-custodial TedixPay payment account records for the caller's organization. These records store public addresses and signer metadata, never private keys.",
			})
			.input(McpPaymentListAccountsInputSchema)
			.output(McpPaymentListAccountsOutputSchema),

		registerAccount: oc
			.route({
				method: "POST",
				path: "/accounts",
				summary: "Register MCP payment account",
				description:
					"Creates or updates a non-custodial TedixPay payment account for an organization, tedi, or app scope. This does not custody private keys.",
			})
			.input(McpPaymentRegisterAccountInputSchema)
			.output(McpPaymentRegisterAccountOutputSchema),

		listReservations: oc
			.route({
				method: "GET",
				path: "/reservations",
				summary: "List MCP payment reservations",
				description:
					"Returns budget reservations created by paid MCP tools before x402 settlement, including reserved, settled, rejected, expired, and canceled states.",
			})
			.input(McpPaymentListReservationsInputSchema)
			.output(McpPaymentListReservationsOutputSchema),
	});

export type McpPaymentsContract = typeof mcpPaymentsContract;
