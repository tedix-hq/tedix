/**
 * MCP payment event query helpers.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type McpPaymentAccount,
	type McpPaymentEvent,
	type McpPaymentPolicy,
	type McpPaymentReservation,
	type McpPaymentReservationStatus,
	type McpPaymentStatus,
	mcpPaymentAccounts,
	mcpPaymentEvents,
	mcpPaymentPolicies,
	mcpPaymentReservations,
	type NewMcpPaymentAccount,
	type NewMcpPaymentEvent,
	type NewMcpPaymentPolicy,
	type NewMcpPaymentReservation,
} from "../schema/mcp-payments";

export async function insertMcpPaymentEvent(
	db: DbClient,
	event: NewMcpPaymentEvent,
): Promise<McpPaymentEvent> {
	const [row] = await db.insert(mcpPaymentEvents).values(event).returning();
	if (!row) {
		throw new Error(`Failed to insert mcp_payment_event ${event.id}`);
	}
	return row;
}

export interface McpSettlementBudgetGuard {
	/** Budget ceiling for the window, decimal string. */
	maxAmount: string;
	/** Inclusive lower bound of the budget window, sqlite timestamp. */
	since: string;
	toolId?: string;
	tediId?: string;
	userId?: string;
}

/**
 * Insert a settled payment event only while the window's settled spend plus
 * this event's amount stays within the budget ceiling. The window SUM and the
 * insert are one D1 statement, so concurrent settlements serialize on the
 * write and cannot interleave between a separate read and write (the TOCTOU
 * a SUM-then-insert pair allows). Returns false when the guard rejected the
 * insert. Single statement, single RETURNING column: safe in a batch.
 */
export async function insertSettledMcpPaymentEventWithinBudget(
	db: DbClient,
	event: NewMcpPaymentEvent,
	guard: McpSettlementBudgetGuard,
): Promise<boolean> {
	if (!event.organizationId) {
		throw new Error(
			"organizationId is required for a budget-guarded settlement",
		);
	}
	const json = (value: unknown): string | null =>
		value === undefined || value === null ? null : JSON.stringify(value);
	const toolScope = guard.toolId ? sql` AND tool_id = ${guard.toolId}` : sql``;
	const tediScope = guard.tediId ? sql` AND tedi_id = ${guard.tediId}` : sql``;
	const userScope = guard.userId ? sql` AND user_id = ${guard.userId}` : sql``;

	const rows = (await db.all(sql`
		INSERT INTO mcp_payment_events (
			id, requirement_id, event_type, status, protocol, mode, network, asset,
			currency, amount, recipient, resource, app_id, app_slug,
			organization_id, tool_row_id, tool_id, tedi_id, user_id, client_id,
			auth_type, trace_id, tool_args_hash, settled, requirements,
			payment_proof, payment_response, budget_policy, budget_decision,
			decision_rationale, audit_event_id, rationale_record_id
		)
		SELECT
			${event.id}, ${event.requirementId}, ${event.eventType}, ${event.status},
			${event.protocol ?? "x402"}, ${event.mode ?? "mock"}, ${event.network},
			${event.asset ?? null}, ${event.currency ?? null}, ${event.amount},
			${event.recipient}, ${event.resource ?? null}, ${event.appId ?? null},
			${event.appSlug}, ${event.organizationId},
			${event.toolRowId ?? null}, ${event.toolId}, ${event.tediId ?? null},
			${event.userId ?? null}, ${event.clientId ?? null},
			${event.authType ?? null}, ${event.traceId ?? null},
			${event.toolArgsHash ?? null}, ${event.settled ? 1 : 0},
			${json(event.requirements)}, ${json(event.paymentProof)},
			${json(event.paymentResponse)}, ${json(event.budgetPolicy)},
			${json(event.budgetDecision)}, ${event.decisionRationale ?? null},
			${event.auditEventId ?? null}, ${event.rationaleRecordId ?? null}
		WHERE (
			SELECT COALESCE(SUM(CAST(amount AS REAL)), 0)
			FROM mcp_payment_events
			WHERE organization_id = ${event.organizationId}
				AND status = 'settled'
				AND settled = 1
				AND app_slug = ${event.appSlug}
				AND currency = ${event.currency ?? "USDC"}
				AND network = ${event.network}
				AND datetime(created_at) >= datetime(${guard.since})
				${toolScope}${tediScope}${userScope}
		) + CAST(${event.amount} AS REAL) <= CAST(${guard.maxAmount} AS REAL)
		RETURNING id
	`)) as Array<{ id: string }> | Array<[string]>;

	return rows.length > 0;
}

