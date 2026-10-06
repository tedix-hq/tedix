/**
 * Tedis Schema
 * Tedi instances managed by the platform
 *
 * TERMINOLOGY:
 * - "Tedi" = durable worker identity with runtime profiles, policies, memory, tools, audit, and body adapters
 * - Each tedi belongs to an organization for multi-tenant isolation
 * - Tedis are conceptually separate from MCP "Apps" — different entity, different purpose
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	real,
	sqliteTable,
	text,
	unique,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "./control-plane";
import { organizations } from "./organizations";

// =============================================================================
// ENUMS
// =============================================================================

export const TEDI_STATUS_VALUES = [
	"active",
	"paused",
	"error",
	"provisioning",
] as const;
export type TediStatus = (typeof TEDI_STATUS_VALUES)[number];

export const RUNTIME_STATE_VALUES = ["active", "standby", "archived"] as const;
export type RuntimeState = (typeof RUNTIME_STATE_VALUES)[number];

export const TEDI_BILLING_STATE_VALUES = ["cold", "warm", "active"] as const;
export type TediBillingState = (typeof TEDI_BILLING_STATE_VALUES)[number];

export const RUNTIME_STATUS_VALUES = [
	"running",
	"sleeping",
	"starting",
	"error",
	"unknown",
] as const;
export type RuntimeStatus = (typeof RUNTIME_STATUS_VALUES)[number];

export const BODY_GENERATION_STATUS_VALUES = [
	"armed",
	"starting",
	"ready",
	"failed",
	"terminated",
	"expired",
] as const;
export type BodyGenerationStatus =
	(typeof BODY_GENERATION_STATUS_VALUES)[number];

// Body-model vocabulary. The product model is one Agent runtime plus additive
// Sandbox workstation leases, not peer runtime bodies.
export const BODY_KIND_VALUES = ["agent", "workstation"] as const;
export type BodyKind = (typeof BODY_KIND_VALUES)[number];

export const MCP_CAPABILITY_PROFILE_VALUES = [
	"standard",
	"content_admin",
	"org_admin",
	"platform_admin",
] as const;
export type McpCapabilityProfile =
	(typeof MCP_CAPABILITY_PROFILE_VALUES)[number];

export const DEVICE_STATUS_VALUES = ["pending", "paired", "revoked"] as const;
export type DeviceStatus = (typeof DEVICE_STATUS_VALUES)[number];

// =============================================================================
// JSON METADATA INTERFACES
// =============================================================================

/** Tool execution approval policies */
export interface ToolPolicy {
	bash?: "always-allow" | "approve-first-then-allow" | "always-approve";
	browser?: "always-allow" | "always-approve";
	browserEgress?: BrowserHostnamePolicy;
	github?: "always-allow" | "always-approve";
	deploy?: "always-allow" | "always-approve";
}

export interface BrowserHostnamePolicy {
	allowedHostnames?: string[];
	deniedHostnames?: string[];
}

/** Self-improvement gates */
export interface SelfImprovementPolicy {
	memoryAppend?: "auto" | "approval-required";
	skillRefUpdate?: "auto" | "pr-required" | "pr-and-approval";
	newSkill?: "pr-required" | "pr-and-approval";
	cronJob?: "auto" | "approval-required";
	configChange?: "auto" | "approval-required";
}

/** Daily/operational budget caps */
export interface TediBudgets {
	dailyTokenLimit?: number;
	dailyMessageLimit?: number;
	operatorTokenReserve?: number;
	operatorMessageReserve?: number;
	governedLearningTokenReserve?: number;
	governedLearningMessageReserve?: number;
	maxCronJobs?: number;
	maxIterationsPerTask?: number;
	browserBudgetDaily?: number;
}

/** Notification quiet hours */
export interface QuietHours {
	start?: string;
	end?: string;
	timezone?: string;
	emergencyOverride?: boolean;
}

/** Channel configuration (Telegram, Signal, Voice) */
export interface TelegramGroupConfig {
	groupPolicy?: "open" | "allowlist" | "disabled";
	requireMention?: boolean;
	allowFrom?: string[];
	enabled?: boolean;
}

