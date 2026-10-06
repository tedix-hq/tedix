/**
 * Workstation schemas
 *
 * A workstation is a leased OS/process environment that a durable tedi joins
 * for an episode or project. Runtime bodies remain internal adapters.
 * Non-OS work such as support, marketing, research, and ops should be modeled
 * as native tedi capabilities, skills, policies, MCP apps, and workflows.
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";

export const WORKSTATION_PROFILE_ID_VALUES = ["general"] as const;
export const WorkstationProfileIdSchema = z.enum(WORKSTATION_PROFILE_ID_VALUES);
export type WorkstationProfileId = z.infer<typeof WorkstationProfileIdSchema>;

export const WORKSTATION_ADAPTER_VALUES = [
	"think-isolate",
	"codemode-runtime",
	"sandbox-workstation",
	"workflow",
	"browser-connector",
	"mcp-connector",
	"artifacts",
	"artifact-fs",
] as const;
export const WorkstationAdapterSchema = z.enum(WORKSTATION_ADAPTER_VALUES);
export type WorkstationAdapter = z.infer<typeof WorkstationAdapterSchema>;

export const WORKSTATION_REPO_STRATEGY_VALUES = [
	"clone",
	"artifact-fs",
	"git-api-workspace",
] as const;
export const WorkstationRepoStrategySchema = z.enum(
	WORKSTATION_REPO_STRATEGY_VALUES,
);
export type WorkstationRepoStrategy = z.infer<
	typeof WorkstationRepoStrategySchema
>;

export const WORKSTATION_CAPABILITY_VALUES = [
	"artifacts",
	"approvals",
	"browser",
	"campaign-assets",
	"citations",
	"cms",
	"chat",
	"crm",
	"customer-transcript",
	"deploy",
	"email",
	"git",
	"github-cli",
	"logs",
	"memory",
	"mcp",
	"native-deps",
	"processes",
	"provider-api",
	"repo",
	"rationale",
	"sandbox-proof",
	"schedule",
	"search",
	"shell",
	"skills",
	"subagents",
	"tests",
	"workflow",
] as const;
export const WorkstationCapabilitySchema = z.enum(
	WORKSTATION_CAPABILITY_VALUES,
);
export type WorkstationCapability = z.infer<typeof WorkstationCapabilitySchema>;

export const WORKSTATION_SEAT_ROLE_VALUES = [
	"lead",
	"collaborator",
	"operator",
	"reviewer",
	"specialist",
] as const;
export const WorkstationSeatRoleSchema = z.enum(WORKSTATION_SEAT_ROLE_VALUES);
export type WorkstationSeatRole = z.infer<typeof WorkstationSeatRoleSchema>;

export const WORKSTATION_STATUS_VALUES = [
	"planned",
	"provisioning",
	"ready",
	"degraded",
	"blocked",
	"archived",
] as const;
export const WorkstationStatusSchema = z.enum(WORKSTATION_STATUS_VALUES);
export type WorkstationStatus = z.infer<typeof WorkstationStatusSchema>;

export const WORKSTATION_LEASE_STATUS_VALUES = [
	"requested",
	"provisioning",
	"active",
	"degraded",
	"blocked",
	"releasing",
	"released",
	"expired",
] as const;
export const WorkstationLeaseStatusSchema = z.enum(
	WORKSTATION_LEASE_STATUS_VALUES,
);
export type WorkstationLeaseStatus = z.infer<
	typeof WorkstationLeaseStatusSchema
>;

export const WORKSTATION_PARTICIPANT_STATUS_VALUES = [
	"invited",
	"active",
	"paused",
	"left",
	"removed",
] as const;
export const WorkstationParticipantStatusSchema = z.enum(
	WORKSTATION_PARTICIPANT_STATUS_VALUES,
);
export type WorkstationParticipantStatus = z.infer<
	typeof WorkstationParticipantStatusSchema
>;

export const WORKSTATION_SESSION_KIND_VALUES = [
	"chat",
	"codemode",
	"shell",
	"test-runner",
	"codex",
	"claude",
	"browser",
	"workflow",
	"dev-server",
	"mcp",
] as const;
export const WorkstationSessionKindSchema = z.enum(
	WORKSTATION_SESSION_KIND_VALUES,
);
export type WorkstationSessionKind = z.infer<
	typeof WorkstationSessionKindSchema
>;

export const WORKSTATION_OPERATION_LOCK_VALUES = [
	"package_install",
	"migration",
	"deploy",
	"branch_push",
	"dependency_cache",
] as const;
export const WorkstationOperationLockSchema = z.enum(
	WORKSTATION_OPERATION_LOCK_VALUES,
);
export type WorkstationOperationLock = z.infer<
	typeof WorkstationOperationLockSchema
>;

export const WORKSTATION_EGRESS_LOGGING_MODE_VALUES = [
	"all",
	"deny_only",
] as const;
export const WorkstationEgressLoggingModeSchema = z.enum(
	WORKSTATION_EGRESS_LOGGING_MODE_VALUES,
);
export type WorkstationEgressLoggingMode = z.infer<
	typeof WorkstationEgressLoggingModeSchema
>;

export const WorkstationEgressHostPatternSchema = z.string().trim().min(1);
export const WorkstationEgressHeaderNameSchema = z
	.string()
	.trim()
	.regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/)
	.refine((value) => {
		const lower = value.toLowerCase();
		return (
			![
				"connection",
				"content-length",
				"host",
				"proxy-authorization",
				"te",
				"trailer",
				"transfer-encoding",
				"upgrade",
			].includes(lower) &&
			!lower.startsWith("cf-") &&
			!lower.startsWith("x-tedix-")
		);
	});

export const WorkstationEgressHeaderInjectionRuleSchema = z.object({
	hosts: z.array(WorkstationEgressHostPatternSchema).min(1),
	header: WorkstationEgressHeaderNameSchema,
	value: z.object({
		secretRef: z.string().trim().min(1),
		prefix: z.string().optional(),
		suffix: z.string().optional(),
	}),
});
export type WorkstationEgressHeaderInjectionRule = z.input<
	typeof WorkstationEgressHeaderInjectionRuleSchema
>;

export const WorkstationEgressPolicySchema = z.object({
	allowedHosts: z.array(WorkstationEgressHostPatternSchema).optional(),
	deniedHosts: z.array(WorkstationEgressHostPatternSchema).optional(),
	injectHeaders: z.array(WorkstationEgressHeaderInjectionRuleSchema).optional(),
	artifactsRepository: z
		.object({
			host: z.string().regex(/^[a-f0-9]{32}\.artifacts\.cloudflare\.net$/),
			path: z
				.string()
				.regex(/^\/git\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*\.git$/),
		})
		.optional(),
	loggingMode: WorkstationEgressLoggingModeSchema.default("deny_only"),
});
export type WorkstationEgressPolicy = z.input<
	typeof WorkstationEgressPolicySchema
>;

export const WORKSTATION_INSTALL_STATUS_VALUES = [
	"blocked",
	"canceled",
	"completed",
	"failed",
	"missing",
	"not_required",
	"ready",
	"running",
	"stuck",
	"timed_out",
	"unknown",
] as const;
export const WorkstationInstallStatusSchema = z.enum(
	WORKSTATION_INSTALL_STATUS_VALUES,
);
export type WorkstationInstallStatus = z.infer<
	typeof WorkstationInstallStatusSchema
>;

export const WORKSTATION_CACHE_BACKUP_STATUS_VALUES = [
	"failed",
	"missing",
	"pending",
	"persisted",
	"restored",
	"skipped",
	"unavailable",
] as const;
export const WorkstationCacheBackupStatusSchema = z.enum(
	WORKSTATION_CACHE_BACKUP_STATUS_VALUES,
);
export type WorkstationCacheBackupStatus = z.infer<
	typeof WorkstationCacheBackupStatusSchema
>;

export const WorkstationPackageManagerSchema = z.enum([
	"bun",
	"npm",
	"pnpm",
	"unknown",
	"yarn",
]);
export type WorkstationPackageManager = z.infer<
	typeof WorkstationPackageManagerSchema
>;

const JsonRecordSchema = z.record(z.string(), JsonValueSchema);

export const WorkstationBootstrapReadinessSchema = z.object({
	toolsReady: z.boolean(),
	secretsReady: z.boolean(),
	repoReady: z.boolean(),
	depsReady: z.boolean(),
	environmentReady: z.boolean(),
	installStatus: WorkstationInstallStatusSchema,
	installProcessId: z.string().min(1),
	lockfileHash: z.string().nullable(),
	packageManager: WorkstationPackageManagerSchema.nullable(),
	cacheKey: z.string().nullable(),
	cacheRestoredAt: z.string().nullable(),
	cacheBackupRef: z.string().nullable(),
	cacheBackupStatus: WorkstationCacheBackupStatusSchema,
	cacheBackupError: z.string().nullable(),
	lastInstallExitCode: z.number().int().nullable(),
	lastInstallArtifactRef: z.string().nullable(),
	lastBootstrapError: z.string().nullable(),
	nextAction: z.string().nullable(),
	nextCommand: z.string().nullable(),
	dimensions: z.object({
		toolsReady: z.boolean(),
		secretsReady: z.boolean(),
		repoReady: z.boolean(),
		depsReady: z.boolean(),
	}),
});
export type WorkstationBootstrapReadiness = z.infer<
	typeof WorkstationBootstrapReadinessSchema
>;

export const WorkstationProfileSchema = z.object({
	id: WorkstationProfileIdSchema,
	title: z.string(),
	summary: z.string(),
	defaultEnvironment: z.string(),
	capabilities: z.array(WorkstationCapabilitySchema).min(1),
	defaultAdapters: z.array(WorkstationAdapterSchema).min(1),
	repoStrategy: WorkstationRepoStrategySchema.default("clone"),
	approvalTriggers: z.array(z.string()).default([]),
	collaboration: z.object({
		/**
		 * Exclusive is the safe default: one task episode owns the mutable
		 * workspace. Collaborative leases admit named tedis deliberately, while
		 * pool reuse only reuses capacity after the previous episode releases it.
		 */
		mode: z.enum(["exclusive", "collaborative"]),
		sharedWorkspace: z.boolean(),
		multipleTediSeats: z.boolean(),
	}),
});
export type WorkstationProfile = z.infer<typeof WorkstationProfileSchema>;

