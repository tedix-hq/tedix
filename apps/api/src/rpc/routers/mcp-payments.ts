/**
 * MCP Payments Router
 *
 * Read-only x402/MCP payment ledger surface for dashboards and MCP tools.
 */

import { implement } from "@orpc/server";
import { mcpPaymentsContract } from "@tedix/api-contract/contracts/mcp-payments";
import { ensurePaymentBudgetOverrideRequest } from "@tedix/db/queries/approvals";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import {
	disableMcpPaymentPolicy,
	getEffectiveMcpPaymentPolicy,
	getMcpPaymentEventByIdForOrg,
	getMcpPaymentPolicyById,
	getMcpPaymentReceiptById,
	getMcpPaymentSpendSummary,
	listMcpPaymentAccounts,
	listMcpPaymentEvents,
	listMcpPaymentEventsByRequirementForOrg,
	listMcpPaymentPolicies,
	listMcpPaymentReservations,
	upsertMcpPaymentAccount,
	upsertMcpPaymentPolicy,
} from "@tedix/db/queries/mcp-payments";
import { getTediOrganizationId } from "@tedix/db/queries/tedis";
import type {
	McpPaymentAccount,
	McpPaymentEvent,
	McpPaymentReservation,
} from "@tedix/db/schema/mcp-payments";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	AUTHZ,
	withAuthorization,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withFleetAuthority,
} from "../orpc";

const mcpPaymentsOs = implement(mcpPaymentsContract).$context<BaseContext>();
const authedOs = mcpPaymentsOs.use(withAuth);