export interface TelegramChannelConfig {
	enabled: boolean;
	botToken?: string;
	botUsername?: string;
	botId?: string;
	dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
	allowFrom?: string[];
	groupPolicy?: "open" | "allowlist" | "disabled";
	groupAllowFrom?: string[];
	groups?: Record<string, TelegramGroupConfig>;
	requireMention?: boolean;
}

export interface SignalChannelConfig {
	enabled: boolean;
	account?: string;
	cliPath?: string;
	httpUrl?: string;
	dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
	allowFrom?: string[];
	groupPolicy?: "open" | "allowlist" | "disabled";
	groupAllowFrom?: string[];
	autoStart?: boolean;
	startupTimeoutMs?: number;
	receiveMode?: "native" | "json-rpc";
}

export interface VoiceChannelConfig {
	enabled: boolean;
	/** E.164 numbers allowed to call inbound (e.g. ["+15555550100"]) */
	allowFrom?: string[];
	/** Inbound greeting text spoken when a call connects */
	inboundGreeting?: string;
	/** Inbound policy: "allowlist" (default), "open", "disabled" */
	inboundPolicy?: "allowlist" | "open" | "disabled";
	/** Default outbound mode: "conversation" (multi-turn) or "notify" (one-shot) */
	outboundMode?: "conversation" | "notify";
}

export interface ChannelsConfig {
	[key: string]: unknown;
	telegram?: TelegramChannelConfig;
	signal?: SignalChannelConfig;
	voice?: VoiceChannelConfig;
}

/** Cron job configuration */
export interface CronJobConfig {
	name: string;
	schedule: string;
	enabled: boolean;
}

/** Repository configuration for coding agent workloads */
export interface RepoConfig {
	repoUrl: string;
	branch?: string;
	githubRepositoryId?: number;
	githubInstallationId?: number;
	githubAppEnabled?: boolean;
	/** Optional body-specific clone/work location. Workstations derive their own path from repoUrl. */
	worktreePath?: string;
}

/**
 * Per-tedi governance override — a nullable JSON column that wins over the
 * policy pack governance when set. Shape is intentionally extensible; currently
 * only `requiresApproval` is recognized by `deriveRequiresApproval`.
 * Applied by the CTO (or any platform-admin) via `updateTediGovernance`.
 * Cleared (set to null) to revert to pack-derived governance.
 */
export interface TediGovernanceOverride {
	requiresApproval?: boolean;
}

/** Serializable backup handle from Sandbox SDK */
export interface DirectoryBackupHandle {
	id: string;
	dir: string;
}

/** Combined runtime backup handles stored in D1 for sleep/wake. */
export interface BackupHandles {
	runtime?: DirectoryBackupHandle;
	workspace?: DirectoryBackupHandle;
	createdAt: string;
}

// =============================================================================
// TEDIS TABLE
// =============================================================================

