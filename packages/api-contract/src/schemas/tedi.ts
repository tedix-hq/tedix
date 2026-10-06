/**
 * Tedi Zod Schemas
 * Validation schemas for tedi instance management
 */

import * as z from "zod";
import { ModelGenerationPolicySchema } from "./model-generation";
import { SkillScheduleSchema } from "./cognitive";
import { JsonValueSchema } from "./common";

// =============================================================================
// ENUM SCHEMAS
// =============================================================================

export const TediStatusSchema = z.enum([
	"active",
	"paused",
	"error",
	"provisioning",
]);
export type TediStatus = z.infer<typeof TediStatusSchema>;

export const TediBillingStateSchema = z.enum(["cold", "warm", "active"]);
export type TediBillingState = z.infer<typeof TediBillingStateSchema>;

export const RuntimeStateSchema = z.enum(["active", "standby", "archived"]);
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

export const RuntimeStatusSchema = z.enum([
	"running",
	"sleeping",
	"starting",
	"error",
	"unknown",
]);
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

export const DeviceStatusSchema = z.enum(["pending", "paired", "revoked"]);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

// =============================================================================
// GOVERNANCE CONFIG SCHEMAS
// =============================================================================

export const BrowserHostnamePatternSchema = z
	.string()
	.trim()
	.toLowerCase()
	.min(1)
	.max(253)
	.refine(
		(value) =>
			value === "*" ||
			/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
				value,
			),
		"Expected an exact hostname, '*' or a leading wildcard such as *.example.com",
	);

export const BrowserHostnamePolicySchema = z.object({
	allowedHostnames: z.array(BrowserHostnamePatternSchema).max(100).default([]),
	deniedHostnames: z.array(BrowserHostnamePatternSchema).max(100).default([]),
});
export type BrowserHostnamePolicy = z.infer<typeof BrowserHostnamePolicySchema>;

export const AiGatewayModelTierSchema = z.enum([
	"economy",
	"balanced",
	"frontier",
]);
export type AiGatewayModelTier = z.infer<typeof AiGatewayModelTierSchema>;

export const AiGatewayAdmissionPolicySchema = z.object({
	allowedModelTiers: z.array(AiGatewayModelTierSchema).min(1).max(3).optional(),
	dailyTokenLimit: z.number().int().positive().optional(),
	dailySpendLimitMicros: z.number().int().positive().optional(),
});
export type AiGatewayAdmissionPolicy = z.infer<
	typeof AiGatewayAdmissionPolicySchema
>;

export const ToolPolicySchema = z.object({
	bash: z
		.enum(["always-allow", "approve-first-then-allow", "always-approve"])
		.default("approve-first-then-allow"),
	browser: z.enum(["always-allow", "always-approve"]).default("always-allow"),
	browserEgress: BrowserHostnamePolicySchema.optional(),
	github: z.enum(["always-allow", "always-approve"]).default("always-allow"),
	deploy: z.enum(["always-allow", "always-approve"]).default("always-approve"),
});
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

export const SelfImprovementPolicySchema = z.object({
	memoryAppend: z.enum(["auto", "approval-required"]).default("auto"),
	skillRefUpdate: z
		.enum(["auto", "pr-required", "pr-and-approval"])
		.default("pr-required"),
	newSkill: z
		.enum(["pr-required", "pr-and-approval"])
		.default("pr-and-approval"),
	cronJob: z.enum(["auto", "approval-required"]).default("approval-required"),
	configChange: z
		.enum(["auto", "approval-required"])
		.default("approval-required"),
});
export type SelfImprovementPolicy = z.infer<typeof SelfImprovementPolicySchema>;

// Per-tedi runtime ceilings are optional overrides. The defaults use shared
// organization inference capacity; managed D1 admission still reserves every
// model call. Positive values opt an individual tedi into a local ceiling.
export const TediBudgetsSchema = z.object({
	dailyTokenLimit: z
		.number()
		.default(-1)
		.describe(
			"Daily local token ceiling; -1 uses shared organization capacity without an individual ceiling.",
		),
	dailyMessageLimit: z
		.number()
		.default(-1)
		.describe(
			"Daily local message ceiling; -1 disables the individual message ceiling.",
		),
	operatorTokenReserve: z.number().default(400000),
	operatorMessageReserve: z.number().default(20),
	governedLearningTokenReserve: z.number().default(400000),
	governedLearningMessageReserve: z.number().default(80),
	maxCronJobs: z.number().default(20),
	maxIterationsPerTask: z.number().default(-1),
	browserBudgetDaily: z.number().default(50),
	aiGatewayPolicy: AiGatewayAdmissionPolicySchema.optional(),
});
export type TediBudgets = z.infer<typeof TediBudgetsSchema>;

export const QuietHoursSchema = z.object({
	start: z.string().default("22:00"),
	end: z.string().default("07:00"),
	timezone: z.string().default("Europe/Berlin"),
	emergencyOverride: z.boolean().default(true),
});
export type QuietHours = z.infer<typeof QuietHoursSchema>;

export const ChannelConfigSchema = z.record(z.string(), JsonValueSchema);

export const ChannelsConfigSchema = z.strictObject({
	telegram: ChannelConfigSchema.optional().describe(
		"Absent until an operator configures Telegram for this tedi.",
	),
	signal: ChannelConfigSchema.optional().describe(
		"Absent until an operator configures Signal for this tedi.",
	),
	voice: ChannelConfigSchema.optional().describe(
		"Absent until an operator configures Voice for this tedi.",
	),
});
export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>;

export const CronJobSchema = z.object({
	name: z.string().min(1).max(100),
	schedule: z.string().min(1).max(100),
	enabled: z.boolean(),
});
export type CronJob = z.infer<typeof CronJobSchema>;