export async function listMcpPaymentEventsByRequirement(
	db: DbClient,
	requirementId: string,
): Promise<McpPaymentEvent[]> {
	return db
		.select()
		.from(mcpPaymentEvents)
		.where(eq(mcpPaymentEvents.requirementId, requirementId))
		.orderBy(desc(mcpPaymentEvents.createdAt));
}

export async function listMcpPaymentEventsForTool(
	db: DbClient,
	params: {
		appSlug: string;
		toolId: string;
		limit: number;
	},
): Promise<McpPaymentEvent[]> {
	return db
		.select()
		.from(mcpPaymentEvents)
		.where(
			and(
				eq(mcpPaymentEvents.appSlug, params.appSlug),
				eq(mcpPaymentEvents.toolId, params.toolId),
			),
		)
		.orderBy(desc(mcpPaymentEvents.createdAt))
		.limit(params.limit);
}

export interface ListMcpPaymentEventsOptions {
	organizationId: string;
	appSlug?: string;
	toolId?: string;
	requirementId?: string;
	tediId?: string;
	status?: McpPaymentStatus;
	limit: number;
}

export async function listMcpPaymentEvents(
	db: DbClient,
	options: ListMcpPaymentEventsOptions,
): Promise<McpPaymentEvent[]> {
	const conditions = [
		eq(mcpPaymentEvents.organizationId, options.organizationId),
	];
	if (options.appSlug) {
		conditions.push(eq(mcpPaymentEvents.appSlug, options.appSlug));
	}
	if (options.toolId) {
		conditions.push(eq(mcpPaymentEvents.toolId, options.toolId));
	}
	if (options.requirementId) {
		conditions.push(eq(mcpPaymentEvents.requirementId, options.requirementId));
	}
	if (options.tediId) {
		conditions.push(eq(mcpPaymentEvents.tediId, options.tediId));
	}
	if (options.status) {
		conditions.push(eq(mcpPaymentEvents.status, options.status));
	}

	return db
		.select()
		.from(mcpPaymentEvents)
		.where(and(...conditions))
		.orderBy(desc(mcpPaymentEvents.createdAt))
		.limit(options.limit);
}

export async function getMcpPaymentReceiptById(
	db: DbClient,
	params: {
		id: string;
		organizationId: string;
	},
): Promise<McpPaymentEvent | null> {
	const [row] = await db
		.select()
		.from(mcpPaymentEvents)
		.where(
			and(
				eq(mcpPaymentEvents.id, params.id),
				eq(mcpPaymentEvents.organizationId, params.organizationId),
				eq(mcpPaymentEvents.status, "settled"),
				eq(mcpPaymentEvents.settled, true),
			),
		)
		.limit(1);

	return row ?? null;
}

export async function getMcpPaymentEventByIdForOrg(
	db: DbClient,
	params: {
		id: string;
		organizationId: string;
	},
): Promise<McpPaymentEvent | null> {
	const [row] = await db
		.select()
		.from(mcpPaymentEvents)
		.where(
			and(
				eq(mcpPaymentEvents.id, params.id),
				eq(mcpPaymentEvents.organizationId, params.organizationId),
			),
		)
		.limit(1);

	return row ?? null;
}

export async function listMcpPaymentEventsByRequirementForOrg(
	db: DbClient,
	params: {
		requirementId: string;
		organizationId: string;
	},
): Promise<McpPaymentEvent[]> {
	return db
		.select()
		.from(mcpPaymentEvents)
		.where(
			and(
				eq(mcpPaymentEvents.requirementId, params.requirementId),
				eq(mcpPaymentEvents.organizationId, params.organizationId),
			),
		)
		.orderBy(desc(mcpPaymentEvents.createdAt));
}

export interface McpPaymentSpendSummaryOptions {
	organizationId: string;
	tediId?: string;
	appSlug?: string;
	toolId?: string;
	since: string;
	limit: number;
}

export interface McpPaymentSpendSummaryRow {
	appSlug: string;
	toolId: string;
	currency: string | null;
	asset: string | null;
	network: string;
	settledCount: number;
	totalAmount: number;
	firstSettledAt: string | null;
	lastSettledAt: string | null;
}

