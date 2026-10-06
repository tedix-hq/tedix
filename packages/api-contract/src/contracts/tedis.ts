import {
	EmbeddedModelSelectionSchema,
	EmbeddedTediSelectionSchema,
} from "../schemas/embedded-widget-access";
import { HostDelegationSchema } from "../schemas/host-delegation";
import {
	EmbeddedContactProfilePatchSchema,
	EmbeddedContactIdentitySchema,
	EmbeddedContactUserSchema,
	EmbeddedContactCompanySchema,
} from "../schemas/embedded-contact";
import { ProviderOnboardingSchema } from "../schemas/organization";
import { ProviderCapacityPolicySchema } from "../schemas/billing";
import {
	EmbeddedWidgetAccessPolicySchema,
	EmbeddedWidgetAccessConfigurationSchema,
	EmbeddedWidgetAccessDecisionSchema,
} from "../schemas/embedded-widget-access";
import "@orpc/openapi/extensions/route";
/**
 * Tedis Contract
 * oRPC contract for tedi instance management
 *
 * Used by: apps/os (unified control plane), tedi Workers
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	RunTediDurableCodeInputSchema,
	ListTediCodeExecutionsInputSchema,
	GetTediCodeExecutionInputSchema,
	ApproveTediCodeExecutionInputSchema,
	RejectTediCodeExecutionInputSchema,
	RollbackTediCodeExecutionInputSchema,
	RecoverTediCodeExecutionInputSchema,
	RecoverTediCodeExecutionOutputSchema,
	TediDurableCodeOutputSchema,
	ListTediCodeExecutionsOutputSchema,
	GetTediCodeExecutionOutputSchema,
	RejectTediCodeExecutionOutputSchema,
	RollbackTediCodeExecutionOutputSchema,
} from "../schemas/tedi-durable-code";
import {
	JsonValueSchema,
	PaginationMetaSchema,
	PaginationSchema,
	SuccessResponseSchema,
} from "../schemas/common";
import {
	AddCustomDomainInputSchema,
	ChannelTokenValidationSchema,
	CreateTediInputSchema,
	CustomDomainSchema,
	IngestRuntimeProjectionInputSchema,
	ListTediRuntimeMetaBySlugsInputSchema,
	ListTediRuntimeMetaBySlugsResponseSchema,
	TediBackupAuditResponseSchema,
	TediChannelConfigSchema,
	TediChannelConfigUpdateResponseSchema,
	TediChannelStatusResponseSchema,
	TediCronSyncResponseSchema,
	TediDeviceListSchema,
	TediDreamsSchema,
	TediIdParamSchema,
	TediIngestProjectionResponseSchema,
	TediInitiateConnectionResponseSchema,
	TediModelPolicyResponseSchema,
	TediPairingApproveResponseSchema,
	TediPairingRequestListSchema,
	TediPeerListSchema,
	TediProcessLogsSchema,
	TediRepairResponseSchema,
	TediResetSandboxResponseSchema,
	TediRotateAccessKeyResponseSchema,
	TediRuntimeProjectionResponseSchema,
	TediRuntimeStatusSchema,
	TediScheduleListResponseSchema,
	TediRuntimeOutboxDiagnosticResponseSchema,
	TediRuntimeCutoverQuerySchema,
	TediRuntimeCutoverOperationQuerySchema,
	TediRuntimeCutoverOperationResponseSchema,
	TediRuntimeCutoverInventoryResponseSchema,
	TediRuntimeRecoveryQuerySchema,
	TediRuntimeRecoveryDiagnosticResponseSchema,
	TediSchema,
	TediStatusSchema,
	TediSessionDeleteResponseSchema,
	TediSessionKeySchema,
	TediSessionStateListSchema,
	TediSessionStatePatchSchema,
	TediSessionStateSchema,
	TediSessionsBulkDeleteResponseSchema,
	TediStorageFileSchema,
	TediStorageFilesSchema,
	TediStorageStatusSchema,
	TediSuccessMessageSchema,
	TediSyncConfigResponseSchema,
	TediSyncStorageResponseSchema,
	TediWakeResponseSchema,
	TediWriteStorageFileInputSchema,
	TediWriteStorageFileResultSchema,
	UpdateTediGovernanceInputSchema,
	UpdateTediGovernanceResponseSchema,
	UpdateTediInputSchema,
} from "../schemas/tedi";
import { DelegationProfileSchema } from "./earned-delegation";
import { CronExecutionSchema } from "./flywheel-health";
import { GrowthSnapshotMetricsSchema } from "./growth-snapshots";
import { PortableWebMcpProfileSchema } from "../schemas/portable-webmcp";
import {
	PortableTediGitReadAccessInputSchema,
	PortableTediGitReadAccessOutputSchema,
	PortableTediImportBeginInputSchema,
	PortableTediImportBeginOutputSchema,
	PortableTediSnapshotPageInputSchema,
	PortableTediSnapshotPageOutputSchema,
} from "../schemas/portable-tedi";
import { CapabilitySchema } from "./capabilities";
import {
	ConversationCapabilityReplayNameSchema,
	ConversationCapabilitySchema,
	ConversationArtifactPinSchema,
} from "../schemas/kernel-runtime";

export const EmbeddedConversationCapabilityTargetSchema =
	TediIdParamSchema.extend({
		conversationId: z.string().regex(/^embed:[A-Za-z0-9_-]{32}$/),
	});

const TediOperationsTaskSchema = z.object({
	id: z.string(),
	title: z.string(),
	status: z.string(),
	blocker: z.string().nullable(),
});

const TediOperationsObjectiveSchema = z.object({
	id: z.string(),
	status: z.string(),
	gateConfig: z.record(z.string(), JsonValueSchema).nullable(),
});

const TediOperationsRationaleSchema = z.object({
	id: z.string(),
	action: z.string(),
	category: z.string(),
	outcomeStatus: z.string(),
	createdAt: z.string(),
});

const TediOperationsPulseSchema = z.object({
	lastRationale: z
		.object({
			id: z.string(),
			action: z.string(),
			category: z.string(),
			confidence: z.number(),
			outcomeStatus: z.string(),
			createdAt: z.string(),
		})
		.nullable(),
	lastFactLearned: z
		.object({
			id: z.string(),
			summary: z.string().nullable(),
			factType: z.string(),
			confidence: z.number(),
			source: z.string().nullable(),
			createdAt: z.string().nullable(),
		})
		.nullable(),
	lastToolCall: z
		.object({
			toolName: z.string().nullable(),
			success: z.boolean().nullable(),
			createdAt: z.string(),
		})
		.nullable(),
	decisionsLast24h: z.number(),
	factsLearnedLast24h: z.number(),
});

export const TediOperationsSummarySchema = z.object({
	tediId: z.string(),
	delegationProfile: DelegationProfileSchema,
	pulse: TediOperationsPulseSchema,
	activeTasks: z.array(TediOperationsTaskSchema),
	objectives: z.array(TediOperationsObjectiveSchema),
	growthMetrics: GrowthSnapshotMetricsSchema.nullable(),
	crons: z.array(CronExecutionSchema),
	recentRationales: z.array(TediOperationsRationaleSchema),
	muscleCount: z.number(),
	completedObjectives: z.number(),
	approvalFatigueSignal: z
		.object({
			type: z.string(),
			evidence: z.array(z.string()),
		})
		.nullable(),
});
export type TediOperationsSummary = z.infer<typeof TediOperationsSummarySchema>;

export const ProviderInstallationSchema = z.object({
	id: z.uuid(),
	providerOrganizationId: z.uuid(),
	providerAppId: z.uuid(),
	providerApiKeyId: z.uuid(),
	externalTenantId: z.string().trim().min(1).max(200),
	customerOrganizationId: z.uuid(),
	primaryWorkspaceId: z.uuid(),
	primaryTediId: z.uuid(),
	allowedOrigin: z.url(),
	hostTenantArgument: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
	hostTenantNamespace: z.string().regex(/^[a-z][a-z0-9_]{1,127}$/),
	status: z.enum(["active", "paused"]),
	provisionedBy: z.string().min(1),
	provenance: z
		.record(z.string(), JsonValueSchema)
		.nullable()
		.describe(
			"Optional operator-supplied audit metadata; null when the installation was provisioned without external provenance.",
		),
	createdAt: z.string(),
	updatedAt: z.string(),
	pausedAt: z
		.string()
		.nullable()
		.describe("Null while the provider installation is active."),
});

export const EmbeddedSessionFailureReasonSchema = z.enum([
	"capacity_unavailable",
	"workspace_unavailable",
	"worker_unavailable",
]);

export const tedisContract = oc
	.route({ tags: ["tedis"], prefix: "/tedis" })
	.errors({
		...baseErrors,
		SERVICE_UNAVAILABLE: {
			message: "Embedded Tedi session is temporarily unavailable",
			data: z
				.object({
					reason: EmbeddedSessionFailureReasonSchema,
					retryable: z.boolean(),
				})
				.optional()
				.describe(
					"Present for embedded-session availability failures; absent for legacy Tedi procedures that share this router-level error code.",
				),
		},
	})
	.router({
		runTediDurableCode: oc
			.route({ method: "POST", summary: "Run durable code on a tedi" })
			.input(RunTediDurableCodeInputSchema)
			.output(TediDurableCodeOutputSchema),
		listTediCodeExecutions: oc
			.route({
				method: "GET",
				summary: "List a tedi's durable code executions",
			})
			.input(ListTediCodeExecutionsInputSchema)
			.output(ListTediCodeExecutionsOutputSchema),
		getTediCodeExecution: oc
			.route({ method: "GET", summary: "Read a tedi's durable code execution" })
			.input(GetTediCodeExecutionInputSchema)
			.output(GetTediCodeExecutionOutputSchema),
		approveTediCodeExecution: oc
			.route({
				method: "POST",
				summary: "Approve and resume a tedi's durable code execution",
			})
			.input(ApproveTediCodeExecutionInputSchema)
			.output(TediDurableCodeOutputSchema),
		rejectTediCodeExecution: oc
			.route({
				method: "POST",
				summary: "Reject a tedi's pending durable code action",
			})
			.input(RejectTediCodeExecutionInputSchema)
			.output(RejectTediCodeExecutionOutputSchema),
		rollbackTediCodeExecution: oc
			.route({
				method: "POST",
				summary: "Compensate a tedi's durable code execution",
			})
			.input(RollbackTediCodeExecutionInputSchema)
			.output(RollbackTediCodeExecutionOutputSchema),
		recoverTediCodeExecution: oc
			.route({
				method: "POST",
				summary: "Record an interrupted stale durable execution without replay",
			})
			.input(RecoverTediCodeExecutionInputSchema)
			.output(RecoverTediCodeExecutionOutputSchema),
		// =====================================================================
		// CRUD
		// =====================================================================

		list: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "" as `/${string}`,
				summary: "List tedis",
				description:
					"List the current organization's live tedis. Set includeRetired to list its retired tedis instead — deleting a tedi retires it rather than destroying it, so a retired worker's memory, rationale, skills, artifacts and growth history remain in the platform keyed by the id returned here. Retirement renames slug to free the name for a replacement worker; retiredSlug carries the name the worker answered to.",
			})
			.input(
				PaginationSchema.extend({
					/**
					 * `false` (default) lists live tedis; `true` lists ONLY retired
					 * ones. The two sets are disjoint so a retired worker can never be
					 * mistaken for an operating one in the default view.
					 */
					includeRetired: z
						.boolean()
						.optional()
						.describe(
							"Lifecycle: absent/false lists the organization's live tedis; true lists ONLY its retired ones. The two sets are disjoint so a retired worker can never be mistaken for an operating one in the default view.",
						),
					search: z
						.string()
						.max(200)
						.refine(
							(value) => value.trim().split(/\s+/).length <= 12,
							"Use at most 12 search terms",
						)
						.optional(),
					status: TediStatusSchema.or(z.literal("unknown")).optional(),
				}).optional(),
			)
			.output(
				z.object({
					data: z.array(TediSchema),
					pagination: PaginationMetaSchema,
				}),
			),

		listOperationsSummaries: oc
			.route({
				method: "GET",
				path: "/operations-summaries",
				summary: "List tedi operations summaries",
				description:
					"Returns one compact, org-scoped operations summary per visible tedi for administrative health and automation diagnostics.",
			})
			.input(
				z
					.object({
						tediIds: z.array(z.uuid()).max(50).optional(),
					})
					.optional(),
			)
			.output(z.object({ data: z.array(TediOperationsSummarySchema) })),

		portableSnapshotPage: oc
			.route({
				method: "GET",
				path: "/portable-snapshot-page",
				summary: "Read one page of a tedi's portable cognitive snapshot",
			})
			.input(PortableTediSnapshotPageInputSchema)
			.output(PortableTediSnapshotPageOutputSchema),

		portableGitReadAccess: oc
			.route({
				method: "POST",
				path: "/portable-git-read-access",
				summary:
					"Issue short-lived read access to the tedi's Artifacts Git repo",
			})
			.input(PortableTediGitReadAccessInputSchema)
			.output(PortableTediGitReadAccessOutputSchema),

		portableImportBegin: oc
			.route({
				method: "POST",
				path: "/portable-import-begin",
				summary: "Create a paused tedi for a validated portable import",
			})
			.input(PortableTediImportBeginInputSchema)
			.output(PortableTediImportBeginOutputSchema),

		auditBackups: oc
			.route({
				method: "GET",
				path: "/backup-audit",
				summary: "Audit tedi backups",
				description:
					"Read-only fleet backup audit for the current organization. Checks stored backup handles, optional R2 object presence, freshness, and restore readiness without waking workstation sandboxes.",
			})
			.input(
				PaginationSchema.extend({
					maxBackupAgeHours: z
						.number()
						.int()
						.positive()
						.max(24 * 30)
						.optional(),
					includeR2: z.boolean().optional(),
				}).optional(),
			)
			.output(TediBackupAuditResponseSchema),

		get: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/{tediId}",
				summary: "Get tedi",
				description: "Get one digital worker in the caller's organization.",
			})
			.input(TediIdParamSchema)
			.output(TediSchema),

		listRuntimeMetaBySlugs: oc
			.route({
				method: "POST",
				path: "/runtime-meta-by-slugs",
				summary: "Resolve runtime metadata for a batch of tedi slugs",
				description:
					"Internal service-binding batched lookup used by the MCP aggregate edge to hydrate tediId + runtime kind from globally-unique slugs. Cross-org by design (slug is globally unique).",
				tags: ["internal"],
			})
			.input(ListTediRuntimeMetaBySlugsInputSchema)
			.output(ListTediRuntimeMetaBySlugsResponseSchema),

		create: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "" as `/${string}`,
				summary: "Create tedi",
				description:
					"Create and provision a digital worker in the caller's organization.",
				successStatus: 201,
			})
			.input(CreateTediInputSchema)
			.output(TediSchema),

		update: oc
			.route({
				tags: ["REST"],
				method: "PATCH",
				path: "/{tediId}",
				summary: "Update tedi",
				description:
					"Update the identity and governed configuration of an organization-owned digital worker.",
			})
			.input(TediIdParamSchema.extend(UpdateTediInputSchema.shape))
			.output(TediSchema),

		delete: oc
			.route({
				tags: ["REST"],
				method: "DELETE",
				path: "/{tediId}",
				summary: "Delete (retire) tedi",
				description:
					"Retire an organization-owned digital worker through the supported lifecycle path. The worker stops immediately — its Descope identity, FGA grants and AIH MCP server are purged, its runtime is archived, and its slug is freed for a replacement — but its row is retained, so its memory, rationale, skills, artifacts, growth history and audit trail are NOT destroyed. List them again with tedis.list?includeRetired=true. Destroying that cognitive state requires the platform-admin tedis.decommission hardPurge path.",
			})
			.input(TediIdParamSchema)
			.output(SuccessResponseSchema),

		/**
		 * Get process logs for a tedi
		 * GET /tedis/{tediId}/logs
		 */
		getLogs: oc
			.route({
				method: "GET",
				path: "/{tediId}/logs",
				summary: "Get tedi process logs",
			})
			.input(TediIdParamSchema)
			.output(TediProcessLogsSchema),

		// =====================================================================
		// CUSTOM DOMAINS
		// =====================================================================

		listCustomDomains: oc
			.route({
				method: "GET",
				path: "/{tediId}/domains",
				summary: "List custom domains",
			})
			.input(TediIdParamSchema)
			.output(z.object({ data: z.array(CustomDomainSchema) })),

		addCustomDomain: oc
			.route({
				method: "POST",
				path: "/{tediId}/domains",
				summary: "Add custom domain",
				successStatus: 201,
			})
			.input(TediIdParamSchema.extend(AddCustomDomainInputSchema.shape))
			.output(CustomDomainSchema),

		removeCustomDomain: oc
			.route({
				method: "DELETE",
				path: "/{tediId}/domains/{domainId}",
				summary: "Remove custom domain",
			})
			.input(TediIdParamSchema.extend({ domainId: z.uuid() }))
			.output(SuccessResponseSchema),

		// =====================================================================
		// RUNTIME OPERATIONS (proxied to the tedi Worker)
		// =====================================================================

		getStatus: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/{tediId}/status",
				summary: "Get tedi runtime status",
				description:
					"Read the current runtime status of an organization-owned digital worker.",
			})
			.input(TediIdParamSchema)
			.output(TediRuntimeStatusSchema),

		listSchedules: oc
			.route({
				method: "GET",
				path: "/{tediId}/schedules",
				summary: "List a tedi's runtime schedules",
				description:
					"Org-scoped read-only view combining manifest-owned skill workflow schedules from D1 with the tedi Durable Object's turn/maintenance scheduler. Runtime reads are fail-soft; skill schedules remain visible when the tedi runtime is unreachable.",
			})
			.input(TediIdParamSchema)
			.output(TediScheduleListResponseSchema),

		inspectRuntimeCutover: oc
			.route({
				method: "GET",
				path: "/{routeTediId}/runtime-cutover/inspect",
				summary: "Inspect one finite cutover object's stored metadata",
				description:
					"Temporary platform-admin-only stable paged inventory for an exact known raw object ID. Each page is bounded to 200 entries per array with complete counts and an inventory hash; continuation requires that hash. The route tedi is a transport anchor, not an ownership claim. Optional exact candidate names recover only the matching named object ID and never infer ownership. Does not import, apply, redrive, delete, or explicitly dispatch cognition.",
				tags: ["internal"],
			})
			.input(TediRuntimeCutoverQuerySchema)
			.output(TediRuntimeCutoverInventoryResponseSchema),

		operateRuntimeCutover: oc
			.route({
				method: "POST",
				path: "/{routeTediId}/runtime-cutover/operate",
				summary: "Operate one finite runtime cutover object",
				description:
					"Temporary platform-admin-only stored cutover operations with canonical D1 custody and exact physical roots/facets. Historical custody commands require an already nonactive canonical root and actual local Raw receiver: inspect returns the exact engine source hash, capture pins it to one atomic immutable archive with all replay seals, and audit verifies the existing archive hash and generation. They preserve only the root local fixed whitelist, not descendants or financial coverage; no execution authority, admission transition or unknown-effect settlement is granted. inspect_capture_size returns root-only fixed-whitelist scalar read-window observations, permits ACTIVE or admission-absent generation-zero roots, and creates no admission or receipt; results are not atomic snapshot size, peak heap, financial coverage or writer exclusion. Other stored operations retain their admission and receipt requirements. Root-only exclude_writers requires an already nonactive canonical root and interrupts its hosted graph and in-flight execution. It creates no success receipt, automatic retry, provider cancellation or settlement. A lost outcome remains UNKNOWN; obtain fresh passive Raw-object inspection confirming exact current custody, object ID and generation before continuing. Does not redrive effects or infer ownership.",
				tags: ["internal"],
			})
			.input(TediRuntimeCutoverOperationQuerySchema)
			.output(TediRuntimeCutoverOperationResponseSchema),

		inspectRuntimeRecovery: oc
			.route({
				method: "GET",
				path: "/{tediId}/runtime-recovery/inspect",
				summary: "Inspect an existing Pi session's native recovery state",
				description:
					"Platform-admin-only metadata for an exact existing session and optional operation. Does not submit, resume, configure, or create a conversation.",
				tags: ["internal"],
			})
			.input(TediIdParamSchema.extend(TediRuntimeRecoveryQuerySchema.shape))
			.output(TediRuntimeRecoveryDiagnosticResponseSchema),

		inspectRuntimeOutbox: oc
			.route({
				method: "GET",
				path: "/{tediId}/runtime-outbox/inspect",
				summary: "Inspect one tedi run's ledger delivery queue",
				description:
					"Platform-admin-only, payload-free diagnostic for one exact Agent-runtime run. Does not redrive or mutate the queue.",
				tags: ["internal"],
			})
			.input(
				TediIdParamSchema.extend({
					runId: z
						.string()
						.min(1)
						.max(512)
						.refine((value) => value === value.trim()),
				}),
			)
			.output(TediRuntimeOutboxDiagnosticResponseSchema),

		inspectAgentMemory: oc
			.route({
				method: "GET",
				path: "/{tediId}/agent-memory/inspect",
				summary: "Inspect a governed Agent Memory projection",
				description:
					"Platform-admin validation surface for bounded session inspection and optional low-effort recall.",
				tags: ["internal"],
			})
			.input(
				TediIdParamSchema.extend({
					sessionId: z.string().trim().min(1).max(64),
					query: z
						.string()
						.trim()
						.min(1)
						.max(1_000)
						.optional()
						.describe(
							"Optional bounded recall query; absence performs session inspection only.",
						),
				}),
			)
			.output(
				z.object({
					ok: z.literal(true),
					sessionId: z.string(),
					memories: z.array(z.record(z.string(), z.unknown())),
					recall: z
						.record(z.string(), z.unknown())
						.optional()
						.describe("Present only when the request includes a recall query."),
				}),
			),

		wake: oc
			.route({
				method: "POST",
				path: "/{tediId}/wake",
				summary: "Wake a tedi runtime and optionally wait until ready",
			})
			.input(
				TediIdParamSchema.extend({
					allowSandboxReset: z
						.boolean()
						.optional()
						.describe(
							"Operator recovery path: if normal wake fails with a Sandbox transport/startup error, destroy the sandbox and retry from backup.",
						),
					forceSandboxReset: z
						.boolean()
						.optional()
						.describe(
							"Allow the recovery reset even when no healthy backup exists. This can permanently destroy workstation sandbox state.",
						),
					reason: z.string().optional(),
				}),
			)
			.output(TediWakeResponseSchema),

		restart: oc
			.route({
				method: "POST",
				path: "/{tediId}/restart",
				summary: "Restart tedi runtime",
			})
			.input(TediIdParamSchema)
			.output(TediSuccessMessageSchema),

		resetSandbox: oc
			.route({
				method: "POST",
				path: "/{tediId}/reset-sandbox",
				summary: "Destroy and recreate the tedi sandbox",
				description:
					"Nuclear option: destroys the entire Sandbox Durable Object, forcing a fresh sandbox on the next request. Use when the gateway is stuck due to stale lockfiles or orphaned processes that restart cannot fix. Pre-flight backup check blocks the reset if no healthy backup exists — use force=true to bypass.",
			})
			.input(
				TediIdParamSchema.extend({
					reason: z.string().optional(),
					force: z.boolean().optional(),
				}),
			)
			.output(TediResetSandboxResponseSchema),

		syncStorage: oc
			.route({
				method: "POST",
				path: "/{tediId}/sync",
				tags: ["internal"],
				summary: "Trigger R2 sync",
			})
			.input(TediIdParamSchema)
			.output(TediSyncStorageResponseSchema),

		triggerCronSync: oc
			.route({
				method: "POST",
				path: "/{tediId}/cron-sync",
				tags: ["internal"],
				summary: "Reconcile policy cron schedules on demand",
				description:
					"Reconciles current D1 policy-pack cron templates into the tedi's durable Agent-runtime scheduler. Returns cronBootstrap diagnostics. Pass forceUpdate=true to re-register matching template schedules as well as applying normal drift repairs.",
			})
			.input(
				TediIdParamSchema.extend({
					forceUpdate: z
						.boolean()
						.optional()
						.describe(
							"When true, re-registers matching policy-template schedules as well as applying normal drift repairs",
						),
				}),
			)
			.output(TediCronSyncResponseSchema),

		getStorageStatus: oc
			.route({
				method: "GET",
				path: "/{tediId}/storage",
				summary: "Get storage status",
				description:
					"Returns storage mount configuration and last sync marker from the tedi runtime.",
			})
			.input(TediIdParamSchema)
			.output(TediStorageStatusSchema),

		listStorageFiles: oc
			.route({
				method: "GET",
				path: "/{tediId}/storage/files",
				summary: "List storage files",
				description:
					"Lists files in the mounted runtime storage namespace (read-only).",
			})
			.input(
				TediIdParamSchema.extend({
					path: z.string().optional(),
					recursive: z.boolean().optional(),
				}),
			)
			.output(TediStorageFilesSchema),

		getStorageFile: oc
			.route({
				method: "GET",
				path: "/{tediId}/storage/file",
				summary: "Read a storage file",
				description:
					"Reads a small text file from the mounted R2 namespace (read-only).",
			})
			.input(
				TediIdParamSchema.extend({
					path: z.string(),
				}),
			)
			.output(TediStorageFileSchema),

		writeStorageFile: oc
			.route({
				method: "POST",
				path: "/{tediId}/storage/file",
				summary: "Write a storage file",
				description: "Writes a text file to the mounted R2 namespace.",
			})
			.input(TediIdParamSchema.extend(TediWriteStorageFileInputSchema.shape))
			.output(TediWriteStorageFileResultSchema),

		deleteStorageFile: oc
			.route({
				method: "DELETE",
				path: "/{tediId}/storage/file",
				summary: "Delete a storage file",
				description: "Deletes a file from the mounted R2 namespace.",
			})
			.input(
				TediIdParamSchema.extend({
					path: z.string(),
				}),
			)
			.output(z.object({ success: z.boolean() })),

		getDreams: oc
			.route({
				method: "GET",
				path: "/{tediId}/dreams",
				summary: "Removed legacy dream diary",
				description:
					"The dream diary endpoint was removed. Use Agent-runtime memory, rationale, and cognitive-runtime readback instead.",
			})
			.input(TediIdParamSchema)
			.output(TediDreamsSchema),

		// =====================================================================
		// DEVICE MANAGEMENT
		// =====================================================================

		listDevices: oc
			.route({
				method: "GET",
				path: "/{tediId}/devices",
				summary: "List tedi devices",
			})
			.input(TediIdParamSchema)
			.output(TediDeviceListSchema),

		approveDevice: oc
			.route({
				method: "POST",
				path: "/{tediId}/devices/{deviceId}/approve",
				summary: "Approve a pending device",
			})
			.input(TediIdParamSchema.extend({ deviceId: z.string() }))
			.output(TediSuccessMessageSchema),

		getChannelStatus: oc
			.route({
				method: "GET",
				path: "/{tediId}/channels/status",
				summary: "Get runtime channel connectivity status",
			})
			.input(TediIdParamSchema)
			.output(TediChannelStatusResponseSchema),

		testChannelToken: oc
			.route({
				method: "POST",
				path: "/{tediId}/channels/test",
				summary: "Test a channel bot token without saving it",
			})
			.input(
				TediIdParamSchema.extend({
					channel: z.enum(["telegram", "signal", "voice"]),
					token: z.string().min(1),
				}),
			)
			.output(ChannelTokenValidationSchema),

		validateChannelToken: oc
			.route({
				method: "POST",
				path: "/channels/test",
				summary: "Validate a channel bot token before creating a tedi",
			})
			.input(
				z.object({
					channel: z.enum(["telegram", "signal", "voice"]),
					token: z.string().min(1),
				}),
			)
			.output(ChannelTokenValidationSchema),

		revokeDevice: oc
			.route({
				method: "DELETE",
				path: "/{tediId}/devices/{deviceId}",
				summary: "Revoke a paired device",
			})
			.input(TediIdParamSchema.extend({ deviceId: z.string() }))
			.output(SuccessResponseSchema),

		// =====================================================================
		// PAIRING MANAGEMENT
		// =====================================================================

		listPairingRequests: oc
			.route({
				method: "GET",
				path: "/{tediId}/pairing/{channel}",
				summary: "List pending pairing requests for a channel",
			})
			.input(
				TediIdParamSchema.extend({
					channel: z.enum(["telegram", "signal"]),
				}),
			)
			.output(TediPairingRequestListSchema),

		approvePairing: oc
			.route({
				method: "POST",
				path: "/{tediId}/pairing/approve",
				summary: "Approve a pending pairing request",
			})
			.input(
				TediIdParamSchema.extend({
					channel: z.enum(["telegram", "signal", "voice"]),
					code: z.string().min(1),
				}),
			)
			.output(TediPairingApproveResponseSchema),

		// =====================================================================
		// CHANNEL CONFIGURATION
		// =====================================================================

		updateChannelConfig: oc
			.route({
				method: "PATCH",
				path: "/{tediId}/channels/{channel}/config",
				summary:
					"Update channel-specific configuration (groups, policies, etc.)",
			})
			.input(
				TediIdParamSchema.extend({
					channel: z.enum(["telegram", "signal", "voice"]),
					config: TediChannelConfigSchema,
				}),
			)
			.output(TediChannelConfigUpdateResponseSchema),

		listSessionStates: oc
			.route({
				method: "GET",
				path: "/{tediId}/sessions/state",
				summary: "List session organization state",
			})
			.input(TediIdParamSchema)
			.output(TediSessionStateListSchema),

		updateSessionState: oc
			.route({
				method: "PATCH",
				path: "/{tediId}/sessions/{sessionKey}/state",
				summary: "Update session organization state",
			})
			.input(
				TediIdParamSchema.extend({
					sessionKey: TediSessionKeySchema,
				}).extend(TediSessionStatePatchSchema.shape),
			)
			.output(TediSessionStateSchema),

		deleteSession: oc
			.route({
				method: "DELETE",
				path: "/{tediId}/sessions/{sessionKey}",
				summary: "Delete a tedi session",
			})
			.input(
				TediIdParamSchema.extend({
					sessionKey: TediSessionKeySchema,
				}),
			)
			.output(TediSessionDeleteResponseSchema),

		deleteSessions: oc
			.route({
				method: "POST",
				path: "/{tediId}/sessions/bulk-delete",
				summary:
					"Bulk-delete tedi sessions by explicit list or id-pattern / age filter (soft-delete; never touches agent:main:main)",
			})
			.input(
				TediIdParamSchema.extend({
					// Explicit target session keys. Takes precedence over the filter.
					sessionKeys: z.array(TediSessionKeySchema).max(500).optional(),
					// Case-insensitive regex matched against each conversation id
					// (used when sessionKeys is omitted). e.g. "codex|claude|smoke".
					idPattern: z.string().min(1).max(200).optional(),
					// Only match conversations whose last activity is older than N days.
					olderThanDays: z.number().int().positive().max(3650).optional(),
					// Preview the matched set without deleting.
					dryRun: z.boolean().optional(),
				}),
			)
			.output(TediSessionsBulkDeleteResponseSchema),

		// =====================================================================
		// MESSAGING
		// =====================================================================

		sendMessage: oc
			.route({
				method: "POST",
				path: "/{tediId}/message",
				summary: "Send a message to the tedi agent",
			})
			.input(
				TediIdParamSchema.extend({
					message: z.string().min(1),
					session: z.string().optional(),
					channel: z.string().optional(),
					wait: z.boolean().optional(),
				}),
			)
			.output(
				z.object({
					success: z.boolean(),
					error: z.string().optional(),
					runId: z
						.string()
						.optional()
						.describe("Absent when the runtime rejects before creating a run."),
					sessionKey: z
						.string()
						.optional()
						.describe("Absent when the runtime does not resolve a session."),
					assistant: z
						.object({
							role: z.literal("assistant"),
							content: z.string(),
							ts: z.number(),
						})
						.optional()
						.describe(
							"Absent for async or failed injects; synchronous successful turns include the assistant reply.",
						),
				}),
			),

		createEmbeddedSession: oc
			.route({
				method: "POST",
				path: "/{tediId}/embedded-sessions",
				summary: "Create a short-lived embedded Tedi session",
				description:
					"Exchanges a trusted host-server identity for a browser-safe, origin-bound Tedi conversation capability.",
			})
			.input(
				TediIdParamSchema.extend({
					allowedOrigin: z
						.url()
						.refine(
							(value) => URL.canParse(value) && new URL(value).origin === value,
							{
								message: "allowedOrigin must be an origin without a path",
							},
						),
					conversationId: z.uuid(),
					hostOrganizationId: z.string().trim().min(1).max(200),
					hostOrganizationLabel: z
						.string()
						.trim()
						.min(1)
						.max(300)
						.optional()
						.describe(
							"Optional host display label; identity remains bound by hostOrganizationId when the host has no organization name.",
						),
					hostRole: z
						.string()
						.trim()
						.min(1)
						.max(200)
						.optional()
						.describe(
							"Optional host role label for conversation context; it grants no Tedix authority.",
						),
					hostTenantArgument: z
						.string()
						.regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
						.optional()
						.describe(
							"Host API argument that must be forced to hostOrganizationId for embedded tool calls. When present, arbitrary Code Mode is disabled for this browser session.",
						),
					hostTenantNamespace: z
						.string()
						.regex(/^[a-z][a-z0-9_]{1,127}$/)
						.optional()
						.describe(
							"MCP namespace whose calls receive the forced host tenant argument. Required together with hostTenantArgument.",
						),
					surface: z
						.enum(["os", "host"])
						.optional()
						.describe(
							"Which product surface opened this session. Defaults to host; the first-party console passes os, which selects the latency-oriented quick-chat model instead of the tedi's full chat model.",
						),
					portableRouteAssertion: z
						.object({
							routeId: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),
							pathname: z.string().startsWith("/").max(500),
							routeKey: z.string().trim().min(1).max(120),
						})
						.strict()
						.optional()
						.describe(
							"First-party OS route request. The API admits only its canonical untargeted route and signs one route's callables.",
						),
					hostUserId: z.string().trim().min(1).max(200),
					hostUserLabel: z
						.string()
						.trim()
						.min(1)
						.max(300)
						.optional()
						.describe(
							"Optional host display name or email; identity remains bound by hostUserId when the host has no label.",
						),
					hostConversationContext: z
						.object({
							kind: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
							reference: z.string().trim().min(1).max(200),
							label: z
								.string()
								.trim()
								.min(1)
								.max(300)
								.optional()
								.describe(
									"Optional host-owned display label; the stable reference remains the signed identity of this context.",
								),
						})
						.optional()
						.describe(
							"A host-prepared conversation reference signed into the browser capability. It provides context only and grants no host-tool authority.",
						),
				}).refine(
					(input) =>
						Boolean(input.hostTenantArgument) ===
						Boolean(input.hostTenantNamespace),
					{
						message:
							"hostTenantArgument and hostTenantNamespace must be provided together",
					},
				),
			)
			.output(
				z.object({
					tediSelection: EmbeddedTediSelectionSchema.optional().describe(
						"Returned for OS widget sessions; direct non-OS sessions have no configurable picker roster.",
					),
					modelSelection: EmbeddedModelSelectionSchema.optional().describe(
						"The models this session may route a turn at, projected from the one model catalog scoped to the tedi. Returned for OS widget sessions; a third-party widget keeps its tedi's configured model and gets no picker. Advisory for the UI only — the runtime edge re-validates every chosen ref.",
					),
					token: z.string().min(1),
					expiresAt: z.number().int().positive(),
					actorCacheKey: z.string().min(1),
					sessionKey: z.string().min(1),
					streamUrl: z.url(),
					hostRole: z
						.string()
						.trim()
						.min(1)
						.max(200)
						.optional()
						.describe(
							"Signed host role returned when supplied; absent for hosts that do not provide role context.",
						),
					webMcpProfile: PortableWebMcpProfileSchema.optional().describe(
						"Provider-managed portable route tools; absent when no profile is published.",
					),
					portableRoute: z
						.object({
							id: z.string(),
							pathname: z.string(),
							routeKey: z
								.string()
								.optional()
								.describe(
									"Absent for legacy signed routes without a route key.",
								),
							bindings: z.record(
								z.string(),
								z.record(
									z.string(),
									z.union([z.string(), z.number(), z.boolean()]),
								),
							),
						})
						.optional()
						.describe(
							"Absent when the embedded session has no admitted route.",
						),
				}),
			),

		authorizeOsPortableCall: oc
			.route({
				method: "POST",
				path: "/embedded-sessions/portable-call/authorize",
				tags: ["internal"],
				summary: "Verify one first-party portable route call",
			})
			.input(
				z
					.object({
						token: z.string().min(1).max(24000),
						routeId: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),
						callable: z
							.string()
							.regex(/^[a-z][a-z0-9_]{1,127}\.[a-z][a-z0-9_]{1,127}$/),
						args: z.record(z.string(), z.unknown()),
						origin: z.url(),
						refererPathname: z.string().startsWith("/").max(500),
					})
					.strict(),
			)
			.output(z.object({ authorized: z.literal(true) })),

		listEmbeddedConversationCapabilities: oc
			.route({
				method: "GET",
				path: "/{tediId}/embedded-conversations/{conversationId}/capabilities",
				summary: "List embedded conversation capabilities",
				description:
					"Internal signed-session projection. Named capabilities are context only and grant no execution authority.",
			})
			.input(EmbeddedConversationCapabilityTargetSchema.strict())
			.output(
				z.object({
					attached: z.array(ConversationCapabilitySchema),
					available: z.array(
						CapabilitySchema.pick({ id: true, name: true, slug: true }),
					),
					authority: z.literal("context_only"),
				}),
			),

		attachEmbeddedConversationCapability: oc
			.route({
				method: "POST",
				path: "/{tediId}/embedded-conversations/{conversationId}/capabilities",
				summary: "Attach an embedded conversation capability",
			})
			.input(
				EmbeddedConversationCapabilityTargetSchema.extend({
					capabilityId: z.uuid(),
					replayName: ConversationCapabilityReplayNameSchema,
					hostUserId: z.string().trim().min(1).max(200),
				}),
			)
			.output(z.object({ capability: ConversationCapabilitySchema })),

		detachEmbeddedConversationCapability: oc
			.route({
				method: "DELETE",
				path: "/{tediId}/embedded-conversations/{conversationId}/capabilities/{referenceId}",
				summary: "Detach an embedded conversation capability",
			})
			.input(
				EmbeddedConversationCapabilityTargetSchema.extend({
					referenceId: z.uuid(),
					hostUserId: z.string().trim().min(1).max(200),
				}),
			)
			.output(z.object({ detached: z.literal(true), referenceId: z.uuid() })),

		listEmbeddedConversationArtifactPins: oc
			.route({
				method: "GET",
				path: "/{tediId}/embedded-conversations/{conversationId}/artifact-pins",
				summary: "List embedded conversation artifact pins",
			})
			.input(EmbeddedConversationCapabilityTargetSchema.strict())
			.output(z.object({ pins: z.array(ConversationArtifactPinSchema) })),

		attachEmbeddedConversationArtifactPin: oc
			.route({
				method: "POST",
				path: "/{tediId}/embedded-conversations/{conversationId}/artifact-pins",
				summary: "Pin an embedded artifact revision",
			})
			.input(
				EmbeddedConversationCapabilityTargetSchema.extend({
					artifactId: z.string().min(1).max(200),
					replayName: ConversationCapabilityReplayNameSchema,
					hostUserId: z.string().trim().min(1).max(200),
				}),
			)
			.output(z.object({ pin: ConversationArtifactPinSchema })),

		detachEmbeddedConversationArtifactPin: oc
			.route({
				method: "DELETE",
				path: "/{tediId}/embedded-conversations/{conversationId}/artifact-pins/{pinId}",
				summary: "Detach an embedded artifact revision pin",
			})
			.input(
				EmbeddedConversationCapabilityTargetSchema.extend({
					pinId: z.uuid(),
					hostUserId: z.string().trim().min(1).max(200),
				}),
			)
			.output(z.object({ detached: z.literal(true), pinId: z.uuid() })),

		identifyEmbeddedProviderContact: oc
			.route({
				method: "POST",
				path: "/embedded-installations/identify",
				summary: "Identify a host-authenticated embedded contact",
				description:
					"Updates durable profiles without starting a session, checking audience, or consuming inference capacity. Uses only the authenticated provider key's existing installation.",
			})
			.input(
				z.strictObject({
					externalTenantId: z.string().trim().min(1).max(200),
					hostUserId: z.string().trim().min(1).max(200),
					hostRole: z
						.string()
						.trim()
						.min(1)
						.max(200)
						.nullable()
						.optional()
						.describe(
							"Host-facing label only; omit to preserve, null clears. Grants no permissions.",
						),
					profile: EmbeddedContactProfilePatchSchema,
				}),
			)
			.output(EmbeddedContactIdentitySchema),
		listWidgetContacts: oc
			.route({
				method: "GET",
				path: "/embedded-contacts",
				summary: "Search the provider's durable contact directory",
			})
			.input(
				z
					.object({
						kind: z.enum(["people", "companies"]),
						search: z
							.string()
							.trim()
							.max(300)
							.optional()
							.describe("Search canonical names, email or host IDs."),
						installationId: z
							.uuid()
							.optional()
							.describe("Restrict to one provider-owned business."),
						hostUserIds: z
							.array(z.string().trim().min(1).max(200))
							.max(100)
							.optional()
							.describe(
								"Resolve selected people IDs within one installation; requires people kind and installationId.",
							),
						offset: z.number().int().nonnegative().max(1000000).default(0),
						limit: z.number().int().min(1).max(100).default(50),
					})
					.strict()
					.refine(
						(value) =>
							!value.hostUserIds ||
							(value.kind === "people" && !!value.installationId),
						"Selected IDs require a business and people kind",
					),
			)
			.output(
				z.object({
					people: z.array(EmbeddedContactUserSchema),
					companies: z
						.array(EmbeddedContactCompanySchema)
						.describe(
							"Company pages, or companies associated with the current people page.",
						),
					total: z.number().int().nonnegative(),
					nextOffset: z
						.number()
						.int()
						.nullable()
						.describe(
							"Null when the current page reaches the end of the directory results.",
						),
				}),
			),
		getWidgetContact: oc
			.route({
				method: "GET",
				path: "/embedded-contacts/{installationId}",
				summary: "Read one provider-owned company and optional person",
			})
			.input(
				z.object({
					installationId: z.uuid(),
					hostUserId: z
						.string()
						.trim()
						.min(1)
						.max(200)
						.optional()
						.describe("Omit for company details only."),
				}),
			)
			.output(
				z.object({
					company: EmbeddedContactCompanySchema,
					user: EmbeddedContactUserSchema.nullable().describe(
						"Null for a company-only request that omits hostUserId.",
					),
				}),
			),

		getEmbeddedProviderAvailability: oc
			.route({
				method: "POST",
				path: "/embedded-installations/availability",
				summary:
					"Check provider widget availability for an authenticated host user",
				tags: ["internal"],
			})
			.input(
				z.object({
					externalTenantId: z.string().trim().min(1).max(200),
					hostUserId: z.string().trim().min(1).max(200),
				}),
			)
			.output(z.object({ enabled: z.boolean() })),

		resolveEmbeddedHostDelegation: oc
			.route({
				method: "POST",
				path: "/internal/embedded-host-delegation",
				tags: ["internal"],
				summary: "Resolve verified embedded provider delegation",
			})
			.input(
				z.object({
					token: z.string().min(1).max(24000),
					tediId: z.uuid(),
					organizationId: z.uuid(),
					sourceAppId: z.uuid(),
					callable: z.string().min(3).max(260),
					audience: HostDelegationSchema.shape.audience,
				}),
			)
			.output(
				HostDelegationSchema.extend({
					providerOrganizationId: z.uuid(),
					connectionProviderId: z.string().min(1),
					connectionScopes: z.array(z.string()),
					authHeader: z.string().min(1),
					authTemplate: z.string().min(1),
					authEncoding: z
						.literal("base64")
						.optional()
						.describe(
							"Omitted when the source credential profile uses the token without encoding.",
						),
				}),
			),
		createEmbeddedProviderSession: oc
			.route({
				method: "POST",
				path: "/embedded-installations/session",
				summary:
					"Exchange a provider installation for an embedded Tedi session",
				description:
					"Uses the authenticated provider organization and API key plus its external tenant id to resolve the customer organization, Workspace, Tedi, origin, and forced tool constraint. A requested tedi must belong to the configured installation allowlist.",
			})
			.input(
				z.object({
					externalTenantId: z.string().trim().min(1).max(200),
					hostDelegation: HostDelegationSchema.optional().describe(
						"Omitted when the host does not delegate access to a provider API.",
					),
					conversationId: z.uuid(),
					selectedTediId: z
						.uuid()
						.optional()
						.describe(
							"Omit to use the installation configured default; an explicit requested worker must belong to its permitted roster.",
						),
					portableRouteAssertion: z
						.object({
							routeId: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),
							pathname: z
								.string()
								.startsWith("/")
								.max(500)
								.refine(
									(value) => !value.startsWith("//") && !value.includes("?"),
								),
							routeKey: z
								.string()
								.trim()
								.min(1)
								.max(120)
								.optional()
								.describe("Omitted for pathname-only routes."),
							params: z
								.record(
									z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/),
									z.union([
										z.string().max(200),
										z.number().finite(),
										z.boolean(),
									]),
								)
								.refine((value) => Object.keys(value).length <= 24)
								.optional()
								.describe(
									"Omitted when this route has no host-authenticated context parameters.",
								),
							entity: z
								.object({
									type: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
									id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
								})
								.strict()
								.optional()
								.describe(
									"Omitted when the authenticated route does not identify one entity.",
								),
						})
						.strict()
						.optional()
						.describe(
							"Route and target derived by the authenticated provider server from its own session and router; never forward browser-supplied route authority.",
						),
					hostOrganizationLabel: z
						.string()
						.trim()
						.min(1)
						.max(300)
						.optional()
						.describe(
							"Optional display label supplied by the host; authorization uses the installed external tenant id instead.",
						),
					hostRole: z
						.string()
						.trim()
						.min(1)
						.max(200)
						.optional()
						.describe(
							"Optional host-facing role label for personalization; it does not grant Tedix permissions.",
						),
					hostUserId: z.string().trim().min(1).max(200),
					hostUserLabel: z
						.string()
						.trim()
						.min(1)
						.max(300)
						.optional()
						.describe(
							"Optional human-readable host user label; the stable host user id remains authoritative.",
						),
				}),
			)
			.output(
				z.object({
					installationId: z.uuid(),
					tediSelection: EmbeddedTediSelectionSchema,
					analyticsEnabled: z.boolean(),
					workspaceId: z.uuid(),
					token: z.string().min(1),
					expiresAt: z.number().int().positive(),
					actorCacheKey: z.string().min(1),
					sessionKey: z.string().min(1),
					streamUrl: z.url(),
					hostRole: z
						.string()
						.trim()
						.min(1)
						.max(200)
						.optional()
						.describe(
							"Signed host role returned when supplied; absent for hosts that do not provide role context.",
						),
					webMcpProfile: PortableWebMcpProfileSchema.optional().describe(
						"Provider-managed portable route tools; absent when no profile is published.",
					),
					portableRoute: z
						.object({
							id: z.string(),
							pathname: z.string(),
							routeKey: z
								.string()
								.optional()
								.describe("Absent for pathname-only routes."),
							params: z
								.record(
									z.string(),
									z.union([z.string(), z.number(), z.boolean()]),
								)
								.optional()
								.describe(
									"Absent when the signed route has no context parameters.",
								),
							entity: z
								.object({ type: z.string(), id: z.string() })
								.optional()
								.describe("Absent when the signed route has no entity target."),
							bindings: z.record(
								z.string(),
								z.record(
									z.string(),
									z.union([z.string(), z.number(), z.boolean()]),
								),
							),
						})
						.optional()
						.describe(
							"Provider-server asserted page route and target signed into this session.",
						),
				}),
			),

		listWidgetAccessConfigurations: oc
			.route({
				method: "GET",
				path: "/embedded-installations/access",
				summary: "List provider widget access settings",
			})
			.input(z.object({}).strict())
			.output(
				z.object({ data: z.array(EmbeddedWidgetAccessConfigurationSchema) }),
			),
		updateWidgetAccessConfiguration: oc
			.route({
				method: "POST",
				path: "/embedded-installations/{installationId}/access",
				summary: "Update provider widget access settings",
			})
			.input(
				z.object({
					installationId: z.uuid(),
					expectedRevision: z.number().int().nonnegative(),
					policy: EmbeddedWidgetAccessPolicySchema,
				}),
			)
			.output(EmbeddedWidgetAccessConfigurationSchema),
		previewWidgetAccess: oc
			.route({
				method: "POST",
				path: "/embedded-installations/{installationId}/access/preview",
				summary: "Test saved widget access for a user",
			})
			.input(
				z.object({
					installationId: z.uuid(),
					hostUserId: z.string().trim().min(1).max(200),
				}),
			)
			.output(EmbeddedWidgetAccessDecisionSchema),
		authorizeEmbeddedWidgetAccess: oc
			.route({
				method: "POST",
				path: "/embedded-installations/access/authorize",
				summary: "Check current embedded widget authority",
				tags: ["internal"],
			})
			.input(
				z.object({
					installationId: z.uuid(),
					providerAppId: z.uuid(),
					externalTenantId: z.string(),
					allowedOrigin: z.string().url(),
					hostUserId: z.string().min(1).max(200),
				}),
			)
			.output(EmbeddedWidgetAccessDecisionSchema),

		validatePortableWebMcpProfile: oc
			.route({
				method: "POST",
				path: "/embedded-installations/{installationId}/webmcp/validate",
				summary: "Validate a Portable WebMCP profile",
				description:
					"Validates provider-managed route tools against the provider-owned installation namespace and the installed app's authoritative read-only tool classifications. It grants no execution authority.",
			})
			.input(
				z.object({
					installationId: z.uuid(),
					profile: PortableWebMcpProfileSchema,
				}),
			)
			.output(
				z.object({
					valid: z.boolean(),
					admittedCallables: z.array(z.string()).max(1_000),
					diagnostics: z
						.array(
							z.object({
								callable: z.string(),
								status: z.enum(["admitted", "rejected"]),
								reason: z
									.enum([
										"namespace_mismatch",
										"tool_unavailable",
										"not_declared_read_only",
										"write_confirmation_required",
										"prepare_tool_not_read_only",
										"converge_tool_not_read_only",
										"destructive_tool_forbidden",
									])
									.optional()
									.describe(
										"Absent only when the callable was admitted; rejected callables carry the fail-closed reason.",
									),
							}),
						)
						.max(1_000),
				}),
			),

		listPortableWebMcpConfigurations: oc
			.route({
				method: "GET",
				path: "/embedded-installations/webmcp",
				summary: "List Portable WebMCP configurations",
				description:
					"Lists provider-owned installations with their published profile revision and eligible read-only catalog tools.",
			})
			.output(
				z.array(
					z.object({
						installationId: z.uuid(),
						providerAppId: z.uuid(),
						externalTenantId: z.string(),
						hostTenantNamespace: z.string(),
						revision: z.number().int().nonnegative(),
						profile: PortableWebMcpProfileSchema.nullable().describe(
							"Null until this installation publishes its first tenant-scoped profile revision.",
						),
						history: z.array(
							z.object({
								revision: z.number().int().positive(),
								profile: PortableWebMcpProfileSchema,
								changeSummary: z.string(),
								publishedAt: z.string(),
								publishedBy: z.string(),
							}),
						),
						activation: z.object({
							status: z.enum(["ready", "unconfigured", "blocked"]),
							routeCount: z.number().int().nonnegative(),
							admittedToolCount: z.number().int().nonnegative(),
							rejectedToolCount: z.number().int().nonnegative(),
							reasonCodes: z
								.array(
									z.enum([
										"profile_missing",
										"namespace_mismatch",
										"tool_unavailable",
										"not_declared_read_only",
										"write_confirmation_required",
										"prepare_tool_not_read_only",
										"converge_tool_not_read_only",
										"destructive_tool_forbidden",
									]),
								)
								.describe(
									"Content-free, tenant-safe activation diagnostics for provider operators.",
								),
						}),
						eligibleTools: z.array(
							z.object({
								toolId: z.string(),
								callable: z.string(),
								title: z
									.string()
									.nullable()
									.describe(
										"Null when the catalog tool has no optional display title.",
									),
								description: z
									.string()
									.nullable()
									.describe(
										"Null when the catalog tool has no optional agent-facing description.",
									),
								inputSchema: z.record(z.string(), z.unknown()),
								writeCapability: z.enum(["read", "write"]),
							}),
						),
					}),
				),
			),

		publishPortableWebMcpProfile: oc
			.route({
				method: "POST",
				path: "/embedded-installations/{installationId}/webmcp/publish",
				summary: "Publish a Portable WebMCP profile revision",
				description:
					"Validates and compare-and-swap publishes one provider installation profile. Every publication creates an immutable bounded revision.",
			})
			.input(
				z.object({
					installationId: z.uuid(),
					expectedRevision: z.number().int().nonnegative(),
					profile: PortableWebMcpProfileSchema,
					changeSummary: z.string().trim().min(1).max(500),
				}),
			)
			.output(
				z.object({
					installationId: z.uuid(),
					revision: z.number().int().positive(),
					profile: PortableWebMcpProfileSchema,
				}),
			),

		configureProviderOnboarding: oc
			.route({
				method: "PUT",
				path: "/embedded-installations/onboarding/{providerOrganizationId}",
				summary: "Configure provider customer onboarding defaults",
				description:
					"Platform administration configures the provider-owned integration and explicit sponsored billing defaults. Does not change existing customer installations.",
				tags: ["internal"],
			})
			.input(
				z.object({
					providerOrganizationId: z.uuid(),
					config: ProviderOnboardingSchema,
				}),
			)
			.output(z.object({ configured: z.boolean() })),

		getProviderOnboardingStatus: oc
			.route({
				method: "GET",
				path: "/embedded-installations/onboarding",
				summary: "Check whether customer activation is configured",
			})
			.input(z.object({}))
			.output(z.object({ configured: z.boolean() })),

		activateProviderCustomer: oc
			.route({
				method: "POST",
				path: "/embedded-installations/activate",
				summary: "Activate an embedded assistant for a business",
				description:
					"Provider console administrators supply only their business ID and name. Protected provider defaults determine identity, billing and integration settings. Existing installations are preserved.",
			})
			.input(
				z.strictObject({
					externalTenantId: z.string().trim().min(1).max(200),
					name: z.string().trim().min(1).max(100),
				}),
			)
			.output(z.object({ installationId: z.uuid() })),

		provisionProviderInstallation: oc
			.route({
				method: "PUT",
				path: "/embedded-installations",
				summary: "Provision a provider-to-customer Tedi installation",
				description:
					"Link existing customer resources or automatically create an isolated organization, workspace and worker with explicit internal billing and sponsorship. Automatic retries return existing installations unchanged. Requires platform administration.",
				tags: ["internal"],
			})
			.input(
				z
					.object({
						providerOrganizationId: z.uuid(),
						providerAppId: z.uuid(),
						providerApiKeyId: z.uuid(),
						externalTenantId: z.string().trim().min(1).max(200),
						customerOrganizationId: z
							.uuid()
							.optional()
							.describe(
								"Omitted only when customer configuration creates the organization.",
							),
						primaryWorkspaceId: z
							.uuid()
							.optional()
							.describe(
								"Omitted only when customer configuration creates the workspace.",
							),
						primaryTediId: z
							.uuid()
							.optional()
							.describe(
								"Omitted only when customer configuration creates the worker.",
							),
						customer: z
							.object({
								name: z.string().trim().min(1).max(100),
								billingPlanKey: z.enum(["growth", "business", "enterprise"]),
								ownerUserId: z
									.string()
									.min(1)
									.optional()
									.describe(
										"Required for machine callers; human callers use their authenticated identity.",
									),
								ownerEmail: z
									.email()
									.optional()
									.describe(
										"Required for machine callers; human callers use their authenticated email.",
									),
								language: z
									.string()
									.min(2)
									.max(10)
									.optional()
									.describe(
										"Omit to use the standard worker language behavior.",
									),
								timezone: z
									.string()
									.max(100)
									.optional()
									.describe(
										"Omit to use the standard worker timezone behavior.",
									),
								personality: z
									.string()
									.max(10000)
									.optional()
									.describe("Omit to use the standard worker instructions."),
								sponsoredCapacity: ProviderCapacityPolicySchema,
							})
							.optional()
							.describe(
								"Create isolated customer resources automatically. Existing installations are returned unchanged; no customer OS onboarding is performed.",
							),
						allowedOrigin: z
							.url()
							.refine(
								(value) =>
									URL.canParse(value) && new URL(value).origin === value,
								{
									message: "allowedOrigin must be an origin without a path",
								},
							),
						hostTenantArgument: z
							.string()
							.regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
						hostTenantNamespace: z.string().regex(/^[a-z][a-z0-9_]{1,127}$/),
						provenance: z
							.record(z.string(), JsonValueSchema)
							.optional()
							.describe(
								"Optional audit metadata describing the provisioning source or rollout.",
							),
					})
					.refine(
						(value) =>
							value.customer
								? !value.customerOrganizationId &&
									!value.primaryWorkspaceId &&
									!value.primaryTediId
								: !!value.customerOrganizationId &&
									!!value.primaryWorkspaceId &&
									!!value.primaryTediId,
						{
							message:
								"Provide either customer configuration or all three existing resource IDs",
						},
					),
			)
			.output(ProviderInstallationSchema),

		getProviderInstallation: oc
			.route({
				method: "GET",
				path: "/embedded-installations/{providerOrganizationId}/{providerAppId}/{externalTenantId}",
				summary: "Get a provider Tedi installation",
				tags: ["internal"],
			})
			.input(
				z.object({
					providerOrganizationId: z.uuid(),
					providerAppId: z.uuid(),
					externalTenantId: z.string().trim().min(1).max(200),
				}),
			)
			.output(ProviderInstallationSchema),

		setProviderInstallationPaused: oc
			.route({
				method: "POST",
				path: "/embedded-installations/{providerOrganizationId}/{installationId}/pause",
				summary: "Pause or resume a provider Tedi installation",
				tags: ["internal"],
			})
			.input(
				z.object({
					providerOrganizationId: z.uuid(),
					installationId: z.uuid(),
					paused: z.boolean(),
				}),
			)
			.output(ProviderInstallationSchema),

		// =====================================================================
		// PEER COMMUNICATION
		// =====================================================================

		listPeers: oc
			.route({
				method: "GET",
				path: "/{tediId}/peers",
				summary: "List peer tedis in the same organization",
			})
			.input(TediIdParamSchema)
			.output(TediPeerListSchema),

		rotateAccessKey: oc
			.route({
				method: "POST",
				path: "/{tediId}/auth/rotate-access-key",
				summary: "Rotate tedi Descope access key",
				description:
					"Issues a fresh Descope access key for the tedi, updates encrypted Tedix secrets, and refreshes runtime config so the MCP plugin can resume authenticated operation.",
			})
			.input(TediIdParamSchema)
			.output(TediRotateAccessKeyResponseSchema),

		// =====================================================================
		// CONFIG SYNC
		// =====================================================================

		syncConfig: oc
			.route({
				method: "POST",
				path: "/{tediId}/sync-config",
				tags: ["internal"],
				summary: "Sync tedi runtime config",
				description:
					"Projects workspace files for preview and asks the runtime to refresh generated workspace, secret sidecar, and auth files.",
			})
			.input(TediIdParamSchema.extend({ force: z.boolean().optional() }))
			.output(TediSyncConfigResponseSchema),

		getModelPolicy: oc
			.route({
				method: "GET",
				path: "/{tediId}/model-policy",
				summary: "Get per-role model policy for a tedi",
				description:
					"Resolves the tedi's runtime_profile_id → runtime_profiles.config.modelPolicy so the runtime can select this role's model (kernel=cheap/fast, CTO=full-power, CFO=small). chatModelRef is the default surface; the optional cronModelRef/observerModelRef let scheduled and observer work run cheaper without touching interactive turns. null when unset (env default).",
				tags: ["internal"],
			})
			.input(TediIdParamSchema)
			.output(TediModelPolicyResponseSchema),

		// =====================================================================
		// RUNTIME PROJECTION (Observed State + Usage Ledger)
		// =====================================================================

		getRuntimeProjection: oc
			.route({
				method: "GET",
				path: "/{tediId}/runtime-projection",
				summary: "Get latest runtime projection for a tedi",
			})
			.input(TediIdParamSchema)
			.output(TediRuntimeProjectionResponseSchema),

		ingestRuntimeProjection: oc
			.route({
				method: "POST",
				path: "/{tediId}/runtime-projection",
				summary: "Ingest runtime projection from tedi runtime/reconciler",
				tags: ["internal"],
			})
			.input(IngestRuntimeProjectionInputSchema)
			.output(TediIngestProjectionResponseSchema),

		cleanupSnapshots: oc
			.route({
				method: "POST",
				path: "/cleanup-snapshots",
				summary: "Clean up old runtime snapshots",
				tags: ["internal"],
			})
			.input(
				z.object({
					olderThanDays: z.number().int().min(1).max(90).default(7),
				}),
			)
			.output(
				z.object({
					ok: z.boolean(),
					deletedCount: z.number(),
				}),
			),

		// =====================================================================
		// SELF-HEALING
		// =====================================================================

		repair: oc
			.route({
				method: "POST",
				path: "/{tediId}/repair",
				summary: "Repair tedi by auto-generating missing required secrets",
				description:
					"Checks for required runtime secrets and auto-generates any that are missing. Optionally registers a per-tedi Descope AIH MCP server when registerDescopeAih is true.",
				tags: ["internal"],
			})
			.input(
				TediIdParamSchema.extend({
					registerDescopeAih: z.boolean().optional().default(false),
				}),
			)
			.output(TediRepairResponseSchema),

		// =====================================================================
		// GOVERNANCE OVERRIDE
		// =====================================================================

		updateGovernance: oc
			.route({
				method: "POST",
				path: "/{tediId}/governance",
				summary: "Set or clear a per-tedi governance override",
				description:
					"Lets an authorized tenant tedi administrator flip an organization-owned tedi between gated and autonomous without mutating shared policy packs. " +
					"The override wins over the policy pack in `deriveRequiresApproval` on the next capability card assembly. " +
					"Pass `requiresApproval: null` to clear the override and revert to pack-derived governance. " +
					"The target is organization-scoped and every change writes an audited `tedi.governance.updated` event.",
				tags: ["internal"],
			})
			.input(UpdateTediGovernanceInputSchema)
			.output(UpdateTediGovernanceResponseSchema),

		initiateAppConnection: oc
			.route({
				method: "POST",
				path: "/{tediId}/connections/initiate",
				summary: "Initiate OAuth connection for tedi",
				description:
					"Returns a clickable URL to connect a third-party service. Open the URL in a browser to complete the OAuth flow.",
			})
			.input(
				z.object({
					tediId: z.uuid(),
					appSlug: z.string().min(1),
				}),
			)
			.output(TediInitiateConnectionResponseSchema),

		// =====================================================================
		// AGENT RUNTIME RECOVERY
		// =====================================================================

		rebind: oc
			.route({
				method: "POST",
				path: "/{tediId}/rebind",
				summary: "Rebind an Agent-runtime tedi to a fresh Durable Object name",
				description:
					"Recovers a wedged Agent-runtime tedi by repointing its `isolate_agent_id` to a brand-new name, which routes future requests to a pristine empty Durable Object. The previous DO's persisted native sessions, receipts, schedules and recovery state remain in that object and are not transferred. This explicitly redirects future requests; it does not recover native state from the previous object. Platform-admin / trusted-service-binding only.",
				tags: ["internal"],
			})
			.input(TediIdParamSchema)
			.output(
				z.object({
					ok: z.literal(true),
					isolateAgentId: z.string(),
					previous: z.string(),
				}),
			),

		// =====================================================================
		// DECOMMISSION / HARD-PURGE
		// =====================================================================

		decommission: oc
			.route({
				method: "POST",
				path: "/{tediId}/decommission",
				summary: "Decommission (and optionally hard-purge) a tedi",
				description:
					"Platform-admin staged teardown of a tedi, encapsulating the supported removal cascade. Stage 1 (always, reversible): set status='paused' + runtime_state='archived'. Stage 2 (stopSchedules, default true): invoke the isolate runtime admin dequeue with cancelSchedules so the Durable Object's self-perpetuating maintenance alarms actually stop (skipped when no runtime scheduler is present). Stage 3 (hardPurge, irreversible): requires confirmSlug to equal the tedi slug; deletes the D1 tedis row, the Descope identity, FGA grants, the AIH MCP server, and the exact org/tedi Cloudflare Agent Memory profile. The D1 delete is the ONLY path that destroys customer-owned cognitive state: FK ON DELETE CASCADE removes memory_facts (and memory_edges), tedi_expertise, knowledge_entries, skill_entries, skill_runs (and skill_run_artifacts), tedi_muscle_memory, tedi_rationale_records, tedi_artifacts, tedi_runtime_events, tedi_growth_snapshots, tedi_entrustment_grants, competency_observations, tedi_secrets, tedi_session_states and every other tediId-scoped child row. Ordinary DELETE /tedis/{tediId} does NOT do this — it retires the tedi and retains all of the above. Sub-cleanups with no programmatic path (R2 storage, artifacts repo) are NOT faked — they are returned in residualManualSteps with the scope each requires. Platform-admin / trusted-service-binding only; fail-closed.",
				tags: ["internal"],
			})
			.input(
				TediIdParamSchema.extend({
					stopSchedules: z.boolean().optional().default(true),
					hardPurge: z.boolean().optional().default(false),
					confirmSlug: z.string().optional(),
				}),
			)
			.output(
				z.object({
					ok: z.literal(true),
					tediId: z.string(),
					slug: z.string().nullable(),
					// Stage 1 — status='paused' + runtime_state='archived' applied.
					decommissioned: z.boolean(),
					// Stage 2 — isolate DO armed-schedule cancellation.
					schedulesStopped: z.object({
						attempted: z.boolean(),
						ok: z.boolean(),
						canceledScheduleIds: z.array(z.string()).optional(),
						detail: z.string().optional(),
					}),
					// Stage 3 — irreversible hard purge executed.
					purged: z.boolean(),
					// Sub-cleanups with a programmatic path that were attempted.
					programmaticCleanups: z.array(
						z.object({
							step: z.string(),
							ok: z.boolean(),
							detail: z.string().optional(),
						}),
					),
					// Sub-cleanups with NO programmatic path the operator must do by hand.
					residualManualSteps: z.array(
						z.object({
							step: z.string(),
							reason: z.string(),
							scope: z.string(),
						}),
					),
				}),
			),

		// =====================================================================
		// CODE MODE SESSION AUTHORIZATION
		// =====================================================================

		authorizeCodingSession: oc
			.route({
				method: "POST",
				path: "/{tediId}/codemode/authorize",
				summary: "Authorize a coding session for Code Mode execute",
				description:
					"Pre-authorizes a sessionKey so the tedi's `execute` tool will run code for requests carrying that key. Requires CODEMODE_EXECUTE_ENABLED=1 on the runtime Worker to take effect. Gate: platform principal or tedi owner. The sessionKey is the same session_id already tracked by the tedi DO.",
				tags: ["internal"],
			})
			.input(
				TediIdParamSchema.extend({
					sessionKey: z
						.string()
						.min(1)
						.describe("Session key to authorize for execute access"),
					authorizedBy: z
						.string()
						.optional()
						.describe("Actor label stored in the DO audit log"),
				}),
			)
			.output(
				z.object({
					ok: z.boolean(),
					error: z.string().optional(),
				}),
			),

		revokeCodingSession: oc
			.route({
				method: "POST",
				path: "/{tediId}/codemode/revoke",
				summary: "Revoke a coding session authorization",
				description:
					"Removes a sessionKey from the tedi DO's execute allowlist. Subsequent `execute` calls carrying that sessionKey will park rather than run. Gate: platform principal or tedi owner.",
				tags: ["internal"],
			})
			.input(
				TediIdParamSchema.extend({
					sessionKey: z.string().min(1).describe("Session key to revoke"),
				}),
			)
			.output(
				z.object({
					ok: z.boolean(),
					error: z.string().optional(),
				}),
			),
	});

export type TedisContract = typeof tedisContract;