export const tedis = sqliteTable(
	"tedis",
	{
		id: text("id").primaryKey(),

		// Organization ownership (multi-tenant)
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		// Ownership
		ownerUserId: text("owner_user_id"), // Descope user ID for personal tedis
		scope: text("scope", {
			enum: ["personal", "organization"],
		}).default("personal"),

		// Identity
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		displayName: text("display_name"), // Friendly name like "Tedi"
		descopeUserId: text("descope_user_id"), // Descope user ID (V2 auth — tedi as first-class identity)
		descopeMcpResourceId: text("descope_mcp_resource_id"), // Descope AIH MCP Server ID for per-tedi OAuth
		externalRef: text("external_ref"), // Customer-owned worker ID from external systems
		tags: text("tags", { mode: "json" }).$type<string[]>(), // Lightweight labels for filtering/slicing
		personality: text("personality"), // SOUL.md content
		avatar: text("avatar"), // URL or emoji
		timezone: text("timezone"),
		language: text("language"),

		// Extensions (JSON arrays)
		installedSkills: text("installed_skills", { mode: "json" }).$type<
			string[]
		>(),
		installedPlugins: text("installed_plugins", { mode: "json" }).$type<
			string[]
		>(),

		// Retirement (soft delete). `tedis.delete` retires the worker instead of
		// destroying its row: every tediId-scoped FK is ON DELETE CASCADE, so a
		// real DELETE takes memory_facts, tedi_rationale_records, tedi_artifacts,
		// tedi_runtime_events, skill_entries/runs, tedi_expertise,
		// tedi_growth_snapshots and tedi_entrustment_grants with it — the exact
		// customer-owned cognitive state that must survive.
		// Retiring keeps the parent row alive so the cascade never fires and the
		// memory stays queryable by tediId.
		retiredAt: text("retired_at"),
		// The slug the worker answered to before retirement. Retirement renames
		// `slug` (both `uniq_tedi_slug` and `uniq_tedi_org_slug` are permanent
		// uniqueness, and the retired row now holds its name forever) so a
		// replacement worker can reuse the name; this column keeps the original
		// identity readable for audit and recovery.
		retiredSlug: text("retired_slug"),

		// Deployment info
		status: text("status", {
			enum: [...TEDI_STATUS_VALUES],
		}).default("provisioning"),
		billingState: text("billing_state", {
			enum: [...TEDI_BILLING_STATE_VALUES],
		}).default("cold"),
		workerName: text("worker_name"), // CF Worker deployment name
		r2BucketName: text("r2_bucket_name"), // R2 bucket for this tedi's data

		// MCP capability profile — determines which scope groups this tedi gets
		mcpCapabilityProfile: text("mcp_capability_profile", {
			enum: [...MCP_CAPABILITY_PROFILE_VALUES],
		})
			.notNull()
			.default("standard"),

		// Governance config (JSON columns)
		toolPolicy: text("tool_policy", { mode: "json" }).$type<ToolPolicy>(),
		selfImprovementPolicy: text("self_improvement_policy", {
			mode: "json",
		}).$type<SelfImprovementPolicy>(),
		budgets: text("budgets", { mode: "json" }).$type<TediBudgets>(),
		quietHours: text("quiet_hours", { mode: "json" }).$type<QuietHours>(),
		/**
		 * Per-tedi governance override. When set, the `requiresApproval` field
		 * wins over the policy pack governance in `deriveRequiresApproval`. This
		 * lets a delegated CTO flip a gated tedi to autonomous (or back) without
		 * mutating shared policy packs. Set via `updateTediGovernance`.
		 * Null means "no override — fall through to policy pack".
		 */
		governanceOverride: text("governance_override", {
			mode: "json",
		}).$type<TediGovernanceOverride>(),

		// Control plane references (optional — falls back to system defaults when null)
		runtimeProfileId: text("runtime_profile_id").references(
			() => runtimeProfiles.id,
			{ onDelete: "set null" },
		),
		policyPackId: text("policy_pack_id").references(() => policyPacks.id, {
			onDelete: "set null",
		}),
		workspaceTemplateSetId: text("workspace_template_set_id").references(
			() => workspaceTemplateSets.id,
			{ onDelete: "set null" },
		),

		// Per-tedi runtime override payload.
		runtimeOverrides: text("runtime_overrides", {
			mode: "json",
		}).$type<Record<string, JsonValue>>(),

		// Channel config
		channels: text("channels", { mode: "json" }).$type<ChannelsConfig>(),

		// Cron jobs config
		cronJobs: text("cron_jobs", { mode: "json" }).$type<CronJobConfig[]>(),

		// Repository config (coding agent workload)
		repoConfig: text("repo_config", { mode: "json" }).$type<RepoConfig>(),

		// Runtime state tier (active/standby/archived)
		runtimeState: text("runtime_state", {
			enum: [...RUNTIME_STATE_VALUES],
		})
			.notNull()
			.default("standby"),

		// Idle detection signals
		lastActivityAt: text("last_activity_at"), // Last meaningful activity timestamp
		lastHeartbeatAt: text("last_heartbeat_at"), // Last runtime heartbeat
		idleSince: text("idle_since"), // When the tedi became idle

		// Runtime status updated by heartbeat from the tedi Worker.
		runtimeStatus: text("runtime_status", {
			enum: [...RUNTIME_STATUS_VALUES],
		}).default("unknown"),
		// Runtime binary version is observed live and persisted to
		// tedi_runtime_snapshots; tedis rows do not store it.
		lastSeenAt: text("last_seen_at"),
		lastSyncAt: text("last_sync_at"),
		lastSyncResult: text("last_sync_result", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		lastBackupHandles: text("last_backup_handles", {
			mode: "json",
		}).$type<BackupHandles>(),

		// Runtime placement ID (persisted across Worker isolate recycles).
		// Physical column stays placement_id for the current production table.
		placementId: text("placement_id"),

		// Ephemeral runtime body generation. The tedi row is durable; the
		// Cloudflare DO/Sandbox/container generation is replaceable and must prove
		// possession of this short-lived credential before being considered ready.
		bodyGenerationId: text("body_generation_id"),
		bodyGenerationKind: text("body_generation_kind", {
			enum: [...BODY_KIND_VALUES],
		}),
		bodyGenerationStatus: text("body_generation_status", {
			enum: [...BODY_GENERATION_STATUS_VALUES],
		}),
		bodyGenerationTokenHash: text("body_generation_token_hash"),
		bodyGenerationTokenExpiresAt: text("body_generation_token_expires_at"),
		bodyGenerationExternalId: text("body_generation_external_id"),
		bodyGenerationHeartbeatAt: text("body_generation_heartbeat_at"),

		// Runtime kind. All tedis use the Cloudflare Agents with native Pi Agent runtime;
		// workstation capability is an additive lease, not a runtime kind.
		runtimeKind: text("runtime_kind", {
			enum: ["agent"],
		})
			.notNull()
			.default("agent"),

		// DO instance name for Agent-runtime tedis. Derived from slug when null.
		isolateAgentId: text("isolate_agent_id"),

		// Timestamps
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		unique("uniq_tedi_org_slug").on(table.organizationId, table.slug),
		unique("uniq_tedi_slug").on(table.slug),
		index("idx_tedis_org").on(table.organizationId),
		index("idx_tedis_slug").on(table.slug),
		index("tedis_descope_user_id_idx").on(table.descopeUserId),
		uniqueIndex("tedis_body_generation_token_hash_idx").on(
			table.bodyGenerationTokenHash,
		),
	],
);

export type Tedi = typeof tedis.$inferSelect;
export type NewTedi = typeof tedis.$inferInsert;

// =============================================================================
// TEDI CUSTOM DOMAINS TABLE
// =============================================================================

export const CUSTOM_DOMAIN_STATUS_VALUES = [
	"pending",
	"active",
	"error",
] as const;
export type CustomDomainStatus = (typeof CUSTOM_DOMAIN_STATUS_VALUES)[number];

export const tediCustomDomains = sqliteTable(
	"tedi_custom_domains",
	{
		id: text("id").primaryKey(),

		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),

		hostname: text("hostname").notNull(), // e.g. "ai.acme.com"
		status: text("status", {
			enum: [...CUSTOM_DOMAIN_STATUS_VALUES],
		}).default("pending"),
		sslStatus: text("ssl_status", {
			enum: [...CUSTOM_DOMAIN_STATUS_VALUES],
		}).default("pending"),

		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		unique("uniq_custom_domain_hostname").on(table.hostname),
		index("idx_custom_domains_tedi").on(table.tediId),
	],
);