export const WorkstationSeatSchema = z.object({
	tediId: z.string(),
	slug: z.string().optional(),
	role: WorkstationSeatRoleSchema.default("collaborator"),
	permissionScopes: z.array(z.string()).default([]),
});
export type WorkstationSeat = z.infer<typeof WorkstationSeatSchema>;

export const WorkstationSchema = z.object({
	id: z.string(),
	profileId: WorkstationProfileIdSchema,
	organizationId: z.string().nullable(),
	status: WorkstationStatusSchema,
	seats: z.array(WorkstationSeatSchema).min(1),
	capabilities: z.array(WorkstationCapabilitySchema).min(1),
	adapters: z.array(WorkstationAdapterSchema).min(1),
	artifactRefs: z.array(z.string()).default([]),
	metadata: JsonRecordSchema.default({}),
});
export type Workstation = z.infer<typeof WorkstationSchema>;

export const WorkstationParticipantSchema = z.object({
	id: z.string(),
	leaseId: z.string(),
	organizationId: z.string().nullable(),
	tediId: z.string(),
	slug: z.string().optional(),
	role: WorkstationSeatRoleSchema.default("collaborator"),
	status: WorkstationParticipantStatusSchema.default("active"),
	permissionScopes: z.array(z.string()).default([]),
	joinedAt: z.string(),
	leftAt: z.string().nullable().default(null),
	metadata: JsonRecordSchema.default({}),
});
export type WorkstationParticipant = z.infer<
	typeof WorkstationParticipantSchema