export async function getMcpPaymentSpendSummary(
	db: DbClient,
	options: McpPaymentSpendSummaryOptions,
): Promise<McpPaymentSpendSummaryRow[]> {
	const conditions = [
		eq(mcpPaymentEvents.organizationId, options.organizationId),
		eq(mcpPaymentEvents.status, "settled"),
		eq(mcpPaymentEvents.settled, true),
		sql`datetime(${mcpPaymentEvents.createdAt}) >= datetime(${options.since})`,
	];
	if (options.tediId) {
		conditions.push(eq(mcpPaymentEvents.tediId, options.tediId));
	}
	if (options.appSlug) {
		conditions.push(eq(mcpPaymentEvents.appSlug, options.appSlug));
	}
	if (options.toolId) {
		conditions.push(eq(mcpPaymentEvents.toolId, options.toolId));
	}

	const rows = await db
		.select({
			appSlug: mcpPaymentEvents.appSlug,
			toolId: mcpPaymentEvents.toolId,
			currency: mcpPaymentEvents.currency,
			asset: mcpPaymentEvents.asset,
			network: mcpPaymentEvents.network,
			settledCount: sql<number>`count(*)`,
			totalAmount: sql<number>`sum(cast(${mcpPaymentEvents.amount} as real))`,
			firstSettledAt: sql<string>`min(${mcpPaymentEvents.createdAt})`,
			lastSettledAt: sql<string>`max(${mcpPaymentEvents.createdAt})`,
		})
		.from(mcpPaymentEvents)
		.where(and(...conditions))
		.groupBy(
			mcpPaymentEvents.appSlug,
			mcpPaymentEvents.toolId,
			mcpPaymentEvents.currency,
			mcpPaymentEvents.asset,
			mcpPaymentEvents.network,
		)
		.orderBy(desc(sql`sum(cast(${mcpPaymentEvents.amount} as real))`))
		.limit(options.limit);

	return rows.map((row) => ({
		appSlug: row.appSlug,
		toolId: row.toolId,
		currency: row.currency,
		asset: row.asset,
		network: row.network,
		settledCount: Number(row.settledCount ?? 0),
		totalAmount: Number(row.totalAmount ?? 0),
		firstSettledAt: row.firstSettledAt ?? null,
		lastSettledAt: row.lastSettledAt ?? null,
	}));
}

export async function sumSettledMcpPaymentAmount(
	db: DbClient,
	params: {
		organizationId: string;
		appSlug: string;
		currency: string;
		network: string;
		since: string;
		toolId?: string;
		tediId?: string;
		userId?: string;
	},
): Promise<number> {
	if (!params.organizationId) {
		throw new Error(
			"organizationId is required when summing MCP payment budget spend",
		);
	}

	const conditions = [
		eq(mcpPaymentEvents.organizationId, params.organizationId),
		eq(mcpPaymentEvents.status, "settled"),
		eq(mcpPaymentEvents.settled, true),
		eq(mcpPaymentEvents.appSlug, params.appSlug),
		eq(mcpPaymentEvents.currency, params.currency),
		eq(mcpPaymentEvents.network, params.network),
		sql`datetime(${mcpPaymentEvents.createdAt}) >= datetime(${params.since})`,
	];

	if (params.toolId) {
		conditions.push(eq(mcpPaymentEvents.toolId, params.toolId));
	}
	if (params.tediId) {
		conditions.push(eq(mcpPaymentEvents.tediId, params.tediId));
	}
	if (params.userId) {
		conditions.push(eq(mcpPaymentEvents.userId, params.userId));
	}

	const [row] = await db
		.select({
			spent: sql<number>`COALESCE(SUM(CAST(${mcpPaymentEvents.amount} AS REAL)), 0)`,
		})
		.from(mcpPaymentEvents)
		.where(and(...conditions));

	return Number(row?.spent ?? 0);
}

export interface ListMcpPaymentPoliciesOptions {
	organizationId: string;
	tediId?: string;
	appSlug?: string;
	toolId?: string;
	enabled?: boolean;
	limit: number;
}

export async function listMcpPaymentPolicies(
	db: DbClient,
	options: ListMcpPaymentPoliciesOptions,
): Promise<McpPaymentPolicy[]> {
	const conditions = [
		eq(mcpPaymentPolicies.organizationId, options.organizationId),
	];
	if (options.tediId) {
		conditions.push(eq(mcpPaymentPolicies.tediId, options.tediId));
	}
	if (options.appSlug) {
		conditions.push(eq(mcpPaymentPolicies.appSlug, options.appSlug));
	}
	if (options.toolId) {
		conditions.push(eq(mcpPaymentPolicies.toolId, options.toolId));
	}
	if (options.enabled !== undefined) {
		conditions.push(eq(mcpPaymentPolicies.enabled, options.enabled));
	}

	return db
		.select()
		.from(mcpPaymentPolicies)
		.where(and(...conditions))
		.orderBy(desc(mcpPaymentPolicies.updatedAt))
		.limit(options.limit);
}

