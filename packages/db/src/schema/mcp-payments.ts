/**
 * MCP payment event ledger.
 *
 * Records machine-payment requests and settlements emitted by MCP tools. This is
 * intentionally an append-only event table: a single requirement can be retried
 * by multiple hosts or tedis, and each request/settlement should remain visible
 * for budget policy, rationale, and demo/audit timelines.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
import { uuid4Default } from "./_sql-helpers";
import { apps } from "./apps";
import { organizations } from "./organizations";
import { tedis } from "./tedis";

export const MCP_PAYMENT_EVENT_TYPES = [
	"payment_required",
	"payment_settled",
	"payment_rejected",
] as const;
export type McpPaymentEventType = (typeof MCP_PAYMENT_EVENT_TYPES)[number];

export const MCP_PAYMENT_STATUSES = [
	"required",
	"settled",
	"rejected",
] as const;
export type McpPaymentStatus = (typeof MCP_PAYMENT_STATUSES)[number];

export const mcpPaymentEvents = sqliteTable(
	"mcp_payment_events",
	{
		id: text("id").primaryKey(),

		/** x402 requirement id shared by the request and eventual settlement. */
		requirementId: text("requirement_id").notNull(),

		eventType: text("event_type", { enum: MCP_PAYMENT_EVENT_TYPES }).notNull(),
		status: text("status", { enum: MCP_PAYMENT_STATUSES }).notNull(),

		protocol: text("protocol").notNull().default("x402"),
		mode: text("mode").notNull().default("mock"),
		network: text("network").notNull(),
		asset: text("asset"),
		currency: text("currency"),
		amount: text("amount").notNull(),
		recipient: text("recipient").notNull(),
		resource: text("resource"),

		appId: text("app_id").references(() => apps.id, { onDelete: "set null" }),
		appSlug: text("app_slug").notNull(),
		organizationId: text("organization_id").references(() => organizations.id, {
			onDelete: "set null",
		}),
		toolRowId: text("tool_row_id"),
		toolId: text("tool_id").notNull(),

		tediId: text("tedi_id").references(() => tedis.id, {
			onDelete: "set null",
		}),
		userId: text("user_id"),
		clientId: text("client_id"),
		authType: text("auth_type"),

		traceId: text("trace_id"),
		toolArgsHash: text("tool_args_hash"),
		settled: integer("settled", { mode: "boolean" }).notNull().default(false),

		requirements: text("requirements", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		paymentProof: text("payment_proof", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		paymentResponse: text("payment_response", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		budgetPolicy: text("budget_policy", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		budgetDecision: text("budget_decision", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		decisionRationale: text("decision_rationale"),
		auditEventId: text("audit_event_id"),
		rationaleRecordId: text("rationale_record_id"),

		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_mcp_payment_requirement").on(table.requirementId),
		index("idx_mcp_payment_app").on(table.appId),
		index("idx_mcp_payment_org").on(table.organizationId),
		index("idx_mcp_payment_tedi").on(table.tediId),
		index("idx_mcp_payment_tool").on(table.appSlug, table.toolId),
		index("idx_mcp_payment_status").on(table.status),
		index("idx_mcp_payment_created").on(table.createdAt),
		index("idx_mcp_payment_rationale").on(table.rationaleRecordId),
	],
);

export type McpPaymentEvent = typeof mcpPaymentEvents.$inferSelect;
export type NewMcpPaymentEvent = typeof mcpPaymentEvents.$inferInsert;

export const MCP_PAYMENT_POLICY_MODES = ["enforce", "warn"] as const;
export type McpPaymentPolicyMode = (typeof MCP_PAYMENT_POLICY_MODES)[number];

/**
 * First-class payment budget policies for TedixPay/x402 tools.
 *
 * Policies are evaluated by the MCP edge before a mock settlement is accepted.
 * A row can target a whole organization, one tedi, one app, or one tool by
 * leaving narrower columns null. More specific rows win.
 */
export const mcpPaymentPolicies = sqliteTable(
	"mcp_payment_policies",
	{
		id: text("id").primaryKey().default(uuid4Default()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id").references(() => tedis.id, {
			onDelete: "cascade",
		}),
		appSlug: text("app_slug"),
		toolId: text("tool_id"),
		currency: text("currency").notNull().default("USDC"),
		network: text("network").notNull().default("solana-devnet"),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		maxAmount: text("max_amount").notNull(),
		maxTransactionAmount: text("max_transaction_amount"),
		allowedRecipients: text("allowed_recipients", { mode: "json" }).$type<
			string[]
		>(),
		allowedTools: text("allowed_tools", { mode: "json" }).$type<string[]>(),
		windowSeconds: integer("window_seconds").notNull().default(86_400),
		mode: text("mode", { enum: MCP_PAYMENT_POLICY_MODES })
			.notNull()
			.default("enforce"),
		createdBy: text("created_by"),
		updatedBy: text("updated_by"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		unique("uniq_mcp_payment_policy_target").on(
			table.organizationId,
			table.tediId,
			table.appSlug,
			table.toolId,
			table.currency,
			table.network,
		),
		index("idx_mcp_payment_policy_org").on(table.organizationId),
		index("idx_mcp_payment_policy_tedi").on(table.tediId),
		index("idx_mcp_payment_policy_tool").on(table.appSlug, table.toolId),
		index("idx_mcp_payment_policy_enabled").on(table.enabled),
	],
);

export type McpPaymentPolicy = typeof mcpPaymentPolicies.$inferSelect;
export type NewMcpPaymentPolicy = typeof mcpPaymentPolicies.$inferInsert;

export const MCP_PAYMENT_ACCOUNT_STATUSES = [
	"active",
	"paused",
	"disabled",
] as const;
export type McpPaymentAccountStatus =
	(typeof MCP_PAYMENT_ACCOUNT_STATUSES)[number];

export const MCP_PAYMENT_CUSTODY_MODES = [
	"mock",
	"watch_only",
	"delegated",
	"non_custodial",
] as const;
export type McpPaymentCustodyMode = (typeof MCP_PAYMENT_CUSTODY_MODES)[number];

export const MCP_PAYMENT_SIGNER_PROVIDERS = [
	"mock",
	"pay_sh",
	"privy",
	"solana_pay",
	"manual",
] as const;
export type McpPaymentSignerProvider =
	(typeof MCP_PAYMENT_SIGNER_PROVIDERS)[number];

/**
 * Non-custodial payment account registry.
 *
 * Rows describe where an org/tedi/app can pay from or receive to. Tedix v1 does
 * not store private keys; signer/provider configuration is metadata for policy
 * and verification, not custody.
 */
export const mcpPaymentAccounts = sqliteTable(
	"mcp_payment_accounts",
	{
		id: text("id").primaryKey().default(uuid4Default()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id").references(() => tedis.id, {
			onDelete: "cascade",
		}),
		appSlug: text("app_slug"),
		label: text("label").notNull(),
		network: text("network").notNull().default("solana-devnet"),
		asset: text("asset").notNull().default("USDC"),
		publicAddress: text("public_address").notNull(),
		status: text("status", { enum: MCP_PAYMENT_ACCOUNT_STATUSES })
			.notNull()
			.default("active"),
		custodyMode: text("custody_mode", { enum: MCP_PAYMENT_CUSTODY_MODES })
			.notNull()
			.default("mock"),
		signerProvider: text("signer_provider", {
			enum: MCP_PAYMENT_SIGNER_PROVIDERS,
		})
			.notNull()
			.default("mock"),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		createdBy: text("created_by"),
		updatedBy: text("updated_by"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		unique("uniq_mcp_payment_account_target").on(
			table.organizationId,
			table.tediId,
			table.appSlug,
			table.network,
			table.asset,
			table.publicAddress,
		),
		index("idx_mcp_payment_account_org").on(table.organizationId),
		index("idx_mcp_payment_account_tedi").on(table.tediId),
		index("idx_mcp_payment_account_app").on(table.appSlug),
		index("idx_mcp_payment_account_status").on(table.status),
	],
);

export type McpPaymentAccount = typeof mcpPaymentAccounts.$inferSelect;
export type NewMcpPaymentAccount = typeof mcpPaymentAccounts.$inferInsert;

export const MCP_PAYMENT_RESERVATION_STATUSES = [
	"reserved",
	"settled",
	"rejected",
	"expired",
	"canceled",
] as const;
export type McpPaymentReservationStatus =
	(typeof MCP_PAYMENT_RESERVATION_STATUSES)[number];

/**
 * Budget reservations created before paid MCP execution.
 *
 * A reservation links a requirement id to the exact amount, tedi, tool, policy,
 * and account context that was evaluated. It is the bridge from "402 required"
 * to "settled/rejected/expired" without relying on event ordering alone.
 */
export const mcpPaymentReservations = sqliteTable(
	"mcp_payment_reservations",
	{
		id: text("id").primaryKey().default(uuid4Default()),
		requirementId: text("requirement_id").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id").references(() => tedis.id, {
			onDelete: "set null",
		}),
		appSlug: text("app_slug").notNull(),
		toolId: text("tool_id").notNull(),
		accountId: text("account_id").references(() => mcpPaymentAccounts.id, {
			onDelete: "set null",
		}),
		policyId: text("policy_id").references(() => mcpPaymentPolicies.id, {
			onDelete: "set null",
		}),
		status: text("status", { enum: MCP_PAYMENT_RESERVATION_STATUSES })
			.notNull()
			.default("reserved"),
		protocol: text("protocol").notNull().default("x402"),
		mode: text("mode").notNull().default("mock"),
		network: text("network").notNull(),
		asset: text("asset"),
		currency: text("currency"),
		amount: text("amount").notNull(),
		recipient: text("recipient").notNull(),
		resource: text("resource"),
		expiresAt: text("expires_at").notNull(),
		settledEventId: text("settled_event_id"),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		unique("uniq_mcp_payment_reservation_requirement").on(table.requirementId),
		index("idx_mcp_payment_reservation_org").on(table.organizationId),
		index("idx_mcp_payment_reservation_tedi").on(table.tediId),
		index("idx_mcp_payment_reservation_tool").on(table.appSlug, table.toolId),
		index("idx_mcp_payment_reservation_status").on(table.status),
		index("idx_mcp_payment_reservation_expires").on(table.expiresAt),
	],
);

export type McpPaymentReservation = typeof mcpPaymentReservations.$inferSelect;
export type NewMcpPaymentReservation =
	typeof mcpPaymentReservations.$inferInsert;
