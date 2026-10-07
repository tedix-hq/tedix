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

/** A Durable Object ID hop, kept for recorded historical billing exposure payloads. */
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