async function budgetOverrideRequestId(eventId: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`mcp-budget-override:${eventId}`),
		),
	);
	const bytes = digest.slice(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type PaymentEventOutput = Omit<
	McpPaymentEvent,
	| "requirements"
	| "paymentProof"
	| "paymentResponse"
	| "budgetPolicy"
	| "budgetDecision"
> & {
	requirements: Record<string, unknown> | null;
	paymentProof: Record<string, unknown> | null;
	paymentResponse: Record<string, unknown> | null;
	budgetPolicy: Record<string, unknown> | null;
	budgetDecision: Record<string, unknown> | null;
};

type PaymentAccountOutput = Omit<McpPaymentAccount, "metadata"> & {
	metadata: Record<string, unknown> | null;
};

type PaymentReservationOutput = Omit<McpPaymentReservation, "metadata"> & {
	metadata: Record<string, unknown> | null;
};

function normalizePaymentEvent(row: McpPaymentEvent): PaymentEventOutput {
	return {
		...row,
		requirements: row.requirements ?? null,
		paymentProof: row.paymentProof ?? null,
		paymentResponse: row.paymentResponse ?? null,
		budgetPolicy: row.budgetPolicy ?? null,
		budgetDecision: row.budgetDecision ?? null,
	};
}

function normalizePaymentAccount(row: McpPaymentAccount): PaymentAccountOutput {
	return {
		...row,
		metadata: row.metadata ?? null,
	};
}

function normalizePaymentReservation(
	row: McpPaymentReservation,
): PaymentReservationOutput {
	return {
		...row,
		metadata: row.metadata ?? null,
	};
}

async function resolveOrganizationId(context: BaseContext): Promise<string> {
	if (context.organizationId) return context.organizationId;

	if (context.tediId) {
		const organizationId = await getTediOrganizationId(
			context.db,
			context.tediId,
		);
		if (organizationId) return organizationId;
	}

	throw createError(ErrorCodes.UNAUTHORIZED, "Organization required");
}

function toSqlTimestamp(date: Date): string {
	return date.toISOString().slice(0, 19).replace("T", " ");
}

function paymentPolicyId(params: {
	organizationId: string;
	tediId?: string | null;
	appSlug?: string | null;
	toolId?: string | null;
	currency: string;
	network: string;
}): string {
	return [
		"mcp-payment-policy",
		params.organizationId,
		params.tediId ?? "org",
		params.appSlug ?? "*",
		params.toolId ?? "*",
		params.currency,
		params.network,
	]
		.map(encodeURIComponent)
		.join(":");
}

function paymentAccountId(params: {
	organizationId: string;
	tediId?: string | null;
	appSlug?: string | null;
	network: string;
	asset: string;
	publicAddress: string;
}): string {
	return [
		"mcp-payment-account",
		params.organizationId,
		params.tediId ?? "org",
		params.appSlug ?? "*",
		params.network,
		params.asset,
		params.publicAddress,
	]
		.map(encodeURIComponent)
		.join(":");
}

function actorId(context: BaseContext): string | null {
	return (
		context.user?.sub ??
		context.descopeUserId ??
		context.apiKey?.id ??
		context.serviceAccount?.clientId ??
		context.tediId ??
		context.authType ??
		null
	);
}

async function assertTediBelongsToOrg(
	context: BaseContext,
	tediId: string | undefined,
	organizationId: string,
): Promise<void> {
	if (!tediId) return;
	const tediOrgId = await getTediOrganizationId(context.db, tediId);
	if (tediOrgId !== organizationId) {
		throw createError(ErrorCodes.FORBIDDEN, "Tedi is not in this organization");
	}
}

function buildSpendTotals(
	summary: Awaited<ReturnType<typeof getMcpPaymentSpendSummary>>,
) {
	const byUnit = new Map<
		string,
		{
			currency: string | null;
			asset: string | null;
			network: string;
			settledCount: number;
			totalAmount: number;
		}
	>();

	for (const row of summary) {
		const key = `${row.currency ?? ""}:${row.asset ?? ""}:${row.network}`;
		const existing = byUnit.get(key);
		if (existing) {
			existing.settledCount += row.settledCount;
			existing.totalAmount += row.totalAmount;
		} else {
			byUnit.set(key, {
				currency: row.currency,
				asset: row.asset,
				network: row.network,
				settledCount: row.settledCount,
				totalAmount: row.totalAmount,
			});
		}
	}

	return [...byUnit.values()].sort((a, b) => b.totalAmount - a.totalAmount);
}

const listEventsProcedure = authedOs.listEvents
	.use(withFleetAuthority)
	.use(AUTHZ.billingRead)
	.handler(async ({ input, context }) => {
		const organizationId = await resolveOrganizationId(context);
		const events = await listMcpPaymentEvents(context.db, {
			organizationId,
			appSlug: input.appSlug,
			toolId: input.toolId,
			requirementId: input.requirementId,
			tediId: input.tediId,
			status: input.status,
			limit: input.limit,
		});

		return { events: events.map(normalizePaymentEvent) };
	});

export async function requestBudgetOverrideForTedi(
	context: BaseContext,
	organizationId: string,
	tediId: string,
	input: { rejectedEventId: string; reason: string },
) {
	const event = await getMcpPaymentEventByIdForOrg(context.db, {
		id: input.rejectedEventId,
		organizationId,
	});
	if (
		!event ||
		event.tediId !== tediId ||
		event.eventType !== "payment_rejected" ||
		event.budgetDecision?.reason !== "budget_exceeded"
	) {
		throw createError(ErrorCodes.NOT_FOUND, "Budget rejection not found");
	}
	const decision = event.budgetDecision;
	const requestId = await budgetOverrideRequestId(event.id);
	const now = new Date();
	const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
	const workflowId = `approval-${requestId}`;
	const { request, created } = await ensurePaymentBudgetOverrideRequest(
		context.db,
		{
			id: requestId,
			orgId: organizationId,
			tediId,
			actionType: "payment_budget_override",
			description: `Review a budget increase for ${event.appSlug}:${event.toolId}. ${input.reason} Raise the matching Payments policy before approving; approval alone never authorizes payment.`,
			payload: {
				kind: "payment_budget_override",
				rejectedEventId: event.id,
				requirementId: event.requirementId,
				appSlug: event.appSlug,
				toolId: event.toolId,
				amount: event.amount,
				currency: event.currency ?? "USDC",
				network: event.network,
				recipient: event.recipient,
				currentMaxAmount:
					typeof decision.maxAmount === "string" ? decision.maxAmount : null,
				projectedAmount:
					typeof decision.projected === "string" ? decision.projected : null,
			},
			createdAt: now.toISOString(),
			expiresAt: expiresAt.toISOString(),
			workflowId,
		},
	);
	if (created) {
		try {
			await context.env.APPROVAL_WORKFLOW.create({
				id: workflowId,
				params: {
					approvalRequestId: requestId,
					tediId,
					orgId: organizationId,
					ttlHours: 7 * 24,
				},
			});
		} catch (error) {
			console.error(
				"Failed to start budget override approval workflow:",
				error,
			);
		}
	}
	await insertAuditEvent(context.db, {
		id: `payment-budget-override:${requestId}`,
		ignoreDuplicates: true,
		organizationId,
		actorId: tediId,
		actorType: "tedi",
		action: "approval.requested",
		resourceType: "approval_request",
		resourceId: requestId,
		metadata: {
			actionType: "payment_budget_override",
			rejectedEventId: event.id,
		},
	});
	return { approvalRequestId: request.id, status: request.status, created };
}

const requestBudgetOverrideProcedure = authedOs.requestBudgetOverride
	.use(withFleetAuthority)
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler requires a tedi identity and binds the rejected event to that same tedi and organization.",
			},
			"mcp:messaging.write",
		),
	)
	.handler(async ({ input, context }) => {
		const tediId = context.tediId;
		const forwardedTediId =
			context.headers.get("X-Tedix-Tedi-Id") ??
			context.headers.get("x-tedix-tedi-id");
		if (
			!tediId ||
			(context.authType !== "tedi" &&
				(context.authType !== "service-binding" || forwardedTediId !== tediId))
		) {
			throw createError(ErrorCodes.FORBIDDEN, "A tedi identity is required");
		}
		const organizationId = await resolveOrganizationId(context);
		return requestBudgetOverrideForTedi(context, organizationId, tediId, input);
	});

