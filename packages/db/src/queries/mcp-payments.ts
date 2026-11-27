/**
 * MCP payment event query helpers.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	and,
	desc,
	eq,
	isNull,
	or,
	sql,
	type SQL,
	type SQLWrapper,
} from "drizzle-orm";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { booleanValue, coreStore, jsonParameter } from "../core-store/dialect";
import {
	type McpPaymentAccount,
	type McpPaymentEvent,
	type McpPaymentPolicy,
	type McpPaymentReservation,
	type McpPaymentReservationStatus,
	type McpPaymentStatus,
	mcpPaymentAccounts as schemaMcpPaymentAccounts,
	mcpPaymentEvents as schemaMcpPaymentEvents,
	mcpPaymentPolicies as schemaMcpPaymentPolicies,
	mcpPaymentReservations as schemaMcpPaymentReservations,
	type NewMcpPaymentAccount,
	type NewMcpPaymentEvent,
	type NewMcpPaymentPolicy,
	type NewMcpPaymentReservation,
} from "../schema/mcp-payments";

/** Text timestamp in the stores' shared `YYYY-MM-DD HH24:MI:SS` UTC format. */
function nowTimestamp(db: DbClient): SQL {
	return coreStore(db) === "postgres"
		? sql`to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`
		: sql`(CURRENT_TIMESTAMP)`;
}

/** `datetime(column) >= datetime(since)` on D1; timestamptz comparison on Postgres. */
function createdAtGte(db: DbClient, column: SQLWrapper, since: string): SQL {
	return coreStore(db) === "postgres"
		? sql`CAST(${column} AS timestamptz) >= CAST(${since} AS timestamptz)`
		: sql`datetime(${column}) >= datetime(${since})`;
}

/** REAL on D1, double precision on Postgres, for summing the text amount. */
function realAmount(db: DbClient, column: SQLWrapper): SQL {
	return coreStore(db) === "postgres"
		? sql`CAST(${column} AS double precision)`
		: sql`CAST(${column} AS REAL)`;
}

/** JSON null stays JSON; absent values stay SQL NULL on both stores. */
function jsonColumn(db: DbClient, value: unknown): SQL {
	return value === undefined || value === null
		? sql`NULL`
		: jsonParameter(db, value);
}