>;

export const WorkstationSessionSchema = z.object({
	id: z.string(),
	leaseId: z.string(),
	organizationId: z.string().nullable(),
	participantId: z.string().nullable().default(null),
	kind: WorkstationSessionKindSchema,
	adapter: WorkstationAdapterSchema,
	status: WorkstationStatusSchema,
	sessionKey: z.string().nullable().default(null),
	externalId: z.string().nullable().default(null),
	artifactRefs: z.array(z.string()).default([]),
	startedAt: z.string(),
	endedAt: z.string().nullable().default(null),
	metadata: JsonRecordSchema.default({}),
});
export type WorkstationSession = z.infer<typeof WorkstationSessionSchema>;

export const WorkstationLeaseSchema = z.object({
	id: z.string(),
	workstationId: z.string(),
	profileId: WorkstationProfileIdSchema,
	organizationId: z.string().nullable(),
	workItemId: z.string().nullable().default(null),
	attemptId: z
		.string()
		.nullable()
		.optional()
		.describe("Absent on leases created before governed attempt binding."),
	repositoryPath: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Present only after a governed repository preparation binds immutable authority.",
		),
	repoStartSha: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Present only after the repository checkout has been prepared and bound.",
		),
	preparedStartSha: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Present only after a fresh native preparation is durably bound.",
		),
	kernelRunId: z.string().nullable().default(null),
	traceBundleId: z.string().nullable().default(null),
	status: WorkstationLeaseStatusSchema,
	capabilities: z.array(WorkstationCapabilitySchema).min(1),
	adapters: z.array(WorkstationAdapterSchema).min(1),
	participants: z.array(WorkstationParticipantSchema).default([]),
	sessions: z.array(WorkstationSessionSchema).default([]),
	approvalIds: z.array(z.string()).default([]),
	artifactRefs: z.array(z.string()).default([]),
	createdAt: z.string(),
	updatedAt: z.string(),
	expiresAt: z.string().nullable().default(null),
	releasedAt: z.string().nullable().default(null),
	metadata: JsonRecordSchema.default({}),
});
export type WorkstationLease = z.infer<typeof WorkstationLeaseSchema>;

