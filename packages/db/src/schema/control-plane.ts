import type { ModelCatalogConfig } from "@tedix/api-contract/schemas/model-catalog-config";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { ModelGenerationPolicy } from "@tedix/api-contract/schemas/model-generation";
import { sql } from "drizzle-orm";
import {
	type AnySQLiteColumn,
	index,
	integer,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
import { uuid4Default } from "./_sql-helpers";
import { organizations } from "./organizations";

export const CONTROL_PLANE_SCOPE_VALUES = ["system", "organization"] as const;
export type ControlPlaneScope = (typeof CONTROL_PLANE_SCOPE_VALUES)[number];

export const CONTROL_PLANE_STATUS_VALUES = [
	"draft",
	"active",
	"archived",
] as const;
export type ControlPlaneStatus = (typeof CONTROL_PLANE_STATUS_VALUES)[number];

export const POLICY_PACK_TARGET_VALUES = ["tedi", "app", "shared"] as const;
export type PolicyPackTarget = (typeof POLICY_PACK_TARGET_VALUES)[number];

export interface TtsPolicy {
	auto?: "off" | "always" | "inbound" | "tagged";
	provider?: "azure-openai" | "gradium" | "kugel" | "openai";
	voiceId?: string;
	modelId?: string;
	languageCode?: string;
	voice?: string;
	ttsDeployment?: string;
	realtimeDeployment?: string;
	sttApiVersion?: string;
	sttDeployment?: string;
	sttFallbackDeployment?: string;
	voiceSettings?: {
		stability?: number;
		similarityBoost?: number;
		style?: number;
		speed?: number;
	};
}

/**
 * Evolution strategy governs how a tedi allocates effort between innovation,
 * optimization, and repair.
 * - "balanced" — 50% innovation, 30% optimization, 20% repair (default for new tedis)
 * - "harden"  — 20% innovation, 40% optimization, 40% repair (production steady-state)
 * - "repair-only" — 0% innovation, 20% optimization, 80% repair (incident recovery)
 */
export type EvolutionStrategy = "balanced" | "harden" | "repair-only";

/**
 * Chat/reasoning model selection for a runtime profile — the config-driven home
 * for per-role model choice (e.g. kernel=cheap/fast, CTO=full-power, CFO=small).
 * Each ref is a `provider/model-id` ref validated against the cognition
 * model catalog: `azure-openai/gpt-5.6-terra` (Azure credits) or
 * `workers-ai/@cf/meta/llama-3.1-8b-instruct` (Cloudflare credits). Absent → the
 * runtime's env default. Switching a role's provider is a one-field change here.
 *
 * Every stored policy carries explicit chat, cron, and observer refs. The
 * migration to the adaptive default backfilled missing slots before the
 * optional-field compatibility path was removed. The distinct slots exist because
 * scheduled background work (cognitive crons) and the post-turn observer are a
 * large share of token spend and tolerate a smaller model, while the SAME tedi
 * must keep a frontier model for interactive turns.
 */
export interface ModelPolicy {
	/** Explicit per-round settings for ordinary chat and scheduled turns. */
	generation?: ModelGenerationPolicy;
	/** Interactive/default chat ref for the role. */
	chatModelRef: string;
	/** Tool-free workflow reviews. Absent preserves the interactive model. */
	synthesisModelRef?: string;
	/** Scheduled (cron / trusted-scheduler) turns. Absent → `chatModelRef`. */
	cronModelRef: string;
	/**
	 * Post-turn observer + reflector. Absent → the runtime's observer env
	 * default. Deliberately does NOT inherit `chatModelRef`: the observer path
	 * has always had its own deployment that `chatModelRef` never steered.
	 */
	observerModelRef: string;
}

export interface RuntimeProfileConfig {
	[key: string]: JsonValue | undefined;
	/** Stored as JSON; read via `config.modelPolicy as ModelPolicy | undefined`. */
	modelPolicy?: JsonValue;
	pluginPolicy?: JsonValue;
	channelPolicy?: JsonValue;
	runtimePolicy?: JsonValue;
	ttsPolicy?: JsonValue;
	evolutionStrategy?: EvolutionStrategy;
}

export interface PolicyPackDefinition {
	/** Ownerless system/shared publication only; tenant policies cannot define model authority. */
	modelCatalog?: ModelCatalogConfig;
	[key: string]: JsonValue | undefined;
	missionPolicy?: JsonValue;
	governancePolicy?: JsonValue;
	cronPolicy?: JsonValue;
	gatingPolicy?: JsonValue;
	assignmentPolicy?: JsonValue;
	catalogPolicy?: JsonValue;
	promptPolicy?: JsonValue;
	/**
	 * Pace-layer-scaled governance (flywheel remodel WS6): per strategic layer
	 * (`skill_entries.pace_layer`), how much rigor mutations/promotions carry.
	 * Resolved against DEFAULT_PACE_LAYER_POLICY via `resolvePaceLayerPolicy()`.
	 *
	 * ENFORCED TODAY: `record.approvalRequired` — content/workflow mutations to
	 * record-layer (crystallized) skills by agent-authenticated callers are
	 * rejected in `skills.improve` (apps/api cognitive router); human users and
	 * operator API keys pass (capability-mutation-gate allowlist doctrine).
	 * `evalRequired` gates promotion/layer moves against revision-pinned skill
	 * run certification; `draftTtlDays` controls the per-layer draft sweep.
	 * Both are enforced in the db skill lifecycle query owners.
	 */
	paceLayerPolicy?: {
		innovation?: PaceLayerGovernance;
		differentiation?: PaceLayerGovernance;
		record?: PaceLayerGovernance;
	};
	/**
	 * Org-level default scope patterns for the MCP tool-approval grant layer
	 * (`packages/db/src/schema/mcp-governance.ts`,
	 * `apps/mcp/src/mcp/governance.ts`'s `requireDestructiveToolApproval`).
	 * Shape mirrors `decideKernelWriteApproval`'s `writeTier.trustedTools`
	 * allowlist for a consistent mental model — `"{appSlug}:{toolId}"` exact,
	 * `"{appSlug}:*"` app-wide, or `"*:*"` global — but this is a DIFFERENT
	 * trust boundary (raw `tools/call`, not kernel write proposals) and reuses
	 * only the pattern shape, not the kernel's allowlist machinery.
	 *
	 * ADDITIVE, UNWIRED as of this field's introduction: no code path reads
	 * this key yet. It is a documented slot for a follow-up that would resolve
	 * it into an org-wide default grant (or auto-create one) instead of
	 * requiring a per-subject `createGrant` call for every tedi/user. Until
	 * that follow-up lands, setting this field has NO effect on approval
	 * behavior — the gate only ever consults `mcp_tool_approval_grants` rows.
	 */
	approvalPolicy?: {
		autoApprove?: string[];
	};
	voicePolicy?: {
		enabled: boolean;
		maxOutboundCallsPerDay: number;
		maxCallDurationMinutes: number;
		inboundPolicy: "disabled" | "allowlist" | "open";
		provider?: "azure-openai" | "gradium" | "kugel" | "openai";
		allowedOutboundPatterns?: string[];
		defaultGreeting?: string;
		ttsVoice?: string;
		azureVoice?: string;
		ttsDeployment?: string;
		realtimeDeployment?: string;
		realtimeApiVersion?: string;
		sttApiVersion?: string;
		sttDeployment?: string;
		sttFallbackDeployment?: string;
		silenceTimeoutMs?: number;
		vadThreshold?: number;
		silenceDurationMs?: number;
	};
}

/**
 * Per-layer governance knobs inside PolicyPackDefinition.paceLayerPolicy.
 * (A type alias, not an interface, so it stays assignable to the definition's
 * JsonValue index signature.)
 */
export type PaceLayerGovernance = {
	/** Mutations to skills in this layer by agent-authenticated callers require human/operator approval. */
	approvalRequired?: boolean;
	/** Promotions into/within this layer require a passing eval for the skill revision. */
	evalRequired?: boolean;
	/** Draft inactivity TTL for this layer in days; the global sweep default applies when unset. */
	draftTtlDays?: number;
};

export type ResolvedPaceLayerPolicy = Record<
	"innovation" | "differentiation" | "record",
	Required<Pick<PaceLayerGovernance, "approvalRequired" | "evalRequired">> &
		Pick<PaceLayerGovernance, "draftTtlDays">
>;

/**
 * GAIE three-tier default: innovation = automated-with-monitoring (light
 * gates, TTL discipline), differentiation = human-over-the-loop (approval +
 * eval on promotion), record = human-in-the-loop (mutation requires
 * approval + regression eval).
 */
export const DEFAULT_PACE_LAYER_POLICY: ResolvedPaceLayerPolicy = {
	innovation: {
		approvalRequired: false,
		evalRequired: false,
		draftTtlDays: 14,
	},
	differentiation: { approvalRequired: true, evalRequired: true },
	record: { approvalRequired: true, evalRequired: true },
};

/** Merge a policy pack's paceLayerPolicy over the platform defaults. */
export function resolvePaceLayerPolicy(
	definition?: PolicyPackDefinition | null,
): ResolvedPaceLayerPolicy {
	const overrides = definition?.paceLayerPolicy;
	return {
		innovation: {
			...DEFAULT_PACE_LAYER_POLICY.innovation,
			...overrides?.innovation,
		},
		differentiation: {
			...DEFAULT_PACE_LAYER_POLICY.differentiation,
			...overrides?.differentiation,
		},
		record: { ...DEFAULT_PACE_LAYER_POLICY.record, ...overrides?.record },
	};
}

export interface WorkspaceTemplateSetDefinition {
	[key: string]: JsonValue | undefined;
	files?: JsonValue;
	variables?: JsonValue;
	platformFiles?: JsonValue;
	managedFiles?: string[];
}

export const runtimeProfiles = sqliteTable(
	"runtime_profiles",
	{
		id: text("id").primaryKey().default(uuid4Default()),
		organizationId: text("organization_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		description: text("description"),
		scope: text("scope", { enum: CONTROL_PLANE_SCOPE_VALUES })
			.notNull()
			.default("organization"),
		status: text("status", { enum: CONTROL_PLANE_STATUS_VALUES })
			.notNull()
			.default("draft"),
		version: integer("version").notNull().default(1),
		/** Prior revision in this `(scope, slug)` family. Null at the retained root. */
		supersedesRevisionId: text("supersedes_revision_id").references(
			(): AnySQLiteColumn => runtimeProfiles.id,
			{ onDelete: "restrict" },
		),
		/** Older revision whose snapshot was restored by this revision. */
		rollbackOfRevisionId: text("rollback_of_revision_id").references(
			(): AnySQLiteColumn => runtimeProfiles.id,
			{ onDelete: "restrict" },
		),
		changeSummary: text("change_summary"),
		publishedAt: text("published_at"),
		publishedBy: text("published_by"),
		config: text("config", { mode: "json" })
			.$type<RuntimeProfileConfig>()
			.notNull(),
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		unique("uniq_runtime_profiles_scope_slug_version").on(
			table.scope,
			table.slug,
			table.version,
		),
		index("idx_runtime_profiles_org").on(table.organizationId),
		index("idx_runtime_profiles_status").on(table.status),
		index("idx_runtime_profiles_family").on(
			table.scope,
			table.slug,
			table.version,
		),
	],
);

export const policyPacks = sqliteTable(
	"policy_packs",
	{
		id: text("id").primaryKey().default(uuid4Default()),
		organizationId: text("organization_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		description: text("description"),
		scope: text("scope", { enum: CONTROL_PLANE_SCOPE_VALUES })
			.notNull()
			.default("organization"),
		target: text("target", { enum: POLICY_PACK_TARGET_VALUES })
			.notNull()
			.default("shared"),
		status: text("status", { enum: CONTROL_PLANE_STATUS_VALUES })
			.notNull()
			.default("draft"),
		version: integer("version").notNull().default(1),
		supersedesRevisionId: text("supersedes_revision_id").references(
			(): AnySQLiteColumn => policyPacks.id,
			{ onDelete: "restrict" },
		),
		rollbackOfRevisionId: text("rollback_of_revision_id").references(
			(): AnySQLiteColumn => policyPacks.id,
			{ onDelete: "restrict" },
		),
		changeSummary: text("change_summary"),
		publishedAt: text("published_at"),
		publishedBy: text("published_by"),
		definition: text("definition", { mode: "json" })
			.$type<PolicyPackDefinition>()
			.notNull(),
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		unique("uniq_policy_packs_scope_slug_version").on(
			table.scope,
			table.slug,
			table.version,
		),
		index("idx_policy_packs_org").on(table.organizationId),
		index("idx_policy_packs_status").on(table.status),
		index("idx_policy_packs_target").on(table.target),
		index("idx_policy_packs_family").on(table.scope, table.slug, table.version),
	],
);

export const workspaceTemplateSets = sqliteTable(
	"workspace_template_sets",
	{
		id: text("id").primaryKey().default(uuid4Default()),
		organizationId: text("organization_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		description: text("description"),
		scope: text("scope", { enum: CONTROL_PLANE_SCOPE_VALUES })
			.notNull()
			.default("organization"),
		status: text("status", { enum: CONTROL_PLANE_STATUS_VALUES })
			.notNull()
			.default("draft"),
		version: integer("version").notNull().default(1),
		supersedesRevisionId: text("supersedes_revision_id").references(
			(): AnySQLiteColumn => workspaceTemplateSets.id,
			{ onDelete: "restrict" },
		),
		rollbackOfRevisionId: text("rollback_of_revision_id").references(
			(): AnySQLiteColumn => workspaceTemplateSets.id,
			{ onDelete: "restrict" },
		),
		changeSummary: text("change_summary"),
		publishedAt: text("published_at"),
		publishedBy: text("published_by"),
		templates: text("templates", { mode: "json" })
			.$type<WorkspaceTemplateSetDefinition>()
			.notNull(),
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		unique("uniq_workspace_template_sets_scope_slug_version").on(
			table.scope,
			table.slug,
			table.version,
		),
		index("idx_workspace_template_sets_org").on(table.organizationId),
		index("idx_workspace_template_sets_status").on(table.status),
		index("idx_workspace_template_sets_family").on(
			table.scope,
			table.slug,
			table.version,
		),
	],
);

export type RuntimeProfile = typeof runtimeProfiles.$inferSelect;
export type NewRuntimeProfile = typeof runtimeProfiles.$inferInsert;

export type PolicyPack = typeof policyPacks.$inferSelect;
export type NewPolicyPack = typeof policyPacks.$inferInsert;

export type WorkspaceTemplateSet = typeof workspaceTemplateSets.$inferSelect;
export type NewWorkspaceTemplateSet = typeof workspaceTemplateSets.$inferInsert;

/** Shape of a single cron template inside PolicyPackDefinition.cronPolicy.cronTemplates */
export interface PolicyPackCronTemplate {
	name: string;
	/** Cron expression string e.g. "0 *\/8 * * *" (every 8 hours) */
	schedule: string;
	/** Optional stagger in milliseconds to spread cron load */
	staggerMs?: number;
	event: string;
	message: string;
	/** v2026.4.1: per-job tool allowlist — scopes which tools the cron job can use */
	tools?: string[];
}

/** Shape of cronPolicy field inside PolicyPackDefinition */
export interface CronPolicy {
	cronTemplates?: PolicyPackCronTemplate[];
	/**
	 * Cron job NAMES the in-session `cron` tool may not remove or replace on
	 * tedis using this pack (watcher/safety-net jobs). Admin-managed here in
	 * D1; enforcement lives in the Agent runtime's cron tool (fail-closed).
	 */
	protectedCronNames?: string[];
	/** Per-tedi overrides may suppress all inherited templates. */
	disableCognitiveDefaults?: boolean;
	/** Per-tedi overrides may suppress inherited templates by name. */
	disabledCognitiveCronNames?: string[];
}

// The system-default record IDs used to be pinned here as three literals, and
// every caller that took the fallback read whichever revision those ids named.
// Publishing a revision mints a NEW id, so the literals went stale the first
// time anyone published: the policy-pack constant still pointed at v26 while
// the live head was v27. Resolution now follows the head of the
// `system-default` slug in D1 — see `getSystemDefaultRuntimeProfile`,
// `getSystemDefaultPolicyPack` and `getSystemDefaultWorkspaceTemplateSet` in
// `queries/control-plane/definitions.ts`. Do not reintroduce a compiled-in id.