const getReceiptProcedure = authedOs.getReceipt
	.use(withFleetAuthority)
	.use(AUTHZ.billingRead)
	.handler(async ({ input, context }) => {
		const organizationId = await resolveOrganizationId(context);
		const receipt = await getMcpPaymentReceiptById(context.db, {
			id: input.id,
			organizationId,
		});
		if (!receipt) {
			throw createError(ErrorCodes.NOT_FOUND, "Payment receipt not found");
		}

		const events = await listMcpPaymentEventsByRequirementForOrg(context.db, {
			requirementId: receipt.requirementId,
			organizationId,
		});

		return {
			receipt: normalizePaymentEvent(receipt),
			events: events.map(normalizePaymentEvent),
		};
	});

const spendSummaryProcedure = authedOs.spendSummary
	.use(withFleetAuthority)
	.use(AUTHZ.billingRead)
	.handler(async ({ input, context }) => {
		const organizationId = await resolveOrganizationId(context);
		const since = toSqlTimestamp(
			new Date(Date.now() - input.lastHours * 60 * 60 * 1000),
		);
		const summary = await getMcpPaymentSpendSummary(context.db, {
			organizationId,
			tediId: input.tediId,
			appSlug: input.appSlug,
			toolId: input.toolId,
			since,
			limit: input.limit,
		});

		return {
			lastHours: input.lastHours,
			since,
			summary,
			totals: buildSpendTotals(summary),
		};
	});

const listPoliciesProcedure = authedOs.listPolicies
	.use(AUTHZ.billingRead)
	.handler(async ({ input, context }) => {
		const organizationId = await resolveOrganizationId(context);
		await assertTediBelongsToOrg(context, input.tediId, organizationId);
		const policies = await listMcpPaymentPolicies(context.db, {
			organizationId,
			tediId: input.tediId,
			appSlug: input.appSlug,
			toolId: input.toolId,
			enabled: input.enabled,
			limit: input.limit,
		});
		return { policies };
	});

const setBudgetPolicyProcedure = authedOs.setBudgetPolicy
	.use(withAuthorization("billing:manage", "billing:write"))
	.handler(async ({ input, context }) => {
		const organizationId = await resolveOrganizationId(context);
		await assertTediBelongsToOrg(context, input.tediId, organizationId);
		const policy = await upsertMcpPaymentPolicy(context.db, {
			id: paymentPolicyId({
				organizationId,
				tediId: input.tediId,
				appSlug: input.appSlug,
				toolId: input.toolId,
				currency: input.currency,
				network: input.network,
			}),
			organizationId,
			tediId: input.tediId ?? null,
			appSlug: input.appSlug ?? null,
			toolId: input.toolId ?? null,
			currency: input.currency,
			network: input.network,
			enabled: input.enabled,
			maxAmount: input.maxAmount,
			maxTransactionAmount: input.maxTransactionAmount,
			allowedRecipients: input.allowedRecipients,
			allowedTools: input.allowedTools,
			windowSeconds: input.windowSeconds,
			mode: input.mode,
			createdBy: actorId(context),
			updatedBy: actorId(context),
		});
		return { policy };
	});