export async function insertMcpPaymentEvent(
	db: DbClient,
	event: NewMcpPaymentEvent,
): Promise<McpPaymentEvent> {
	const mcpPaymentEvents = coreTable(db, schemaMcpPaymentEvents);
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
	const e = coreTable(db, schemaMcpPaymentEvents);
	// SUM without GROUP BY yields exactly one row, so the insert selects from
	// the window total and the budget check stays in the same statement.
	const window = db
		.select({
			spent: sql<number>`COALESCE(SUM(${realAmount(db, e.amount)}), 0)`.as(
				"spent",
			),
		})
		.from(e)
		.where(
			and(
				eq(e.organizationId, event.organizationId),
				sql`${e.status} = 'settled'`,
				sql`${e.settled} = ${booleanValue(db, true)}`,
				eq(e.appSlug, event.appSlug),
				eq(e.currency, event.currency ?? "USDC"),
				eq(e.network, event.network),
				createdAtGte(db, e.createdAt, guard.since),
				guard.toolId ? eq(e.toolId, guard.toolId) : undefined,
				guard.tediId ? eq(e.tediId, guard.tediId) : undefined,
				guard.userId ? eq(e.userId, guard.userId) : undefined,
			),
		)
		.as("budget_window");

	const rows = await db
		.insert(e)
		.select(
			db
				.select({
					id: sql`${event.id}`.as("id"),
					requirementId: sql`${event.requirementId}`.as("requirement_id"),
					eventType: sql`${event.eventType}`.as("event_type"),
					status: sql`${event.status}`.as("status"),
					protocol: sql`${event.protocol ?? "x402"}`.as("protocol"),
					mode: sql`${event.mode ?? "mock"}`.as("mode"),
					network: sql`${event.network}`.as("network"),
					asset: sql`${event.asset ?? null}`.as("asset"),
					currency: sql`${event.currency ?? null}`.as("currency"),
					amount: sql`${event.amount}`.as("amount"),
					recipient: sql`${event.recipient}`.as("recipient"),
					resource: sql`${event.resource ?? null}`.as("resource"),
					appId: sql`${event.appId ?? null}`.as("app_id"),
					appSlug: sql`${event.appSlug}`.as("app_slug"),
					organizationId: sql`${event.organizationId}`.as("organization_id"),
					toolRowId: sql`${event.toolRowId ?? null}`.as("tool_row_id"),
					toolId: sql`${event.toolId}`.as("tool_id"),
					tediId: sql`${event.tediId ?? null}`.as("tedi_id"),
					userId: sql`${event.userId ?? null}`.as("user_id"),
					clientId: sql`${event.clientId ?? null}`.as("client_id"),
					authType: sql`${event.authType ?? null}`.as("auth_type"),
					traceId: sql`${event.traceId ?? null}`.as("trace_id"),
					toolArgsHash: sql`${event.toolArgsHash ?? null}`.as("tool_args_hash"),
					settled: booleanValue(db, event.settled ?? false).as("settled"),
					requirements: jsonColumn(db, event.requirements).as("requirements"),
					paymentProof: jsonColumn(db, event.paymentProof).as("payment_proof"),
					paymentResponse: jsonColumn(db, event.paymentResponse).as(
						"payment_response",
					),
					budgetPolicy: jsonColumn(db, event.budgetPolicy).as("budget_policy"),
					budgetDecision: jsonColumn(db, event.budgetDecision).as(
						"budget_decision",
					),
					decisionRationale: sql`${event.decisionRationale ?? null}`.as(
						"decision_rationale",
					),
					auditEventId: sql`${event.auditEventId ?? null}`.as("audit_event_id"),
					rationaleRecordId: sql`${event.rationaleRecordId ?? null}`.as(
						"rationale_record_id",
					),
				})
				.from(window)
				.where(
					sql`${window.spent} + ${realAmount(db, sql`${event.amount}`)} <= ${realAmount(db, sql`${guard.maxAmount}`)}`,
				),
		)
		.returning({ id: e.id });

	return rows.length > 0;
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
	const mcpPaymentEvents = coreTable(db, schemaMcpPaymentEvents);
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
	const mcpPaymentEvents = coreTable(db, schemaMcpPaymentEvents);
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
	const mcpPaymentEvents = coreTable(db, schemaMcpPaymentEvents);
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
	const mcpPaymentEvents = coreTable(db, schemaMcpPaymentEvents);
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
	const mcpPaymentEvents = coreTable(db, schemaMcpPaymentEvents);
	const conditions = [
		eq(mcpPaymentEvents.organizationId, options.organizationId),
		eq(mcpPaymentEvents.status, "settled"),
		eq(mcpPaymentEvents.settled, true),
		createdAtGte(db, mcpPaymentEvents.createdAt, options.since),
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
			totalAmount: sql<number>`sum(${realAmount(db, mcpPaymentEvents.amount)})`,
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
		.orderBy(desc(sql`sum(${realAmount(db, mcpPaymentEvents.amount)})`))
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

	const mcpPaymentEvents = coreTable(db, schemaMcpPaymentEvents);
	const conditions = [
		eq(mcpPaymentEvents.organizationId, params.organizationId),
		eq(mcpPaymentEvents.status, "settled"),
		eq(mcpPaymentEvents.settled, true),
		eq(mcpPaymentEvents.appSlug, params.appSlug),
		eq(mcpPaymentEvents.currency, params.currency),
		eq(mcpPaymentEvents.network, params.network),
		createdAtGte(db, mcpPaymentEvents.createdAt, params.since),
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
			spent: sql<number>`COALESCE(SUM(${realAmount(db, mcpPaymentEvents.amount)}), 0)`,
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
	const mcpPaymentPolicies = coreTable(db, schemaMcpPaymentPolicies);
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
	const mcpPaymentPolicies = coreTable(db, schemaMcpPaymentPolicies);
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
				updatedAt: nowTimestamp(db),
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
	const mcpPaymentPolicies = coreTable(db, schemaMcpPaymentPolicies);
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
	const mcpPaymentPolicies = coreTable(db, schemaMcpPaymentPolicies);
	const [row] = await db
		.update(mcpPaymentPolicies)
		.set({
			enabled: false,
			updatedBy: params.updatedBy ?? null,
			updatedAt: nowTimestamp(db),
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
	const mcpPaymentPolicies = coreTable(db, schemaMcpPaymentPolicies);
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
	const mcpPaymentAccounts = coreTable(db, schemaMcpPaymentAccounts);
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
	const mcpPaymentAccounts = coreTable(db, schemaMcpPaymentAccounts);
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
				updatedAt: nowTimestamp(db),
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
	const mcpPaymentReservations = coreTable(db, schemaMcpPaymentReservations);
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
	const mcpPaymentReservations = coreTable(db, schemaMcpPaymentReservations);
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
				updatedAt: nowTimestamp(db),
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
	const mcpPaymentReservations = coreTable(db, schemaMcpPaymentReservations);
	const [row] = await db
		.update(mcpPaymentReservations)
		.set({
			status: params.status,
			settledEventId: params.settledEventId ?? null,
			metadata: params.metadata,
			updatedAt: nowTimestamp(db),
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