export const RepoConfigSchema = z.object({
	repoUrl: z
		.string()
		.url()
		.startsWith("https://", "Repository URL must use HTTPS"),
	branch: z.string().min(1).max(100).optional(),
	worktreePath: z.string().min(1).max(512).optional(),
	githubRepositoryId: z
		.number()
		.int()
		.positive()
		.safe()
		.optional()
		.describe(
			"Immutable GitHub repository id; absent until workstation GitHub App authority is explicitly configured.",
		),
	githubInstallationId: z
		.number()
		.int()
		.positive()
		.safe()
		.optional()
		.describe(
			"GitHub App installation id; absent until repository-scoped workstation authority is provisioned.",
		),
	githubAppEnabled: z
		.boolean()
		.optional()
		.describe(
			"Explicit per-tedi GitHub App authority switch; absence remains fail-closed for existing repo configurations.",
		),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

// =============================================================================
// ENTITY SCHEMAS
// =============================================================================

export const TediScopeSchema = z.enum(["personal", "organization"]);
export type TediScope = z.infer<typeof TediScopeSchema>;

export const TediSchema = z
	.object({
		id: z.uuid(),
		organizationId: z.uuid(),
		ownerUserId: z.string().nullable(),
		scope: TediScopeSchema.nullable(),
		name: z.string(),
		slug: z.string(),
		displayName: z.string().nullable(),
		descopeUserId: z.string().nullable().optional(),
		descopeMcpResourceId: z.string().nullable().optional(),
		externalRef: z.string().nullable(),
		tags: z.array(z.string()).nullable(),
		personality: z.string().nullable(),
		avatar: z.string().nullable(),
		timezone: z.string().nullable(),
		language: z.string().nullable(),
		installedSkills: z.array(z.string()).nullable(),
		installedPlugins: z.array(z.string()).nullable(),
		status: TediStatusSchema.nullable(),
		billingState: TediBillingStateSchema.nullable(),
		workerName: z.string().nullable(),
		r2BucketName: z.string().nullable(),
		toolPolicy: ToolPolicySchema.nullable().optional(),
		selfImprovementPolicy: SelfImprovementPolicySchema.nullable().optional(),
		budgets: TediBudgetsSchema.nullable().optional(),
		quietHours: QuietHoursSchema.nullable().optional(),
		channels: ChannelsConfigSchema.nullable().optional(),
		cronJobs: z.array(CronJobSchema).nullable().optional(),
		repoConfig: RepoConfigSchema.nullable().optional(),
		runtimeOverrides: z
			.record(z.string(), JsonValueSchema)
			.nullable()
			.optional(),
		runtimeState: RuntimeStateSchema.nullable().optional(),
		lastActivityAt: z.string().nullable().optional(),
		lastHeartbeatAt: z.string().nullable().optional(),
		idleSince: z.string().nullable().optional(),
		runtimeStatus: RuntimeStatusSchema.nullable(),
		runtimeKind: z.literal("agent").nullable().optional(),
		isolateAgentId: z.string().nullable().optional(),
		lastSeenAt: z.string().nullable(),
		lastSyncAt: z.string().nullable(),
		// Retirement (soft delete). Non-null `retiredAt` means the worker was
		// retired, not destroyed: its memory, rationale, skills, artifacts and
		// growth history are retained in the platform under this `id`.
		// `retiredSlug` is the name it answered to before retirement renamed
		// `slug` to free the name for a replacement worker.
		retiredAt: z
			.string()
			.nullable()
			.optional()
			.describe(
				"Lifecycle: null/absent on every live tedi, and absent entirely on rows read before the retirement columns existed. Non-null means the worker was retired (soft-deleted) at this ISO timestamp — its identity and runtime are gone, but its memory, rationale, skills, artifacts and growth history are retained under this id.",
			),
		retiredSlug: z
			.string()
			.nullable()
			.optional()
			.describe(
				"Lifecycle: set only alongside retiredAt. The slug the worker answered to before retirement renamed `slug` to free the permanently unique name for a replacement worker.",
			),
		createdAt: z.string().nullable(),
		updatedAt: z.string().nullable(),
	})
	.passthrough();
export type TediType = z.infer<typeof TediSchema>;

export const TediDeviceSchema = z.object({
	id: z.uuid(),
	tediId: z.uuid().nullable().optional(),
	deviceId: z.string().nullable().optional(),
	displayName: z.string().nullable(),
	platform: z.string().nullable(),
	channel: z.string().nullable(),
	status: DeviceStatusSchema,
	pairedAt: z.string().nullable(),
	createdAt: z.string().nullable(),
});
export type TediDeviceType = z.infer<typeof TediDeviceSchema>;

// =============================================================================
// INPUT SCHEMAS
// =============================================================================

// "agent" is the Agent runtime (Cloudflare Agents/Pi Durable). Workstation access is
// an additive lease, not a runtime kind.
export const RuntimeKindSchema = z.literal("agent");
export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;

// Runtime-routing projection resolved by globally-unique slug. Used by the MCP
// aggregate edge (service-binding only) to hydrate tediId + runtime kind.
//
// The enum-ish fields are intentionally tolerant `string`s, NOT strict enums:
// `tedis.runtimeKind/runtimeState/status` are drizzle enum HINTS over plain
// SQLite text with no SQL CHECK constraint, so legacy/drifted values are
// physically possible. The MCP consumer applies its own tolerant equality/
// includes checks (`row.runtimeKind === "agent"`, `status ∈ {…}`); a single
// drifted row must never fail whole-response output validation, because that
// would 500 the endpoint → the consumer's transient-outage fail-safe → retired
// tedis silently re-advertised. This matches the old raw-D1-read tolerance.
export const TediRuntimeMetaSchema = z.object({
	slug: z.string(),
	id: z.string(),
	organizationId: z.string(),
	runtimeKind: z.string(),
	runtimeState: z.string(),
	status: z.string().nullable(),
});
export type TediRuntimeMeta = z.infer<typeof TediRuntimeMetaSchema>;

export const ListTediRuntimeMetaBySlugsInputSchema = z.object({
	slugs: z.array(z.string().min(1)).min(1).max(200),
});
export type ListTediRuntimeMetaBySlugsInput = z.infer<
	typeof ListTediRuntimeMetaBySlugsInputSchema
>;

export const ListTediRuntimeMetaBySlugsResponseSchema = z.object({
	data: z.array(TediRuntimeMetaSchema),
});
export type ListTediRuntimeMetaBySlugsResponse = z.infer<
	typeof ListTediRuntimeMetaBySlugsResponseSchema
>;

export const CreateTediInputSchema = z.object({
	/**
	 * Target organization. Defaults to the caller's org.
	 *
	 * Creating a tedi in a DIFFERENT org requires platform-admin authority. Without
	 * this, tenant onboarding could not be automated at all: `tedis.create` derived
	 * the org solely from the caller's context, so a platform admin (or the CTO
	 * tedi) had to interactively log into the customer's workspace to give it its
	 * first tedi — even though `apps.provision`/`apps.update` already accept a
	 * cross-org `organizationId`.
	 */
	organizationId: z
		.uuid()
		.optional()
		.describe(
			"Organization to create the tedi in. Defaults to the caller's org; a different org requires platform-admin authority.",
		),
	name: z.string().min(1, "Name is required").max(100),
	slug: z
		.string()
		.min(1)
		.max(50)
		.regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens")
		.optional(),
	displayName: z.string().max(100).optional(),
	externalRef: z.string().max(200).optional(),
	tags: z.array(z.string().min(1).max(64)).max(32).optional(),
	personality: z.string().max(5000).optional(),
	timezone: z.string().max(50).optional(),
	language: z.string().max(10).optional(),
	r2BucketName: z.string().optional(),
	workerName: z.string().optional(),
	runtimeOverrides: z.record(z.string(), JsonValueSchema).optional(),
	runtimeKind: RuntimeKindSchema.optional().describe(
		"Runtime adapter tier: 'agent' (Worker+DO Agent runtime).",
	),
	isolateAgentId: z
		.string()
		.nullable()
		.optional()
		.describe("Optional DO agent id pin for the Agent runtime."),
	registerDescopeAih: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			"Opt in to creating a per-tedi Descope AIH MCP server for standalone OAuth or cross-tedi M2M.",
		),
});
export type CreateTediInput = z.infer<typeof CreateTediInputSchema>;

export const UpdateTediInputSchema = z.object({
	name: z.string().min(1).max(100).optional(),
	displayName: z.string().max(100).nullable().optional(),
	externalRef: z.string().max(200).nullable().optional(),
	tags: z.array(z.string().min(1).max(64)).max(32).optional(),
	personality: z.string().max(5000).nullable().optional(),
	avatar: z.string().max(500).nullable().optional(),
	timezone: z.string().max(50).nullable().optional(),
	language: z.string().max(10).nullable().optional(),
	status: z.enum(["active", "paused"]).optional(),
	billingState: TediBillingStateSchema.optional(),
	workerName: z.string().optional(),
	r2BucketName: z.string().optional(),
	toolPolicy: ToolPolicySchema.optional(),
	selfImprovementPolicy: SelfImprovementPolicySchema.optional(),
	budgets: TediBudgetsSchema.optional(),
	quietHours: QuietHoursSchema.optional(),
	channels: ChannelsConfigSchema.optional(),
	cronJobs: z.array(CronJobSchema).optional(),
	installedSkills: z.array(z.string()).optional(),
	installedPlugins: z.array(z.string()).optional(),
	runtimeOverrides: z.record(z.string(), JsonValueSchema).nullable().optional(),
	// Rebind the tedi to a specific runtime profile (which selects the model via
	// its `modelPolicy.chatModelRef`). Must be a system profile or one owned by
	// the tedi's org; `null` resets to the system default. Capability-gated
	// (human/operator only) — see AGENT_UNREACHABLE_CAPABILITY_FIELDS.
	runtimeProfileId: z.string().uuid().nullable().optional(),
	repoConfig: RepoConfigSchema.nullable().optional(),
	mcpCapabilityProfile: z
		.enum(["standard", "content_admin", "org_admin", "platform_admin"])
		.optional(),
});
export type UpdateTediInput = z.infer<typeof UpdateTediInputSchema>;

// =============================================================================
// ID PARAMETER SCHEMAS
// =============================================================================

export const TediIdParamSchema = z.object({
	tediId: z.uuid("Tedi ID must be a valid UUID"),
});
export type TediIdParam = z.infer<typeof TediIdParamSchema>;

// =============================================================================
// CUSTOM DOMAIN SCHEMAS
// =============================================================================

export const CustomDomainStatusSchema = z.enum(["pending", "active", "error"]);

export const CustomDomainSchema = z.object({
	id: z.uuid(),
	tediId: z.uuid(),
	hostname: z.string(),
	status: CustomDomainStatusSchema.nullable(),
	sslStatus: CustomDomainStatusSchema.nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});
export type CustomDomainType = z.infer<typeof CustomDomainSchema>;

export const AddCustomDomainInputSchema = z.object({
	hostname: z
		.string()
		.min(1, "Hostname is required")
		.max(253)
		.regex(
			/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i,
			"Must be a valid domain (e.g. ai.acme.com)",
		),
});
export type AddCustomDomainInput = z.infer<typeof AddCustomDomainInputSchema>;

// =============================================================================
// RUNTIME PROJECTION SCHEMAS
// =============================================================================

export const RuntimeDeviceObservationSchema = z.object({
	id: z.string(),
	displayName: z.string().nullable().optional(),
	channel: z.string().nullable().optional(),
	platform: z.string().nullable().optional(),
	status: z.enum(["pending", "paired", "revoked"]),
	observedAt: z.string().optional(),
});
export type RuntimeDeviceObservation = z.infer<
	typeof RuntimeDeviceObservationSchema
>;

export const RuntimeChannelStatusSchema = z.object({
	channel: z.string(),
	enabled: z.boolean().optional(),
	connected: z.boolean().optional(),
	status: z.string().optional(),
	probeStatus: z.enum(["probed", "config-fallback", "probe-failed"]).optional(),
	lastError: z.string().nullable().optional(),
	observedAt: z.string().optional(),
});

// =============================================================================
// STORAGE (Mounted R2 Namespace)
// =============================================================================

export const TediBackupHandleSummarySchema = z.object({
	runtimeId: z.string().nullable().optional(),
	runtimeDir: z.string().nullable().optional(),
	runtimePresent: z.boolean().optional(),
	workspaceId: z.string().nullable().optional(),
	workspaceDir: z.string().nullable().optional(),
	workspacePresent: z.boolean().optional(),
	createdAt: z.string().nullable().optional(),
	createdAtValid: z.boolean().optional(),
	restorable: z.boolean().optional(),
	format: z.enum(["missing", "unified", "legacy-split", "unknown"]).optional(),
	issues: z.array(z.string()).optional(),
	primaryIssue: z.string().nullable().optional(),
});
export type TediBackupHandleSummary = z.infer<
	typeof TediBackupHandleSummarySchema
>;

export const TediBackupR2ObjectSchema = z.object({
	key: z.string(),
	exists: z.boolean(),
	sizeBytes: z.number().nullable(),
	etag: z.string().nullable(),
	uploadedAt: z.string().nullable(),
	checkedAt: z.string(),
	error: z.string().nullable().optional(),
});
export type TediBackupR2Object = z.infer<typeof TediBackupR2ObjectSchema>;

export const TediBackupWarningDetailSchema = z.object({
	code: z.string(),
	severity: z.enum(["info", "warning", "critical"]),
	message: z.string(),
	recommendedAction: z.string(),
});
export type TediBackupWarningDetail = z.infer<
	typeof TediBackupWarningDetailSchema
>;

export const TediBackupReadinessSchema = z.object({
	status: z.enum(["ready", "warning", "blocked"]),
	reasons: z.array(z.string()),
});
export type TediBackupReadiness = z.infer<typeof TediBackupReadinessSchema>;

export const TediBackupFreshnessReadinessSchema = z.object({
	status: z.enum(["fresh", "stale", "unknown"]),
	source: z.enum(["backup", "no-change-sync", "none"]),
	reasons: z.array(z.string()),
	maxBackupAgeHours: z.number(),
	backupAgeHours: z.number().nullable(),
	syncAgeHours: z.number().nullable(),
});
export type TediBackupFreshnessReadiness = z.infer<
	typeof TediBackupFreshnessReadinessSchema
>;

export const TediBackupAuditEventSchema = z.object({
	id: z.string(),
	action: z.string(),
	actorType: z.string(),
	actorId: z.string(),
	at: z.string(),
	metadata: z.record(z.string(), JsonValueSchema).nullable(),
});
export type TediBackupAuditEvent = z.infer<typeof TediBackupAuditEventSchema>;

export const TediBackupAuditItemSchema = z.object({
	tediId: z.uuid(),
	slug: z.string(),
	name: z.string(),
	organizationId: z.uuid(),
	status: TediStatusSchema.nullable(),
	runtimeState: RuntimeStateSchema.nullable(),
	runtimeStatus: RuntimeStatusSchema.nullable(),
	lastSeenAt: z.string().nullable(),
	lastSyncAt: z.string().nullable(),
	backup: TediBackupHandleSummarySchema,
	backupAgeHours: z.number().nullable(),
	syncAgeHours: z.number().nullable(),
	backupFresh: z.boolean(),
	freshnessSource: z.enum(["backup", "no-change-sync", "none"]),
	r2Object: TediBackupR2ObjectSchema.nullable(),
	lastBackupResult: z.record(z.string(), JsonValueSchema).nullable(),
	warnings: z.array(z.string()),
	warningDetails: z.array(TediBackupWarningDetailSchema),
	restoreRisk: z.enum(["none", "warning", "blocked"]),
	restoreReadiness: TediBackupReadinessSchema,
	freshnessReadiness: TediBackupFreshnessReadinessSchema,
	recentRuntimeEvents: z.array(TediBackupAuditEventSchema),
	restorable: z.boolean(),
});
export type TediBackupAuditItem = z.infer<typeof TediBackupAuditItemSchema>;

export const TediBackupAuditResponseSchema = z.object({
	checkedAt: z.string(),
	maxBackupAgeHours: z.number(),
	includeR2: z.boolean(),
	total: z.number(),
	restorable: z.number(),
	warnings: z.number(),
	items: z.array(TediBackupAuditItemSchema),
});
export type TediBackupAuditResponse = z.infer<
	typeof TediBackupAuditResponseSchema
>;

export const TediStorageStatusSchema = z.object({
	configured: z.boolean(),
	bucketName: z.string().nullable().optional(),
	prefix: z.string().optional(),
	lastSync: z.string().nullable(),
	backupHandles: TediBackupHandleSummarySchema.optional(),
	message: z.string(),
	missing: z.array(z.string()).optional(),
});

export const TediStorageFileEntrySchema = z.object({
	path: z.string(),
	type: z.enum(["file", "dir"]),
});

export const TediStorageFilesSchema = z.object({
	path: z.string(),
	entries: z.array(TediStorageFileEntrySchema),
});

export const TediStorageFileSchema = z.object({
	path: z.string(),
	content: z.string(),
	sizeBytes: z.number().nullable(),
	truncated: z.boolean(),
});
export type RuntimeChannelStatus = z.infer<typeof RuntimeChannelStatusSchema>;

export const TediWriteStorageFileInputSchema = z.object({
	path: z.string().min(1, "Path is required"),
	content: z.string().max(1_048_576, "Content too large (max 1MB)"),
});

export const TediDreamsSchema = z.object({
	content: z.string(),
	found: z.boolean(),
	path: z.string(),
});

export const TediWriteStorageFileResultSchema = z.object({
	success: z.boolean(),
	path: z.string(),
});

export const TediRuntimeSnapshotSchema = z.object({
	id: z.uuid(),
	tediId: z.uuid(),
	source: z.string(),
	runtimeStatus: z.string().nullable(),
	runtimeVersion: z.string().nullable(),
	channelStatus: z.record(z.string(), JsonValueSchema).nullable().optional(),
	deviceStatus: z.record(z.string(), JsonValueSchema).nullable().optional(),
	observedAt: z.string(),
	createdAt: z.string().nullable(),
});
export type TediRuntimeSnapshotType = z.infer<typeof TediRuntimeSnapshotSchema>;

export const TediUsageEventSchema = z.object({
	id: z.uuid(),
	tediId: z.uuid(),
	eventType: z.string(),
	startedAt: z.string(),
	endedAt: z.string().nullable(),
	durationMs: z.number().nullable(),
	units: z.number().nullable(),
	metadata: z.record(z.string(), JsonValueSchema).nullable().optional(),
	createdAt: z.string().nullable(),
});
export type TediUsageEventType = z.infer<typeof TediUsageEventSchema>;

export const IngestRuntimeProjectionInputSchema = z.object({
	tediId: z.uuid(),
	source: z.string().default("runtime"),
	runtimeStatus: z.string().optional(),
	runtimeVersion: z.string().nullable().optional(),
	channelStatus: z.array(RuntimeChannelStatusSchema).optional(),
	devices: z.array(RuntimeDeviceObservationSchema).optional(),
	observedAt: z.string().optional(),
	usageEvents: z
		.array(
			z.object({
				eventType: z.string(),
				startedAt: z.string(),
				endedAt: z.string().optional(),
				durationMs: z.number().optional(),
				units: z.number().optional(),
				metadata: z.record(z.string(), JsonValueSchema).optional(),
			}),
		)
		.optional(),
});
export type IngestRuntimeProjectionInput = z.infer<
	typeof IngestRuntimeProjectionInputSchema
>;

// =============================================================================
// RESPONSE SCHEMAS (extracted from tedis contract)
// =============================================================================

export const TediSuccessMessageSchema = z.object({
	success: z.boolean(),
	message: z.string(),
});
export type TediSuccessMessage = z.infer<typeof TediSuccessMessageSchema>;

export const ChannelTokenValidationSchema = z.object({
	valid: z.boolean(),
	botUsername: z.string().optional(),
	botId: z.string().optional(),
	error: z.string().optional(),
});
export type ChannelTokenValidation = z.infer<
	typeof ChannelTokenValidationSchema
>;

export const TediProcessLogsSchema = z.object({
	processId: z.string(),
	status: z.string(),
	stdout: z.string(),
	stderr: z.string(),
});
export type TediProcessLogs = z.infer<typeof TediProcessLogsSchema>;

export const TediRuntimeStatusSchema = z.object({
	runtimeStatus: z.string(),
	lastSeenAt: z.string().nullable(),
	lastSyncAt: z.string().nullable(),
	runtimeVersion: z.string().nullable(),
	processCount: z.number(),
	slug: z.string(),
});
export type TediRuntimeStatus = z.infer<typeof TediRuntimeStatusSchema>;

/**
 * One schedule on a tedi's Agent-runtime Durable Object (Agents-SDK scheduler,
 * `cf_agents_schedules`). Mirrors the runtime's `AdminScheduleSnapshot`
 * (apps/tedi-runtime `GET /__admin/schedules`).
 */
export const TediScheduleSchema = z.object({
	id: z.string(),
	/** DO callback the alarm invokes ("onCronFire" = operator/tedi cron job). */
	callback: z.string(),
	name: z.string().nullable(),
	/** cron = recurring expression, every = fixed interval, at = one-shot. */
	kind: z.enum(["cron", "every", "at"]),
	/** Cron expression (kind=cron only). */
	expr: z.string().nullable(),
	/** Interval in milliseconds (kind=every only). */
	everyMs: z.number().nullable(),
	/** Prompt message injected as a real tedi turn when the job fires. */
	message: z.string().nullable(),
	sessionTarget: z.string().nullable(),
	/** Next scheduled fire time (ISO-8601), when derivable. */
	nextRunAt: z.string().nullable(),
});
export type TediSchedule = z.infer<typeof TediScheduleSchema>;

export const TediScheduleListResponseSchema = z.object({
	schedules: z.array(TediScheduleSchema),
	/** Manifest-owned skill workflow schedules projected from canonical D1. */
	skillSchedules: z.array(SkillScheduleSchema).optional(),
	/** Set when the runtime was unreachable or returned a partial read (fail-soft). */
	warning: z.string().optional(),
});
export type TediScheduleListResponse = z.infer<
	typeof TediScheduleListResponseSchema
>;

/** Payload-free, exact-run Agent-runtime ledger delivery diagnostic. */
export const TediRuntimeOutboxSnapshotSchema = z.object({
	runId: z.string().min(1).max(512),
	observational: z.number().int().nonnegative(),
	terminal: z.number().int().nonnegative(),
	kinds: z.record(z.string(), z.number().int().nonnegative()),
	oldestPendingAgeMs: z
		.number()
		.nonnegative()
		.nullable()
		.describe("Null when this exact run has no queued outbox entry."),
	maxRedrives: z.number().int().nonnegative(),
	blockedPending: z.number().int().nonnegative(),
	blockedInMemory: z.boolean(),
	inFlight: z.number().int().nonnegative(),
	redriveActive: z.boolean(),
});
export const TediRuntimeOutboxDiagnosticResponseSchema = z.object({
	ok: z.literal(true),
	outbox: TediRuntimeOutboxSnapshotSchema,
});
export type TediRuntimeOutboxDiagnosticResponse = z.infer<
	typeof TediRuntimeOutboxDiagnosticResponseSchema
>;

/** Operator-only native Pi scheduling metadata. Never includes task or model payloads. */
export const TediRuntimeRecoveryQuerySchema = z.object({
	sessionKey: z
		.string()
		.min(1)
		.max(512)
		.refine((value) => value === value.trim()),
	operationId: z
		.string()
		.min(1)
		.max(512)
		.refine((value) => value === value.trim())
		.optional(),
});
const PiDiagnosticIdSchema = z.number().int().positive();
export const TediRuntimeRecoverySubmissionSchema = z.object({
	id: PiDiagnosticIdSchema,
	conversationId: PiDiagnosticIdSchema,
	operationId: z.string().min(1).max(512).nullable(),
	type: z.enum(["input", "write"]),
	status: z.enum(["queued", "placed", "done", "unanswered"]),
});
export const TediRuntimeRecoveryDiagnosticResponseSchema = z.object({
	ok: z.literal(true),
	runtime: z.literal("pi"),
	sessionKey: z.string().min(1).max(512),
	sampledAt: z.string().datetime(),
	conversationId: PiDiagnosticIdSchema,
	scheduling: z.enum(["paused", "running", "closing"]),
	operation: TediRuntimeRecoverySubmissionSchema.nullable(),
	tasks: z
		.array(
			z.object({
				id: PiDiagnosticIdSchema,
				conversationId: PiDiagnosticIdSchema,
				kind: z.string().min(1).max(128),
				owner: PiDiagnosticIdSchema.nullable(),
				background: z.boolean(),
				abortRequested: z.boolean(),
				status: z.enum([
					"pending",
					"running",
					"waiting",
					"completing",
					"terminal",
				]),
				view: z.enum(["running", "ready", "waiting", "completing", "blocked"]),
				blockedReason: z
					.enum(["missing_task", "task_too_old", "migration_failed"])
					.nullable(),
				waitingOn: z.array(PiDiagnosticIdSchema).max(20),
				waitingOnTruncated: z.boolean(),
			}),
		)
		.max(50),
	submissions: z.array(TediRuntimeRecoverySubmissionSchema).max(50),
	taskCount: z.number().int().nonnegative(),
	submissionCount: z.number().int().nonnegative(),
	truncated: z.boolean(),
});
export type TediRuntimeRecoveryDiagnosticResponse = z.infer<
	typeof TediRuntimeRecoveryDiagnosticResponseSchema
>;

/** Temporary finite cutover inventory. routeTediId is only a transport anchor. */
export const TediRuntimeCutoverObjectIdSchema = z
	.string()
	.regex(/^[0-9a-f]{64}$/);
export const CutoverInspectionHopSchema = z
	.strictObject({
		className: z.string().min(1).max(128),
		name: z.string().min(1).max(512),
		identityVersion: z.enum(["path-v2"]).nullable(),
		identityName: z.string().min(1).max(1024).nullable(),
		objectId: TediRuntimeCutoverObjectIdSchema,
		registryHash: z.string().regex(/^[a-f0-9]{64}$/),
		parentGeneration: z.number().int().nonnegative().safe(),
	})
	.refine(
		(value) =>
			value.identityVersion === "path-v2"
				? value.identityName !== null
				: value.identityName === null,
		{ message: "Inconsistent registered identity" },
	);
export type CutoverInspectionHop = z.infer<typeof CutoverInspectionHopSchema>;
export const TediRuntimeCutoverQuerySchema = z
	.strictObject({
		routeTediId: z.string().uuid(),
		objectId: TediRuntimeCutoverObjectIdSchema,
		custodyTediId: z.string().uuid().optional(),
		targetPath: z.array(CutoverInspectionHopSchema).min(1).max(16).optional(),
		expectedGeneration: z.number().int().nonnegative().safe().optional(),
		offset: z.number().int().nonnegative().safe().default(0),
		limit: z.number().int().min(1).max(200).default(200),
		expectedInspectionHash: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
		expectedHash: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
		/** Exact names are used only to recover the matching named transport ID. */
		candidateObjectNames: z
			.array(z.string().min(1).max(1024))
			.max(100)
			.optional(),
	})
	.refine((value) => !value.targetPath || value.custodyTediId !== undefined, {
		path: ["custodyTediId"],
		message: "Registered inspection requires canonical custody",
	})
	.refine(
		(value) =>
			value.offset === 0 ||
			(value.expectedHash !== undefined &&
				value.expectedInspectionHash !== undefined),
		{
			path: ["expectedHash"],
			message: "A continuation page requires the full inventory hash",
		},
	);
const CutoverMetadataTextSchema = z.string().max(512);
const CutoverMetadataHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const CutoverMetadataCountSchema = z.number().int().nonnegative().safe();
const CutoverMetadataLimit = 200;
/** SDK tracking-cache metadata only; timestamps are Unix seconds, not provider samples. */
export const CutoverSdkWorkflowStatusSchema = z.enum([
	"queued",
	"running",
	"paused",
	"errored",
	"terminated",
	"complete",
	"waiting",
	"waitingForPause",
	"unknown",
]);
export const CutoverSdkWorkflowRowSchema = z.strictObject({
	workflow_id: z.string().min(1).max(512),
	workflow_name: z.string().min(1).max(512),
	status: CutoverSdkWorkflowStatusSchema,
	created_at: CutoverMetadataCountSchema,
	updated_at: CutoverMetadataCountSchema,
	completed_at: CutoverMetadataCountSchema.nullable(),
});
export type CutoverSdkWorkflowRow = z.infer<typeof CutoverSdkWorkflowRowSchema>;
/** SQLite BINARY orders valid UTF-8 identifiers by Unicode code point. */
export function compareCutoverWorkflowIds(left: string, right: string): number {
	const a = Array.from(left, (c) => c.codePointAt(0)!);
	const b = Array.from(right, (c) => c.codePointAt(0)!);
	for (let i = 0; i < Math.min(a.length, b.length); i++)
		if (a[i] !== b[i]) return a[i]! - b[i]!;
	return a.length - b.length;
}

/** Exact pinned, read-only operator observations; no settlement or activation claim. */
export const CutoverQualificationTables = [
	"pi_durable_schema",
	"pi_durable_metadata",
	"pi_record_ids",
	"pi_conversations",
	"pi_entries",
	"pi_tasks",
	"pi_submissions",
	"pi_documents",
	"pi_document_revisions",
	"chat_sdk_state_subscriptions",
	"chat_sdk_state_locks",
	"chat_sdk_state_cache",
	"chat_sdk_state_queue",
	"chat_sdk_state_lists",
	"chat_sdk_state_metadata",
] as const;
export const CutoverQualificationFamilies = [
	"legacy_accounting",
	"native_accounting",
	"legacy_pending",
	"native_pending",
	"native_admission_binding",
	"legacy_import_marker",
	"native_active_conversation",
	"native_display",
	"legacy_messenger_recovery",
	"chat_recovery",
	"native_telegram_delivery",
	"native_maintenance_fire",
	"image_cleanup",
	"cutover_markers",
] as const;
export const CutoverQualificationStates = [
	"present",
	"prepared",
	"started",
	"completed",
	"unknown",
	"accepted",
	"answered",
	"sending",
	"uncertain",
	"skipped",
	"exhausted",
	"failed",
	"running",
	"issued",
	"acknowledged",
	"pending",
	"done",
	"uploaded_images",
	"terminal",
	"cancelled",
	"queued",
	"placed",
	"unanswered",
	"waiting",
	"completing",
	"detected",
	"scheduled",
	"attempting",
] as const;
export const CutoverQualificationFamilyStates: Record<
	(typeof CutoverQualificationFamilies)[number],
	readonly (typeof CutoverQualificationStates)[number][]
> = {
	legacy_accounting: ["present"],
	native_accounting: ["present"],
	legacy_pending: [],
	native_pending: ["present"],
	native_admission_binding: ["present"],
	legacy_import_marker: ["present"],
	native_active_conversation: ["present"],
	native_display: ["present"],
	legacy_messenger_recovery: [
		"accepted",
		"answered",
		"sending",
		"completed",
		"uncertain",
		"skipped",
		"failed",
		"pending",
		"done",
	],
	chat_recovery: [
		"detected",
		"scheduled",
		"attempting",
		"completed",
		"skipped",
		"exhausted",
		"failed",
	],
	native_telegram_delivery: [
		"accepted",
		"answered",
		"sending",
		"completed",
		"uncertain",
	],
	native_maintenance_fire: [
		"accepted",
		"running",
		"acknowledged",
		"completed",
		"uncertain",
	],
	image_cleanup: ["uploaded_images", "issued", "acknowledged", "completed"],
	cutover_markers: ["present"],
};
const QualificationCount = z.number().int().nonnegative().max(20000);
const QualificationStatusCounts = z.partialRecord(
	z.enum(CutoverQualificationStates),
	QualificationCount,
);
const QualificationTableSchema = z.strictObject({
	table: z.enum(CutoverQualificationTables),
	present: z.boolean(),
	schemaState: z.enum(["absent", "supported", "unknown"]),
	rowCount: QualificationCount.nullable(),
	projectionHash: CutoverMetadataHashSchema.nullable(),
	statusCounts: QualificationStatusCounts,
});
const QualificationRowSchema = z.strictObject({
	ordinal: QualificationCount,
	family: z.enum(CutoverQualificationFamilies),
	identityHash: CutoverMetadataHashSchema.nullable(),
	projectionHash: CutoverMetadataHashSchema.nullable(),
	structuralState: z.enum(["known", "malformed", "unsupported"]),
	observedState: z.enum(CutoverQualificationStates),
	completionValidation: z.enum(["passed", "not_passed", "unknown"]),
	faultPresent: z.boolean().nullable(),
	phaseCounts: QualificationStatusCounts,
	unacknowledgedCount: QualificationCount.nullable(),
	unsealedEffectsCount: QualificationCount.nullable(),
	usageNullCounts: z
		.strictObject({
			inputTokens: QualificationCount,
			outputTokens: QualificationCount,
			totalTokens: QualificationCount,
		})
		.nullable(),
});
export const CutoverQualificationSchema = z
	.strictObject({
		nativeSchemaState: z.enum(["absent", "supported", "unknown"]),
		nativeSchemaVersion: z.number().int().nonnegative().safe().nullable(),
		tables: z
			.array(QualificationTableSchema)
			.length(CutoverQualificationTables.length),
		journalFamilies: z
			.array(
				z.strictObject({
					family: z.enum(CutoverQualificationFamilies),
					count: QualificationCount,
					states: QualificationStatusCounts,
					malformedCount: QualificationCount,
					unsupportedCount: QualificationCount,
				}),
			)
			.length(CutoverQualificationFamilies.length),
		journalCount: QualificationCount,
		offset: CutoverMetadataCountSchema,
		rows: z.array(QualificationRowSchema).max(200),
	})
	.superRefine((value, ctx) => {
		for (const [index, table] of value.tables.entries()) {
			const absent = table.schemaState === "absent";
			const allowed =
				table.schemaState !== "supported"
					? []
					: table.table === "pi_tasks"
						? [
								"pending",
								"running",
								"waiting",
								"completing",
								"terminal",
								"unknown",
							]
						: table.table === "pi_submissions"
							? ["queued", "placed", "done", "unanswered", "unknown"]
							: [];
			if (
				Object.keys(table.statusCounts).some(
					(state) => !allowed.includes(state),
				)
			)
				ctx.addIssue({
					code: "custom",
					path: ["tables", index, "statusCounts"],
					message: "Unsupported table state",
				});
			if (
				table.schemaState === "supported" &&
				(table.table === "pi_tasks" || table.table === "pi_submissions") &&
				Object.values(table.statusCounts).reduce((a, b) => a + b, 0) !==
					table.rowCount
			)
				ctx.addIssue({
					code: "custom",
					path: ["tables", index, "statusCounts"],
					message: "Incomplete table states",
				});
			if (
				table.table !== CutoverQualificationTables[index] ||
				table.present === absent ||
				(absent
					? table.rowCount !== null ||
						table.projectionHash !== null ||
						Object.keys(table.statusCounts).length !== 0
					: table.rowCount === null) ||
				(table.schemaState === "unknown" && table.projectionHash !== null) ||
				(table.schemaState === "supported" && table.projectionHash === null) ||
				Object.values(table.statusCounts).reduce((a, b) => a + b, 0) >
					(table.rowCount ?? 0)
			)
				ctx.addIssue({
					code: "custom",
					path: ["tables", index],
					message: "Incoherent qualification table",
				});
		}
		let total = 0;
		for (const [index, family] of value.journalFamilies.entries()) {
			total += family.count;
			if (
				family.family !== CutoverQualificationFamilies[index] ||
				Object.values(family.states).reduce((a, b) => a + b, 0) !==
					family.count ||
				family.malformedCount + family.unsupportedCount !==
					(family.states.unknown ?? 0) ||
				Object.keys(family.states).some(
					(state) =>
						state !== "unknown" &&
						!CutoverQualificationFamilyStates[family.family].includes(
							state as (typeof CutoverQualificationStates)[number],
						),
				)
			)
				ctx.addIssue({
					code: "custom",
					path: ["journalFamilies", index],
					message: "Incoherent journal family",
				});
		}
		if (total !== value.journalCount)
			ctx.addIssue({
				code: "custom",
				path: ["journalCount"],
				message: "Incoherent journal count",
			});
		for (const [index, row] of value.rows.entries()) {
			let familyEnd = 0;
			const expectedFamily = value.journalFamilies.find((family) => {
				familyEnd += family.count;
				return row.ordinal < familyEnd;
			})?.family;
			if (row.family !== expectedFamily)
				ctx.addIssue({
					code: "custom",
					path: ["rows", index, "family"],
					message: "Journal family ordinal mismatch",
				});
			const accounting =
					row.family === "legacy_accounting" ||
					row.family === "native_accounting",
				known = row.structuralState === "known";
			const invalid =
				row.ordinal !== value.offset + index ||
				(known
					? row.projectionHash === null ||
						!CutoverQualificationFamilyStates[row.family].includes(
							row.observedState,
						)
					: row.observedState !== "unknown" ||
						row.projectionHash !== null ||
						row.identityHash !== null ||
						row.completionValidation !== "unknown" ||
						row.faultPresent !== null ||
						Object.keys(row.phaseCounts).length !== 0 ||
						row.unacknowledgedCount !== null ||
						row.unsealedEffectsCount !== null ||
						row.usageNullCounts !== null);
			const attempts = Object.values(row.phaseCounts).reduce(
				(a, b) => a + b,
				0,
			);
			const invalidAccounting =
				known &&
				(accounting
					? row.faultPresent === null ||
						row.unacknowledgedCount === null ||
						row.unsealedEffectsCount === null ||
						(row.unacknowledgedCount ?? 0) > attempts ||
						(row.unsealedEffectsCount ?? 0) > attempts ||
						row.usageNullCounts === null ||
						row.completionValidation === "unknown" ||
						Object.keys(row.phaseCounts).some(
							(state) =>
								!["prepared", "started", "completed", "unknown"].includes(
									state,
								),
						) ||
						Object.values(row.usageNullCounts ?? {}).some(
							(n) => n > (row.phaseCounts.completed ?? 0),
						)
					: row.faultPresent !== null ||
						Object.keys(row.phaseCounts).length !== 0 ||
						row.unacknowledgedCount !== null ||
						row.unsealedEffectsCount !== null ||
						row.usageNullCounts !== null ||
						(row.family !== "native_telegram_delivery" &&
							row.completionValidation !== "unknown"));
			if (invalid || invalidAccounting)
				ctx.addIssue({
					code: "custom",
					path: ["rows", index],
					message: "Incoherent journal observation",
				});
		}
		for (const [index, family] of value.journalFamilies.entries()) {
			const page = value.rows.filter((row) => row.family === family.family);
			for (const state of CutoverQualificationStates)
				if (
					page.filter((row) => row.observedState === state).length >
					(family.states[state] ?? 0)
				)
					ctx.addIssue({
						code: "custom",
						path: ["journalFamilies", index, "states"],
						message: "Journal page state mismatch",
					});
			if (
				page.filter((row) => row.structuralState === "malformed").length >
					family.malformedCount ||
				page.filter((row) => row.structuralState === "unsupported").length >
					family.unsupportedCount
			)
				ctx.addIssue({
					code: "custom",
					path: ["journalFamilies", index],
					message: "Journal page structure mismatch",
				});
		}
		if (
			value.nativeSchemaState === "absent" &&
			(value.nativeSchemaVersion !== null ||
				value.tables.slice(0, 9).some((t) => t.present))
		)
			ctx.addIssue({
				code: "custom",
				path: ["nativeSchemaState"],
				message: "Incoherent absent native store",
			});
		if (
			value.nativeSchemaState === "supported" &&
			(value.nativeSchemaVersion !== 1 ||
				value.tables.slice(0, 9).some((t) => t.schemaState !== "supported"))
		)
			ctx.addIssue({
				code: "custom",
				path: ["nativeSchemaState"],
				message: "Incoherent native store",
			});
	});
export type CutoverQualification = z.infer<typeof CutoverQualificationSchema>;

export const TediRuntimeCutoverInventoryResponseSchema = z
	.strictObject({
		ok: z.literal(true),
		version: z.literal("pi-cutover-inspection-v2"),
		qualification: CutoverQualificationSchema,
		id: TediRuntimeCutoverObjectIdSchema,
		sampledAt: z.string().datetime(),
		sdkWork: z
			.array(
				z.strictObject({
					table: z.enum([
						"cf_agents_fibers",
						"cf_agents_runs",
						"cf_agents_task_runs",
						"cf_agents_workflows",
						"cf_agents_facet_runs",
					]),
					present: z.boolean(),
					counts: z.partialRecord(
						z.enum([
							"queued",
							"paused",
							"errored",
							"terminated",
							"complete",
							"waiting",
							"waitingForPause",
							"pending",
							"running",
							"interrupted",
							"completed",
							"aborted",
							"error",
							"failed",
							"cancelled",
							"skipped",
							"unknown",
						]),
						z.number().int().nonnegative().safe(),
					),
				}),
			)
			.length(5),
		sdkWorkflows: z.strictObject({
			present: z.boolean(),
			count: CutoverMetadataCountSchema,
			offset: CutoverMetadataCountSchema,
			rows: z.array(CutoverSdkWorkflowRowSchema).max(CutoverMetadataLimit),
		}),
		maintenanceJournal: z.strictObject({
			count: z.number().int().nonnegative().max(200),
			offset: z.number().int().nonnegative().safe(),
			records: z
				.array(
					z.strictObject({
						taskId: z.string().min(1).max(512),
						nextRunAt: z.number().finite(),
						legacyScheduleIds: z.array(z.string().min(1).max(512)).max(200),
						legacyCancelled: z.boolean(),
						nativeScheduleId: z.string().min(1).max(512).nullable(),
						recurringScheduleId: z.string().min(1).max(512).nullable(),
					}),
				)
				.max(200),
		}),
		admission: z
			.strictObject({
				state: z.enum(["active", "held", "quarantined", "retired"]),
				generation: z.number().int().positive().safe(),
			})
			.nullable(),
		hash: CutoverMetadataHashSchema,
		inspectionHash: CutoverMetadataHashSchema,
		receiver: z.literal("raw-cutover-v1").optional(),
		targetsKnown: z.boolean(),
		inspectionTargets: z.array(CutoverInspectionHopSchema).max(200),
		offset: CutoverMetadataCountSchema,
		limit: z.number().int().min(1).max(200),
		counts: z.strictObject({
			tables: CutoverMetadataCountSchema,
			receipts: CutoverMetadataCountSchema,
			privateImages: CutoverMetadataCountSchema,
			children: CutoverMetadataCountSchema,
			maintenance: CutoverMetadataCountSchema,
		}),
		nextOffset: CutoverMetadataCountSchema.nullable(),
		inventory: z.strictObject({
			storedOwner: z.strictObject({
				tediId: z.string().max(256).nullable(),
				orgId: z.string().max(256).nullable(),
				slug: z.string().max(256).nullable(),
				sessionKey: z.string().max(256).nullable(),
				unknown: z.boolean(),
			}),
			tables: z
				.array(
					z.strictObject({
						name: z.string().min(1).max(128),
						rows: CutoverMetadataCountSchema,
					}),
				)
				.max(CutoverMetadataLimit),
			imported: z.boolean(),
			activeConversationId: z.number().int().positive().safe().nullable(),
			receipts: z
				.array(
					z.strictObject({
						id: CutoverMetadataTextSchema,
						source: z.string().min(1).max(128),
						status: z.string().max(128),
						terminal: z.boolean(),
						sha256: CutoverMetadataHashSchema.optional(),
					}),
				)
				.max(CutoverMetadataLimit),
			privateImages: z
				.array(
					z.strictObject({
						key: CutoverMetadataTextSchema,
						tediId: z.string().max(256).nullable(),
						orgId: z.string().max(256).nullable(),
						scheme: z
							.string()
							.max(64)
							.regex(/^[a-z][a-z0-9+.-]*:$/)
							.nullable(),
						sha256: CutoverMetadataHashSchema,
					}),
				)
				.max(CutoverMetadataLimit),
			children: z
				.array(
					z.strictObject({
						className: z.string().min(1).max(128),
						name: CutoverMetadataTextSchema,
						identityVersion: z.string().max(128).nullable(),
						identityName: CutoverMetadataTextSchema.nullable(),
					}),
				)
				.max(CutoverMetadataLimit),
			maintenance: z
				.array(
					z.strictObject({
						taskId: CutoverMetadataTextSchema,
						scheduleId: CutoverMetadataTextSchema.nullable(),
						nextRunAt: z.number().finite().nullable(),
					}),
				)
				.max(CutoverMetadataLimit),
			blocked: z.boolean(),
		}),
	})
	.superRefine((value, ctx) => {
		if (
			new Set(value.sdkWork.map((row) => row.table)).size !== 5 ||
			value.sdkWork.some(
				(row) => !row.present && Object.keys(row.counts).length !== 0,
			)
		)
			ctx.addIssue({
				code: "custom",
				path: ["sdkWork"],
				message: "Incoherent SDK metadata",
			});
		if (
			value.maintenanceJournal.offset !== value.offset ||
			value.maintenanceJournal.records.length !==
				Math.min(
					value.limit,
					Math.max(0, value.maintenanceJournal.count - value.offset),
				)
		)
			ctx.addIssue({
				code: "custom",
				path: ["maintenanceJournal"],
				message: "Incoherent maintenance page",
			});

		const workflowSummary = value.sdkWork.find(
			(row) => row.table === "cf_agents_workflows",
		);
		const workflows = value.sdkWorkflows;
		if (
			workflows.offset !== value.offset ||
			workflows.rows.length !==
				Math.min(value.limit, Math.max(0, workflows.count - value.offset)) ||
			workflows.present !== workflowSummary?.present ||
			workflows.count !==
				Object.values(workflowSummary?.counts ?? {}).reduce(
					(total, count) => total + (count ?? 0),
					0,
				) ||
			(!workflows.present &&
				(workflows.count !== 0 || workflows.rows.length !== 0)) ||
			workflows.rows.some(
				(row, index) =>
					index > 0 &&
					compareCutoverWorkflowIds(
						workflows.rows[index - 1]!.workflow_id,
						row.workflow_id,
					) >= 0,
			)
		)
			ctx.addIssue({
				code: "custom",
				path: ["sdkWorkflows"],
				message: "Incoherent SDK workflow page",
			});
		const keys = [
			"tables",
			"receipts",
			"privateImages",
			"children",
			"maintenance",
		] as const;
		for (const key of keys)
			if (
				value.inventory[key].length !==
				Math.min(value.limit, Math.max(0, value.counts[key] - value.offset))
			)
				ctx.addIssue({
					code: "custom",
					path: ["inventory", key],
					message: "Incoherent inventory page",
				});
		if (
			value.inspectionTargets.length !==
				(value.targetsKnown ? value.inventory.children.length : 0) ||
			value.inspectionTargets.some(
				(target, index) =>
					target.registryHash !== value.hash ||
					target.parentGeneration !== (value.admission?.generation ?? 0) ||
					JSON.stringify({
						className: target.className,
						name: target.name,
						identityVersion: target.identityVersion,
						identityName: target.identityName,
					}) !== JSON.stringify(value.inventory.children[index]),
			)
		)
			ctx.addIssue({
				code: "custom",
				path: ["inspectionTargets"],
				message: "Incoherent inspection targets",
			});
		if (
			value.qualification.offset !== value.offset ||
			value.qualification.rows.length !==
				Math.min(
					value.limit,
					Math.max(0, value.qualification.journalCount - value.offset),
				)
		)
			ctx.addIssue({
				code: "custom",
				path: ["qualification"],
				message: "Incoherent qualification page",
			});
		const next =
			keys.some((key) => value.counts[key] > value.offset + value.limit) ||
			value.maintenanceJournal.count > value.offset + value.limit ||
			value.sdkWorkflows.count > value.offset + value.limit ||
			value.qualification.journalCount > value.offset + value.limit
				? value.offset + value.limit
				: null;
		if (
			value.nextOffset !== next ||
			(next !== null && !Number.isSafeInteger(next))
		)
			ctx.addIssue({
				code: "custom",
				path: ["nextOffset"],
				message: "Incoherent continuation",
			});
	});
export type TediRuntimeCutoverInventoryResponse = z.infer<
	typeof TediRuntimeCutoverInventoryResponseSchema
>;

/** Temporary explicit operator requests; custody is resolved server-side, never asserted by input. */
const CutoverOperationCommon = {
	routeTediId: z.string().uuid(),
	objectId: TediRuntimeCutoverObjectIdSchema,
	operationId: z.string().min(1).max(256),
	candidateObjectNames: z
		.array(z.string().min(1).max(1024))
		.max(100)
		.optional(),
	targetPath: z.array(CutoverInspectionHopSchema).min(1).max(16).optional(),
	target: z
		.strictObject({
			className: z.string().min(1).max(128),
			name: z.string().min(1).max(512),
			identityVersion: z.string().max(128).nullable(),
			identityName: z.string().max(512).nullable(),
			objectId: TediRuntimeCutoverObjectIdSchema,
			registryHash: CutoverMetadataHashSchema,
			parentGeneration: z.number().int().positive().safe(),
		})
		.optional(),
};
const CutoverKnownCustody = {
	custodyTediId: z.string().uuid(),
	expectedGeneration: z.number().int().positive().safe(),
	sourceHash: CutoverMetadataHashSchema,
};
const CaptureSizeCommandSchema = z.strictObject({
	routeTediId: z.string().uuid(),
	objectId: TediRuntimeCutoverObjectIdSchema,
	operationId: z.string().min(1).max(256),
	command: z.literal("inspect_capture_size"),
	custodyTediId: z.string().uuid(),
	expectedGeneration: z.number().int().nonnegative().safe(),
	continuation: z.string().min(1).optional(),
});
const HistoricalCustodyCommon = {
	routeTediId: z.string().uuid(),
	objectId: TediRuntimeCutoverObjectIdSchema,
	operationId: z.string().min(1).max(256),
	custodyTediId: z.string().uuid(),
	targetPath: z.array(CutoverInspectionHopSchema).min(1).max(16).optional(),
	expectedGeneration: z.number().int().positive().safe(),
};
const CustodyCoverageCommand = z
	.strictObject({
		...HistoricalCustodyCommon,
		command: z.literal("inspect_custody_coverage"),
		continuation: z.string().min(1).max(131_072).optional(),
		coverageHash: CutoverMetadataHashSchema.optional(),
	})
	.refine(
		(v) => (v.continuation === undefined) === (v.coverageHash === undefined),
		"Continuation requires original coverage hash",
	);
const NativePreservationCommands = [
	z.strictObject({
		...HistoricalCustodyCommon,
		command: z.literal("inspect_native_preservation"),
	}),
	z.strictObject({
		...HistoricalCustodyCommon,
		command: z.literal("capture_native_preservation"),
		archiveId: z.string().uuid(),
		proof: z.string().min(1).max(131_072),
	}),
	z.strictObject({
		...HistoricalCustodyCommon,
		command: z.literal("audit_native_preservation"),
		archiveId: z.string().uuid(),
	}),
] as const;
const SessionPreservationCommands = [
	z.strictObject({
		...HistoricalCustodyCommon,
		command: z.literal("inspect_session_rehydration"),
		archiveId: z.string().uuid(),
	}),
	z.strictObject({
		...HistoricalCustodyCommon,
		command: z.literal("inspect_session_preservation"),
	}),
	z.strictObject({
		...HistoricalCustodyCommon,
		command: z.literal("capture_session_preservation"),
		archiveId: z.string().uuid(),
		proof: z.string().min(1).max(131_072),
	}),
	z.strictObject({
		...HistoricalCustodyCommon,
		command: z.literal("audit_session_preservation"),
		archiveId: z.string().uuid(),
	}),
] as const;
const SdkPreservationCommands = [
	z.strictObject({
		...HistoricalCustodyCommon,
		command: z.literal("inspect_sdk_preservation"),
	}),
	z.strictObject({
		...HistoricalCustodyCommon,
		command: z.literal("capture_sdk_preservation"),
		archiveId: z.string().uuid(),
		proof: z.string().min(1).max(131_072),
	}),
	z.strictObject({
		...HistoricalCustodyCommon,
		command: z.literal("audit_sdk_preservation"),
		archiveId: z.string().uuid(),
	}),
] as const;
const CutoverOperationCommandsSchema = z
	.discriminatedUnion("command", [
		CaptureSizeCommandSchema,
		CustodyCoverageCommand,
		...NativePreservationCommands,
		...SdkPreservationCommands,
		...SessionPreservationCommands,
		z.strictObject({
			...HistoricalCustodyCommon,
			command: z.literal("inspect_historical_custody"),
		}),
		z.strictObject({
			...HistoricalCustodyCommon,
			command: z.literal("capture_historical_custody"),
			expectedSourceHash: CutoverMetadataHashSchema,
		}),
		z.strictObject({
			...HistoricalCustodyCommon,
			command: z.literal("audit_historical_custody"),
			expectedSourceHash: CutoverMetadataHashSchema,
		}),
		z.strictObject({
			routeTediId: z.string().uuid(),
			objectId: TediRuntimeCutoverObjectIdSchema,
			operationId: z.string().min(1).max(256),
			command: z.literal("exclude_writers"),
			custodyTediId: z.string().uuid(),
			expectedGeneration: z.number().int().positive().safe(),
		}),
		z.strictObject({
			...CutoverOperationCommon,
			command: z.literal("plan"),
			custodyTediId: z.string().uuid(),
			expectedGeneration: z.number().int().nonnegative().safe(),
			verificationAction: z.enum(["initialize", "hold", "release"]),
		}),
		z.strictObject({
			...CutoverOperationCommon,
			command: z.literal("inspect_accounting"),
			custodyTediId: z.string().uuid(),
			expectedGeneration: z.number().int().nonnegative().safe(),
		}),
		z.strictObject({
			...CutoverOperationCommon,
			command: z.literal("transfer_accounting"),
			custodyTediId: z.string().uuid(),
			expectedGeneration: z.number().int().positive().safe(),
			accountingManifestHash: CutoverMetadataHashSchema,
		}),
		z.strictObject({
			...CutoverOperationCommon,
			...CutoverKnownCustody,
			command: z.literal("prepare"),
			evidenceHash: CutoverMetadataHashSchema,
		}),
		z.strictObject({
			...CutoverOperationCommon,
			...CutoverKnownCustody,
			command: z.literal("bootstrap_prepare"),
			expectedGeneration: z.literal(0),
			evidenceHash: CutoverMetadataHashSchema,
		}),
		z.strictObject({
			...CutoverOperationCommon,
			...CutoverKnownCustody,
			command: z.literal("apply"),
		}),
		z.strictObject({
			...CutoverOperationCommon,
			...CutoverKnownCustody,
			command: z.literal("release"),
			evidenceHash: CutoverMetadataHashSchema,
		}),
		z.strictObject({
			...CutoverOperationCommon,
			command: z.literal("quarantine"),
			custodyTediId: z.string().uuid().optional(),
			expectedGeneration: z.number().int().nonnegative().safe(),
			reasonCode: z.enum([
				"operator_hold",
				"unknown_owner",
				"unresolved_work",
				"unresolved_effects",
				"identity_mismatch",
			]),
		}),
	])
	.refine(
		(value) =>
			!(
				value.command === "quarantine" &&
				value.target !== undefined &&
				value.custodyTediId === undefined
			),
		{
			path: ["custodyTediId"],
			message: "Registered facet operations require canonical parent custody",
		},
	)
	.refine(
		(value) =>
			!("targetPath" in value && value.targetPath !== undefined) ||
			(value.command === "quarantine" &&
				value.custodyTediId !== undefined &&
				value.target === undefined &&
				value.expectedGeneration === 0) ||
			((value.command === "inspect_native_preservation" ||
				value.command === "capture_native_preservation" ||
				value.command === "audit_native_preservation" ||
				value.command === "inspect_sdk_preservation" ||
				value.command === "capture_sdk_preservation" ||
				value.command === "audit_sdk_preservation" ||
				value.command === "inspect_session_preservation" ||
				value.command === "capture_session_preservation" ||
				value.command === "audit_session_preservation" ||
				value.command === "inspect_session_rehydration" ||
				value.command === "inspect_custody_coverage" ||
				value.command === "inspect_historical_custody" ||
				value.command === "capture_historical_custody" ||
				value.command === "audit_historical_custody") &&
				value.custodyTediId !== undefined &&
				value.expectedGeneration > 0),
		{
			path: ["targetPath"],
			message:
				"Registered paths support generation-zero quarantine or nonactive historical custody with canonical custody",
		},
	);

// MCP inputs require an object root. The command schema remains the exact
// validator, including required fields and command-specific extra-key rejection.
export const TediRuntimeCutoverOperationQuerySchema = z
	.strictObject({
		...CutoverOperationCommon,
		command: z.enum([
			"inspect_native_preservation",
			"capture_native_preservation",
			"audit_native_preservation",
			"inspect_sdk_preservation",
			"capture_sdk_preservation",
			"audit_sdk_preservation",
			"inspect_session_preservation",
			"capture_session_preservation",
			"audit_session_preservation",
			"inspect_session_rehydration",
			"inspect_custody_coverage",
			"inspect_capture_size",
			"inspect_historical_custody",
			"capture_historical_custody",
			"audit_historical_custody",
			"exclude_writers",
			"plan",
			"inspect_accounting",
			"transfer_accounting",
			"prepare",
			"bootstrap_prepare",
			"apply",
			"release",
			"quarantine",
		]),
		custodyTediId: z.string().uuid().optional(),
		continuation: z.string().min(1).optional(),
		coverageHash: CutoverMetadataHashSchema.optional(),
		archiveId: z.string().uuid().optional(),
		proof: z.string().min(1).max(131_072).optional(),
		expectedGeneration: z.number().int().nonnegative().safe(),
		verificationAction: z.enum(["initialize", "hold", "release"]).optional(),
		sourceHash: CutoverMetadataHashSchema.optional(),
		expectedSourceHash: CutoverMetadataHashSchema.optional(),
		evidenceHash: CutoverMetadataHashSchema.optional(),
		accountingManifestHash: CutoverMetadataHashSchema.optional(),
		reasonCode: z
			.enum([
				"operator_hold",
				"unknown_owner",
				"unresolved_work",
				"unresolved_effects",
				"identity_mismatch",
			])
			.optional(),
	})
	.describe(
		"Historical custody commands require an already nonactive canonical root and actual local Raw receiver. An optional registered targetPath selects one nonactive original descendant at its positive leaf generation; targetObjectId identifies that exact physical leaf. inspect_historical_custody supplies the exact engine source hash; capture_historical_custody pins that hash and atomically preserves the selected physical object fixed whitelist with replay seals; audit_historical_custody verifies the existing archive against its original hash and generation. Each archive covers only the selected physical object fixed whitelist, not complete descendant graph coverage, execution or financial coverage, or settlement of unknown effects. inspect_capture_size reads fixed-whitelist root scalar observations without changing admission or storage; ACTIVE pages are read-window observations, not an atomic snapshot, archive size, peak heap, financial coverage or writer exclusion. Continuations are encrypted. exclude_writers interrupts the root hosted graph and in-flight calls; no success receipt is returned. Lost transport outcome is UNKNOWN. Before retry, perform fresh authenticated inspection of the same current owner custody, physical object and nonactive generation and actual Raw receiver raw-cutover-v1. If verified, stop retrying; absent or changed proof leaves outcome UNKNOWN. Never retry automatically. This does not cancel provider Workflows or settle unknown effects.",
	)
	.pipe(CutoverOperationCommandsSchema);
export type TediRuntimeCutoverOperationQuery = z.infer<
	typeof TediRuntimeCutoverOperationQuerySchema
>;
const CutoverMutationResponseSchema = z
	.strictObject({
		ok: z.literal(true),
		id: TediRuntimeCutoverObjectIdSchema,
		targetObjectId: TediRuntimeCutoverObjectIdSchema.optional(),
		command: z.enum([
			"plan",
			"inspect_accounting",
			"transfer_accounting",
			"prepare",
			"bootstrap_prepare",
			"apply",
			"release",
			"quarantine",
		]),
		operationId: z.string().min(1).max(256),
		generation: z.number().int().nonnegative().safe(),
		state: z.enum(["uninitialized", "held", "active", "quarantined"]),
		sourceHash: CutoverMetadataHashSchema.optional(),
		evidenceHash: CutoverMetadataHashSchema.optional(),
		accountingManifestHash: CutoverMetadataHashSchema.optional(),
		sourceHashBefore: CutoverMetadataHashSchema.optional(),
		sourceHashAfter: CutoverMetadataHashSchema.optional(),
		destinationHashBefore: CutoverMetadataHashSchema.optional(),
		destinationHashAfter: CutoverMetadataHashSchema.optional(),
		records: CutoverMetadataCountSchema.optional(),
		unknown: CutoverMetadataCountSchema.optional(),
		nonterminal: CutoverMetadataCountSchema.optional(),
		entries: CutoverMetadataCountSchema.optional(),
		conversations: CutoverMetadataCountSchema.optional(),
		preservedNativeConversations: CutoverMetadataCountSchema.optional(),
	})
	.refine(
		(value) => (value.generation === 0) === (value.state === "uninitialized"),
		{ path: ["generation"], message: "Incoherent runtime admission epoch" },
	);
export const TediRuntimeCaptureSizeResponseSchema = z
	.strictObject({
		ok: z.literal(true),
		id: TediRuntimeCutoverObjectIdSchema,
		command: z.literal("inspect_capture_size"),
		operationId: z.string().min(1).max(256),
		generation: z.number().int().nonnegative().safe(),
		state: z.enum([
			"uninitialized",
			"active",
			"held",
			"quarantined",
			"retired",
		]),
		receiver: z.literal("raw-cutover-v1").optional(),
		selectorVersion: CutoverMetadataHashSchema,
		observation: z.literal("read_window_not_atomic_snapshot"),
		sampledAt: z.string().datetime(),
		complete: z.boolean(),
		continuation: z.string().min(1).optional(),
		sql: z.array(
			z.strictObject({
				category: z.enum(["fact", "history", "sdk"]),
				selector: CutoverMetadataCountSchema,
				present: z.boolean(),
				rows: CutoverMetadataCountSchema,
				castValueBytes: CutoverMetadataCountSchema,
				maxRowCastValueBytes: CutoverMetadataCountSchema,
			}),
		),
		kv: z.strictObject({
			entries: z.number().int().min(0).max(32),
			canonicalItemBytes: CutoverMetadataCountSchema,
		}),
	})
	.refine(
		(value) => (value.generation === 0) === (value.state === "uninitialized"),
		{ path: ["generation"], message: "Incoherent runtime admission epoch" },
	)
	.refine((value) => value.complete === (value.continuation === undefined), {
		path: ["continuation"],
		message: "Incoherent diagnostic continuation",
	});
export type TediRuntimeCaptureSizeResponse = z.infer<
	typeof TediRuntimeCaptureSizeResponseSchema
>;
export const TediRuntimeHistoricalCustodyResponseSchema = z.strictObject({
	ok: z.literal(true),
	id: TediRuntimeCutoverObjectIdSchema,
	targetObjectId: TediRuntimeCutoverObjectIdSchema.optional(),
	command: z.enum([
		"inspect_historical_custody",
		"capture_historical_custody",
		"audit_historical_custody",
	]),
	operationId: z.string().min(1).max(256),
	generation: z.number().int().positive().safe(),
	state: z.enum(["held", "quarantined", "retired"]),
	receiver: z.literal("raw-cutover-v1"),
	snapshotId: CutoverMetadataHashSchema,
	sourceHash: CutoverMetadataHashSchema,
	workflowCount: CutoverMetadataCountSchema,
	fiberCount: CutoverMetadataCountSchema,
	identityCount: CutoverMetadataCountSchema,
});
export const NativePreservationTableNames = [
	"pi_durable_schema",
	"pi_durable_metadata",
	"pi_record_ids",
	"pi_conversations",
	"pi_entries",
	"pi_tasks",
	"pi_submissions",
	"pi_documents",
	"pi_document_revisions",
	"chat_sdk_state_subscriptions",
	"chat_sdk_state_locks",
	"chat_sdk_state_cache",
	"chat_sdk_state_queue",
	"chat_sdk_state_lists",
	"chat_sdk_state_metadata",
	"cf_agents_state",
	"runtime_admission",
	"cf_agents_sub_agents",
	"runtime_admission_turns",
	"runtime_admission_operations",
	"runtime_admission_identities",
	"runtime_admission_evidence",
	"runtime_admission_receipts",
] as const;
const NativePreservationSummarySchema = z.strictObject({
	format: z.literal("native-state-archive-v1"),
	archiveId: z.string().uuid(),
	selectorVersion: CutoverMetadataHashSchema,
	metadata: z.strictObject({
		tables: z
			.array(
				z.strictObject({
					table: z.enum(NativePreservationTableNames),
					present: z.boolean(),
					rows: CutoverMetadataCountSchema,
					schema: z.enum(["absent", "unknown"]),
				}),
			)
			.length(23)
			.refine((rows) =>
				rows.every(
					(r, i) =>
						r.table === NativePreservationTableNames[i] &&
						r.present === (r.schema === "unknown") &&
						(r.present || r.rows === 0),
				),
			),
		kvEntries: CutoverMetadataCountSchema,
		sourceBytes: CutoverMetadataCountSchema,
		recordCount: CutoverMetadataCountSchema,
		localOwnerUnknown: z.boolean(),
	}),
	metadataDigest: CutoverMetadataHashSchema,
	projectionDigest: z.null(),
	legacyArchive: z.discriminatedUnion("state", [
		z.strictObject({ state: z.literal("absent") }),
		z.strictObject({
			state: z.literal("present"),
			snapshotId: CutoverMetadataHashSchema,
			sourceHash: CutoverMetadataHashSchema,
			generation: z.number().int().positive().safe(),
			workflowCount: CutoverMetadataCountSchema,
			fiberCount: CutoverMetadataCountSchema,
			identityCount: CutoverMetadataCountSchema,
		}),
	]),
});
const NativePreservationResponseCommon = {
	ok: z.literal(true),
	id: TediRuntimeCutoverObjectIdSchema,
	targetObjectId: TediRuntimeCutoverObjectIdSchema,
	operationId: z.string().min(1).max(256),
	generation: z.number().int().positive().safe(),
	state: z.enum(["held", "quarantined", "retired"]),
	receiver: z.literal("raw-cutover-v1"),
};
export const TediRuntimeNativePreservationResponseSchema = z.discriminatedUnion(
	"command",
	[
		z.strictObject({
			...NativePreservationResponseCommon,
			command: z.literal("inspect_native_preservation"),
			archive: NativePreservationSummarySchema,
			proof: z.string().min(1).max(131_072),
		}),
		z.strictObject({
			...NativePreservationResponseCommon,
			command: z.literal("capture_native_preservation"),
			archive: NativePreservationSummarySchema,
		}),
		z.strictObject({
			...NativePreservationResponseCommon,
			command: z.literal("audit_native_preservation"),
			archive: NativePreservationSummarySchema.nullable(),
		}),
	],
);
export const SessionPreservationTableNames = [
	"session_entries",
	"cf_agents_session_messages",
	"cf_agents_session_message_chunks",
	"cf_agents_session_compactions",
	"cf_agents_session_config",
	"cf_agents_session_attachment_meta",
	"cf_agents_session_attachment_chunks",
	"cf_agents_session_attachment_refs",
] as const;
const SessionPreservationSummarySchema = z.strictObject({
	format: z.literal("session-state-archive-v1"),
	archiveId: z.string().uuid(),
	selectorVersion: CutoverMetadataHashSchema,
	metadata: z.strictObject({
		tables: z
			.array(
				z.strictObject({
					table: z.enum(SessionPreservationTableNames),
					present: z.boolean(),
					rows: CutoverMetadataCountSchema,
					schema: z.enum(["absent", "unknown"]),
				}),
			)
			.length(8)
			.refine((rows) =>
				rows.every(
					(r, i) =>
						r.table === SessionPreservationTableNames[i] &&
						r.present === (r.schema === "unknown") &&
						(r.present || r.rows === 0),
				),
			),
		sourceBytes: CutoverMetadataCountSchema,
		recordCount: CutoverMetadataCountSchema,
		localOwnerUnknown: z.boolean(),
	}),
	metadataDigest: CutoverMetadataHashSchema,
	projectionDigest: z.null(),
	priorArchives: z.strictObject({
		historical: z.enum(["absent", "present"]),
		native: z.enum(["absent", "present"]),
	}),
});
export const TediRuntimeSessionPreservationResponseSchema =
	z.discriminatedUnion("command", [
		z.strictObject({
			...NativePreservationResponseCommon,
			command: z.literal("inspect_session_preservation"),
			archive: SessionPreservationSummarySchema,
			proof: z.string().min(1).max(131_072),
		}),
		z.strictObject({
			...NativePreservationResponseCommon,
			command: z.literal("capture_session_preservation"),
			archive: SessionPreservationSummarySchema,
		}),
		z.strictObject({
			...NativePreservationResponseCommon,
			command: z.literal("audit_session_preservation"),
			archive: SessionPreservationSummarySchema.nullable(),
		}),
	]);
const SessionSemanticObservationSchema = z
	.strictObject({
		status: z.enum(["supported", "absent", "unavailable"]),
		reason: z
			.enum(["budget_unavailable", "unsupported_schema", "invalid_semantics"])
			.nullable(),
		sessions: CutoverMetadataCountSchema,
		messages: CutoverMetadataCountSchema,
		branches: CutoverMetadataCountSchema,
		compactions: CutoverMetadataCountSchema,
		attachments: CutoverMetadataCountSchema,
	})
	.refine(
		(v) =>
			(v.status === "unavailable") === (v.reason !== null) &&
			(v.status === "supported" ||
				v.sessions + v.messages + v.branches + v.compactions + v.attachments ===
					0),
	);
export const SessionSemanticBudgetSchema = z.strictObject({
	policy: z.literal("session-semantic-stream-v2"),
	sourceBytes: z.number().int().nonnegative().safe(),
	selectedRows: z.number().int().nonnegative().safe(),
	processedRows: z.number().int().min(0).max(20000),
	workUnits: z.number().int().min(0).max(200000),
	scanBytes: z.number().int().min(0).max(67108864),
	retainedBytes: z.number().int().min(0).max(8388608),
	exhausted: z
		.enum([
			"source_bytes",
			"selected_rows",
			"retained_bytes",
			"semantic_work",
			"scan_bytes",
			"time",
		])
		.nullable(),
	attemptedCharge: z.number().int().positive().safe().nullable(),
	clockExpired: z.boolean(),
	retainedAtFailure: z.number().int().min(0).max(8388608).nullable(),
});
export const TediRuntimeSessionRehydrationResponseSchema = z
	.strictObject({
		...NativePreservationResponseCommon,
		command: z.literal("inspect_session_rehydration"),
		archive: SessionPreservationSummarySchema.nullable(),
		qualification: z
			.strictObject({
				schemaVersion: z.literal(2),
				budget: SessionSemanticBudgetSchema,
				scope: z.literal("archived_selected_session8"),
				archiveAuthenticated: z.literal(true),
				parentLocal: SessionSemanticObservationSchema,
				sdk7: SessionSemanticObservationSchema,
				canonicalLedgerCorrespondence: z.literal("not_queried"),
				adoptionReady: z.literal(false),
				executionEligible: z.literal(false),
			})
			.nullable(),
	})
	.refine((v) => {
		if ((v.archive === null) !== (v.qualification === null)) return false;
		if (!v.archive || !v.qualification) return true;
		const tables = v.archive.metadata.tables,
			p = v.qualification.parentLocal,
			s = v.qualification.sdk7,
			root = tables[0]!,
			sdk = tables.slice(1),
			messages = sdk[0]!,
			compactions = sdk[2]!,
			attachments = sdk[4]!;
		const budget = v.qualification.budget;
		let selectedRows = 0;
		for (const t of tables) {
			if (t.rows > Number.MAX_SAFE_INTEGER - selectedRows) return false;
			selectedRows += t.rows;
		}
		if (
			budget.sourceBytes !== v.archive.metadata.sourceBytes ||
			budget.selectedRows !== selectedRows ||
			budget.processedRows > selectedRows
		)
			return false;
		const priority =
			budget.sourceBytes > 8388608
				? "source_bytes"
				: selectedRows > 20000
					? "selected_rows"
					: null;
		if (priority) {
			if (
				budget.exhausted !== priority ||
				budget.processedRows !== 0 ||
				budget.workUnits !== 0 ||
				budget.scanBytes !== 0 ||
				budget.retainedBytes !== 0 ||
				budget.attemptedCharge !== null ||
				budget.retainedAtFailure !== null ||
				budget.clockExpired
			)
				return false;
		} else if (
			budget.exhausted === "source_bytes" ||
			budget.exhausted === "selected_rows"
		)
			return false;
		const reason = budget.exhausted;
		if (
			reason === "semantic_work" ||
			reason === "scan_bytes" ||
			reason === "retained_bytes"
		) {
			if (budget.attemptedCharge === null || budget.clockExpired) return false;
			const used =
				reason === "semantic_work"
					? budget.workUnits
					: reason === "scan_bytes"
						? budget.scanBytes
						: budget.retainedAtFailure;
			const max =
				reason === "semantic_work"
					? 200000
					: reason === "scan_bytes"
						? 67108864
						: 8388608;
			if (used === null || budget.attemptedCharge <= max - used) return false;
		} else if (budget.attemptedCharge !== null) return false;
		if ((reason === "time") !== budget.clockExpired) return false;
		if (
			reason !== "retained_bytes"
				? budget.retainedAtFailure !== null
				: budget.retainedAtFailure === null ||
					budget.retainedAtFailure > budget.retainedBytes
		)
			return false;
		if (
			reason === null &&
			(budget.processedRows !== selectedRows ||
				budget.workUnits < budget.processedRows ||
				budget.scanBytes < budget.sourceBytes)
		)
			return false;
		const budgetState =
			p.reason === "budget_unavailable" && s.reason === "budget_unavailable";
		if (
			(reason !== null) !== budgetState ||
			(!budgetState &&
				(p.reason === "budget_unavailable" ||
					s.reason === "budget_unavailable"))
		)
			return false;

		const coherent = (
			o: z.infer<typeof SessionSemanticObservationSchema>,
			present: boolean,
		) =>
			o.status === "absent" ? !present : o.status !== "supported" || present;
		return (
			coherent(p, root.present) &&
			coherent(
				s,
				sdk.some((t) => t.present),
			) &&
			p.messages + p.compactions <= root.rows &&
			p.sessions <= root.rows &&
			p.branches <= root.rows &&
			p.attachments === 0 &&
			s.messages <= messages.rows &&
			s.compactions <= compactions.rows &&
			s.attachments <= attachments.rows &&
			s.branches <= messages.rows &&
			s.sessions <= messages.rows + sdk[3]!.rows &&
			(p.status !== "supported" ||
				root.rows === 0 ||
				(p.sessions > 0 && p.branches > 0)) &&
			(s.status !== "supported" ||
				(sdk.every((t) => t.present) &&
					s.messages === messages.rows &&
					s.compactions === compactions.rows &&
					s.attachments === attachments.rows &&
					(messages.rows === 0 || (s.sessions > 0 && s.branches > 0))))
		);
	});
export const SdkPreservationTableNames = [
	"cf_agents_jobs",
	"cf_agents_schedules",
	"cf_agents_queues",
	"cf_agents_fibers",
	"cf_agents_runs",
	"cf_agents_facet_runs",
	"cf_agents_task_runs",
	"cf_agents_task_steps",
	"cf_agent_tool_runs",
	"cf_agents_workflows",
	"cf_think_submissions",
	"cf_think_scheduled_tasks",
	"assistant_messages",
	"assistant_compactions",
	"assistant_sessions",
	"assistant_config",
	"cf_agents_context_blocks",
	"cf_agents_search_entries",
	"cf_ai_chat_stream_metadata",
	"cf_ai_chat_stream_chunks",
	"cf_agents_chat_progress",
	"cf_agents_streams",
	"cf_agents_stream_blocks",
	"cf_agents_mcp_servers",
	"cf_agents_routed_agents",
	"assistant_fts",
	"cf_agents_session_fts",
	"cf_agents_search_fts",
	"assistant_fts_data",
	"assistant_fts_idx",
	"assistant_fts_content",
	"assistant_fts_docsize",
	"assistant_fts_config",
	"cf_agents_session_fts_data",
	"cf_agents_session_fts_idx",
	"cf_agents_session_fts_content",
	"cf_agents_session_fts_docsize",
	"cf_agents_session_fts_config",
	"cf_agents_search_fts_data",
	"cf_agents_search_fts_idx",
	"cf_agents_search_fts_content",
	"cf_agents_search_fts_docsize",
	"cf_agents_search_fts_config",
] as const;
export const SdkPreservationSummarySchema = z.strictObject({
	format: z.literal("sdk-work-state-archive-v1"),
	archiveId: z.string().uuid(),
	selectorVersion: z.literal(
		"420335a11e49b81134025035a54fc9cda5b6b1bec4dd2b276f3766531651e242",
	),
	metadata: z.strictObject({
		tables: z
			.array(
				z.strictObject({
					table: z.enum(SdkPreservationTableNames),
					present: z.boolean(),
					rows: CutoverMetadataCountSchema,
					schema: z.enum(["absent", "unknown"]),
				}),
			)
			.length(43)
			.refine((rows) =>
				rows.every(
					(r, i) =>
						r.table === SdkPreservationTableNames[i] &&
						r.present === (r.schema === "unknown") &&
						(r.present || r.rows === 0) &&
						(i < 25 || (!r.present && r.rows === 0)),
				),
			),
		kvEntries: CutoverMetadataCountSchema,
		sourceBytes: CutoverMetadataCountSchema,
		recordCount: CutoverMetadataCountSchema,
		localOwnerUnknown: z.boolean(),
	}),
	metadataDigest: CutoverMetadataHashSchema,
	projectionDigest: z.null(),
	priorArchives: z.strictObject({
		historical: z.enum(["absent", "present"]),
		native: z.enum(["absent", "present"]),
		session: z.enum(["absent", "present"]),
	}),
	alarmCovered: z.literal(false),
	alarmConsistency: z.literal("UNKNOWN"),
});
export const TediRuntimeSdkPreservationResponseSchema = z.discriminatedUnion(
	"command",
	[
		z.strictObject({
			...NativePreservationResponseCommon,
			command: z.literal("inspect_sdk_preservation"),
			archive: SdkPreservationSummarySchema,
			proof: z.string().min(1).max(131_072),
		}),
		z.strictObject({
			...NativePreservationResponseCommon,
			command: z.literal("capture_sdk_preservation"),
			archive: SdkPreservationSummarySchema,
		}),
		z.strictObject({
			...NativePreservationResponseCommon,
			command: z.literal("audit_sdk_preservation"),
			archive: SdkPreservationSummarySchema.nullable(),
		}),
	],
);

/** Coverage declarations describe metadata, never authenticated content preservation. */
export const CustodyCoverageSqlItemSchema = z.strictObject({
	domain: z.literal("sql"),
	name: z.string().min(1).max(65_536),
	type: z.enum(["table", "index", "trigger", "view"]),
	tableName: z.string().min(1).max(65_536),
	ddlHash: CutoverMetadataHashSchema.nullable(),
	columnsHash: CutoverMetadataHashSchema.nullable(),
	shape: z.enum([
		"ordinary",
		"view",
		"virtual",
		"shadow",
		"generated",
		"case_collision",
		"provider_private",
	]),
	classification: z.enum(["declared", "uncovered", "unsupported"]),
	memberships: z
		.array(
			z.enum(["native23", "session8", "sdk43", "historical", "prior_archive"]),
		)
		.max(5),
	archiveAuthenticated: z.literal(false),
});
export const CustodyCoverageRegistryItemSchema = z
	.strictObject({
		domain: z.literal("registry"),
		className: CutoverInspectionHopSchema.shape.className,
		name: CutoverInspectionHopSchema.shape.name,
		identityVersion: CutoverInspectionHopSchema.shape.identityVersion,
		identityName: CutoverInspectionHopSchema.shape.identityName,
		objectId: TediRuntimeCutoverObjectIdSchema,
		parentGeneration: CutoverInspectionHopSchema.shape.parentGeneration,
		registryMetadataHash: CutoverMetadataHashSchema,
		routingCustody: z.literal("not_queried"),
		disposition: z.literal("registered_not_visited"),
		childGeneration: z.null(),
		localOwner: z.literal("UNKNOWN"),
	})
	.refine(
		(v) =>
			v.identityVersion === "path-v2"
				? v.identityName !== null
				: v.identityName === null,
		{ message: "Inconsistent descriptive identity" },
	);
export const TediRuntimeCustodyCoverageResponseSchema = z
	.strictObject({
		...NativePreservationResponseCommon,
		command: z.literal("inspect_custody_coverage"),
		version: z.literal("custody-coverage-metadata-v1"),
		coverageHash: CutoverMetadataHashSchema,
		sqlMetadataHash: CutoverMetadataHashSchema,
		registryHash: CutoverMetadataHashSchema,
		issuedAt: z.number().int().nonnegative().safe(),
		expiresAt: z.number().int().nonnegative().safe(),
		sqlObjects: CutoverMetadataCountSchema,
		registeredTargets: CutoverMetadataCountSchema,
		offset: CutoverMetadataCountSchema,
		items: z
			.array(
				z.union([
					CustodyCoverageSqlItemSchema,
					CustodyCoverageRegistryItemSchema,
				]),
			)
			.max(200),
		continuation: z.string().min(1).max(131_072).nullable(),
		metadataEnumerationComplete: z.boolean(),
		kv: z.strictObject({
			status: z.literal("unsupported_metadata_only_enumeration_unavailable"),
			enumeration: z.literal("not_queried"),
			complete: z.literal(false),
			keyCount: z.null(),
			keyIdentityHash: z.null(),
			valueCoverage: z.literal("not_queried"),
			payloadAuthenticity: z.literal("not_queried"),
		}),
		alarm: z.literal("UNKNOWN"),
		remoteEffects: z.literal("not_queried"),
		writerExclusionAck: z.literal("UNKNOWN"),
		wholeContentPreserved: z.literal(false),
		wholePreservationReady: z.literal(false),
		adoptionReady: z.literal(false),
		executionEligible: z.literal(false),
		financialClearance: z.literal(false),
	})
	.superRefine((v, ctx) => {
		const total = v.sqlObjects + v.registeredTargets,
			end = v.offset + v.items.length;
		if (
			!Number.isSafeInteger(total) ||
			!Number.isSafeInteger(end) ||
			v.expiresAt - v.issuedAt !== 300000 ||
			end > total ||
			v.offset > total ||
			v.items.length !== Math.min(200, total - v.offset) ||
			v.metadataEnumerationComplete !== (end === total) ||
			(v.continuation === null) !== v.metadataEnumerationComplete ||
			v.items.some(
				(r, i) =>
					r.domain !== (v.offset + i < v.sqlObjects ? "sql" : "registry") ||
					(r.domain === "registry" &&
						(r.registryMetadataHash !== v.registryHash ||
							r.parentGeneration !== v.generation)),
			)
		)
			ctx.addIssue({
				code: "custom",
				message: "Incoherent custody metadata page",
			});
	});
export type TediRuntimeCustodyCoverageResponse = z.infer<
	typeof TediRuntimeCustodyCoverageResponseSchema
>;

export const TediRuntimeCutoverOperationResponseSchema = z.union([
	TediRuntimeCustodyCoverageResponseSchema,
	TediRuntimeSessionRehydrationResponseSchema,
	TediRuntimeSessionPreservationResponseSchema,
	TediRuntimeSdkPreservationResponseSchema,
	TediRuntimeNativePreservationResponseSchema,
	CutoverMutationResponseSchema,
	TediRuntimeCaptureSizeResponseSchema,
	TediRuntimeHistoricalCustodyResponseSchema,
]);
export type TediRuntimeCutoverOperationResponse = z.infer<
	typeof TediRuntimeCutoverOperationResponseSchema
>;

export const TediWakeResponseSchema = z.object({
	success: z.boolean(),
	ready: z.boolean(),
	woke: z.boolean(),
	restoredFromBackup: z.boolean(),
	status: z.string(),
	processId: z.string().nullable(),
	waitMs: z.number(),
	attempts: z.number().optional(),
	recoveredBySandboxReset: z.boolean().optional(),
	message: z.string().optional(),
});
export type TediWakeResponse = z.infer<typeof TediWakeResponseSchema>;

export const TediResetSandboxResponseSchema = z.object({
	success: z.boolean(),
	message: z.string(),
	audit: z
		.object({
			tediId: z.string(),
			triggeredBy: z.string(),
			triggeredAt: z.string(),
			reason: z.string().nullable(),
		})
		.optional(),
});
export type TediResetSandboxResponse = z.infer<
	typeof TediResetSandboxResponseSchema
>;

export const TediSyncStorageResponseSchema = z.object({
	success: z.boolean(),
	lastSync: z.string().nullable(),
	backupHandles: z
		.object({
			runtimeId: z.string().nullable().optional(),
			runtimeDir: z.string().nullable().optional(),
			runtimePresent: z.boolean().optional(),
			workspaceId: z.string().nullable().optional(),
			workspaceDir: z.string().nullable().optional(),
			workspacePresent: z.boolean().optional(),
			createdAt: z.string().nullable().optional(),
			createdAtValid: z.boolean().optional(),
			restorable: z.boolean().optional(),
			format: z
				.enum(["missing", "unified", "legacy-split", "unknown"])
				.optional(),
			issues: z.array(z.string()).optional(),
			primaryIssue: z.string().nullable().optional(),
		})
		.optional(),
	error: z.string().optional(),
	details: z.string().optional(),
});
export type TediSyncStorageResponse = z.infer<
	typeof TediSyncStorageResponseSchema
>;

export const TediCronSyncResponseSchema = z.object({
	success: z.boolean(),
	cronBootstrap: z.object({
		ok: z.boolean(),
		forceUpdate: z.boolean(),
		templateCount: z.number().int().nonnegative(),
		existingCount: z.number().int().nonnegative(),
		plannedCount: z.number().int().nonnegative(),
		appliedCount: z.number().int().nonnegative(),
		actions: z.array(
			z.object({
				op: z.enum(["add", "update", "remove"]),
				name: z.string(),
			}),
		),
		errors: z.array(z.string()),
	}),
});
export type TediCronSyncResponse = z.infer<typeof TediCronSyncResponseSchema>;

export const TediDeviceListSchema = z.object({
	pending: z.array(TediDeviceSchema),
	paired: z.array(TediDeviceSchema),
});
export type TediDeviceList = z.infer<typeof TediDeviceListSchema>;

export const TediChannelStatusResponseSchema = z.object({
	channels: z.array(RuntimeChannelStatusSchema),
	observedAt: z.string(),
});
export type TediChannelStatusResponse = z.infer<
	typeof TediChannelStatusResponseSchema
>;

export const TediPairingRequestSchema = z.object({
	code: z.string(),
	senderId: z.string().optional(),
	senderName: z.string().optional(),
	createdAt: z.string().optional(),
});
export type TediPairingRequest = z.infer<typeof TediPairingRequestSchema>;

export const TediPairingRequestListSchema = z.object({
	channel: z.string(),
	pending: z.array(TediPairingRequestSchema),
	count: z.number(),
});
export type TediPairingRequestList = z.infer<
	typeof TediPairingRequestListSchema
>;

export const TediPairingApproveResponseSchema = z.object({
	success: z.boolean(),
	channel: z.string(),
	code: z.string(),
	message: z.string(),
});
export type TediPairingApproveResponse = z.infer<
	typeof TediPairingApproveResponseSchema
>;

export const TediChannelGroupConfigSchema = z.object({
	groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
	requireMention: z.boolean().optional(),
	allowFrom: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
});
export type TediChannelGroupConfig = z.infer<
	typeof TediChannelGroupConfigSchema
>;

export const TediChannelConfigSchema = z.object({
	// Common fields (all channels)
	dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
	allowFrom: z.array(z.string()).optional(),
	groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
	groupAllowFrom: z.array(z.string()).optional(),
	requireMention: z.boolean().optional(),
	// Telegram: groups (per-group overrides)
	groups: z.record(z.string(), TediChannelGroupConfigSchema).optional(),
	// Signal
	account: z.string().optional(),
	httpUrl: z.string().optional(),
	autoStart: z.boolean().optional(),
	startupTimeoutMs: z.number().optional(),
	receiveMode: z.enum(["native", "json-rpc"]).optional(),
	// Voice (phone calls via Twilio)
	inboundPolicy: z.enum(["allowlist", "open", "disabled"]).optional(),
	inboundGreeting: z.string().optional(),
	outboundMode: z.enum(["conversation", "notify"]).optional(),
	enabled: z.boolean().optional(),
});
export type TediChannelConfig = z.infer<typeof TediChannelConfigSchema>;

export const TediChannelConfigUpdateResponseSchema = z.object({
	success: z.boolean(),
	message: z.string(),
	syncResult: z
		.object({
			success: z.boolean(),
			message: z.string(),
		})
		.optional(),
});
export type TediChannelConfigUpdateResponse = z.infer<
	typeof TediChannelConfigUpdateResponseSchema
>;

export const TediSessionKeySchema = z
	.string()
	.min(1)
	.max(512)
	.regex(/^[a-zA-Z0-9:._-]+$/);
export type TediSessionKey = z.infer<typeof TediSessionKeySchema>;

export const TediSessionStateSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	tediId: z.string(),
	userId: z.string(),
	sessionKey: TediSessionKeySchema,
	title: z.string().nullable(),
	pinnedAt: z.string().nullable(),
	deletedAt: z.string().nullable(),
	lastSeenAt: z.number().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type TediSessionState = z.infer<typeof TediSessionStateSchema>;

export const TediSessionStatePatchSchema = z.object({
	title: z.string().trim().min(1).max(80).nullable().optional(),
	derivedTitle: z.string().trim().min(1).max(80).optional(),
	pinned: z.boolean().optional(),
	deleted: z.boolean().optional(),
	lastSeenAt: z.number().nullable().optional(),
});
export type TediSessionStatePatch = z.infer<typeof TediSessionStatePatchSchema>;

export const TediSessionStateListSchema = z.object({
	states: z.array(TediSessionStateSchema),
});
export type TediSessionStateList = z.infer<typeof TediSessionStateListSchema>;

export const TediSessionDeleteResponseSchema = z.object({
	success: z.boolean(),
	sessionKey: TediSessionKeySchema,
	runtimeDeleted: z.boolean().optional(),
	retainedTranscripts: z.array(z.string()).optional(),
});
export type TediSessionDeleteResponse = z.infer<
	typeof TediSessionDeleteResponseSchema
>;

/**
 * Bulk session delete (`deleteSessions`). `matched` is the resolved target set
 * (after the explicit-list / pattern / age filter AND the hard
 * `agent:main:main` guard); `deleted` is how many were actually soft-deleted
 * (0 when `dryRun`).
 */
export const TediSessionsBulkDeleteResponseSchema = z.object({
	matched: z.array(z.string()),
	deleted: z.number().int(),
	dryRun: z.boolean(),
});
export type TediSessionsBulkDeleteResponse = z.infer<
	typeof TediSessionsBulkDeleteResponseSchema
>;

export const TediPeerSchema = z.object({
	id: z.string(),
	name: z.string(),
	slug: z.string(),
	status: z.string(),
	description: z.string().optional(),
});
export type TediPeer = z.infer<typeof TediPeerSchema>;

export const TediPeerListSchema = z.object({
	peers: z.array(TediPeerSchema),
});
export type TediPeerList = z.infer<typeof TediPeerListSchema>;

export const TediRotateAccessKeyResponseSchema = z.object({
	success: z.boolean(),
	message: z.string(),
	descopeKeyId: z.string(),
	oldKeyDeactivated: z.boolean(),
	runtimeRefreshed: z.boolean(),
});
export type TediRotateAccessKeyResponse = z.infer<
	typeof TediRotateAccessKeyResponseSchema
>;

export const TediSyncConfigResponseSchema = z.object({
	success: z.boolean(),
	message: z.string(),
	workspaceFiles: z.object({
		"SOUL.md": z.string(),
		"IDENTITY.md": z.string(),
		"USER.md": z.string(),
		"AGENTS.md": z.string(),
		"TOOLS.md": z.string(),
		"MEMORY.md": z.string(),
		"HEARTBEAT.md": z.string(),
	}),
	syncResult: z
		.object({
			success: z.boolean(),
			message: z.string(),
		})
		.optional(),
});
export type TediSyncConfigResponse = z.infer<
	typeof TediSyncConfigResponseSchema
>;

/**
 * Per-role model policy for a tedi, resolved from
 * `runtime_profile_id → runtime_profiles.config.modelPolicy`.
 * `null` when the tedi has no runtime profile or no policy for that surface (the
 * runtime falls back to its env default model). Read by the tedi runtime DO to
 * select this role's model (kernel=cheap/fast, CTO=full-power, CFO=small).
 *
 * Every response carries all three surface refs. Stored profiles were
 * backfilled before the optional-field compatibility path was removed.
 * Runtime fallback chains:
 * chat → `chatModelRef`; cron → `cronModelRef` → `chatModelRef`;
 * observer → `observerModelRef` (observer-only: the observer path has its own
 * env default deployment that `chatModelRef` has never steered).
 */
export const TediModelPolicyResponseSchema = z.object({
	chatModelRef: z.string().nullable(),
	/** Scheduled/cron turns. Null only for a deliberate fixed-model fallback. */
	cronModelRef: z.string().nullable(),
	/** Post-turn observer/reflector. Null only for a deliberate fixed fallback. */
	observerModelRef: z.string().nullable(),
	generation: ModelGenerationPolicySchema.optional().describe(
		"Absent when the runtime profile has no explicit generation settings; runtime defaults apply.",
	),
});
export type TediModelPolicyResponse = z.infer<
	typeof TediModelPolicyResponseSchema
>;

export const TediRuntimeProjectionResponseSchema = z.object({
	snapshot: TediRuntimeSnapshotSchema.nullable(),
	usageEvents: z.array(TediUsageEventSchema),
});
export type TediRuntimeProjectionResponse = z.infer<
	typeof TediRuntimeProjectionResponseSchema
>;

export const TediIngestProjectionResponseSchema = z.object({
	ok: z.boolean(),
	snapshotId: z.uuid(),
	usageEventCount: z.number(),
});
export type TediIngestProjectionResponse = z.infer<
	typeof TediIngestProjectionResponseSchema
>;

export const TediRepairResponseSchema = z.object({
	repaired: z.array(z.string()),
	alreadyPresent: z.array(z.string()),
	errors: z.array(z.string()),
});
export type TediRepairResponse = z.infer<typeof TediRepairResponseSchema>;

// =============================================================================
// GOVERNANCE OVERRIDE
// =============================================================================

/**
 * Input for `updateTediGovernance`.
 * `requiresApproval: true`  → tedi is gated (human approval needed before dispatch).
 * `requiresApproval: false` → tedi is autonomous (auto-dispatch enabled).
 * `requiresApproval: null`  → clear the override; revert to policy pack derivation.
 */
export const UpdateTediGovernanceInputSchema = z.object({
	tediId: z.uuid("Tedi ID must be a valid UUID"),
	requiresApproval: z
		.boolean()
		.nullable()
		.describe(
			"true = gated (requires approval), false = autonomous, null = clear override (revert to policy pack)",
		),
});
export type UpdateTediGovernanceInput = z.infer<
	typeof UpdateTediGovernanceInputSchema
>;

export const UpdateTediGovernanceResponseSchema = z.object({
	tediId: z.uuid(),
	slug: z.string(),
	governanceOverride: z
		.object({
			requiresApproval: z.boolean().optional(),
		})
		.nullable(),
	/** Effective requiresApproval value after applying the override (or pack fallback). */
	requiresApproval: z.boolean(),
	autonomy: z.enum(["gated", "autonomous"]),
});
export type UpdateTediGovernanceResponse = z.infer<
	typeof UpdateTediGovernanceResponseSchema
>;

export const TediInitiateConnectionResponseSchema = z.object({
	connectUrl: z.string(),
	providerName: z.string(),
	message: z.string(),
});
export type TediInitiateConnectionResponse = z.infer<
	typeof TediInitiateConnectionResponseSchema
>;