export async function upsertMcpPaymentPolicy(
	db: DbClient,
	policy: NewMcpPaymentPolicy,
): Promise<McpPaymentPolicy> {
	const [row] = await db
		.insert(mcpPaymentPolicies)
		.values(policy)
		.onConflictDoUpdate({
			target: mcpPaymentPolicies.id,
			set: {
				enabled: policy.enabled ?? true,
				maxAmount: policy.maxAmount,
				...(policy.maxTransactionAmount !== undefined
					? { maxTransactionAmount: policy.maxTransactionAmount }
					: {}),
				...(policy.allowedRecipients !== undefined
					? { allowedRecipients: policy.allowedRecipients }
					: {}),
				...(policy.allowedTools !== undefined
					? { allowedTools: policy.allowedTools }
					: {}),
				windowSeconds: policy.windowSeconds ?? 86_400,
				mode: policy.mode ?? "enforce",
				updatedBy: policy.updatedBy ?? policy.createdBy ?? null,
				updatedAt: sql`(CURRENT_TIMESTAMP)`,
			},
		})
		.returning();
	if (!row) throw new Error(`Failed to upsert mcp_payment_policy ${policy.id}`);
	return row;
}

export async function getMcpPaymentPolicyById(
	db: DbClient,
	params: { id: string; organizationId: string },
): Promise<McpPaymentPolicy | null> {
	const [row] = await db
		.select()
		.from(mcpPaymentPolicies)
		.where(
			and(
				eq(mcpPaymentPolicies.id, params.id),
				eq(mcpPaymentPolicies.organizationId, params.organizationId),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function disableMcpPaymentPolicy(
	db: DbClient,
	params: { id: string; organizationId: string; updatedBy?: string | null },
): Promise<McpPaymentPolicy | null> {
	const [row] = await db
		.update(mcpPaymentPolicies)
		.set({
			enabled: false,
			updatedBy: params.updatedBy ?? null,
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(
			and(
				eq(mcpPaymentPolicies.id, params.id),
				eq(mcpPaymentPolicies.organizationId, params.organizationId),
			),
		)
		.returning();
	return row ?? null;
}

export interface EffectiveMcpPaymentPolicyOptions {
	organizationId: string;
	tediId?: string | null;
	appSlug: string;
	toolId: string;
	currency: string;
	network: string;
}

export async function getEffectiveMcpPaymentPolicy(
	db: DbClient,
	options: EffectiveMcpPaymentPolicyOptions,
): Promise<McpPaymentPolicy | null> {
	const rows = await db
		.select()
		.from(mcpPaymentPolicies)
		.where(
			and(
				eq(mcpPaymentPolicies.organizationId, options.organizationId),
				eq(mcpPaymentPolicies.enabled, true),
				eq(mcpPaymentPolicies.currency, options.currency),
				eq(mcpPaymentPolicies.network, options.network),
				options.tediId
					? or(
							isNull(mcpPaymentPolicies.tediId),
							eq(mcpPaymentPolicies.tediId, options.tediId),
						)
					: isNull(mcpPaymentPolicies.tediId),
				or(
					isNull(mcpPaymentPolicies.appSlug),
					eq(mcpPaymentPolicies.appSlug, options.appSlug),
				),
				or(
					isNull(mcpPaymentPolicies.toolId),
					eq(mcpPaymentPolicies.toolId, options.toolId),
				),
			),
		);

	return (
		rows
			.map((row) => ({
				row,
				score:
					(row.tediId === options.tediId ? 4 : 0) +
					(row.appSlug === options.appSlug ? 2 : 0) +
					(row.toolId === options.toolId ? 1 : 0),
			}))
			.sort((a, b) => {
				if (b.score !== a.score) return b.score - a.score;
				return String(b.row.updatedAt ?? "").localeCompare(
					String(a.row.updatedAt ?? ""),
				);
			})[0]?.row ?? null
	);
}

export interface ListMcpPaymentAccountsOptions {
	organizationId: string;
	tediId?: string;
	appSlug?: string;
	network?: string;
	asset?: string;
	status?: "active" | "paused" | "disabled";
	limit: number;
}

export async function listMcpPaymentAccounts(
	db: DbClient,
	options: ListMcpPaymentAccountsOptions,
): Promise<McpPaymentAccount[]> {
	const conditions = [
		eq(mcpPaymentAccounts.organizationId, options.organizationId),
	];
	if (options.tediId) {
		conditions.push(eq(mcpPaymentAccounts.tediId, options.tediId));
	}
	if (options.appSlug) {
		conditions.push(eq(mcpPaymentAccounts.appSlug, options.appSlug));
	}
	if (options.network) {
		conditions.push(eq(mcpPaymentAccounts.network, options.network));
	}
	if (options.asset) {
		conditions.push(eq(mcpPaymentAccounts.asset, options.asset));
	}
	if (options.status) {
		conditions.push(eq(mcpPaymentAccounts.status, options.status));
	}

	return db
		.select()
		.from(mcpPaymentAccounts)
		.where(and(...conditions))
		.orderBy(desc(mcpPaymentAccounts.updatedAt))
		.limit(options.limit);
}

export async function upsertMcpPaymentAccount(
	db: DbClient,
	account: NewMcpPaymentAccount,
): Promise<McpPaymentAccount> {
	const [row] = await db
		.insert(mcpPaymentAccounts)
		.values(account)
		.onConflictDoUpdate({
			target: mcpPaymentAccounts.id,
			set: {
				label: account.label,
				status: account.status ?? "active",
				custodyMode: account.custodyMode ?? "mock",
				signerProvider: account.signerProvider ?? "mock",
				metadata: account.metadata,
				updatedBy: account.updatedBy ?? account.createdBy ?? null,
				updatedAt: sql`(CURRENT_TIMESTAMP)`,
			},
		})
		.returning();
	if (!row)
		throw new Error(`Failed to upsert mcp_payment_account ${account.id}`);
	return row;
}

export interface ListMcpPaymentReservationsOptions {
	organizationId: string;
	tediId?: string;
	appSlug?: string;
	toolId?: string;
	status?: McpPaymentReservationStatus;
	limit: number;
}

export async function listMcpPaymentReservations(
	db: DbClient,
	options: ListMcpPaymentReservationsOptions,
): Promise<McpPaymentReservation[]> {
	const conditions = [
		eq(mcpPaymentReservations.organizationId, options.organizationId),
	];
	if (options.tediId) {
		conditions.push(eq(mcpPaymentReservations.tediId, options.tediId));
	}
	if (options.appSlug) {
		conditions.push(eq(mcpPaymentReservations.appSlug, options.appSlug));
	}
	if (options.toolId) {
		conditions.push(eq(mcpPaymentReservations.toolId, options.toolId));
	}
	if (options.status) {
		conditions.push(eq(mcpPaymentReservations.status, options.status));
	}

	return db
		.select()
		.from(mcpPaymentReservations)
		.where(and(...conditions))
		.orderBy(desc(mcpPaymentReservations.updatedAt))
		.limit(options.limit);
}

export async function upsertMcpPaymentReservation(
	db: DbClient,
	reservation: NewMcpPaymentReservation,
): Promise<McpPaymentReservation> {
	const [row] = await db
		.insert(mcpPaymentReservations)
		.values(reservation)
		.onConflictDoUpdate({
			target: mcpPaymentReservations.id,
			set: {
				accountId: reservation.accountId ?? null,
				policyId: reservation.policyId ?? null,
				status: reservation.status ?? "reserved",
				resource: reservation.resource,
				expiresAt: reservation.expiresAt,
				metadata: reservation.metadata,
				updatedAt: sql`(CURRENT_TIMESTAMP)`,
			},
		})
		.returning();
	if (!row) {
		throw new Error(
			`Failed to upsert mcp_payment_reservation ${reservation.id}`,
		);
	}
	return row;
}

export async function updateMcpPaymentReservationStatus(
	db: DbClient,
	params: {
		requirementId: string;
		organizationId: string;
		status: McpPaymentReservationStatus;
		settledEventId?: string | null;
		metadata?: Record<string, JsonValue>;
	},
): Promise<McpPaymentReservation | null> {
	const [row] = await db
		.update(mcpPaymentReservations)
		.set({
			status: params.status,
			settledEventId: params.settledEventId ?? null,
			metadata: params.metadata,
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(
			and(
				eq(mcpPaymentReservations.requirementId, params.requirementId),
				eq(mcpPaymentReservations.organizationId, params.organizationId),
			),
		)
		.returning();
	return row ?? null;
}