export type TediCustomDomain = typeof tediCustomDomains.$inferSelect;
export type NewTediCustomDomain = typeof tediCustomDomains.$inferInsert;

// =============================================================================
// TEDI DEVICES TABLE
// =============================================================================

export const tediDevices = sqliteTable(
	"tedi_devices",
	{
		id: text("id").primaryKey(),

		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),

		deviceId: text("device_id").notNull(),
		displayName: text("display_name"),
		platform: text("platform"),
		channel: text("channel"), // telegram | signal | voice | webchat
		status: text("status", {
			enum: [...DEVICE_STATUS_VALUES],
		}).default("pending"),

		pairedAt: text("paired_at"),
		revokedAt: text("revoked_at"),
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [index("idx_tedi_devices_status").on(table.tediId, table.status)],
);

export type TediDevice = typeof tediDevices.$inferSelect;
export type NewTediDevice = typeof tediDevices.$inferInsert;

// =============================================================================
// TEDI RUNTIME PROJECTION TABLES
// =============================================================================

/**
 * Runtime snapshot projected from tedi runtime into D1.
 * This is the "observed state" view used by control plane dashboards and reconcilers.
 */
export const tediRuntimeSnapshots = sqliteTable(
	"tedi_runtime_snapshots",
	{
		id: text("id").primaryKey(),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		source: text("source").notNull().default("tedi-runtime-admin"),
		runtimeStatus: text("runtime_status"),
		runtimeVersion: text("runtime_version"),
		channelStatus: text("channel_status", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		deviceStatus: text("device_status", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		observedAt: text("observed_at").notNull(),
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_tedi_runtime_snapshots_observed").on(
			table.tediId,
			table.observedAt,
		),
	],
);

export type TediRuntimeSnapshot = typeof tediRuntimeSnapshots.$inferSelect;
export type NewTediRuntimeSnapshot = typeof tediRuntimeSnapshots.$inferInsert;

/**
 * Short-lived runtime coordination leases.
 *
 * Used for cross-isolate lifecycle coalescing where per-Worker in-memory maps
 * are not sufficient. Leases are updated in place and expire by timestamp; no
 * cleanup job is required for the small bounded keyspace.
 */
export const tediRuntimeLeases = sqliteTable(
	"tedi_runtime_leases",
	{
		id: text("id").primaryKey(),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		owner: text("owner").notNull(),
		expiresAt: integer("expires_at").notNull(),
		createdAt: text("created_at")
			.default(sql`(CURRENT_TIMESTAMP)`)
			.notNull(),
		updatedAt: text("updated_at")
			.default(sql`(CURRENT_TIMESTAMP)`)
			.notNull(),
	},
	(table) => [
		unique("tedi_runtime_leases_scope_unique").on(table.tediId, table.name),
		index("idx_tedi_runtime_leases_tedi").on(table.tediId),
		index("idx_tedi_runtime_leases_expires").on(table.expiresAt),
	],
);

export type TediRuntimeLease = typeof tediRuntimeLeases.$inferSelect;
export type NewTediRuntimeLease = typeof tediRuntimeLeases.$inferInsert;

/**
 * Immutable usage ledger for runtime billing.
 * Events can be emitted by runtime, reconciler, or billing normalizer jobs.
 */
export const tediUsageEvents = sqliteTable(
	"tedi_usage_events",
	{
		id: text("id").primaryKey(),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		eventType: text("event_type").notNull(), // runtime_active | runtime_idle | invocation | sync
		startedAt: text("started_at").notNull(),
		endedAt: text("ended_at"),
		durationMs: integer("duration_ms"),
		units: real("units"), // optional normalized usage units
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_tedi_usage_events_window").on(table.tediId, table.startedAt),
	],
);

export type TediUsageEvent = typeof tediUsageEvents.$inferSelect;
export type NewTediUsageEvent = typeof tediUsageEvents.$inferInsert;

/**
 * Per-call cost ledger — one row per AI Gateway log entry. Ingested directly
 * from the Cloudflare AI Gateway Logs REST API (tedix-llm-production,
 * tedix-voice-production) by `apps/api/src/jobs/gateway-cost-ingestion.ts`.
 * Powers the get_tedi_usage/get_org_usage/cost-drilldown/billing-ledger APIs.
 */
export const tediCallCosts = sqliteTable(
	"tedi_call_costs",
	{
		id: text("id").primaryKey(),
		tediId: text("tedi_id").references(() => tedis.id, {
			onDelete: "cascade",
		}), // null for kernel-only/unattributed gateway log rows
		// Direct from the gateway log's own cf-aig-metadata (not a tedis join) --
		// the only attribution path for kernel-only rows, which have no tediId.
		// ENFORCED AT THE DB LEVEL (outside Drizzle's declarative schema -- D1/
		// SQLite can't add a CHECK constraint to an existing table without a
		// full rebuild, so this lives as a trigger instead, declared by
		// `drizzle/20260825174735_declare_tedi_call_costs_org_id_trigger`): a BEFORE INSERT trigger
		// `require_org_id_for_attributed_calls` rejects any row with
		// sessionType IN ('tedi','tedi_observer','kernel') and orgId NULL. Only
		// `sessionType = 'unattributed'` rows may legitimately have a null
		// orgId. If a future insert starts failing with
		// SQLITE_CONSTRAINT_TRIGGER referencing this trigger, that means a code
		// path is generating a gateway call with tediId/kernel-surface metadata
		// but no orgId -- fix the caller, don't touch the trigger.
		orgId: text("org_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),

		// Stable identity of the source AI Gateway log row — the dedupe key.
		gatewayLogId: text("gateway_log_id").notNull(),
		// Which gateway the row was ingested from (tedix-llm-production | tedix-voice-production).
		gatewayId: text("gateway_id").notNull(),

		snapshotAt: text("snapshot_at").notNull(), // gateway log row's created_at

		// Model identification
		model: text("model").notNull(),
		provider: text("provider"),
		providerResource: text("provider_resource"),
		providerBaseUrl: text("provider_base_url"),
		deployment: text("deployment"),

		// Attribution
		runId: text("run_id"),
		workItemId: text("work_item_id"),
		billingReservationId: text("billing_reservation_id"),
		sessionKeyHash: text("session_key_hash"),
		sessionType: text("session_type", {
			enum: ["tedi", "tedi_observer", "kernel", "unattributed"],
		})
			.notNull()
			.default("unattributed"),
		source: text("source").notNull().default("ai-gateway-log"),

		// Provider-specific non-token usage carried in one compact Gateway
		// metadata envelope. These units remain cost evidence only until a
		// versioned customer price explicitly enables metering.
		usageKind: text("usage_kind"),
		usageUnit: text("usage_unit"),
		usageQuantity: integer("usage_quantity"),

		// Token counts for this single call
		inputTokens: integer("input_tokens").notNull().default(0),
		outputTokens: integer("output_tokens").notNull().default(0),
		cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
		cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
		totalTokens: integer("total_tokens").notNull().default(0),

		// Cost for this single call
		estimatedCostUsd: real("estimated_cost_usd"),
		executionId: text("provider_execution_id"),
		// Monotonic duration of one admitted provider call, including admission
		// and response parsing. Null for historical and gateway-ingested rows.
		callDurationMs: real("call_duration_ms"),
		rawReportedCostUsd: real("raw_reported_cost_usd"),
		rateVersionId: text("provider_rate_version_id"),
		costBasis: text("cost_basis", {
			enum: [
				"gateway_reported",
				"governed_estimate",
				"legacy_estimate",
				"unknown",
			],
		})
			.notNull()
			.default("legacy_estimate"),
		costReason: text("cost_reason"),

		// Always 1 — one gateway log row = one call, not a session-delta bucket.
		sessionCount: integer("session_count").notNull().default(0),

		// Carried straight from the gateway log row.
		success: integer("success", { mode: "boolean" }).notNull().default(true),
		cached: integer("cached", { mode: "boolean" }).notNull().default(false),
		// Visibility flag for rows whose cost couldn't be computed/trusted —
		// excluded from spend totals but still recorded.
		dataQuality: text("data_quality", {
			enum: ["ok", "quarantined_no_pricing", "quarantined_failed"],
		})
			.notNull()
			.default("ok"),

		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_call_costs_org").on(table.orgId, table.snapshotAt),
		index("idx_call_costs_window").on(table.tediId, table.snapshotAt),
		index("idx_call_costs_model").on(
			table.tediId,
			table.model,
			table.snapshotAt,
		),
		index("idx_call_costs_source").on(
			table.tediId,
			table.source,
			table.snapshotAt,
		),
		index("idx_call_costs_run").on(table.runId, table.snapshotAt),
		index("idx_call_costs_work_item").on(table.workItemId, table.snapshotAt),
		index("idx_call_costs_billing_reservation").on(table.billingReservationId),
		uniqueIndex("idx_call_costs_gateway_log_id").on(table.gatewayLogId),
	],
);

export type TediCallCost = typeof tediCallCosts.$inferSelect;
export type NewTediCallCost = typeof tediCallCosts.$inferInsert;

/**
 * Gateway log ingestion cursor — one row per AI Gateway, tracking the last
 * successfully-ingested log row so the periodic ingestion job resumes forward
 * without reprocessing or double-counting.
 */
export const gatewayLogIngestionCursors = sqliteTable(
	"gateway_log_ingestion_cursors",
	{
		gatewayId: text("gateway_id").primaryKey(),
		lastLogCreatedAt: text("last_log_created_at").notNull(),
		lastLogId: text("last_log_id").notNull(),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
);

export type GatewayLogIngestionCursor =
	typeof gatewayLogIngestionCursors.$inferSelect;
export type NewGatewayLogIngestionCursor =
	typeof gatewayLogIngestionCursors.$inferInsert;