export const RepositoryInspectionOperationSchema = z.enum([
	"status",
	"diff",
	"read",
]);
export const RepositoryInspectionRequestSchema = z
	.object({
		operation: RepositoryInspectionOperationSchema,
		path: z
			.string()
			.min(1)
			.max(4_096)
			.optional()
			.describe(
				"Required for per-file diff/read and absent for status inventory.",
			),
	})
	.superRefine((value, context) => {
		if (value.operation !== "status" && !value.path)
			context.addIssue({ code: "custom", message: "path is required" });
		if (value.operation === "status" && value.path)
			context.addIssue({
				code: "custom",
				message: "status does not accept path",
			});
	});

export const RepositoryChangeStatusSchema = z.enum([
	"added",
	"deleted",
	"modified",
	"type_changed",
	"unmerged",
	"untracked",
	"unknown",
]);
export type RepositoryChangeStatus = z.infer<
	typeof RepositoryChangeStatusSchema
>;

export const RepositoryInspectionTruncationReasonSchema = z.enum([
	"byte_limit",
	"entry_limit",
	"hunk_limit",
	"line_limit",
	"timeout",
]);

export const RepositoryInspectionSkipReasonSchema = z.enum([
	"binary",
	"command_failed",
	"invalid_utf8",
	"unsupported_content_filter",
]);

export const RepositoryChangedFileSchema = z.object({
	path: z.string().min(1).max(4_096),
	status: RepositoryChangeStatusSchema,
	rawStatus: z.string().min(1).max(8),
	untracked: z.boolean(),
});

export const RepositoryDiffLineSchema = z.object({
	kind: z.enum(["addition", "context", "deletion", "meta"]),
	content: z.string().max(16_384),
	oldLine: z.number().int().positive().nullable(),
	newLine: z.number().int().positive().nullable(),
});

export const RepositoryDiffHunkSchema = z.object({
	header: z.string().max(4_096),
	oldStart: z.number().int().nonnegative(),
	oldLines: z.number().int().nonnegative(),
	newStart: z.number().int().nonnegative(),
	newLines: z.number().int().nonnegative(),
	lines: z.array(RepositoryDiffLineSchema).max(2_000),
});

