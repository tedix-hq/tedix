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
	 * `evalRequired` and `draftTtlDays` are config plumbing for the follow-up
	 * layer-scaled gates (innovation TTL already runs at the global
	 * SKILL_DRAFT_TTL_DAYS default).
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
	/** Promotions into/within this layer require a passing eval (config plumbing — not yet enforced). */
	evalRequired?: boolean;
	/** Zero-usage draft TTL for this layer in days (config plumbing — the global sweep default applies today). */
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
	/**
	 * Full opt-out of the platform cognitive-cron floor (see
	 * `withCognitiveCronDefaults` in the Agent runtime). When true, a pack runs
	 * only its own `cronTemplates` — a deliberately cron-less / paused / utility
	 * tedi incurs no recurring LLM-turn spend. The floor otherwise re-adds the S4
	 * defaults, so OMITTING templates does NOT disable them; this flag is the
	 * explicit, config-driven way to disable the whole cognitive cycle set.
	 */
	disableCognitiveDefaults?: boolean;
	/**
	 * Partial opt-out: names of individual platform cognitive crons this pack
	 * disables while keeping the remaining floor. A pack's own same-name
	 * `cronTemplates` entry still schedules (pack authority wins).
	 */
	disabledCognitiveCronNames?: string[];
}

/**
 * Cron-template source definitions used by the system-default policy pack and
 * role-specific runtime overrides.
 *
 * The system-default pack receives only the shared cognitive cycles. The CMO
 * `content-operations` loop is deliberately exported separately and belongs in
 * the CMO tedi's runtime override; putting it in the shared pack makes every
 * default-policy tedi execute a marketing procedure under the wrong identity.
 * HEARTBEAT.md is rendered dynamically from these templates via
 * `generateHeartbeatMd(cronTemplates)` in `@tedix/context-core/tedi-workspace`.
 * The `message` field of each template IS the procedure shown in HEARTBEAT.md.
 *
 * Single source of truth: D1 `policy_packs.definition.cronPolicy.cronTemplates`.
 * This array seeds the system-default pack (`d395b649-3a06-43d4-99cc-697340df2ca5`).
 */
/**
 * Code-level source definitions — kept in sync with D1 production.
 * D1 is authoritative at runtime. Shared entries and the role-specific CMO
 * entry must be updated in D1 deliberately; nothing syncs them from this seed.
 */