const getEffectivePolicyProcedure = authedOs.getEffectivePolicy
	.use(AUTHZ.billingRead)
	.handler(async ({ input, context }) => {
		const organizationId = await resolveOrganizationId(context);
		await assertTediBelongsToOrg(context, input.tediId, organizationId);
		const policy = await getEffectiveMcpPaymentPolicy(context.db, {
			organizationId,
			tediId: input.tediId,
			appSlug: input.appSlug,
			toolId: input.toolId,
			currency: input.currency,
			network: input.network,
		});
		return { policy };
	});

const disablePolicyProcedure = authedOs.disablePolicy
	.use(withAuthorization("billing:manage", "billing:write"))
	.handler(async ({ input, context }) => {
		const organizationId = await resolveOrganizationId(context);
		const existing = await getMcpPaymentPolicyById(context.db, {
			id: input.id,
			organizationId,
		});
		if (!existing) {
			throw createError(ErrorCodes.NOT_FOUND, "Payment policy not found");
		}
		const policy = await disableMcpPaymentPolicy(context.db, {
			id: input.id,
			organizationId,
			updatedBy: actorId(context),
		});
		if (!policy) {
			throw createError(ErrorCodes.NOT_FOUND, "Payment policy not found");
		}
		return { policy };
	});

const listAccountsProcedure = authedOs.listAccounts
	.use(AUTHZ.billingRead)
	.handler(async ({ input, context }) => {
		const organizationId = await resolveOrganizationId(context);
		await assertTediBelongsToOrg(context, input.tediId, organizationId);
		const accounts = await listMcpPaymentAccounts(context.db, {
			organizationId,
			tediId: input.tediId,
			appSlug: input.appSlug,
			network: input.network,
			asset: input.asset,
			status: input.status,
			limit: input.limit,
		});
		return { accounts: accounts.map(normalizePaymentAccount) };
	});

const registerAccountProcedure = authedOs.registerAccount
	.use(withAuthorization("billing:manage", "billing:write"))
	.handler(async ({ input, context }) => {
		const organizationId = await resolveOrganizationId(context);
		await assertTediBelongsToOrg(context, input.tediId, organizationId);
		const account = await upsertMcpPaymentAccount(context.db, {
			id: paymentAccountId({
				organizationId,
				tediId: input.tediId,
				appSlug: input.appSlug,
				network: input.network,
				asset: input.asset,
				publicAddress: input.publicAddress,
			}),
			organizationId,
			tediId: input.tediId ?? null,
			appSlug: input.appSlug ?? null,
			label: input.label,
			network: input.network,
			asset: input.asset,
			publicAddress: input.publicAddress,
			status: input.status,
			custodyMode: input.custodyMode,
			signerProvider: input.signerProvider,
			metadata:
				input.metadata === undefined ? undefined : toJsonRecord(input.metadata),
			createdBy: actorId(context),
			updatedBy: actorId(context),
		});
		return { account: normalizePaymentAccount(account) };
	});

const listReservationsProcedure = authedOs.listReservations
	.use(AUTHZ.billingRead)
	.handler(async ({ input, context }) => {
		const organizationId = await resolveOrganizationId(context);
		await assertTediBelongsToOrg(context, input.tediId, organizationId);
		const reservations = await listMcpPaymentReservations(context.db, {
			organizationId,
			tediId: input.tediId,
			appSlug: input.appSlug,
			toolId: input.toolId,
			status: input.status,
			limit: input.limit,
		});
		return { reservations: reservations.map(normalizePaymentReservation) };
	});

export const mcpPaymentsContractRouter = mcpPaymentsOs.router({
	listEvents: listEventsProcedure,
	requestBudgetOverride: requestBudgetOverrideProcedure,
	getReceipt: getReceiptProcedure,
	spendSummary: spendSummaryProcedure,
	listPolicies: listPoliciesProcedure,
	setBudgetPolicy: setBudgetPolicyProcedure,
	getEffectivePolicy: getEffectivePolicyProcedure,
	disablePolicy: disablePolicyProcedure,
	listAccounts: listAccountsProcedure,
	registerAccount: registerAccountProcedure,
	listReservations: listReservationsProcedure,
});