export const RepositoryInspectionResultSchema = z
	.object({
		baselineSha: z.string().regex(/^[a-f0-9]{40}$/),
		currentSha: z.string().regex(/^[a-f0-9]{40}$/),
		generationId: z.string().min(1),
		observedAt: z.string().datetime(),
		nonAtomic: z.literal(true),
		kind: z.enum(["git", "file", "symlink"]),
		dataBase64: z.string().max(750_000),
		stderrBase64: z.string().max(750_000),
		exitCode: z.number().int(),
		timedOut: z.boolean(),
		truncated: z.boolean(),
		truncationReasons: z
			.array(RepositoryInspectionTruncationReasonSchema)
			.max(5),
		files: z
			.array(RepositoryChangedFileSchema)
			.max(200)
			.optional()
			.describe("Typed bounded change inventory returned only by status."),
		entryCount: z
			.number()
			.int()
			.nonnegative()
			.max(200)
			.optional()
			.describe("Bounded inventory count returned only by status."),
		binary: z
			.boolean()
			.optional()
			.describe("Binary classification returned only by per-file inspection."),
		skipReason: RepositoryInspectionSkipReasonSchema.nullable()
			.optional()
			.describe("Why structured content is intentionally unavailable."),
		hunks: z
			.array(RepositoryDiffHunkSchema)
			.max(200)
			.optional()
			.describe("Bounded parsed unified-diff hunks returned by diff."),
		size: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe(
				"Observed file size returned when the operation has one file target.",
			),
	})
	.superRefine((value, context) => {
		if (value.truncated !== value.truncationReasons.length > 0)
			context.addIssue({
				code: "custom",
				message: "truncated must match explicit truncation reasons",
			});
		const hunkLines = value.hunks?.flatMap((hunk) => hunk.lines) ?? [];
		if (hunkLines.length > 2_000)
			context.addIssue({ code: "custom", message: "too many diff lines" });
		if (
			(value.hunks ?? []).reduce(
				(total, hunk) => total + hunk.header.length,
				0,
			) +
				hunkLines.reduce((total, line) => total + line.content.length, 0) >
			750_000
		)
			context.addIssue({
				code: "custom",
				message: "structured diff is too large",
			});
		if (value.skipReason === "binary" && value.binary !== true)
			context.addIssue({
				code: "custom",
				message: "binary skip reason requires binary classification",
			});
	});
export type RepositoryInspectionResult = z.infer<
	typeof RepositoryInspectionResultSchema
>;

export const WORKSTATION_PROFILES: Record<
	WorkstationProfileId,
	WorkstationProfile
> = {
	general: WorkstationProfileSchema.parse({
		id: "general",
		title: "General workstation",
		summary:
			"Task-scoped OS, shell, process, repository, browser-preview, and artifact capabilities for work that cannot run in the Agent runtime.",
		defaultEnvironment: "Agent runtime with on-demand Sandbox escalation",
		capabilities: [
			"repo",
			"shell",
			"git",
			"github-cli",
			"tests",
			"processes",
			"browser",
			"mcp",
			"artifacts",
			"approvals",
		],
		defaultAdapters: [
			"think-isolate",
			"codemode-runtime",
			"sandbox-workstation",
			"browser-connector",
			"artifacts",
		],
		repoStrategy: "clone",
		approvalTriggers: ["push", "deploy", "write-secret", "delete-data"],
		collaboration: {
			mode: "exclusive",
			sharedWorkspace: false,
			multipleTediSeats: false,
		},
	}),
};

export function getWorkstationProfile(
	id: WorkstationProfileId,
): WorkstationProfile {
	return WORKSTATION_PROFILES[id];
}

export function recommendWorkstationProfileId(input: {
	objective?: string;
	requiredCapabilities?: WorkstationCapability[];
}): WorkstationProfileId {
	void input;
	return "general";
}

function slugPart(value: string | null | undefined): string {
	return (
		(value || "global")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64) || "global"
	);
}

export function createWorkstationEpisodeIds(input: {
	executionKey?: string | null;
	organizationId?: string | null;
	profileId: WorkstationProfileId;
	slug?: string | null;
	tediId: string;
}): { leaseId: string; workstationId: string } {
	const baseWorkstationId = `ws_${input.profileId}_${slugPart(
		input.organizationId,
	)}_${slugPart(input.slug ?? input.tediId)}`;
	const executionPart = input.executionKey
		? slugPart(input.executionKey).slice(0, 48)
		: null;
	const workstationId = executionPart
		? `${baseWorkstationId}_episode_${executionPart}`
		: baseWorkstationId;
	return {
		leaseId: workstationId.replace(/^ws_/, "wl_"),
		workstationId,
	};
}