const PLATFORM_CRON_TEMPLATE_SOURCES: PolicyPackCronTemplate[] = [
	{
		name: "brain-reflection",
		schedule: "0 */8 * * *",
		event: "systemEvent",
		staggerMs: 300000,
		tools: ["code"],
		message: `Use the \`code\` tool through your own credential-bound Code Mode connection. Discover only the capabilities needed for this bounded cycle with discover.search({ query, limit: 3, includeParameters: true }); reuse schemas already present. Call the exact returned callable and validate its required arguments, enum values, and input shapes. Do not assume that another tedi or an operator exposes the same namespaces. Batch dependent reads and writes in one Code Mode program and return a compact result. If a capability is unavailable, report the missing capability and stop that operation; never invent a callable or retry unchanged arguments.

Record the cycle's actual outcome through the discovered rationale capability when available. Supply your real tedi and organization identity and the current runId, workItemId, or toolCallRefs required by its schema. Use a schema-supported category and evidence shape; do not fabricate an execution link. Record failure or partial completion honestly, and claim success only for verified effects.

Brain reflection cycle:
1. Read today's memory log when available and select durable insights, patterns, decisions, and procedures worth preserving.
2. Discover memory learning, reflection, and health capabilities; persist supported insights and consolidate stale or low-confidence facts.
3. Discover gap detection and expertise reads for the relevant domains. Record concrete gaps and the actual cycle outcome.`,
	},
	{
		name: "objective-review",
		schedule: "0 */4 * * *",
		event: "systemEvent",
		staggerMs: 300000,
		tools: ["code"],
		message: `Use the \`code\` tool through your own credential-bound Code Mode connection. Discover only the capabilities needed for this bounded cycle with discover.search({ query, limit: 3, includeParameters: true }); reuse schemas already present. Call the exact returned callable and validate its required arguments, enum values, and input shapes. Do not assume that another tedi or an operator exposes the same namespaces. Batch dependent reads and writes in one Code Mode program and return a compact result. If a capability is unavailable, report the missing capability and stop that operation; never invent a callable or retry unchanged arguments.

Record the cycle's actual outcome through the discovered rationale capability when available. Supply your real tedi and organization identity and the current runId, workItemId, or toolCallRefs required by its schema. Use a schema-supported category and evidence shape; do not fabricate an execution link. Record failure or partial completion honestly, and claim success only for verified effects.

Objective review and rationale closure cycle:
1. Discover active objective and Work Item reads; inspect a bounded set of current objectives and their existing work.
2. Discover recent rationale reads and outcome updates. Close stale pending records only when execution evidence establishes their outcome.
3. For an objective with a concrete uncovered next step, use the discovered Work factory to propose bounded work without duplicating an existing item. Admission and independent review still govern execution and completion.
4. Discover feedback for the brain facts used in these decisions and record the actual review outcome.`,
	},
	{
		name: "content-operations",
		schedule: "0 * * * *",
		event: "systemEvent",
		staggerMs: 300000,
		tools: ["code"],
		message: `Operate the marketing portfolio through the canonical Work factory. Discover only the exact Work tools needed for this cycle. Select by stable projectId, inspect Work Item disposition and derived readiness independently, and start one authoritative attempt only for accepted ready work. Preserve the returned attemptId and immutable executor session fence for every heartbeat, evidence submission, and settlement. Record artifact-neutral evidence against the accepted claims, leave approval to the configured reviewer, and never infer completion from runtime state. If no item is ready, report the explicit readiness reasons and stop without manufacturing work or compatibility identifiers.`,
	},
	{
		name: "app-operations",
		schedule: "0 */6 * * *",
		event: "systemEvent",
		staggerMs: 300000,
		tools: ["code"],
		message: `Use the \`code\` tool through your own credential-bound Code Mode connection. Discover only the capabilities needed for this bounded cycle with discover.search({ query, limit: 3, includeParameters: true }); reuse schemas already present. Call the exact returned callable and validate its required arguments, enum values, and input shapes. Do not assume that another tedi or an operator exposes the same namespaces. Batch dependent reads and writes in one Code Mode program and return a compact result. If a capability is unavailable, report the missing capability and stop that operation; never invent a callable or retry unchanged arguments.

Record the cycle's actual outcome through the discovered rationale capability when available. Supply your real tedi and organization identity and the current runId, workItemId, or toolCallRefs required by its schema. Use a schema-supported category and evidence shape; do not fabricate an execution link. Record failure or partial completion honestly, and claim success only for verified effects.

App operations review:
1. Discover assigned-app reads using your real tedi identity and inspect only your assigned apps.
2. Discover MCP protocol probes, tool-schema synchronization checks, and bounded app telemetry to identify concrete faults.
3. Discover app-tool reads and updates; inspect the current configuration before correcting a demonstrated broken or unclear tool within your authority.
4. Discover skill reads and improvements to capture repeated, verified repair patterns. Record the actual review outcome.`,
	},
	{
		name: "grounding-review",
		schedule: "30 */6 * * *",
		event: "systemEvent",
		staggerMs: 300000,
		tools: ["code"],
		message: `Use the \`code\` tool through your own credential-bound Code Mode connection. Discover only the capabilities needed for this bounded cycle with discover.search({ query, limit: 3, includeParameters: true }); reuse schemas already present. Call the exact returned callable and validate its required arguments, enum values, and input shapes. Do not assume that another tedi or an operator exposes the same namespaces. Batch dependent reads and writes in one Code Mode program and return a compact result. If a capability is unavailable, report the missing capability and stop that operation; never invent a callable or retry unchanged arguments.

Record the cycle's actual outcome through the discovered rationale capability when available. Supply your real tedi and organization identity and the current runId, workItemId, or toolCallRefs required by its schema. Use a schema-supported category and evidence shape; do not fabricate an execution link. Record failure or partial completion honestly, and claim success only for verified effects.

Grounding review and optimization signal processing:
1. Discover recent rationale reads. Inspect a bounded set of high-risk decisions and their supporting evidence.
2. Discover memory optimization backlog capabilities; process a bounded actionable signal and scan for unresolved issues when supported.
3. Convert repeated weak grounding or confidence mismatches into evidence-backed memory updates or skill improvements. Record the actual review outcome.`,
	},
	{
		name: "knowledge-freshness",
		schedule: "0 4 * * *",
		event: "systemEvent",
		staggerMs: 300000,
		tools: ["code"],
		message: `Use the \`code\` tool through your own credential-bound Code Mode connection. Discover only the capabilities needed for this bounded cycle with discover.search({ query, limit: 3, includeParameters: true }); reuse schemas already present. Call the exact returned callable and validate its required arguments, enum values, and input shapes. Do not assume that another tedi or an operator exposes the same namespaces. Batch dependent reads and writes in one Code Mode program and return a compact result. If a capability is unavailable, report the missing capability and stop that operation; never invent a callable or retry unchanged arguments.

Record the cycle's actual outcome through the discovered rationale capability when available. Supply your real tedi and organization identity and the current runId, workItemId, or toolCallRefs required by its schema. Use a schema-supported category and evidence shape; do not fabricate an execution link. Record failure or partial completion honestly, and claim success only for verified effects.

Knowledge freshness and health check:
1. Discover memory and graph health reads, then inspect expertise and recall quality in a relevant domain.
2. Verify suspected stale or incorrect facts before submitting feedback through the discovered capability and its supported signal values.
3. Discover graph maintenance and memory reflection capabilities; run bounded maintenance only when the health evidence warrants it. Record the actual check outcome.`,
	},
	{
		name: "skill-development",
		schedule: "0 5 * * *",
		event: "systemEvent",
		staggerMs: 300000,
		tools: ["code"],
		message: `Use the \`code\` tool through your own credential-bound Code Mode connection. Discover only the capabilities needed for this bounded cycle with discover.search({ query, limit: 3, includeParameters: true }); reuse schemas already present. Call the exact returned callable and validate its required arguments, enum values, and input shapes. Do not assume that another tedi or an operator exposes the same namespaces. Batch dependent reads and writes in one Code Mode program and return a compact result. If a capability is unavailable, report the missing capability and stop that operation; never invent a callable or retry unchanged arguments.

Record the cycle's actual outcome through the discovered rationale capability when available. Supply your real tedi and organization identity and the current runId, workItemId, or toolCallRefs required by its schema. Use a schema-supported category and evidence shape; do not fabricate an execution link. Record failure or partial completion honestly, and claim success only for verified effects.

Skill development and curiosity exploration cycle:
1. Discover skill listing and search capabilities; identify a weak, duplicated, or missing procedure from recent execution evidence.
2. Improve the selected skill or record a demonstrated procedure through its exact schema.
3. Discover recent rationale and curiosity-gap reads; resolve a relevant gap from verified sources and persist the supported learning.
4. Discover muscle-memory crystallization and promote a proven skill only when its success evidence and the capability's prerequisites are satisfied. Record the actual review outcome.`,
	},
	{
		name: "muscle-crystallization",
		schedule: "0 3 * * *",
		event: "systemEvent",
		staggerMs: 300000,
		tools: ["code"],
		message: `Use the \`code\` tool through your own credential-bound Code Mode connection. Discover only the capabilities needed for this bounded cycle with discover.search({ query, limit: 3, includeParameters: true }); reuse schemas already present. Call the exact returned callable and validate its required arguments, enum values, and input shapes. Do not assume that another tedi or an operator exposes the same namespaces. Batch dependent reads and writes in one Code Mode program and return a compact result. If a capability is unavailable, report the missing capability and stop that operation; never invent a callable or retry unchanged arguments.

Record the cycle's actual outcome through the discovered rationale capability when available. Supply your real tedi and organization identity and the current runId, workItemId, or toolCallRefs required by its schema. Use a schema-supported category and evidence shape; do not fabricate an execution link. Record failure or partial completion honestly, and claim success only for verified effects.

Muscle memory crystallization cycle:
1. Discover skill candidates and their execution evidence; select a reliable procedure with strong success evidence.
2. Discover existing muscle memories to avoid duplicates.
3. Discover crystallization or registration only for a qualifying candidate. Use the returned schema's supported kind, origin, and prerequisites; do not guess enum values.
4. Record observed usage regressions and the actual cycle outcome.`,
	},
	{
		name: "growth-snapshot",
		schedule: "0 6 * * 1",
		event: "systemEvent",
		staggerMs: 300000,
		tools: ["code"],
		message: `Use the \`code\` tool through your own credential-bound Code Mode connection. Discover only the capabilities needed for this bounded cycle with discover.search({ query, limit: 3, includeParameters: true }); reuse schemas already present. Call the exact returned callable and validate its required arguments, enum values, and input shapes. Do not assume that another tedi or an operator exposes the same namespaces. Batch dependent reads and writes in one Code Mode program and return a compact result. If a capability is unavailable, report the missing capability and stop that operation; never invent a callable or retry unchanged arguments.

Record the cycle's actual outcome through the discovered rationale capability when available. Supply your real tedi and organization identity and the current runId, workItemId, or toolCallRefs required by its schema. Use a schema-supported category and evidence shape; do not fabricate an execution link. Record failure or partial completion honestly, and claim success only for verified effects.

Weekly growth snapshot:
1. Discover cognitive health and scheduled-cycle health reads for your real tedi identity.
2. Review bounded memory, skill, muscle-memory, rationale, and tool-execution metrics against the previous snapshot.
3. For a verified regression, inspect existing Work Items before proposing a bounded follow-up through the Work factory; preserve its admission and review requirements.
4. Record the measured snapshot and actual outcome so the Growth Timeline stays current.`,
	},
];

/** The CMO-only operating loop. Never seed this into the shared policy pack. */
export const CMO_CONTENT_OPERATIONS_CRON_TEMPLATE =
	PLATFORM_CRON_TEMPLATE_SOURCES.find(
		(template) => template.name === "content-operations",
	) as PolicyPackCronTemplate;

/** Shared system-default templates. Role-specific loops are excluded. */
export const DEFAULT_CRON_TEMPLATES = PLATFORM_CRON_TEMPLATE_SOURCES.filter(
	(template) => template.name !== "content-operations",
);

// The system-default record IDs used to be pinned here as three literals, and
// every caller that took the fallback read whichever revision those ids named.
// Publishing a revision mints a NEW id, so the literals went stale the first
// time anyone published: the policy-pack constant still pointed at v26 while
// the live head was v27. Resolution now follows the head of the
// `system-default` slug in D1 — see `getSystemDefaultRuntimeProfile`,
// `getSystemDefaultPolicyPack` and `getSystemDefaultWorkspaceTemplateSet` in
// `queries/control-plane/definitions.ts`. Do not reintroduce a compiled-in id.