export function createWorkstationSnapshot(input: {
	artifactRefs?: string[];
	metadata?: Record<string, unknown>;
	organizationId?: string | null;
	profileId: WorkstationProfileId;
	seats: WorkstationSeat[];
	status?: WorkstationStatus;
	workstationId?: string;
}): Workstation {
	const profile = getWorkstationProfile(input.profileId);
	const firstSeat = input.seats[0];
	const id =
		input.workstationId ??
		`ws_${profile.id}_${slugPart(input.organizationId)}_${slugPart(
			firstSeat?.slug ?? firstSeat?.tediId,
		)}`;
	return WorkstationSchema.parse({
		id,
		profileId: profile.id,
		organizationId: input.organizationId ?? null,
		status: input.status ?? "planned",
		seats: input.seats,
		capabilities: profile.capabilities,
		adapters: profile.defaultAdapters,
		artifactRefs: input.artifactRefs ?? [],
		metadata: input.metadata ?? {},
	});
}

export function createWorkstationLease(input: {
	artifactRefs?: string[];
	approvalIds?: string[];
	createdAt?: string;
	expiresAt?: string | null;
	kernelRunId?: string | null;
	leaseId?: string;
	metadata?: Record<string, unknown>;
	organizationId?: string | null;
	profileId: WorkstationProfileId;
	sessions?: Array<
		Omit<WorkstationSession, "leaseId" | "organizationId" | "startedAt"> &
			Partial<
				Pick<WorkstationSession, "leaseId" | "organizationId" | "startedAt">
			>
	>;
	status?: WorkstationLeaseStatus;
	traceBundleId?: string | null;
	workItemId?: string | null;
	workstationId?: string;
	seats: WorkstationSeat[];
	updatedAt?: string;
}): WorkstationLease {
	const createdAt = input.createdAt ?? new Date().toISOString();
	const workstation = createWorkstationSnapshot({
		artifactRefs: input.artifactRefs,
		metadata: input.metadata,
		organizationId: input.organizationId,
		profileId: input.profileId,
		seats: input.seats,
		status:
			input.status === "active"
				? "ready"
				: input.status === "requested"
					? "planned"
					: input.status === "releasing" ||
						  input.status === "released" ||
						  input.status === "expired"
						? "archived"
						: input.status,
		workstationId: input.workstationId,
	});
	const leaseId = input.leaseId ?? workstation.id.replace(/^ws_/, "wl_");
	const participants = input.seats.map((seat, index) =>
		WorkstationParticipantSchema.parse({
			id: `${leaseId}_participant_${slugPart(seat.slug ?? seat.tediId)}`,
			leaseId,
			organizationId: input.organizationId ?? null,
			tediId: seat.tediId,
			slug: seat.slug,
			role: seat.role,
			status: "active",
			permissionScopes: seat.permissionScopes,
			joinedAt: createdAt,
			metadata: { seatIndex: index },
		}),
	);
	const sessions = (input.sessions ?? []).map((session) =>
		WorkstationSessionSchema.parse({
			...session,
			leaseId,
			organizationId: input.organizationId ?? null,
			startedAt: session.startedAt ?? createdAt,
		}),
	);

	return WorkstationLeaseSchema.parse({
		id: leaseId,
		workstationId: workstation.id,
		profileId: workstation.profileId,
		organizationId: workstation.organizationId,
		workItemId: input.workItemId ?? null,
		kernelRunId: input.kernelRunId ?? null,
		traceBundleId: input.traceBundleId ?? null,
		status: input.status ?? "requested",
		capabilities: workstation.capabilities,
		adapters: workstation.adapters,
		participants,
		sessions,
		approvalIds: input.approvalIds ?? [],
		artifactRefs: input.artifactRefs ?? [],
		createdAt,
		updatedAt: input.updatedAt ?? createdAt,
		expiresAt: input.expiresAt ?? null,
		metadata: input.metadata ?? {},
	});
}
