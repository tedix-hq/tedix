import { startCheckoutOperation } from "../../../workstation/checkout-lock";
import { tracing } from "cloudflare:workers";
import {
	commandMayPush,
	pushPublicationProof,
	type PushPublicationProof,
} from "../../../workstation/push-publication";
import type { DirectoryBackupRecord } from "@cloudflare/sandbox";
import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import { isServiceBinding } from "@tedix/worker-kit/request-auth";
import type { RecordArtifactInput } from "@tedix/api-contract/schemas/cognitive-runtime";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	createWorkstationEpisodeIds,
	createWorkstationLease,
	createWorkstationSnapshot,
	getWorkstationProfile,
	type Workstation,
	type WorkstationAdapter,
	type WorkstationBootstrapReadiness,
	type WorkstationCacheBackupStatus,
	type WorkstationInstallStatus,
	type WorkstationLease,
	type WorkstationLeaseStatus,
	type WorkstationOperationLock,
	WorkstationOperationLockSchema,
	type WorkstationPackageManager,
	type WorkstationProfileId,
	type WorkstationSeatRole,
	type WorkstationSession,
	type WorkstationSessionKind,
	WorkstationSessionKindSchema,
	type WorkstationStatus,
} from "@tedix/api-contract/schemas/workstation";
import { createDbClient } from "@tedix/db/client";
import { getAuthoritativeWorkItemAttempt } from "@tedix/db/queries/work-items/attempts";
import { canAccessInactiveWorkstation } from "../../../workstation/inactive-lease-access";
import {
	bindWorkstationLeaseRepositoryAuthority,
	getWorkstationLeaseBundle as getWorkstationLeaseRowBundle,
	recordWorkstationLeaseBodyInstance,
	updateWorkstationLeaseBodyGeneration,
} from "@tedix/db/queries/workstations";
import { toJsonRecord } from "@tedix/db/utils/json";
import type { Context } from "hono";
import {
	attachBodyGenerationSecrets,
	type RuntimeBodyGeneration,
} from "../../../runtime/body-launcher";
import {
	createWorkstationOutboundHandlerParams,
	workstationEgressPolicySummary,
} from "../../../runtime/workstation-egress";
import type { AppEnv, TediConfig } from "../../../types";
import { contentFreeTediException, createTediLogger } from "../../../log";
import {
	WorkstationObservationTimeoutError,
	WorkstationDispatchUnknownError,
	withWorkstationObservationDeadline,
	workstationExec,
	workstationExecutionStatus,
	type WorkstationExecResult,
	type WorkstationLaunchResult,
	type WorkstationExecutionStatus,
	type WorkstationRuntimeBody,
} from "../../../workstation/computer-body";
import { WORKSTATION_EGRESS_GUARD_VERSION } from "../../../workstation/egress-guard";
import {
	hydrateGitHubCliCredentials,
	hydrateGitIdentity,
	probeGitHubCliCredentials,
} from "../../../workstation/github-credentials";
import {
	isWorkstationPath,
	WORKSTATION_DIR,
	WORKSTATION_GH_HOSTS_PATH,
	WORKSTATION_GIT_CREDENTIALS_PATH,
	WORKSTATION_HOME,
	WORKSTATION_REPOS_DIR,
} from "../../../workstation/paths";
import {
	getWorkstationLeaseBundle,
	upsertWorkstationLeaseBundle,
	type WorkstationLeaseBundle,
} from "../../../workstation/persistence";
import {
	restoreWorkstationRecoveryCheckpoint,
	type WorkstationRecoveryCheckpointResult,
	type LockedCheckpointNative,
	type RecoveryCheckpointProvenance,
} from "../../../workstation/recovery-checkpoint";
import {
	type RepoSyncResult,
	type RepoTreePreflight,
	readRepoSyncStatus,
	syncRepoIfConfigured,
} from "../../../workstation/repo-sync";
import { errorMessage } from "@tedix/worker-kit/error-message";

const log = createTediLogger("tedi.workstation.receipt");
export const WORKSTATION_HEADER = "X-Tedix-Workstation";
const WORKSTATION_CONVERSATION_HEADER = "X-Tedix-Workstation-Conversation-Id";
const WORKSTATION_RUN_HEADER = "X-Tedix-Workstation-Run-Id";

export const ACTIVE_WORKSTATION_PROFILE_ID =
	"general" satisfies WorkstationProfileId;

export const ACTIVE_WORKSTATION_SESSION_ADAPTER =
	"sandbox-workstation" satisfies WorkstationAdapter;

export const ACTIVE_WORKSTATION_PROFILE = getWorkstationProfile(
	ACTIVE_WORKSTATION_PROFILE_ID,
);

export const ACTIVE_WORKSTATION_BINDING = {
	adapterKind: "cloudflare-sandbox-workstation",
	bodyAdapter: "tedix-sandbox-workstation",
	profile: ACTIVE_WORKSTATION_PROFILE,
	sessionAdapter: ACTIVE_WORKSTATION_SESSION_ADAPTER,
} as const;

if (
	!ACTIVE_WORKSTATION_BINDING.profile.defaultAdapters.includes(
		ACTIVE_WORKSTATION_BINDING.sessionAdapter,
	)
) {
	throw new Error(
		`Workstation profile ${ACTIVE_WORKSTATION_BINDING.profile.id} does not allow adapter ${ACTIVE_WORKSTATION_BINDING.sessionAdapter}`,
	);
}

export const WORKSTATION_JOBS_DIR = `${WORKSTATION_DIR}/jobs`;

export const WORKSTATION_OPERATION_LOCKS_DIR = `${WORKSTATION_DIR}/locks/operations`;

export const WORKSTATION_SESSION_LOCKS_DIR = `${WORKSTATION_DIR}/locks/sessions`;

export const WORKSTATION_BOOTSTRAP_INSTALL_PROCESS_ID = "bootstrap-install";

export const WORKSTATION_BOOTSTRAP_INSTALL_STUCK_MS = 30 * 60 * 1000;

// Wall-clock ceiling for an AUTO-started bootstrap install. Kept below
// WORKSTATION_BOOTSTRAP_INSTALL_STUCK_MS (30m) so a job that overruns records
// `timed_out_at` and surfaces as "timed_out" (operator restart) rather than
// "stuck". A cold full-monorepo install downloads thousands of tarballs through
// the per-host egress proxy. Immutable public package tarballs are edge-cached
// by that broker, and retries retain the package cache before one final clean
// fallback. Only applies to the self-bootstrap path (scheduleBootstrapInstall).
export const WORKSTATION_BOOTSTRAP_INSTALL_TIMEOUT_MS = 25 * 60 * 1000;

// Cooldown after a bootstrap-install LAUNCH failure (Computer exec rejected before
// the wrapped command ran, so no job dir/sentinel exists). Throttles the
// self-bootstrap retry so a persistently-failing launch is not re-fired on every
// readiness poll. See scheduleBootstrapInstall.
export const WORKSTATION_BOOTSTRAP_INSTALL_LAUNCH_BACKOFF_MS = 2 * 60 * 1000;

export const WORKSTATION_BOOTSTRAP_CACHE_RESTORED_AT_PATH = `${WORKSTATION_DIR}/cache/restored_at`;

export const WORKSTATION_BOOTSTRAP_PACKAGE_CACHE_DIR = `${WORKSTATION_DIR}/cache/package-managers`;

export const WORKSTATION_BOOTSTRAP_DEPENDENCY_MARKER =
	"node_modules/.tedix-dependency-fingerprint";

export const WORKSTATION_BOOTSTRAP_CACHE_TTL_SECONDS = 14 * 24 * 60 * 60;

export const WORKSTATION_BOOTSTRAP_CACHE_RECORD_VERSION = 3;

export const WORKSTATION_BOOTSTRAP_CACHE_PROFILE_VERSION = `${ACTIVE_WORKSTATION_BINDING.adapterKind}:${WORKSTATION_EGRESS_GUARD_VERSION}:dependency-cache-v6`;

export const WORKSTATION_BOOTSTRAP_CACHE_MAX_RECORDS = 4;

// Sandbox directory snapshots traverse the full dependency tree inside the DO.
// A live 3,116-package Tedix install exceeded the DO memory limit and replaced
// the Computer generation immediately after readiness. Existing cache records
// remain readable, but writes stay disabled until backup is streamed outside
// the DO rather than materialized through Sandbox.
export const WORKSTATION_BOOTSTRAP_CACHE_BACKUP_ENABLED = false;

export const WORKSTATION_OPERATION_LOCK_TIMEOUT_SECONDS = 600;

export const WORKSTATION_OPERATION_LOCK_STALE_SECONDS = 30 * 60;

export const DEFAULT_PROCESS_TAIL_BYTES = 64_000;

export const MAX_PROCESS_TAIL_BYTES = 256_000;

// Native reviewer reads are deliberately bounded to 200k characters. Publish
// that same bounded tail inline so a terminal log artifact is actually
// inspectable through artifact:// instead of merely pointing at private R2.
export const MAX_REVIEWER_OPENABLE_LOG_BYTES = 200_000;

// Must match the TEDI_STORAGE binding's real bucket (cloudflare.config.ts): the
// artifact-serve streamer resolves r2://<bucket>/ refs by name. Older rows
// carry the legacy "tedi-storage" ref, which artifact-serve aliases.
export const WORKSTATION_PROCESS_ARTIFACT_BUCKET_REF = "tedix-tedi-production";

export const WORKSTATION_PATHS = new Set([
	"/api/admin/workstation/repository/inspect",
	"/api/admin/workstation/wake",
	"/api/admin/workstation/provision",
	"/api/admin/workstation/exec",
	"/api/admin/workstation/files",
	"/api/admin/workstation/dev-server",
	"/api/admin/workstation/process/start",
	"/api/admin/workstation/process/status",
	"/api/admin/workstation/process/wait",
	"/api/admin/workstation/process/cancel",
	"/api/admin/workstation/join",
	"/api/admin/workstation/release",
	"/api/admin/workstation/status",
]);

export function isWorkstationRequest(
	method: string,
	pathname: string,
	headers: Headers,
): boolean {
	return (
		method.toUpperCase() === "POST" &&
		WORKSTATION_PATHS.has(pathname) &&
		headers.get(WORKSTATION_HEADER) === "true"
	);
}

export type ToolProbe = {
	ok: boolean;
	version?: string;
	error?: string;
};

export type WorkstationPreparation = "shell" | "repository";

export function workstationPreparation(
	session?: WorkstationSessionSelection,
): WorkstationPreparation {
	return session?.leaseBundle?.workstation.metadata.preparation === "shell"
		? "shell"
		: "repository";
}

export type WorkstationState = {
	preparation?: WorkstationPreparation;
	/** Physical placement is unavailable in v1; native handles fence critical callbacks. */
	containerPlacementId: string | null;
	credentials: Awaited<ReturnType<typeof hydrateGitHubCliCredentials>>;
	repoSync: RepoSyncResult;
	setupError?: string;
	tools: Record<"gh" | "git", ToolProbe>;
	toolsReady: boolean;
};

export type WorkstationExecOptions = Parameters<typeof workstationExec>[2];

export type ProofWritingLauncher =
	AppEnv["Variables"]["runtimeBodyLauncher"] & {
		writeBodyGenerationProof(): Promise<void>;
	};

export type WorkstationProcessEventType =
	| "workstation.process.canceled"
	| "workstation.process.completed"
	| "workstation.process.failed"
	| "workstation.process.started"
	| "workstation.process.timed_out";

export type WorkstationProcessEvidence = {
	artifactWriteStatus?: WorkstationJobStatus["artifactWriteStatus"];
	conversationId?: string | null;
	eventType: WorkstationProcessEventType;
	workstationId: string;
	leaseId: string;
	profileId: WorkstationProfileId;
	sessionId: string;
	sessionKind: WorkstationSessionKind;
	processId: string;
	participantId: string | null;
	participantTediId: string;
	workItemId: string | null;
	kernelRunId: string | null;
	traceId: string | null;
	operationLock: WorkstationOperationLock | null;
	operationLockSource: WorkstationOperationLockSource | null;
	command: string | null;
	cwd: string | null;
	startedAt: string | null;
	endedAt: string | null;
	terminal: boolean;
	running: boolean;
	exitCode: number | null;
	signal?: number;
	canceled: boolean;
	canceledAt: string | null;
	timeoutMs: number | null;
	timedOut: boolean;
	timedOutAt: string | null;
	localLogPaths: {
		logDir: string;
		stdoutPath: string;
		stderrPath: string;
	};
	artifactRefs: string[];
};

export type WorkstationProcessContext = {
	admittedAt: string | null;
	admittedCheckoutSha: string | null;
	admittedContainerPlacementId: string | null;
	conversationId: string | null;
	kernelRunId: string | null;
	leadParticipantId: string | null;
	leaseId: string | null;
	participantId: string | null;
	participantTediId: string | null;
	operationLock: WorkstationOperationLock | null;
	operationLockSource: WorkstationOperationLockSource | null;
	sessionId: string | null;
	sessionKind: WorkstationSessionKind | null;
	traceBundleId: string | null;
	traceId: string | null;
	workItemId: string | null;
	workstationId: string | null;
};

export type WorkstationOperationLockSource = "detected" | "explicit";

export type WorkstationOperationLockSelection = {
	kind: WorkstationOperationLock;
	source: WorkstationOperationLockSource;
};

export type WorkstationJobStatus = {
	publicationProof?: PushPublicationProof;
	id: string;
	processId: string;
	observation?: "unavailable" | "generation_replaced";
	containerExitContext?: string;
	found: boolean;
	command: string | null;
	context: WorkstationProcessContext | null;
	cwd: string | null;
	process: null;
	running: boolean;
	terminal: boolean;
	exitCode: number | null;
	signal?: number;
	canceled: boolean;
	canceledAt: string | null;
	timeoutMs: number | null;
	timedOut: boolean;
	timedOutAt: string | null;
	startedAt: string | null;
	endedAt: string | null;
	logDir: string;
	stdoutPath: string;
	stderrPath: string;
	tailBytes: number;
	stdoutBytes: number | null;
	stderrBytes: number | null;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	stdoutTail: string;
	stderrTail: string;
	evidence?: WorkstationProcessEvidence;
	artifactRefs?: string[];
	artifactWriteStatus?: {
		error?: string;
		reason?: string;
		status: "failed" | "persisted" | "skipped";
	};
	artifactRowPersistence?: {
		artifactIds?: string[];
		error?: string;
		reason?: string;
		recorded?: number;
		skipped?: number;
		status: "failed" | "persisted" | "skipped";
	};
	workstationEvidencePersistence?: {
		error?: string;
		reason?: string;
		status: "failed" | "persisted" | "skipped";
	};
};

export type WorkstationSessionSelection = {
	leaseBundle?: WorkstationLeaseBundle;
	leadParticipantId: string;
	leaseId: string;
	participantId: string;
	participantRole: WorkstationSeatRole;
	participantTediId: string;
	sessionId: string;
	sessionKind: WorkstationSessionKind;
	workstationId: string;
};

export type WorkstationBootstrapCacheBackup = DirectoryBackupRecord;

export type WorkstationBootstrapCacheBackupEntry = {
	backup: WorkstationBootstrapCacheBackup;
	dir: string;
	kind: "node_modules" | "package_manager_cache";
};

export type WorkstationBootstrapCacheRecord = {
	version: typeof WORKSTATION_BOOTSTRAP_CACHE_RECORD_VERSION;
	cacheKey: string;
	profileId: WorkstationProfileId;
	profileVersion: typeof WORKSTATION_BOOTSTRAP_CACHE_PROFILE_VERSION;
	packageManager: WorkstationPackageManager;
	tediId: string;
	lockfile: string | null;
	lockfileHash: string;
	workdir: string;
	nodeModulesDir: string;
	backups: WorkstationBootstrapCacheBackupEntry[];
	createdAt: string;
};

export type WorkstationBootstrapCacheResult = {
	error?: string;
	executionId?: string;
	observation?: "unknown";
	ref: string | null;
	restoredAt?: string;
	status: WorkstationCacheBackupStatus;
};

export function workstationErrorStatus(
	status: number | undefined,
): 400 | 403 | 404 | 503 {
	if (status === 403) return 403;
	if (status === 404) return 404;
	if (status === 503) return 503;
	return 400;
}

/**
 * Where the time inside a workstation request actually went.
 *
 * The runtime measures one `dispatchMs` for a request that does a dozen
 * things, so "dispatch dominates" was as far as any investigation could get:
 * the number cannot say whether it is transport, container round trips, or
 * D1. These phases are measured here, by the Worker serving the request, and
 * travel back on the response — so the runtime can subtract them from its own
 * clock and name the transport share exactly.
 */
export type WorkstationRequestTimings = Record<string, number> & {
	totalMs: number;
};

export type WorkstationRequestPhases = {
	/** Record how long `run` took under `name`; repeats accumulate. */
	time: <T>(name: string, run: () => Promise<T>) => Promise<T>;
	/** Record a span measured by the caller, for code `time` cannot wrap. */
	mark: (name: string, startedAt: number) => void;
	timings: () => WorkstationRequestTimings;
};

export function workstationRequestPhases(diagnostic?: {
	processId: string;
	leaseId?: string;
}): WorkstationRequestPhases {
	const enteredAt = Date.now();
	const phases: Record<string, number> = {};
	const add = (name: string, startedAt: number): void => {
		phases[name] = (phases[name] ?? 0) + (Date.now() - startedAt);
	};
	return {
		mark: add,
		async time<T>(name: string, run: () => Promise<T>): Promise<T> {
			const startedAt = Date.now();
			// Emit while a phase is stalled: a canceled request cannot return timings.
			const slowTimer = diagnostic
				? setTimeout(() => {
						console.warn("[workstation] slow process status phase", {
							...diagnostic,
							phase: name,
							elapsedMs: Date.now() - startedAt,
							completedPhases: { ...phases },
							totalMs: Date.now() - enteredAt,
						});
					}, 10_000)
				: undefined;
			try {
				return await tracing.enterSpan(`workstation.${name}`, run);
			} finally {
				if (slowTimer !== undefined) clearTimeout(slowTimer);
				add(name, startedAt);
			}
		},
		timings: () => ({ ...phases, totalMs: Date.now() - enteredAt }),
	};
}

export async function execInRuntimeBody(
	c: {
		get: <K extends keyof AppEnv["Variables"]>(
			key: K,
		) => AppEnv["Variables"][K];
	},
	command: string,
	options?: WorkstationExecOptions,
): Promise<WorkstationExecResult> {
	return execInRuntimeBodyAttempt(c, command, options);
}

export async function execInRuntimeBodyAttempt(
	c: {
		get: <K extends keyof AppEnv["Variables"]>(
			key: K,
		) => AppEnv["Variables"][K];
	},
	command: string,
	options?: WorkstationExecOptions,
): Promise<WorkstationExecResult> {
	const launcher = c.get("runtimeBodyLauncher");
	return launcher?.exec
		? (launcher.exec(command, options) as Promise<WorkstationExecResult>)
		: workstationExec(c.get("sandbox"), command, options);
}

export const CHECKOUT_CLOSING_MARKER = `${WORKSTATION_DIR}/locks/checkout.closing`;

/** Recheck durable authority after waiting for the native fence: an old request
 * must not write into a new container after release destroyed its original body. */
export async function assertCheckoutAuthority(
	c: Context<AppEnv>,
	requireLead = false,
): Promise<void> {
	if (!c.env.DB) return;
	const selection = c.get("workstationRuntimeSelection");
	const config = c.get("tediConfig");
	const bundle = selection?.leaseId
		? await getWorkstationLeaseBundle(
				createDbClient(c.env.DB),
				selection.leaseId,
			)
		: null;
	const lease = bundle?.workstationLease;
	const participant = lease?.participants.find((p) => p.tediId === config.id);
	if (
		!lease ||
		!selection ||
		lease.workstationId !== selection.workstationId ||
		lease.organizationId !== config.organizationId ||
		lease.workItemId !== (selection.workItemId ?? null) ||
		["releasing", "released", "expired"].includes(lease.status) ||
		!participant ||
		(requireLead && participant.role !== "lead") ||
		!["active", "invited", "paused"].includes(participant.status)
	) {
		throw new Error("Checkout lease authority changed");
	}
}

export async function execCheckoutOperation(
	c: Context<AppEnv>,
	command: string,
	options: WorkstationExecOptions = {},
	mode: "shared" | "exclusive" = "exclusive",
): Promise<WorkstationExecResult> {
	const operation = await startCheckoutOperation(c.get("sandbox"), {
		command,
		...options,
		mode,
		authorize: () => assertCheckoutAuthority(c),
	});
	try {
		return await operation.process.output({
			encoding: "utf8",
			maxBytes: options.maxBytes ?? 16 * 1024 * 1024,
			timeout: options.timeout,
		});
	} catch {
		throw new WorkstationDispatchUnknownError(operation.id);
	}
}

export function canWriteBodyGenerationProof(
	launcher: AppEnv["Variables"]["runtimeBodyLauncher"],
): launcher is ProofWritingLauncher {
	return Boolean(
		launcher &&
		"writeBodyGenerationProof" in launcher &&
		typeof launcher.writeBodyGenerationProof === "function",
	);
}

/**
 * Arm the body generation and attach its secrets to this request.
 *
 * Deliberately does not write the proof into the container: arming is a
 * cached/D1 operation, while {@link writeWorkstationBodyGenerationProof} is a
 * container round trip that only has to happen once per body per generation.
 */
export async function prepareWorkstationBodyGeneration(c: {
	get: <K extends keyof AppEnv["Variables"]>(key: K) => AppEnv["Variables"][K];
}): Promise<RuntimeBodyGeneration | null> {
	const launcher = c.get("runtimeBodyLauncher");
	if (!canWriteBodyGenerationProof(launcher)) return null;
	const generation = await launcher.arm({ requireToken: true });
	attachBodyGenerationSecrets(c.get("tediConfig"), generation);
	return generation;
}

export async function writeWorkstationBodyGenerationProof(c: {
	get: <K extends keyof AppEnv["Variables"]>(key: K) => AppEnv["Variables"][K];
}): Promise<void> {
	const launcher = c.get("runtimeBodyLauncher");
	if (!canWriteBodyGenerationProof(launcher)) return;
	await launcher.writeBodyGenerationProof();
}

export async function ensureWorkstationEgressGuard(c: {
	get: <K extends keyof AppEnv["Variables"]>(key: K) => AppEnv["Variables"][K];
	set: <K extends keyof AppEnv["Variables"]>(
		key: K,
		value: AppEnv["Variables"][K],
	) => void;
}): Promise<void> {
	const launcher = c.get("runtimeBodyLauncher");
	if (!canWriteBodyGenerationProof(launcher)) return;
	const tediConfig = c.get("tediConfig");
	// Use the same validated selection that chose this physical body. Rebuilding
	// a default identity here mislabels episode preparation as the generic lease.
	const selection = c.get("workstationRuntimeSelection");
	const identity = selection ?? activeWorkstationIdentity(tediConfig);

	// Register policy before the command that boots the Computer host. The
	// workstation runtime forces enableInternet:false on every native
	// WorkspaceContainerAPI generation, so the former warm-container marker probe
	// and Sandbox destroy/recreate path are unnecessary and actively incorrect:
	// a readiness poll could destroy Computer's replacement generation while
	// CloudflareContainerBackend was still connecting to it. Computer exclusively
	// owns container recovery; this edge owns only per-tedi egress policy.
	// setOutboundPolicy persists the per-tedi params (including the
	// DENY_ALL_SENTINEL allow-list + decision recording) to DO storage, and the
	// SDK restores them at container start — so the body is deny-default + recorded
	// from packet #1. Ordering is load-bearing: a fresh container with no params is
	// allow-ALL-public (the static __outbound__ handler only SSRF-blocks
	// private/metadata/internal hosts; it does not deny public egress). So this
	// setOutboundPolicy must run before the marker-write boots the body — do not
	// reorder the boot ahead of it.
	const sandbox = c.get("sandbox");
	await sandbox.setOutboundPolicy(
		createWorkstationOutboundHandlerParams(tediConfig, {
			attemptId: selection?.attemptId ?? null,
			leaseId: identity.leaseId,
			organizationId: tediConfig.organizationId,
			profileId: ACTIVE_WORKSTATION_PROFILE_ID,
			tediId: selection?.participantTediId ?? tediConfig.id,
			...(selection?.workItemId ? { workItemId: selection.workItemId } : {}),
			workstationId: identity.workstationId,
		}),
	);
}

/**
 * Write the marker whose side effect is booting the body under the policy
 * {@link ensureWorkstationEgressGuard} just registered. Separate because the
 * policy registration is a DO-storage write that must precede every boot,
 * while this is a container round trip that only has to happen once per body.
 */
export async function writeWorkstationEgressGuardMarker(c: {
	get: <K extends keyof AppEnv["Variables"]>(key: K) => AppEnv["Variables"][K];
}): Promise<void> {
	const launcher = c.get("runtimeBodyLauncher");
	if (!canWriteBodyGenerationProof(launcher)) return;
	await withWorkstationObservationDeadline(
		async () => {
			await c.get("sandbox").mkdir(WORKSTATION_HOME, { recursive: true });
			await c
				.get("sandbox")
				.writeFile(
					WORKSTATION_EGRESS_GUARD_MARKER,
					`${WORKSTATION_EGRESS_GUARD_VERSION}\n`,
				);
		},
		{
			timeoutMs: WORKSTATION_EGRESS_GUARD_BOOT_TIMEOUT_MS,
			operation: "egress marker",
		},
	);
}

export function isRecoverableWorkstationSandboxError(error: unknown): boolean {
	if (error instanceof WorkstationObservationTimeoutError) return true;
	const message =
		typeof error === "string"
			? error
			: error instanceof Error
				? error.message
				: String(error ?? "");
	return (
		/posix_spawn ['"]?\/bin\/bash['"]?/i.test(message) ||
		/fatal: unable to get current working directory: No such file or directory/i.test(
			message,
		) ||
		/WebSocket upgrade failed/i.test(message) ||
		/ENOENT: no such file or directory/i.test(message)
	);
}

export function blockedToolProbes(error: string): WorkstationState["tools"] {
	return {
		gh: { ok: false, error },
		git: { ok: false, error },
	};
}

export function blockedSetupState(error: string): WorkstationState {
	return {
		containerPlacementId: null,
		credentials: { configured: false, status: "missing" },
		repoSync: {
			branch: "",
			configured: true,
			error,
			repoUrl: "",
			status: "failed",
			strategy: ACTIVE_WORKSTATION_PROFILE.repoStrategy,
			workdir: WORKSTATION_DIR,
		},
		setupError: error,
		tools: blockedToolProbes(error),
		toolsReady: false,
	};
}

export function clampTimeout(
	value: unknown,
	fallback: number,
	max: number,
): number {
	const numeric = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
	return Math.min(Math.trunc(numeric), max);
}

export function clampBytes(
	value: unknown,
	fallback: number,
	max: number,
): number {
	const numeric = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
	return Math.min(Math.trunc(numeric), max);
}

export const WORKSTATION_EGRESS_GUARD_MARKER = `${WORKSTATION_HOME}/.tedix-egress-guard-${WORKSTATION_EGRESS_GUARD_VERSION}`;

// The marker-write exec forces a cold Computer host to boot. Computer owns a
// 180s connection budget including one native restart, so the edge must remain
// alive beyond that complete recovery window rather than abandon valid work.
export const WORKSTATION_EGRESS_GUARD_BOOT_TIMEOUT_MS = 195_000;

export function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

export function generatedProcessId(): string {
	return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function workstationSessionLockDir(sessionId: string): string {
	const stableId =
		sessionId.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160) || "default";
	return `${WORKSTATION_SESSION_LOCKS_DIR}/${stableId}`;
}

export function workstationSessionLockedInvocation(
	sessionId: string,
	invocation: string,
): string {
	const lockDir = workstationSessionLockDir(sessionId);
	return [
		`lock_dir=${shellSingleQuote(lockDir)}`,
		'mkdir -p "$(dirname "$lock_dir")"',
		'owner_pid="$BASHPID"',
		'if [ -z "$owner_pid" ]; then owner_pid="$$"; fi',
		"lock_waited=0",
		'while ! mkdir "$lock_dir" 2>/dev/null; do',
		'  if [ -f "$lock_dir/pid" ]; then',
		'    existing_pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"',
		'    existing_state="$(ps -o stat= -p "$existing_pid" 2>/dev/null | tr -d "[:space:]" || true)"',
		'    if [ -z "$existing_pid" ] || [ -z "$existing_state" ] || [ "${existing_state#Z}" != "$existing_state" ] || [ "${existing_state#X}" != "$existing_state" ]; then',
		'      rm -rf "$lock_dir"',
		"      continue",
		"    fi",
		"  fi",
		'  if [ "$lock_waited" -ge 600 ]; then',
		"    printf '%s\\n' \"workstation session lock timeout: $lock_dir\" >&2",
		"    exit 124",
		"  fi",
		"  lock_waited=$((lock_waited + 1))",
		"  sleep 1",
		"done",
		'printf "%s\\n" "$owner_pid" > "$lock_dir/pid"',
		'cleanup_workstation_session_lock() { if [ -f "$lock_dir/pid" ] && [ "$(cat "$lock_dir/pid" 2>/dev/null || true)" = "$owner_pid" ]; then rm -rf "$lock_dir" 2>/dev/null || true; fi; }',
		"trap cleanup_workstation_session_lock EXIT INT TERM",
		"trap 'cleanup_workstation_session_lock; exit 143' INT TERM",
		invocation,
	].join("\n");
}

export function workstationOperationLockDir(): string {
	return `${WORKSTATION_OPERATION_LOCKS_DIR}/non-idempotent`;
}

export function workstationOperationLockOwner(
	kind: WorkstationOperationLock,
): string {
	return `edge-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function workstationOperationLockAcquireInvocation(
	kind: WorkstationOperationLock,
	ownerExpression: string,
): string {
	const lockDir = workstationOperationLockDir();
	return [
		`operation_lock_dir=${shellSingleQuote(lockDir)}`,
		`operation_lock_kind=${shellSingleQuote(kind)}`,
		`operation_lock_owner=${ownerExpression}`,
		'mkdir -p "$(dirname "$operation_lock_dir")"',
		"operation_lock_waited=0",
		'while ! mkdir "$operation_lock_dir" 2>/dev/null; do',
		'  now="$(date +%s 2>/dev/null || printf 0)"',
		'  lock_created="$(cat "$operation_lock_dir/created_at_epoch" 2>/dev/null || printf 0)"',
		'  if [ "$now" -gt 0 ] && [ "$lock_created" -gt 0 ] && [ $((now - lock_created)) -ge ' +
			String(WORKSTATION_OPERATION_LOCK_STALE_SECONDS) +
			" ]; then",
		'    rm -rf "$operation_lock_dir"',
		"    continue",
		"  fi",
		'  if [ "$operation_lock_waited" -ge ' +
			String(WORKSTATION_OPERATION_LOCK_TIMEOUT_SECONDS) +
			" ]; then",
		"    printf '%s\\n' \"workstation operation lock timeout: $operation_lock_dir ($operation_lock_kind)\" >&2",
		"    exit 124",
		"  fi",
		"  operation_lock_waited=$((operation_lock_waited + 1))",
		"  sleep 1",
		"done",
		'printf "%s\\n" "$operation_lock_owner" > "$operation_lock_dir/owner"',
		'printf "%s\\n" "$operation_lock_kind" > "$operation_lock_dir/kind"',
		'date +%s > "$operation_lock_dir/created_at_epoch" 2>/dev/null || true',
	].join("\n");
}

export function workstationOperationLockReleaseInvocation(
	ownerExpression: string,
): string {
	const lockDir = workstationOperationLockDir();
	return [
		`operation_lock_dir=${shellSingleQuote(lockDir)}`,
		`operation_lock_owner=${ownerExpression}`,
		'if [ -f "$operation_lock_dir/owner" ] && [ "$(cat "$operation_lock_dir/owner" 2>/dev/null || true)" = "$operation_lock_owner" ]; then',
		'  rm -rf "$operation_lock_dir" 2>/dev/null || true',
		"fi",
	].join("\n");
}

export function workstationOperationLockedInvocation(
	kind: WorkstationOperationLock,
	invocation: string,
): string {
	return [
		`operation_lock_owner=${shellSingleQuote(`operation-${kind}`)}-$$-${Date.now().toString(36)}`,
		workstationOperationLockAcquireInvocation(kind, '"$operation_lock_owner"'),
		"cleanup_workstation_operation_lock() {",
		workstationOperationLockReleaseInvocation('"$operation_lock_owner"'),
		"}",
		"trap cleanup_workstation_operation_lock EXIT INT TERM",
		"trap 'cleanup_workstation_operation_lock; exit 143' INT TERM",
		invocation,
	].join("\n");
}

export const PACKAGE_MANAGER_MUTATION_COMMANDS: Record<string, Set<string>> = {
	bun: new Set(["add", "install", "remove", "rm", "update", "upgrade"]),
	npm: new Set([
		"add",
		"ci",
		"i",
		"install",
		"remove",
		"rm",
		"uninstall",
		"update",
		"up",
	]),
	pnpm: new Set([
		"add",
		"i",
		"import",
		"install",
		"remove",
		"rm",
		"uninstall",
		"update",
		"up",
	]),
	yarn: new Set(["add", "install", "remove", "up", "upgrade"]),
};

export function isPackageManagerMutationCommand(command: string): boolean {
	const normalized = command.replace(/\\\s*\n/g, " ").replace(/\s+/g, " ");
	const segments = normalized.split(/(?:&&|\|\||[;&|])/);
	for (const rawSegment of segments) {
		const tokens = rawSegment.trim().split(/\s+/).filter(Boolean);
		if (tokens.length === 0) continue;
		let index = tokens[0] === "corepack" ? 1 : 0;
		const manager = tokens[index];
		if (!manager || !(manager in PACKAGE_MANAGER_MUTATION_COMMANDS)) continue;
		index += 1;
		// Package managers accept global flags before the mutating subcommand, e.g.
		// `pnpm --filter app add zod`. Skip flag/value pairs conservatively until
		// the first non-flag token, then classify that token as the subcommand.
		while (index < tokens.length && tokens[index]?.startsWith("-")) {
			const flag = tokens[index] ?? "";
			index += 1;
			if (flag.includes("=")) continue;
			if (
				[
					"-C",
					"-F",
					"-w",
					"--cwd",
					"--dir",
					"--filter",
					"--prefix",
					"--scope",
					"--workspace",
				].includes(flag)
			) {
				index += 1;
			}
		}
		const subcommand = tokens[index];
		if (
			subcommand &&
			PACKAGE_MANAGER_MUTATION_COMMANDS[manager]?.has(subcommand)
		) {
			return true;
		}
	}
	return false;
}

export function detectedWorkstationOperationLock(
	command: string,
	hasGitPush: boolean,
): WorkstationOperationLock | null {
	const normalized = command.replace(/\\\s*\n/g, " ").replace(/\s+/g, " ");
	if (isPackageManagerMutationCommand(normalized)) {
		return "package_install";
	}
	if (
		/\b(wrangler\s+d1\s+migrations\s+apply|drizzle-kit\s+(migrate|push)|bun\s+run\s+(db:push|db:migrate|migrate))\b/.test(
			normalized,
		)
	) {
		return "migration";
	}
	if (
		/\b((wrangler|cf)\s+deploy|vp\s+run\b[^\n]*\bdeploy(?::[A-Za-z0-9_.:-]+)?|(bun|npm|pnpm|yarn)\s+run\s+deploy(:[A-Za-z0-9_.:-]+)?)\b/.test(
			normalized,
		)
	) {
		return "deploy";
	}
	if (hasGitPush) {
		return "branch_push";
	}
	return null;
}

export function workstationOperationLockSelection(
	body: Record<string, unknown> | null,
	command: string,
	hasGitPush: boolean,
):
	| { ok: true; lock: WorkstationOperationLockSelection | null }
	| { ok: false; error: string } {
	const rawLock = body?.operationLock;
	if (rawLock !== undefined && rawLock !== null && rawLock !== "") {
		const parsed = WorkstationOperationLockSchema.safeParse(rawLock);
		if (!parsed.success) {
			return {
				ok: false,
				error: `operationLock must be one of: ${WorkstationOperationLockSchema.options.join(", ")}`,
			};
		}
		return { ok: true, lock: { kind: parsed.data, source: "explicit" } };
	}
	const detected = detectedWorkstationOperationLock(command, hasGitPush);
	return detected
		? { ok: true, lock: { kind: detected, source: "detected" } }
		: { ok: true, lock: null };
}

export async function withWorkstationOperationLock<T>(
	c: Context<AppEnv>,
	kind: WorkstationOperationLock,
	run: () => Promise<T>,
): Promise<T> {
	const owner = workstationOperationLockOwner(kind);
	const acquire = await execInRuntimeBody(
		c,
		workstationOperationLockAcquireInvocation(kind, shellSingleQuote(owner)),
		{
			cwd: WORKSTATION_DIR,
			timeout: (WORKSTATION_OPERATION_LOCK_TIMEOUT_SECONDS + 10) * 1000,
		},
	);
	if (acquire.exitCode !== 0) {
		throw new Error(
			acquire.stderr ||
				acquire.stdout ||
				`failed to acquire workstation operation lock ${kind}`,
		);
	}
	try {
		return await run();
	} finally {
		await execInRuntimeBody(
			c,
			workstationOperationLockReleaseInvocation(shellSingleQuote(owner)),
			{ cwd: WORKSTATION_DIR, timeout: 30_000 },
		).catch(() => undefined);
	}
}

export function parseProcessId(
	value: unknown,
	fallback = generatedProcessId(),
): string | null {
	const id =
		typeof value === "string" && value.trim() ? value.trim() : fallback;
	if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) return null;
	return id;
}

export function repoReady(repoSync: RepoSyncResult): boolean {
	return (
		repoSync.configured &&
		repoSync.status !== "failed" &&
		repoSync.status !== "refused" &&
		repoSync.status !== "skipped_credentials" &&
		repoSync.status !== "syncing" &&
		repoSync.status !== "unsupported_strategy"
	);
}

export function secretsReady(state: WorkstationState): boolean {
	if (!state.repoSync.configured) return true;
	return (
		state.credentials.configured &&
		state.credentials.status === "brokered" &&
		state.repoSync.status !== "skipped_credentials"
	);
}

export function repoWorkdir(repoSync: RepoSyncResult): string | null {
	return repoSync.configured && repoSync.workdir ? repoSync.workdir : null;
}

export function bootstrapReadiness(
	state: WorkstationState,
	values: Partial<WorkstationBootstrapReadiness> = {},
): WorkstationBootstrapReadiness {
	const tools = values.toolsReady ?? state.toolsReady;
	const secrets = values.secretsReady ?? secretsReady(state);
	const repo = values.repoReady ?? repoReady(state.repoSync);
	const deps = values.depsReady ?? false;
	return {
		toolsReady: tools,
		secretsReady: secrets,
		repoReady: repo,
		depsReady: deps,
		environmentReady: tools && secrets && repo && deps,
		installStatus: values.installStatus ?? "blocked",
		installProcessId:
			values.installProcessId ?? WORKSTATION_BOOTSTRAP_INSTALL_PROCESS_ID,
		lockfileHash: values.lockfileHash ?? null,
		packageManager: values.packageManager ?? null,
		cacheKey: values.cacheKey ?? null,
		cacheRestoredAt: values.cacheRestoredAt ?? null,
		cacheBackupRef: values.cacheBackupRef ?? null,
		cacheBackupStatus: values.cacheBackupStatus ?? "skipped",
		cacheBackupError: values.cacheBackupError ?? null,
		lastInstallExitCode: values.lastInstallExitCode ?? null,
		lastInstallArtifactRef: values.lastInstallArtifactRef ?? null,
		lastBootstrapError:
			values.lastBootstrapError ??
			state.setupError ??
			(state.repoSync.configured ? (state.repoSync.error ?? null) : null),
		nextAction: values.nextAction ?? null,
		nextCommand: values.nextCommand ?? null,
		dimensions: {
			toolsReady: tools,
			secretsReady: secrets,
			repoReady: repo,
			depsReady: deps,
		},
	};
}

export function parseKeyValueLines(stdout: string): Record<string, string> {
	const parsed: Record<string, string> = {};
	for (const line of stdout.split(/\r?\n/)) {
		const index = line.indexOf("=");
		if (index <= 0) continue;
		const key = line.slice(0, index).trim();
		if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) continue;
		parsed[key] = line.slice(index + 1).trim();
	}
	return parsed;
}

export function bootstrapProbeFromBody(
	body: Record<string, unknown> | null,
): { installProcessId: string; workdir: string } | null {
	const setupPlan = body?.setupPlan;
	if (!Array.isArray(setupPlan)) return null;
	for (const step of setupPlan) {
		if (!step || typeof step !== "object" || Array.isArray(step)) continue;
		const record = step as Record<string, unknown>;
		if (record.kind !== "bootstrap_readiness_probe") continue;
		const cwd = typeof record.cwd === "string" ? record.cwd.trim() : "";
		if (!cwd || !isWorkstationPath(cwd)) continue;
		const installProcessId = parseProcessId(
			record.installProcessId,
			WORKSTATION_BOOTSTRAP_INSTALL_PROCESS_ID,
		);
		if (!installProcessId) continue;
		return { installProcessId, workdir: cwd };
	}
	return null;
}

export function packageManagerForLockfile(
	lockfile: string | null,
): WorkstationPackageManager {
	if (lockfile === "bun.lock" || lockfile === "bun.lockb") return "bun";
	if (lockfile === "package-lock.json") return "npm";
	if (lockfile === "pnpm-lock.yaml") return "pnpm";
	if (lockfile === "yarn.lock") return "yarn";
	return "unknown";
}

export function packageManagerCacheDir(
	packageManager: WorkstationPackageManager,
): string {
	return `${WORKSTATION_BOOTSTRAP_PACKAGE_CACHE_DIR}/${packageManager}`;
}

export function bootstrapCacheKey(
	packageManager: WorkstationPackageManager,
	lockfileHash: string,
): string {
	return `${ACTIVE_WORKSTATION_PROFILE_ID}:${WORKSTATION_BOOTSTRAP_CACHE_PROFILE_VERSION}:${packageManager}:${lockfileHash}`;
}

/** Marker echoed because workstation bootstrap deliberately skips lifecycle scripts. */
export const WORKSTATION_INSTALL_DEGRADED_MARKER =
	"TEDIX_WORKSTATION_INSTALL=no-scripts";

export const WORKSTATION_INSTALL_REUSE_CACHE_MARKER =
	"TEDIX_WORKSTATION_INSTALL=reuse-cache";

export const WORKSTATION_INSTALL_RETRY_PRESERVE_CACHE_MARKER =
	"TEDIX_WORKSTATION_INSTALL=retry-preserve-cache";

export const WORKSTATION_INSTALL_RETRY_CLEAN_CACHE_MARKER =
	"TEDIX_WORKSTATION_INSTALL=retry-clean-cache";

export const WORKSTATION_BUN_BOOTSTRAP_FILTERS =
	"--filter '!@tedix/cms' --filter '!@tedix/cms-runtime'";

export const WORKSTATION_BUN_BOOTSTRAP_ARGUMENTS = `--frozen-lockfile --ignore-scripts ${WORKSTATION_BUN_BOOTSTRAP_FILTERS}`;

// Must equal the repo's packageManager pin; bun-version-alignment.test.ts
// is the guard, because this drifted for a day and made every delegated
// verification command unsatisfiable.
export const WORKSTATION_BUN_VERSION = "1.4.2";

export const WORKSTATION_BUN_ALIGNMENT_TIMEOUT_SECONDS = 120;

export const WORKSTATION_BUN_INSTALL_PHASE_TIMEOUT_SECONDS = 300;

export const WORKSTATION_BUN_INSTALL_ATTEMPTS = 3;

/**
 * Install dependencies without lifecycle scripts in the constrained workstation.
 *
 * A plain `bun install --frozen-lockfile` dies compiling
 * `better-sqlite3`, a transitive dependency of the `emdash` CMS package whose
 * `prebuild-install` finds no matching prebuilt binary in the sandbox and
 * falls back to a node-gyp build that cannot complete there. More importantly,
 * the full monorepo lifecycle-script pass can monopolize the container long
 * enough that every status and tool probe times out. Waiting for that pass to
 * fail before retrying is therefore not a usable fallback: the verifier loses
 * its control plane before the retry begins.
 *
 * A workstation exists to run the repo's own tooling (edit, lint, format,
 * test, commit). No coding turn needs a natively-compiled SQLite driver for a
 * CMS runtime that never boots here — the repo's own suites use `node:sqlite`.
 * So bootstrap uses the same frozen lockfile while skipping lifecycle scripts
 * and the two CMS runtime workspaces from the outset. CMS work can install its
 * scoped workspace explicitly; making every coding session pay that native
 * dependency cost leaves the workstation unusable. The policy is announced on
 * stdout so the degraded native environment remains visible rather than silent.
 */
export function withoutLifecycleScripts(command: string): string {
	return `echo ${shellSingleQuote(WORKSTATION_INSTALL_DEGRADED_MARKER)} && ${command}`;
}

export function bunInstallWithResilientCache(
	cacheDir: string,
	installArguments: string,
): string {
	const cache = shellSingleQuote(cacheDir);
	const version = shellSingleQuote(WORKSTATION_BUN_VERSION);
	const install = `rm -rf -- node_modules && mkdir -p ${cache} && timeout ${WORKSTATION_BUN_INSTALL_PHASE_TIMEOUT_SECONDS} env BUN_INSTALL_CACHE_DIR=${cache} bun install ${installArguments} --network-concurrency "$network_concurrency"`;
	return `if [ "$(bun --version)" != ${version} ]; then echo 'TEDIX_WORKSTATION_INSTALL=align-bun' && timeout ${WORKSTATION_BUN_ALIGNMENT_TIMEOUT_SECONDS} npm install -g --force bun@${WORKSTATION_BUN_VERSION}; fi && test "$(bun --version)" = ${version} && attempt=1 && install_status=1 && while [ "$attempt" -le ${WORKSTATION_BUN_INSTALL_ATTEMPTS} ]; do if [ "$attempt" -eq 1 ]; then network_concurrency=8; echo ${shellSingleQuote(WORKSTATION_INSTALL_REUSE_CACHE_MARKER)} attempt="$attempt"; elif [ "$attempt" -eq 2 ]; then network_concurrency=4; echo ${shellSingleQuote(WORKSTATION_INSTALL_RETRY_PRESERVE_CACHE_MARKER)} attempt="$attempt" >&2; else network_concurrency=2; echo ${shellSingleQuote(WORKSTATION_INSTALL_RETRY_CLEAN_CACHE_MARKER)} attempt="$attempt" >&2; rm -rf -- ${cache}; fi; ${install}; install_status=$?; if [ "$install_status" -eq 0 ]; then break; fi; attempt=$((attempt + 1)); done && [ "$install_status" -eq 0 ]`;
}

export function installCommandForLockfile(lockfile: string | null): string {
	const packageManager = packageManagerForLockfile(lockfile);
	const cacheDir = packageManagerCacheDir(packageManager);
	const mkdirCache = `mkdir -p ${shellSingleQuote(cacheDir)}`;
	if (packageManager === "bun") {
		const installArguments = WORKSTATION_BUN_BOOTSTRAP_ARGUMENTS;
		return withoutLifecycleScripts(
			bunInstallWithResilientCache(cacheDir, installArguments),
		);
	}
	if (packageManager === "pnpm") {
		const store = `--store-dir ${shellSingleQuote(`${cacheDir}/store`)}`;
		return `${mkdirCache} && ${withoutLifecycleScripts(`pnpm install --frozen-lockfile --ignore-scripts ${store}`)}`;
	}
	if (packageManager === "yarn") {
		const yarnCache = `YARN_CACHE_FOLDER=${shellSingleQuote(cacheDir)}`;
		return `${mkdirCache} && ${withoutLifecycleScripts(`${yarnCache} yarn install --frozen-lockfile --ignore-scripts`)}`;
	}
	if (packageManager === "npm") {
		const npmCache = `npm_config_cache=${shellSingleQuote(cacheDir)}`;
		return `${mkdirCache} && ${withoutLifecycleScripts(`${npmCache} npm ci --ignore-scripts`)}`;
	}
	const installArguments = `--ignore-scripts ${WORKSTATION_BUN_BOOTSTRAP_FILTERS}`;
	return withoutLifecycleScripts(
		bunInstallWithResilientCache(cacheDir, installArguments),
	);
}

/** The marker describes the install actually usable by this runtime, not just its lockfile. */
export function dependencyFingerprintCommand(
	lockfile: string,
	lockfileHash: string,
): string {
	const policies = Object.fromEntries(
		[
			"bun.lock",
			"bun.lockb",
			"package-lock.json",
			"pnpm-lock.yaml",
			"yarn.lock",
			"",
		].map((name) => [
			name,
			{
				manager: packageManagerForLockfile(name || null),
				install: name.startsWith("bun.lock")
					? `bun@${WORKSTATION_BUN_VERSION} install ${WORKSTATION_BUN_BOOTSTRAP_ARGUMENTS}`
					: installCommandForLockfile(name || null),
			},
		]),
	);
	const script = `const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const [lockfile, expectedHash] = process.argv.slice(1);
const policies = ${JSON.stringify(policies)};
const policy = policies[lockfile];
if (!policy) throw new Error("Unsupported dependency lockfile");
const hash = createHash("sha256").update(fs.readFileSync(lockfile || "package.json")).digest("hex");
if (hash !== expectedHash) throw new Error("Dependency lockfile changed during preparation");
const manager = policy.manager === "unknown" ? "bun" : policy.manager;
const version = execFileSync(manager, ["--version"], { encoding: "utf8" }).trim();
const identity = { lockfile, hash, policy: policy.install, manager, version, node: process.version, platform: process.platform, arch: process.arch };
process.stdout.write(createHash("sha256").update(JSON.stringify(identity)).digest("hex"));`;
	return `node -e ${shellSingleQuote(script)} ${lockfile} ${lockfileHash}`;
}

export function verifiedInstallCommandForLockfile(
	lockfile: string | null,
	lockfileHash: string,
): string {
	const marker = shellSingleQuote(WORKSTATION_BOOTSTRAP_DEPENDENCY_MARKER);
	const markerTemp = shellSingleQuote(
		`${WORKSTATION_BOOTSTRAP_DEPENDENCY_MARKER}.tmp`,
	);
	const fingerprint = dependencyFingerprintCommand(
		shellSingleQuote(lockfile ?? ""),
		shellSingleQuote(lockfileHash),
	);
	// A failed install must never leave a readiness marker. Recompute after install:
	// Bun alignment can change the toolchain, and the lockfile may have changed.
	return `dependency_fingerprint=$(${fingerprint}) && if [ -f ${marker} ] && [ "$(cat ${marker})" = "$dependency_fingerprint" ]; then echo 'TEDIX_WORKSTATION_INSTALL=prepared'; else rm -f -- ${marker} ${markerTemp} && ${installCommandForLockfile(lockfile)} && dependency_fingerprint=$(${fingerprint}) && mkdir -p node_modules && printf '%s\\n' "$dependency_fingerprint" > ${markerTemp} && mv ${markerTemp} ${marker}; fi`;
}

export function isStuckInstall(
	startedAt: string | null,
	running: boolean,
): boolean {
	if (!running || !startedAt) return false;
	const started = Date.parse(startedAt);
	return (
		Number.isFinite(started) &&
		Date.now() - started > WORKSTATION_BOOTSTRAP_INSTALL_STUCK_MS
	);
}

export function bootstrapInstallPointerPath(installProcessId: string): string {
	return `${WORKSTATION_JOBS_DIR}/${installProcessId}-current`;
}

export function parseBootstrapProbeOutput(output: string) {
	const probe = parseKeyValueLines(output);
	// A missing response is not an explicit observation of a manifest-free repo.
	if (probe.packageJson !== "0" && probe.packageJson !== "1") {
		throw new Error(
			"Bootstrap readiness probe returned missing or invalid packageJson observation",
		);
	}
	return probe;
}

export function bootstrapProbeCommand(installProcessId: string): string {
	const installPointerPath = bootstrapInstallPointerPath(installProcessId);
	return [
		"set -u",
		"printf 'packageJson='; if [ -f package.json ]; then printf '1\\n'; else printf '0\\n'; fi",
		"printf 'nodeModules='; if [ -d node_modules ]; then printf '1\\n'; else printf '0\\n'; fi",
		"lockfile=''",
		'for candidate in bun.lock bun.lockb package-lock.json pnpm-lock.yaml yarn.lock; do if [ -f "$candidate" ]; then lockfile="$candidate"; break; fi; done',
		"printf 'lockfile=%s\\n' \"$lockfile\"",
		'lockfile_hash=""',
		'hash_target="$lockfile"; if [ -z "$hash_target" ] && [ -f package.json ]; then hash_target=package.json; fi',
		'if [ -n "$hash_target" ]; then if command -v sha256sum >/dev/null 2>&1; then lockfile_hash=$(sha256sum "$hash_target" | awk \'{print $1}\'); elif command -v shasum >/dev/null 2>&1; then lockfile_hash=$(shasum -a 256 "$hash_target" | awk \'{print $1}\'); fi; fi',
		"printf 'lockfileHash=%s\\n' \"$lockfile_hash\"",
		`active_install_id=${shellSingleQuote(installProcessId)}`,
		`if [ -n "$lockfile_hash" ] && [ -f ${shellSingleQuote(installPointerPath)} ]; then install_pointer=$(cat ${shellSingleQuote(installPointerPath)}); pointer_hash=\${install_pointer%%=*}; pointer_id=\${install_pointer#*=}; case "$pointer_id" in ''|*[!A-Za-z0-9_.:-]*) ;; *) if [ "$pointer_hash" = "$lockfile_hash" ]; then active_install_id="$pointer_id"; fi ;; esac; fi`,
		"printf 'installProcessId=%s\\n' \"$active_install_id\"",
		`dependency_fingerprint=""; if [ -n "$lockfile_hash" ]; then dependency_fingerprint=$(${dependencyFingerprintCommand('"$lockfile"', '"$lockfile_hash"')}) || exit 1; fi`,
		`printf 'depsReady='; if [ -n "$dependency_fingerprint" ] && [ -f ${shellSingleQuote(WORKSTATION_BOOTSTRAP_DEPENDENCY_MARKER)} ] && [ "$(cat ${shellSingleQuote(WORKSTATION_BOOTSTRAP_DEPENDENCY_MARKER)})" = "$dependency_fingerprint" ]; then printf '1\\n'; else printf '0\\n'; fi`,
		`if [ -f ${shellSingleQuote(WORKSTATION_BOOTSTRAP_CACHE_RESTORED_AT_PATH)} ]; then printf 'cacheRestoredAt='; cat ${shellSingleQuote(WORKSTATION_BOOTSTRAP_CACHE_RESTORED_AT_PATH)}; printf '\\n'; fi`,
	].join(" && ");
}

export async function ensureBootstrapInstallProcessId(
	c: Context<AppEnv>,
	fallbackProcessId: string,
	lockfileHash: string,
): Promise<string> {
	const candidate = `${fallbackProcessId}-${crypto.randomUUID().slice(0, 12)}`;
	const pointer = shellSingleQuote(
		bootstrapInstallPointerPath(fallbackProcessId),
	);
	const result = await execCheckoutOperation(
		c,
		[
			`mkdir -p ${shellSingleQuote(WORKSTATION_JOBS_DIR)}`,
			`current=''; if [ -f ${pointer} ]; then current=$(cat ${pointer}); fi`,
			`pointer_hash=\${current%%=*}; pointer_id=\${current#*=}`,
			`if [ "$pointer_hash" != ${shellSingleQuote(lockfileHash)} ] || ! printf '%s' "$pointer_id" | grep -Eq '^[A-Za-z0-9_.:-]+$'; then pointer_id=${shellSingleQuote(candidate)}; tmp=${pointer}.${shellSingleQuote(candidate)}.tmp; printf '%s\\n' ${shellSingleQuote(`${lockfileHash}=${candidate}`)} > "$tmp"; mv "$tmp" ${pointer}; fi`,
			"printf 'installProcessId=%s\\n' \"$pointer_id\"",
		].join(" && "),
		{ timeout: 30_000 },
	);
	if (result.exitCode !== 0 || result.timedOut) {
		throw new Error(
			result.stderr ||
				result.stdout ||
				"failed to allocate a bootstrap install execution id",
		);
	}
	return (
		parseProcessId(
			parseKeyValueLines(result.stdout ?? "").installProcessId,
			candidate,
		) ?? candidate
	);
}

export function installStatusFromProbe(input: {
	depsReady: boolean;
	hasInstallJob: boolean;
	installCanceledAt: string | null;
	installExitCode: number | null;
	installError?: string | null;
	installRunning: boolean;
	installStartedAt: string | null;
	installTimedOutAt: string | null;
	packageJson: boolean;
}): WorkstationInstallStatus {
	if (!input.packageJson) return "not_required";
	if (input.installTimedOutAt) return "timed_out";
	if (input.depsReady) return "ready";
	if (input.installCanceledAt) return "canceled";
	if (input.installRunning && isStuckInstall(input.installStartedAt, true)) {
		return "stuck";
	}
	if (input.installRunning) return "running";
	if (input.installError) return "failed";
	if (typeof input.installExitCode === "number") {
		return input.installExitCode === 0 ? "completed" : "failed";
	}
	return input.hasInstallJob ? "unknown" : "missing";
}

export async function readBootstrapReadiness(
	c: Context<AppEnv>,
	state: WorkstationState,
	body: Record<string, unknown> | null = null,
	session?: WorkstationSessionSelection,
	cacheBackupMode: "deferred" | "synchronous" = "deferred",
): Promise<WorkstationBootstrapReadiness> {
	const base = bootstrapReadiness(state);
	if (state.preparation === "shell" && !state.setupError) {
		return bootstrapReadiness(state, {
			repoReady: true,
			secretsReady: true,
			depsReady: true,
			installStatus: "not_required",
		});
	}
	if (state.setupError) return base;
	if (!base.toolsReady) {
		return bootstrapReadiness(state, {
			...base,
			installStatus: "blocked",
			lastBootstrapError: "required coding tools are unavailable",
			nextAction: "repair_workstation_tools",
		});
	}
	if (!base.secretsReady) {
		return bootstrapReadiness(state, {
			...base,
			installStatus: "blocked",
			lastBootstrapError:
				state.repoSync.configured && state.repoSync.error
					? state.repoSync.error
					: "GitHub credentials are required before the repo can be prepared",
			nextAction: "configure_github_credentials",
		});
	}
	if (!base.repoReady) {
		const nextAction =
			state.repoSync.configured && state.repoSync.status === "syncing"
				? "wait_for_repo_sync"
				: "open_computer";
		return bootstrapReadiness(state, {
			...base,
			installStatus: "blocked",
			nextAction,
		});
	}

	const workdir = repoWorkdir(state.repoSync);
	const setupProbe = bootstrapProbeFromBody(body);
	const probeWorkdir = setupProbe?.workdir ?? workdir;
	const fallbackInstallProcessId =
		setupProbe?.installProcessId ?? WORKSTATION_BOOTSTRAP_INSTALL_PROCESS_ID;
	if (!probeWorkdir) {
		return bootstrapReadiness(state, {
			...base,
			installStatus: "blocked",
			lastBootstrapError: "repo workdir is unavailable",
			nextAction: "open_computer",
		});
	}

	try {
		const result = await execInRuntimeBody(
			c,
			bootstrapProbeCommand(fallbackInstallProcessId),
			{
				cwd: probeWorkdir,
				timeout: 10_000,
			},
		);
		if (result.exitCode !== 0 || result.timedOut) {
			return bootstrapReadiness(state, {
				...base,
				installStatus: "unknown",
				lastBootstrapError:
					result.stderr || result.stdout || "bootstrap readiness probe failed",
				nextAction: "open_computer",
			});
		}
		let probe = parseBootstrapProbeOutput(result.stdout ?? "");
		let installProcessId =
			parseProcessId(probe.installProcessId, fallbackInstallProcessId) ??
			fallbackInstallProcessId;
		const lockfile = () => probe.lockfile || null;
		const packageJson = () => probe.packageJson === "1";
		const lockfileHash = () => probe.lockfileHash || null;
		const packageManager = () => packageManagerForLockfile(lockfile());
		const cacheKey = () => {
			const hash = lockfileHash();
			return hash ? bootstrapCacheKey(packageManager(), hash) : null;
		};
		const installExecution = await workstationExecutionStatus(
			c.get("sandbox"),
			installProcessId,
			{ includeLogs: false },
		);
		const installUnsettled = installExecution.observation === "unavailable";
		const installRunning = installExecution.running || installUnsettled;
		probe.installJob = installExecution.found || installUnsettled ? "1" : "0";
		probe.installExitCode =
			installExecution.exitCode === null
				? ""
				: String(installExecution.exitCode);
		probe.installStartedAt = installExecution.startedAt ?? "";
		probe.installTimedOutAt = installExecution.timedOut
			? (installExecution.endedAt ?? new Date().toISOString())
			: "";
		probe.installCanceledAt = "";
		const markerReady = () => probe.depsReady === "1";
		const installProvesReady = () =>
			installExecution.observation === "not_found" ||
			(installExecution.terminal &&
				installExecution.exitCode === 0 &&
				installExecution.timedOut !== true &&
				!installExecution.error);
		const currentDepsReady = (cacheRestored = false) =>
			!packageJson() ||
			(markerReady() &&
				(cacheRestored ||
					(installProvesReady() && !installRunning && !installUnsettled)));
		let cacheBackup: WorkstationBootstrapCacheResult = {
			ref: null,
			status: "skipped",
		};
		if (packageJson() && !currentDepsReady() && !installRunning) {
			cacheBackup = await restoreBootstrapDependencyCache(c, {
				lockfile: lockfile(),
				lockfileHash: lockfileHash(),
				workdir: probeWorkdir,
			});
			if (cacheBackup.observation === "unknown")
				throw new WorkstationDispatchUnknownError(cacheBackup.executionId!);
			if (cacheBackup.status === "restored") {
				const restoredProbe = await execInRuntimeBody(
					c,
					bootstrapProbeCommand(installProcessId),
					{
						cwd: probeWorkdir,
						timeout: 10_000,
					},
				);
				if (restoredProbe.exitCode === 0) {
					probe = parseBootstrapProbeOutput(restoredProbe.stdout ?? "");
				}
			}
		}
		const depsReady = currentDepsReady(cacheBackup.status === "restored");
		const installExitCode = probe.installExitCode
			? Number(probe.installExitCode)
			: null;
		let installStatus = installStatusFromProbe({
			depsReady,
			hasInstallJob: probe.installJob === "1",
			installCanceledAt: probe.installCanceledAt || null,
			installExitCode: Number.isInteger(installExitCode)
				? installExitCode
				: null,
			installError: installExecution.error ?? null,
			installRunning,
			installStartedAt: probe.installStartedAt || null,
			installTimedOutAt: probe.installTimedOutAt || null,
			packageJson: packageJson(),
		});
		let lastInstallArtifactRef: string | null = null;
		if (
			(installStatus === "completed" ||
				installStatus === "failed" ||
				installStatus === "timed_out" ||
				installStatus === "canceled") &&
			probe.installJob === "1"
		) {
			const job = await readJobStatus(c, installProcessId, {
				tailBytes: 20_000,
			});
			const promotedJob = await promoteWorkstationJobEvidence(c, job, body);
			lastInstallArtifactRef = promotedJob.artifactRefs?.[0] ?? null;
		}
		if (depsReady && installStatus === "completed") {
			installStatus = "ready";
		}
		if (
			depsReady &&
			packageJson() &&
			cacheBackup.status !== "restored" &&
			probe.installJob === "1"
		) {
			const cacheInput = {
				lockfile: lockfile(),
				lockfileHash: lockfileHash(),
				workdir: probeWorkdir,
			};
			cacheBackup = !WORKSTATION_BOOTSTRAP_CACHE_BACKUP_ENABLED
				? { ref: null, status: "skipped" }
				: cacheBackupMode === "synchronous"
					? await ensureBootstrapDependencyCacheBackup(c, cacheInput)
					: await readBootstrapDependencyCacheStatus(c, cacheInput);
		}
		// Self-bootstrap: when deps are missing and there is NO install job yet
		// (status "missing", not running), launch the install ourselves in the
		// background instead of merely telling a caller to. This breaks the
		// dependency-cache chicken-and-egg (install completes, cache backup seeds
		// R2, future cold starts restore). Scoped to "missing" only, so a
		// failed/timed_out/stuck/canceled install keeps its explicit operator
		// nextAction and is never auto-retried into a hot loop. A cache-restored
		// node_modules already satisfies depsReady and never reaches here.
		const autoStartedInstall =
			!depsReady &&
			packageJson() &&
			!installRunning &&
			installStatus === "missing" &&
			cacheBackup.status !== "restored";
		if (autoStartedInstall) {
			const hash = lockfileHash();
			if (!hash) {
				throw new Error(
					"bootstrap dependency install requires a lockfile hash",
				);
			}
			installProcessId = await ensureBootstrapInstallProcessId(
				c,
				fallbackInstallProcessId,
				hash,
			);
			scheduleBootstrapInstall(c, {
				body,
				installProcessId,
				lockfile: lockfile(),
				lockfileHash: hash,
				session,
				workdir: probeWorkdir,
			});
		}
		const nextLockfileHash = lockfileHash();
		const nextCommand = depsReady
			? null
			: nextLockfileHash
				? verifiedInstallCommandForLockfile(lockfile(), nextLockfileHash)
				: installCommandForLockfile(lockfile());
		const nextAction = depsReady
			? null
			: autoStartedInstall
				? "wait_for_install_process"
				: installStatus === "running"
					? "wait_for_install_process"
					: installStatus === "stuck"
						? "cancel_and_restart_install_process"
						: installStatus === "timed_out"
							? "restart_install_process"
							: "start_install_process";
		const lastBootstrapError =
			installStatus === "failed"
				? (installExecution.error ??
					`install process exited with ${installExitCode}`)
				: installStatus === "canceled"
					? "install process was canceled"
					: installStatus === "stuck"
						? `install process exceeded ${Math.round(WORKSTATION_BOOTSTRAP_INSTALL_STUCK_MS / 60_000)} minutes`
						: installStatus === "timed_out"
							? "install process timed out"
							: null;
		return bootstrapReadiness(state, {
			...base,
			cacheKey: cacheKey(),
			cacheBackupError: cacheBackup.error ?? null,
			cacheBackupRef: cacheBackup.ref,
			cacheBackupStatus: cacheBackup.status,
			cacheRestoredAt: probe.cacheRestoredAt || cacheBackup.restoredAt || null,
			depsReady,
			installProcessId,
			installStatus,
			lastBootstrapError,
			lastInstallArtifactRef,
			lastInstallExitCode: Number.isInteger(installExitCode)
				? installExitCode
				: null,
			lockfileHash: lockfileHash(),
			packageManager: packageManager(),
			nextAction,
			nextCommand,
		});
	} catch (error) {
		return bootstrapReadiness(state, {
			...base,
			installStatus: "unknown",
			lastBootstrapError: errorMessage(error),
			nextAction: "open_computer",
		});
	}
}

export function workstationStatusForReadiness(
	state: WorkstationState,
	readiness: WorkstationBootstrapReadiness,
): WorkstationStatus {
	if (state.setupError) return "blocked";
	if (readiness.environmentReady) return "ready";
	if (
		!readiness.toolsReady ||
		!readiness.secretsReady ||
		!readiness.repoReady
	) {
		return "blocked";
	}
	return "degraded";
}

export function parseCwd(value: unknown, repoSync: RepoSyncResult): string {
	const cwd = typeof value === "string" && value ? value : undefined;
	const workdirKnown =
		"workdir" in repoSync && repoSync.workdir ? repoSync.workdir : null;
	// Only cd into the repo workdir once it actually exists (repoReady). While the
	// clone is still 'syncing' in the background that directory is absent, so
	// posix_spawn would ENOENT — run in the workstation root until it lands.
	const fallback =
		repoReady(repoSync) && workdirKnown ? workdirKnown : WORKSTATION_DIR;
	if (!cwd) return fallback;
	if (isWorkstationPath(cwd)) {
		return cwd;
	}
	return fallback;
}

export function jobPaths(processId: string) {
	const logDir = `${WORKSTATION_JOBS_DIR}/${processId}`;
	return {
		logDir,
		stderrPath: `${logDir}/stderr.log`,
		stdoutPath: `${logDir}/stdout.log`,
	};
}

export function processContextFromBody(
	c: Context<AppEnv>,
	body: Record<string, unknown> | null,
	session: WorkstationSessionSelection,
	operationLock: WorkstationOperationLockSelection | null,
	admission: {
		checkoutSha: string | null;
		containerPlacementId: string | null;
	} | null = null,
): WorkstationProcessContext {
	const kernelRunId = stringBodyValue(body, "kernelRunId");
	const headerRunId = c.req.header(WORKSTATION_RUN_HEADER);
	const headerConversationId = c.req.header(WORKSTATION_CONVERSATION_HEADER);
	// These headers exist only on the runtime's internal service-binding hop.
	// A public body, status read, or mismatched run can never assign provenance.
	const trustedConversationId =
		isServiceBinding(c.req.raw.headers) &&
		c.req.header("X-Tedix-Tedi-Id") === c.get("tediConfig").id &&
		kernelRunId &&
		headerRunId === kernelRunId &&
		headerConversationId &&
		headerConversationId.trim() === headerConversationId &&
		headerConversationId.length <= 512
			? headerConversationId
			: null;
	return {
		admittedAt: admission ? new Date().toISOString() : null,
		admittedCheckoutSha: admission?.checkoutSha ?? null,
		admittedContainerPlacementId: admission?.containerPlacementId ?? null,
		conversationId: trustedConversationId,
		kernelRunId,
		leadParticipantId: session.leadParticipantId,
		leaseId: session.leaseId,
		operationLock: operationLock?.kind ?? null,
		operationLockSource: operationLock?.source ?? null,
		participantId: session.participantId,
		participantTediId: session.participantTediId,
		sessionId: session.sessionId,
		sessionKind: session.sessionKind,
		traceBundleId: stringBodyValue(body, "traceBundleId"),
		traceId: traceIdFromRequest(c) ?? stringBodyValue(body, "traceId"),
		workItemId: stringBodyValue(body, "workItemId"),
		workstationId: session.workstationId,
	};
}

export async function applyRequestScopedWorkstationEgressContext(
	c: Context<AppEnv>,
	body: Record<string, unknown> | null,
	session: WorkstationSessionSelection,
): Promise<void> {
	const tediConfig = c.get("tediConfig");
	try {
		await c.get("sandbox").setOutboundPolicy(
			createWorkstationOutboundHandlerParams(tediConfig, {
				attemptId:
					stringBodyValue(body, "attemptId") ??
					session.leaseBundle?.workstationLease.attemptId,
				kernelRunId: stringBodyValue(body, "kernelRunId"),
				leaseId: session.leaseId,
				organizationId: tediConfig.organizationId,
				profileId: ACTIVE_WORKSTATION_PROFILE_ID,
				tediId: session.participantTediId,
				traceBundleId: stringBodyValue(body, "traceBundleId"),
				traceId: traceIdFromRequest(c) ?? stringBodyValue(body, "traceId"),
				workItemId:
					stringBodyValue(body, "workItemId") ??
					session.leaseBundle?.workstationLease.workItemId,
				workstationId: session.workstationId,
			}),
		);
	} catch (error) {
		console.warn(
			"[workstation] request-scoped egress context update failed",
			error instanceof Error ? error.message : String(error),
		);
	}
}

export function parseWorkstationProcessContext(
	value: string,
): WorkstationProcessContext | null {
	if (!value.trim()) return null;
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		const sessionKind = WorkstationSessionKindSchema.safeParse(
			stringBodyValue(parsed, "sessionKind"),
		);
		const operationLock = WorkstationOperationLockSchema.safeParse(
			stringBodyValue(parsed, "operationLock"),
		);
		const operationLockSource = stringBodyValue(parsed, "operationLockSource");
		return {
			admittedAt: stringBodyValue(parsed, "admittedAt"),
			admittedCheckoutSha: stringBodyValue(parsed, "admittedCheckoutSha"),
			admittedContainerPlacementId: stringBodyValue(
				parsed,
				"admittedContainerPlacementId",
			),
			conversationId: stringBodyValue(parsed, "conversationId"),
			kernelRunId: stringBodyValue(parsed, "kernelRunId"),
			leadParticipantId: stringBodyValue(parsed, "leadParticipantId"),
			leaseId: stringBodyValue(parsed, "leaseId"),
			operationLock: operationLock.success ? operationLock.data : null,
			operationLockSource:
				operationLockSource === "detected" || operationLockSource === "explicit"
					? operationLockSource
					: null,
			participantId: stringBodyValue(parsed, "participantId"),
			participantTediId: stringBodyValue(parsed, "participantTediId"),
			sessionId: stringBodyValue(parsed, "sessionId"),
			sessionKind: sessionKind.success ? sessionKind.data : null,
			traceBundleId: stringBodyValue(parsed, "traceBundleId"),
			traceId: stringBodyValue(parsed, "traceId"),
			workItemId: stringBodyValue(parsed, "workItemId"),
			workstationId: stringBodyValue(parsed, "workstationId"),
		};
	} catch {
		return null;
	}
}

/** Metadata from the already governed dispatch, never a new authority grant. */
export function withWorkstationCommitProvenance(
	command: string,
	context: { workItemId: string | null; kernelRunId: string | null },
): string {
	// Clear both variables on unbound commands: the launching shell may belong to another run.
	return [
		`export BUN_INSTALL_CACHE_DIR=${shellSingleQuote(packageManagerCacheDir("bun"))}`,
		`export TEDIX_COMMIT_WORK_ITEM=${shellSingleQuote(context.workItemId ?? "")}`,
		`export TEDIX_COMMIT_AGENT_SESSION=${shellSingleQuote(context.workItemId && context.kernelRunId ? `kernel:${context.kernelRunId}` : "")}`,
		command,
	].join("\n");
}

export function buildJobCommand(
	processId: string,
	command: string,
	cwd: string,
	context: WorkstationProcessContext,
	timeoutMs: number | null,
	lockSession = true,
	executionCommand = command,
) {
	const paths = jobPaths(processId);
	const attributed = withWorkstationCommitProvenance(executionCommand, context);
	const invocation = `bash -lc ${shellSingleQuote(attributed)}`;
	const operation = context.operationLock
		? `(\n${workstationOperationLockedInvocation(context.operationLock, invocation)}\n)`
		: invocation;
	const session =
		lockSession && context.sessionId
			? `(\n${workstationSessionLockedInvocation(context.sessionId, operation)}\n)`
			: operation;
	// Native supervision owns the root exit and descendant drain. The only files
	// retained here spool full artifacts beyond the SDK's bounded replay window.
	const checkoutGuard = context.admittedCheckoutSha
		? `test "$(git rev-parse HEAD)" = ${shellSingleQuote(context.admittedCheckoutSha)} || { echo 'checkout changed after admission' >&2; exit 75; }; `
		: "";
	const commandBody = `cd -- ${shellSingleQuote(cwd)} && ${checkoutGuard}${session}`;
	const script = [
		`mkdir -p ${shellSingleQuote(paths.logDir)}`,
		`exec > >(tee ${shellSingleQuote(paths.stdoutPath)}) 2> >(tee ${shellSingleQuote(paths.stderrPath)} >&2)`,
		`exec bash -lc ${shellSingleQuote(commandBody)}`,
	].join("\n");
	return {
		paths,
		metadata: { command, cwd, context, timeoutMs },
		wrappedCommand: script,
	};
}

export async function parseJsonBody(c: Context<AppEnv>) {
	try {
		return (await c.req.json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Probe one workstation tool.
 *
 * The returned object is persisted into `metadata.tools` and validated against
 * a JSON-value schema, which has no `undefined`. An explicit
 * `version: undefined` property therefore fails validation at
 * `metadata.tools -> <tool> -> version`, the wake route 500s, and the
 * provisioning fiber throws on its first poll, permanently freezing the lease.
 * So omit the
 * key entirely rather than setting it to `undefined`.
 */
export async function probeTool(
	exec: (
		command: string,
		options?: WorkstationExecOptions,
	) => Promise<WorkstationExecResult>,
	command: string,
): Promise<ToolProbe> {
	try {
		const result = await exec(command, { timeout: 15_000 });
		if (result.exitCode === 0 && !result.timedOut) {
			const version = (result.stdout || "").trim().split("\n")[0]?.trim();
			return version ? { ok: true, version } : { ok: true };
		}
		return {
			ok: false,
			error: (
				result.stderr ||
				result.stdout ||
				`exit ${result.exitCode}`
			).trim(),
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function probeWorkstationTools(
	exec: (
		command: string,
		options?: WorkstationExecOptions,
	) => Promise<WorkstationExecResult>,
): Promise<Record<"gh" | "git", ToolProbe>> {
	// Probe without a pipe: `gh --version | head -n 1` takes the pipeline's exit
	// code from `head`, so a missing `gh` still reported exit 0 with empty
	// stdout and the probe claimed ok. probeTool keeps only the first line.
	const [git, gh] = await Promise.all([
		probeTool(exec, "git --version"),
		probeTool(exec, "gh --version"),
	]);
	return { gh, git };
}

export type JobObservationDiagnostics = {
	retainedEvidence: string;
	nativeRegistry: string;
};

export async function readNativeLogTail(
	c: Context<AppEnv>,
	path: string,
	limit: number,
) {
	const result = await c.get("sandbox").readFile(path, { encoding: "none" });
	const bytes =
		result.content instanceof Uint8Array
			? result.content
			: new TextEncoder().encode(result.content);
	const tail = bytes.slice(Math.max(0, bytes.byteLength - limit));
	return {
		text: new TextDecoder().decode(tail),
		bytes: bytes.byteLength,
		truncated: bytes.byteLength > limit,
	};
}

export async function readJobStatus(
	c: Context<AppEnv>,
	processId: string,
	options: {
		tailBytes?: unknown;
		phases?: WorkstationRequestPhases;
		diagnostics?: JobObservationDiagnostics;
	} = {},
): Promise<WorkstationJobStatus> {
	const phases = options.phases ?? workstationRequestPhases();
	let association: WorkstationLaunchResult | null = null;
	let observed: WorkstationExecutionStatus | null = null;
	let unavailable = false;
	try {
		association = await phases.time("association", () =>
			withWorkstationObservationDeadline(
				() => c.get("sandbox").readExecutionAssociation(processId),
				{ timeoutMs: 10000, operation: "process association" },
			),
		);
		if (association)
			observed = await phases.time("nativeStatus", () =>
				withWorkstationObservationDeadline(
					() =>
						workstationExecutionStatus(c.get("sandbox"), processId, {
							includeLogs: false,
						}),
					{ timeoutMs: 10000, operation: "process status" },
				),
			);
	} catch {
		unavailable = true;
	}
	const metadata = association?.metadata;
	const tailBytes = clampBytes(
		options.tailBytes,
		DEFAULT_PROCESS_TAIL_BYTES,
		MAX_PROCESS_TAIL_BYTES,
	);
	const paths = jobPaths(processId);
	const empty = { text: "", bytes: 0, truncated: false };
	const logs = observed?.found
		? await phases.time("logTails", () =>
				Promise.all([
					readNativeLogTail(c, paths.stdoutPath, tailBytes).catch(() => ({
						...empty,
						truncated: true,
					})),
					readNativeLogTail(c, paths.stderrPath, tailBytes).catch(() => ({
						...empty,
						truncated: true,
					})),
				]),
			)
		: [empty, empty];
	const stdout = logs[0]!,
		stderr = logs[1]!;
	if (options.diagnostics)
		options.diagnostics.nativeRegistry = observed?.observation ?? "not_found";
	return {
		id: processId,
		processId,
		found: !!association,
		...(unavailable ||
		(association &&
			(!observed ||
				observed.observation === "unavailable" ||
				observed.observation === "not_found"))
			? { observation: "unavailable" as const }
			: {}),
		command: metadata?.command ?? null,
		cwd: metadata?.cwd ?? null,
		context: metadata
			? parseWorkstationProcessContext(JSON.stringify(metadata.context))
			: null,
		process: null,
		running: observed?.running ?? false,
		terminal: observed?.terminal ?? false,
		exitCode: observed?.exitCode ?? null,
		signal: observed?.signal,
		canceled: false,
		canceledAt: null,
		timeoutMs: metadata?.timeoutMs ?? null,
		timedOut: observed?.timedOut ?? false,
		timedOutAt: observed?.timedOut ? (observed.endedAt ?? null) : null,
		startedAt: observed?.startedAt ?? null,
		endedAt: observed?.endedAt ?? null,
		logDir: paths.logDir,
		stdoutPath: paths.stdoutPath,
		stderrPath: paths.stderrPath,
		tailBytes,
		stdoutBytes: stdout.bytes,
		stderrBytes: stderr.bytes,
		stdoutTruncated: stdout.truncated,
		stderrTruncated: stderr.truncated,
		stdoutTail: stdout.text,
		stderrTail: stderr.text,
		...(observed?.terminal && commandMayPush(metadata?.command ?? "")
			? { publicationProof: pushPublicationProof(stdout.text) }
			: {}),
	};
}

export function uniqueStrings(values: (string | null | undefined)[]): string[] {
	return [
		...new Set(values.filter((value): value is string => Boolean(value))),
	];
}

export function activeWorkstationIdentity(
	tediConfig: TediConfig,
	executionKey?: string | null,
) {
	const { leaseId, workstationId } = createWorkstationEpisodeIds({
		executionKey,
		organizationId: tediConfig.organizationId,
		profileId: ACTIVE_WORKSTATION_PROFILE_ID,
		slug: tediConfig.slug,
		tediId: tediConfig.id,
	});
	const lease = createWorkstationLease({
		leaseId,
		organizationId: tediConfig.organizationId,
		profileId: ACTIVE_WORKSTATION_PROFILE_ID,
		seats: [
			{
				permissionScopes: [],
				role: "lead",
				slug: tediConfig.slug,
				tediId: tediConfig.id,
			},
		],
		workstationId,
	});
	const leadParticipantId =
		lease.participants.find((participant) => participant.role === "lead")?.id ??
		lease.participants[0]?.id ??
		`${lease.id}_participant_${tediConfig.slug}`;
	return {
		leaseId: lease.id,
		leadParticipantId,
		sessionId: `${lease.workstationId}_shell`,
		workstationId: lease.workstationId,
	};
}

export function parseWorkstationSessionKind(
	value: unknown,
	fallback: WorkstationSessionKind,
): WorkstationSessionKind | null {
	if (value === undefined || value === null || value === "") return fallback;
	const parsed = WorkstationSessionKindSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export function workstationSessionSelection(
	tediConfig: TediConfig,
	body: Record<string, unknown> | null,
	fallbackKind: WorkstationSessionKind,
):
	| { ok: true; session: WorkstationSessionSelection }
	| { ok: false; error: string } {
	const identity = activeWorkstationIdentity(tediConfig);
	const sessionKind = parseWorkstationSessionKind(
		body?.sessionKind,
		fallbackKind,
	);
	if (!sessionKind) {
		return {
			ok: false,
			error: `sessionKind must be one of: ${WorkstationSessionKindSchema.options.join(", ")}`,
		};
	}
	const sessionId =
		stringBodyValue(body, "sessionId") ??
		(sessionKind === "shell"
			? identity.sessionId
			: `${identity.workstationId}_${sessionKind}`);
	const participantId =
		stringBodyValue(body, "participantId") ?? identity.leadParticipantId;
	const participantRole =
		participantId === identity.leadParticipantId ? "lead" : "collaborator";
	return {
		ok: true,
		session: {
			leadParticipantId: identity.leadParticipantId,
			leaseId: identity.leaseId,
			participantId,
			participantRole,
			participantTediId: tediConfig.id,
			sessionId,
			sessionKind,
			workstationId: identity.workstationId,
		},
	};
}

export const ACTIVE_WORKSTATION_PARTICIPANT_STATUSES = new Set([
	"active",
	"invited",
	"paused",
]);

export async function workstationSessionSelectionForRequest(
	c: Context<AppEnv>,
	body: Record<string, unknown> | null,
	fallbackKind: WorkstationSessionKind,
): Promise<
	| { ok: true; session: WorkstationSessionSelection }
	| { ok: false; error: string; status?: number }
> {
	const tediConfig = c.get("tediConfig");
	const base = workstationSessionSelection(tediConfig, body, fallbackKind);
	if (!base.ok) return base;

	const requestedLeaseId = stringBodyValue(body, "leaseId");
	// An EXPLICIT lease selection always resolves the durable D1 bundle, even
	// when its id equals the deterministic implicit id. Treating that equality as
	// an implicit selection rebuilt a blank envelope and erased the lease's Work
	// Item/run/trace correlation on every reuse.
	if (!requestedLeaseId) return base;
	if (!c.env.DB) {
		return {
			ok: false,
			error: "workstation lease selection requires DB persistence",
			status: 503,
		};
	}

	const bundle = await getWorkstationLeaseBundle(
		createDbClient(c.env.DB),
		requestedLeaseId,
	);
	if (!bundle) {
		return {
			ok: false,
			error: `workstation lease not found: ${requestedLeaseId}`,
			status: 404,
		};
	}
	const lease = bundle.workstationLease;
	if (lease.organizationId !== tediConfig.organizationId) {
		return {
			ok: false,
			error: `workstation lease ${requestedLeaseId} is not in this organization`,
			status: 403,
		};
	}
	if (lease.profileId !== ACTIVE_WORKSTATION_PROFILE_ID) {
		return {
			ok: false,
			error: `workstation lease ${requestedLeaseId} is not a workstation`,
			status: 400,
		};
	}

	const explicitParticipantId = stringBodyValue(body, "participantId");
	const leadParticipant =
		lease.participants.find((participant) => participant.role === "lead") ??
		lease.participants[0] ??
		null;
	const participant =
		(explicitParticipantId
			? lease.participants.find(
					(candidate) => candidate.id === explicitParticipantId,
				)
			: lease.participants.find(
					(candidate) => candidate.tediId === tediConfig.id,
				)) ?? null;
	if (!participant) {
		return {
			ok: false,
			error: `workstation lease ${requestedLeaseId} has no selectable participant`,
			status: 403,
		};
	}
	if (
		!ACTIVE_WORKSTATION_PARTICIPANT_STATUSES.has(participant.status) &&
		!canAccessInactiveWorkstation({
			path: new URL(c.req.url).pathname,
			leaseStatus: lease.status,
			participantRole: participant.role,
			participantStatus: participant.status,
			preserveChanges: body?.preserveChanges === true,
		})
	) {
		return {
			ok: false,
			error: `workstation participant ${participant.id} is not active`,
			status: 403,
		};
	}
	if (explicitParticipantId && participant.leaseId !== requestedLeaseId) {
		return {
			ok: false,
			error: `workstation participant ${explicitParticipantId} does not belong to lease ${requestedLeaseId}`,
			status: 403,
		};
	}
	if (explicitParticipantId && participant.tediId !== tediConfig.id) {
		return {
			ok: false,
			error: `workstation participant ${explicitParticipantId} does not belong to tedi ${tediConfig.id}`,
			status: 403,
		};
	}
	const requestedWorkstationId = stringBodyValue(body, "workstationId");
	if (
		requestedWorkstationId &&
		requestedWorkstationId !== bundle.workstation.id
	) {
		return {
			ok: false,
			error: `workstationId ${requestedWorkstationId} does not match lease ${requestedLeaseId}`,
			status: 403,
		};
	}

	const sessionKind = base.session.sessionKind;
	const sessionId =
		stringBodyValue(body, "sessionId") ??
		(sessionKind === "shell"
			? `${bundle.workstation.id}_shell`
			: `${bundle.workstation.id}_${sessionKind}`);
	const existingSession =
		lease.sessions.find((session) => session.id === sessionId) ?? null;
	if (
		existingSession?.participantId &&
		existingSession.participantId !== participant.id
	) {
		return {
			ok: false,
			error: `workstation session ${sessionId} belongs to participant ${existingSession.participantId}`,
			status: 403,
		};
	}

	return {
		ok: true,
		session: {
			leaseBundle: bundle,
			leadParticipantId: leadParticipant?.id ?? participant.id,
			leaseId: lease.id,
			participantId: participant.id,
			participantRole: participant.role,
			participantTediId: participant.tediId,
			sessionId,
			sessionKind,
			workstationId: bundle.workstation.id,
		},
	};
}

export function traceIdFromRequest(c: Context<AppEnv>): string | null {
	const direct =
		c.req.header("X-Trace-Id") ??
		c.req.header("X-Tedix-Trace-Id") ??
		c.req.header("trace-id");
	if (direct?.trim()) return direct.trim();

	const traceparent = c.req.header("traceparent")?.trim();
	const traceId = traceparent?.split("-")[1];
	return traceId && /^[a-f0-9]{32}$/i.test(traceId) ? traceId : null;
}

export function processEventType(
	job: WorkstationJobStatus,
): WorkstationProcessEventType {
	if (job.canceled) return "workstation.process.canceled";
	if (job.timedOut) return "workstation.process.timed_out";
	if (!job.terminal) return "workstation.process.started";
	if (job.exitCode === 0) return "workstation.process.completed";
	return "workstation.process.failed";
}

export const WORKSTATION_NON_IDEMPOTENT_AUTHORITY_ROLES =
	new Set<WorkstationSeatRole>(["lead", "operator", "specialist"]);

export function workstationApprovalEscalation(input: {
	approvalKind: "workstation.operation" | "workstation.process.cancel";
	operationLock?: WorkstationOperationLock | null;
	operationLockSource?: WorkstationOperationLockSource | null;
	ownerParticipantId?: string | null;
	reason: string;
	requestingParticipantId?: string | null;
	requestingParticipantRole?: WorkstationSeatRole | null;
	requiredRoles: WorkstationSeatRole[];
}) {
	return {
		approvalKind: input.approvalKind,
		approvalRequired: true,
		operationLock: input.operationLock ?? null,
		operationLockSource: input.operationLockSource ?? null,
		ownerParticipantId: input.ownerParticipantId ?? null,
		reason: input.reason,
		requestingParticipantId: input.requestingParticipantId ?? null,
		requestingParticipantRole: input.requestingParticipantRole ?? null,
		requiredRoles: input.requiredRoles,
	};
}

export function workstationOperationAuthority(
	session: WorkstationSessionSelection,
	lock: WorkstationOperationLockSelection | null,
):
	| { ok: true }
	| {
			ok: false;
			error: string;
			escalation: ReturnType<typeof workstationApprovalEscalation>;
	  } {
	if (!lock) return { ok: true };
	if (WORKSTATION_NON_IDEMPOTENT_AUTHORITY_ROLES.has(session.participantRole)) {
		return { ok: true };
	}
	const requiredRoles = Array.from(WORKSTATION_NON_IDEMPOTENT_AUTHORITY_ROLES);
	const escalation = workstationApprovalEscalation({
		approvalKind: "workstation.operation",
		operationLock: lock.kind,
		operationLockSource: lock.source,
		reason: "participant_role_requires_approval",
		requestingParticipantId: session.participantId,
		requestingParticipantRole: session.participantRole,
		requiredRoles,
	});
	return {
		ok: false,
		error: `participant ${session.participantId} with role ${session.participantRole} requires approval for workstation operation ${lock.kind}`,
		escalation,
	};
}

export function stringBodyValue(
	body: Record<string, unknown> | null,
	key: string,
): string | null {
	const value = body?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export type WorkstationCorrelation = {
	kernelRunId?: string | null;
	traceBundleId?: string | null;
	workItemId?: string | null;
};

export function workstationCorrelationFromBody(
	body: Record<string, unknown> | null,
): WorkstationCorrelation {
	return {
		kernelRunId: stringBodyValue(body, "kernelRunId"),
		traceBundleId: stringBodyValue(body, "traceBundleId"),
		workItemId: stringBodyValue(body, "workItemId"),
	};
}

export function buildWorkstationProcessEvidence(
	c: Context<AppEnv>,
	job: WorkstationJobStatus,
	input: {
		artifactRefs?: string[];
		body?: Record<string, unknown> | null;
		cwd?: string | null;
		eventType?: WorkstationProcessEventType;
	} = {},
): WorkstationProcessEvidence {
	const tediConfig = c.get("tediConfig");
	const selection = workstationSessionSelection(
		tediConfig,
		input.body ?? null,
		job.context?.sessionKind ?? "shell",
	);
	let ids: WorkstationSessionSelection;
	if (selection.ok) {
		ids = selection.session;
	} else {
		const fallbackIdentity = activeWorkstationIdentity(tediConfig);
		ids = {
			leadParticipantId: fallbackIdentity.leadParticipantId,
			leaseId: fallbackIdentity.leaseId,
			participantId: fallbackIdentity.leadParticipantId,
			participantRole: "lead",
			participantTediId: tediConfig.id,
			sessionId: fallbackIdentity.sessionId,
			sessionKind: "shell",
			workstationId: fallbackIdentity.workstationId,
		};
	}
	return {
		conversationId: job.context?.conversationId ?? null,
		eventType: input.eventType ?? processEventType(job),
		workstationId: job.context?.workstationId ?? ids.workstationId,
		leaseId: job.context?.leaseId ?? ids.leaseId,
		profileId: ACTIVE_WORKSTATION_PROFILE_ID,
		sessionId: job.context?.sessionId ?? ids.sessionId,
		sessionKind: job.context?.sessionKind ?? ids.sessionKind,
		processId: job.processId,
		participantId: job.context?.participantId ?? ids.participantId,
		participantTediId: job.context?.participantTediId ?? ids.participantTediId,
		workItemId:
			job.context?.workItemId ??
			stringBodyValue(input.body ?? null, "workItemId") ??
			null,
		kernelRunId:
			job.context?.kernelRunId ??
			stringBodyValue(input.body ?? null, "kernelRunId") ??
			null,
		traceId:
			job.context?.traceId ??
			stringBodyValue(input.body ?? null, "traceId") ??
			traceIdFromRequest(c) ??
			null,
		operationLock: job.context?.operationLock ?? null,
		operationLockSource: job.context?.operationLockSource ?? null,
		command: job.command,
		cwd: input.cwd ?? job.cwd,
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		terminal: job.terminal,
		running: job.running,
		exitCode: job.exitCode,
		...(job.signal === undefined ? {} : { signal: job.signal }),
		canceled: job.canceled,
		canceledAt: job.canceledAt,
		timeoutMs: job.timeoutMs,
		timedOut: job.timedOut,
		timedOutAt: job.timedOutAt,
		localLogPaths: {
			logDir: job.logDir,
			stdoutPath: job.stdoutPath,
			stderrPath: job.stderrPath,
		},
		artifactRefs: input.artifactRefs ?? [],
	};
}

export function r2PrefixForTedi(c: Context<AppEnv>): string {
	const configured = c.get("r2Prefix");
	if (typeof configured === "string" && configured) return configured;
	const tediConfig = c.get("tediConfig");
	return tediConfig.organizationId
		? `orgs/${tediConfig.organizationId}/tedis/${tediConfig.id}`
		: `tedis/${tediConfig.id}`;
}

export function workstationRecoveryCheckpointKeys(c: Context<AppEnv>) {
	const selection = c.get("workstationRuntimeSelection");
	if (!selection?.workstationId)
		throw new Error("Computer recovery requires an exact computer identity");
	const prefix = `${r2PrefixForTedi(c)}/computers/${encodeURIComponent(selection.workItemId ?? selection.workstationId)}/recovery-checkpoints`;
	return {
		manifestKey: `${prefix}/active.json`,
		patchPrefix: `${prefix}/patches`,
	};
}

export function preparedPreflight(
	metadata: Record<string, unknown> | undefined,
): RepoTreePreflight | null {
	const repo = metadata?.repoSync;
	if (!repo || typeof repo !== "object") return null;
	const preflight = (repo as { treePreflight?: RepoTreePreflight })
		.treePreflight;
	return preflight?.startSha && /^[a-f0-9]{40}$/.test(preflight.startSha)
		? preflight
		: null;
}

export function immutableLeasePreflight(
	lease: WorkstationLease | undefined,
): RepoTreePreflight | null {
	if (!lease?.preparedStartSha || !lease.repositoryPath) return null;
	const observed = preparedPreflight(lease.metadata);
	if (!observed || !observed.workdir.endsWith(`/repos/${lease.repositoryPath}`))
		return null;
	const { authoritySource: _authoritySource, ...persisted } = observed;
	return { ...persisted, startSha: lease.preparedStartSha };
}

/** Uses the original persisted task base; a replacement's newer main is not
 * authority to change it. Missing local turn marker plus clean origin HEAD is
 * required before moving a fresh clone back to that base. */
export function restorePreparedBaseCommand(
	workdir: string,
	preflight: RepoTreePreflight,
): string {
	if (!preflight.startSha || !/^[a-f0-9]{40}$/.test(preflight.startSha))
		throw new Error("Invalid prepared base");
	return [
		"set -euo pipefail",
		`cd -- ${shellSingleQuote(workdir)}`,
		`test -z "$(git -c core.fsmonitor=false status --porcelain=v1 --untracked-files=all)" || { echo 'refusing replacement over dirty checkout' >&2; exit 1; }`,
		`test "$(git rev-parse HEAD)" = "$(git rev-parse ${shellSingleQuote(`refs/remotes/origin/${preflight.branch}`)})" || { echo 'refusing replacement over unrelated HEAD' >&2; exit 1; }`,
		`git cat-file -e ${shellSingleQuote(`${preflight.startSha}^{commit}`)} 2>/dev/null || git fetch --no-tags origin ${shellSingleQuote(preflight.startSha)}`,
		`git -c core.hooksPath=/dev/null checkout --detach --no-overwrite-ignore ${shellSingleQuote(preflight.startSha)}`,
		`git config tedix.preparedStartSha ${shellSingleQuote(preflight.startSha)}`,
	].join("\n");
}

export function checkpointNative(
	body: WorkstationRuntimeBody,
	workdir: string,
	authorize: () => Promise<void>,
	options: { closingLeaseId?: string; onProcess?: (id: string) => void } = {},
): LockedCheckpointNative {
	return {
		async exec(command, execOptions) {
			const timeout = (execOptions?.timeout ?? 10000) + 30000;
			const operation = await startCheckoutOperation(body, {
				command: options.closingLeaseId
					? `set -e\nprintf %s ${shellSingleQuote(`${options.closingLeaseId}\n`)} > ${shellSingleQuote(CHECKOUT_CLOSING_MARKER)}\n${command}`
					: command,
				cwd: workdir,
				timeout,
				allowClosing: !!options.closingLeaseId,
				authorize,
			});
			options.onProcess?.(operation.process.id);
			let result: WorkstationExecResult;
			try {
				result = await operation.process.output({
					encoding: "utf8",
					maxBytes: 16 * 1024 * 1024,
					timeout: timeout + 15000,
				});
			} catch {
				// Its native process retains the fence until the actual transaction ends.
				throw new WorkstationDispatchUnknownError(operation.id);
			}
			if (result.truncated || result.timedOut || result.signal !== undefined)
				throw new Error(
					"Checkpoint command output incomplete or execution timed out",
				);
			return result;
		},
		async writeFile(path, content) {
			if (
				!/^\/tmp\/tedix-restore-[a-f0-9-]+\.(patch|bundle)\.base64$/.test(path)
			)
				throw new Error("Checkpoint staging must use unique scratch inputs");
			await body.writeFile(path, content);
		},
	};
}

export function unpreparedCheckoutProbeCommand(workdir: string): string {
	const script = `const fs = require("node:fs"); const path = require("node:path");
let target = ${JSON.stringify(workdir)};
if (!path.isAbsolute(target) || target.split("/").some(part => part === "." || part === "..")) process.exit(1);
const imageRoot = "/home/tedi/workstation";
const canonicalRoot = "/workspace";
if (target === imageRoot || target.startsWith(imageRoot + "/")) {
 for (let parent = path.dirname(imageRoot); parent !== "/"; parent = path.dirname(parent)) {
  const entry = fs.lstatSync(parent);
  if (entry.isSymbolicLink() || !entry.isDirectory()) process.exit(1);
 }
 const alias = fs.lstatSync(imageRoot);
 const canonical = fs.lstatSync(canonicalRoot);
 if (!alias.isSymbolicLink() || fs.readlinkSync(imageRoot) !== canonicalRoot ||
     canonical.isSymbolicLink() || !canonical.isDirectory()) process.exit(1);
 target = canonicalRoot + target.slice(imageRoot.length);
}
let current = "/";
for (const part of target.split("/").filter(Boolean)) {
 current = path.join(current, part);
 let entry;
 try { entry = fs.lstatSync(current); } catch (error) {
  if (error.code === "ENOENT") { console.log("no-checkpoint-needed"); process.exit(0); }
  throw error;
 }
 if (entry.isSymbolicLink() || !entry.isDirectory()) process.exit(1);
}
const dir = fs.opendirSync(target);
try { if (dir.readSync() !== null) process.exitCode = 1;
 else console.log("no-checkpoint-needed"); } finally { dir.closeSync(); }`;
	return `bun -e ${shellSingleQuote(script)}`;
}

export async function recoveryCheckpointOperation(
	c: Context<AppEnv>,
	workdir: string,
	preflight: RepoTreePreflight | undefined,
	run: (input: {
		preparedStartSha: string;
		provenance: RecoveryCheckpointProvenance;
		withLockedCheckpoint: <T>(
			operation: (native: LockedCheckpointNative) => Promise<T>,
		) => Promise<T>;
	}) => Promise<WorkstationRecoveryCheckpointResult>,
	closingLeaseId?: string,
	allowUnpreparedEmpty = false,
): Promise<
	WorkstationRecoveryCheckpointResult & { reason?: "no-checkpoint-needed" }
> {
	const selection = c.get("workstationRuntimeSelection");
	if (!selection?.workstationId || !selection.leaseId)
		return {
			status: "failed",
			error: "Checkpoint requires exact lease authority",
		};
	const bundle = c.env.DB
		? await getWorkstationLeaseBundle(
				createDbClient(c.env.DB),
				selection.leaseId,
			)
		: null;
	if (c.env.DB && !bundle)
		return {
			status: "failed",
			error: "Checkpoint lease authority unavailable",
		};
	const assertAuthority = async () => {
		await assertCheckoutAuthority(c, !!closingLeaseId);
		if (!c.env.DB || !bundle) return;
		const current = await getWorkstationLeaseBundle(
			createDbClient(c.env.DB),
			selection.leaseId!,
		);
		if (
			!current ||
			current.workstationLease.status === "released" ||
			current.workstationLease.workstationId !== selection.workstationId ||
			current.workstationLease.workItemId !== (selection.workItemId ?? null)
		)
			throw new Error("Checkpoint lease authority changed");
	};
	const original =
		preparedPreflight(bundle?.workstationLease.metadata) ??
		preparedPreflight(bundle?.workstation.metadata) ??
		preflight;
	if (
		bundle &&
		(bundle.workstationLease.workstationId !== selection.workstationId ||
			bundle.workstationLease.workItemId !== (selection.workItemId ?? null))
	)
		return { status: "failed", error: "Checkpoint task authority changed" };
	try {
		const provenance: RecoveryCheckpointProvenance = {
			taskId: selection.workItemId ?? selection.workstationId,
			workstationId: selection.workstationId,
			leaseId: selection.leaseId,
			// Replaced by the actual capturing process before any manifest is published.
			containerPlacementId: "capture-pending",
		};
		const native = checkpointNative(
			c.get("sandbox"),
			original?.startSha ? workdir : "/",
			assertAuthority,
			{
				closingLeaseId,
				onProcess: (id) => {
					provenance.containerPlacementId = `native-process:${id}`;
				},
			},
		);
		if (!original?.startSha) {
			const recordedRepo = bundle?.workstationLease.metadata.repoSync;
			if (
				!allowUnpreparedEmpty ||
				!closingLeaseId ||
				!bundle ||
				!recordedRepo ||
				typeof recordedRepo !== "object" ||
				Array.isArray(recordedRepo) ||
				recordedRepo.workdir !== workdir
			)
				return {
					status: "failed",
					error: "Checkpoint requires original prepared task base",
				};
			const result = await native.exec(
				unpreparedCheckoutProbeCommand(workdir),
				{ timeout: 10000 },
			);
			if (
				result.exitCode !== 0 ||
				result.stdout.trim() !== "no-checkpoint-needed"
			)
				return {
					status: "failed",
					error:
						"Unprepared repository is not proven absent or empty; Computer retained",
				};
			return { status: "clean", reason: "no-checkpoint-needed" };
		}
		return await run({
			preparedStartSha: original.startSha,
			provenance,
			async withLockedCheckpoint(operation) {
				await assertAuthority();
				return operation(native);
			},
		});
	} catch (error) {
		return {
			status: "failed",
			error: errorMessage(error),
			...(error instanceof WorkstationDispatchUnknownError
				? { executionId: error.executionId, observation: "unknown" as const }
				: {}),
		};
	}
}

export async function restoreRecoveryCheckpoint(
	c: Context<AppEnv>,
	repoSync: RepoSyncResult,
): Promise<WorkstationRecoveryCheckpointResult> {
	const workdir = repoWorkdir(repoSync);
	if (!workdir || !repoReady(repoSync)) return { status: "missing" };
	const manifestKey = workstationRecoveryCheckpointKeys(c).manifestKey;
	if (!c.env.TEDI_STORAGE) return { status: "unavailable" };
	try {
		if (!(await c.env.TEDI_STORAGE.get(manifestKey)))
			return { status: "missing" };
	} catch (error) {
		return { status: "failed", error: errorMessage(error) };
	}
	return recoveryCheckpointOperation(
		c,
		workdir,
		repoSync.configured ? repoSync.treePreflight : undefined,
		(input) =>
			restoreWorkstationRecoveryCheckpoint({
				...input,
				manifestKey: workstationRecoveryCheckpointKeys(c).manifestKey,
				storage: c.env.TEDI_STORAGE ?? null,
				workdir,
			}),
	);
}

export function workstationBootstrapCacheRefForKey(key: string): string {
	return `r2://${WORKSTATION_PROCESS_ARTIFACT_BUCKET_REF}/${key}`;
}

export function workstationBootstrapCachePrefix(
	c: Context<AppEnv>,
	packageManager: WorkstationPackageManager,
): string {
	const safeProfileVersion = sanitizeArtifactIdPart(
		WORKSTATION_BOOTSTRAP_CACHE_PROFILE_VERSION,
	);
	return `${r2PrefixForTedi(c)}/workstations/${ACTIVE_WORKSTATION_PROFILE_ID}/bootstrap-cache/${safeProfileVersion}/${packageManager}`;
}

export function workstationBootstrapCacheRecordKey(
	c: Context<AppEnv>,
	packageManager: WorkstationPackageManager,
	lockfileHash: string,
): string {
	const safeHash = sanitizeArtifactIdPart(lockfileHash);
	return `${workstationBootstrapCachePrefix(c, packageManager)}/${safeHash}.json`;
}

export function isBootstrapCacheBackupEntry(
	value: unknown,
): value is WorkstationBootstrapCacheBackupEntry {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const entry = value as Partial<WorkstationBootstrapCacheBackupEntry>;
	return (
		(entry.kind === "node_modules" || entry.kind === "package_manager_cache") &&
		typeof entry.dir === "string" &&
		isWorkstationPath(entry.dir) &&
		Boolean(entry.backup)
	);
}

export function isWorkstationBootstrapCacheRecord(
	value: unknown,
	packageManager: WorkstationPackageManager,
	lockfileHash: string,
): value is WorkstationBootstrapCacheRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Partial<WorkstationBootstrapCacheRecord>;
	return (
		record.version === WORKSTATION_BOOTSTRAP_CACHE_RECORD_VERSION &&
		record.profileId === ACTIVE_WORKSTATION_PROFILE_ID &&
		record.profileVersion === WORKSTATION_BOOTSTRAP_CACHE_PROFILE_VERSION &&
		record.packageManager === packageManager &&
		record.cacheKey === bootstrapCacheKey(packageManager, lockfileHash) &&
		record.lockfileHash === lockfileHash &&
		typeof record.tediId === "string" &&
		typeof record.workdir === "string" &&
		isWorkstationPath(record.workdir) &&
		typeof record.nodeModulesDir === "string" &&
		isWorkstationPath(record.nodeModulesDir) &&
		Array.isArray(record.backups) &&
		record.backups.length > 0 &&
		record.backups.every(isBootstrapCacheBackupEntry) &&
		typeof record.createdAt === "string"
	);
}

export async function readBootstrapCacheRecord(
	c: Context<AppEnv>,
	packageManager: WorkstationPackageManager,
	lockfileHash: string,
): Promise<WorkstationBootstrapCacheRecord | null> {
	if (!c.env.TEDI_STORAGE || typeof c.env.TEDI_STORAGE.get !== "function") {
		return null;
	}
	try {
		const obj = await c.env.TEDI_STORAGE.get(
			workstationBootstrapCacheRecordKey(c, packageManager, lockfileHash),
		);
		if (!obj) return null;
		const parsed = JSON.parse(await obj.text()) as unknown;
		return isWorkstationBootstrapCacheRecord(
			parsed,
			packageManager,
			lockfileHash,
		)
			? parsed
			: null;
	} catch {
		return null;
	}
}

export async function pruneBootstrapCacheRecords(
	c: Context<AppEnv>,
	packageManager: WorkstationPackageManager,
	keepLockfileHash: string,
): Promise<void> {
	const storage = c.env.TEDI_STORAGE;
	if (
		!storage ||
		typeof storage.list !== "function" ||
		typeof storage.get !== "function" ||
		typeof storage.delete !== "function"
	) {
		return;
	}
	try {
		const prefix = `${workstationBootstrapCachePrefix(c, packageManager)}/`;
		const listed = await storage.list({ prefix });
		const objects = Array.isArray(listed.objects) ? listed.objects : [];
		const records = (
			await Promise.all(
				objects.map(async (object) => {
					if (!object.key.endsWith(".json")) return null;
					const obj = await storage.get(object.key);
					if (!obj) return null;
					const parsed = JSON.parse(await obj.text()) as unknown;
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
						return null;
					}
					const record = parsed as Partial<WorkstationBootstrapCacheRecord>;
					if (
						record.version !== WORKSTATION_BOOTSTRAP_CACHE_RECORD_VERSION ||
						record.profileId !== ACTIVE_WORKSTATION_PROFILE_ID ||
						record.profileVersion !==
							WORKSTATION_BOOTSTRAP_CACHE_PROFILE_VERSION ||
						record.packageManager !== packageManager ||
						typeof record.lockfileHash !== "string"
					) {
						return null;
					}
					if (
						!isWorkstationBootstrapCacheRecord(
							parsed,
							packageManager,
							record.lockfileHash,
						)
					) {
						return null;
					}
					return { key: object.key, record };
				}),
			)
		).filter(
			(
				entry,
			): entry is { key: string; record: WorkstationBootstrapCacheRecord } =>
				entry !== null,
		);
		records.sort(
			(a, b) => Date.parse(b.record.createdAt) - Date.parse(a.record.createdAt),
		);
		const evicted = records
			.filter((entry) => entry.record.lockfileHash !== keepLockfileHash)
			.slice(Math.max(0, WORKSTATION_BOOTSTRAP_CACHE_MAX_RECORDS - 1));
		await Promise.all(evicted.map((entry) => storage.delete(entry.key)));
	} catch (error) {
		console.warn(
			"[workstation] bootstrap cache eviction failed:",
			errorMessage(error),
		);
	}
}

export async function persistBootstrapCacheRecord(
	c: Context<AppEnv>,
	record: WorkstationBootstrapCacheRecord,
): Promise<WorkstationBootstrapCacheResult> {
	if (!c.env.TEDI_STORAGE || typeof c.env.TEDI_STORAGE.put !== "function") {
		return { ref: null, status: "unavailable" };
	}
	const key = workstationBootstrapCacheRecordKey(
		c,
		record.packageManager,
		record.lockfileHash,
	);
	try {
		await c.env.TEDI_STORAGE.put(key, `${JSON.stringify(record, null, 2)}\n`, {
			httpMetadata: { contentType: "application/json" },
		});
		await pruneBootstrapCacheRecords(
			c,
			record.packageManager,
			record.lockfileHash,
		);
		return {
			ref: workstationBootstrapCacheRefForKey(key),
			status: "persisted",
		};
	} catch (error) {
		return { error: errorMessage(error), ref: null, status: "failed" };
	}
}

export async function restoreBootstrapDependencyCache(
	c: Context<AppEnv>,
	input: {
		attemptId?: string | null;
		lockfile: string | null;
		lockfileHash: string | null;
		workdir: string;
	},
): Promise<WorkstationBootstrapCacheResult> {
	if (!input.lockfileHash) return { ref: null, status: "skipped" };
	const packageManager = packageManagerForLockfile(input.lockfile);
	const record = await readBootstrapCacheRecord(
		c,
		packageManager,
		input.lockfileHash,
	);
	if (!record) return { ref: null, status: "missing" };
	const nodeModulesDir = `${input.workdir}/node_modules`;
	const packageCacheDir = packageManagerCacheDir(packageManager);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			JSON.stringify([
				c.get("workstationRuntimeSelection")?.leaseId,
				input.workdir,
				record.cacheKey,
			]),
		),
	);
	const executionId = `cache-restore-${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
	try {
		const previous = await c
			.get("sandbox")
			.readExecutionAssociation(executionId);
		if (previous) {
			const status = await workstationExecutionStatus(
				c.get("sandbox"),
				executionId,
			);
			if (!status.terminal)
				throw new WorkstationDispatchUnknownError(executionId);
			if (
				status.exitCode !== 0 ||
				status.timedOut ||
				status.signal !== undefined
			)
				return {
					ref: null,
					status: "failed",
					executionId,
					error: "Previous dependency cache publication failed",
				};
			return {
				ref: workstationBootstrapCacheRefForKey(
					workstationBootstrapCacheRecordKey(
						c,
						packageManager,
						input.lockfileHash,
					),
				),
				status: "restored",
				executionId,
				restoredAt:
					typeof previous.metadata?.context.restoredAt === "string"
						? previous.metadata.context.restoredAt
						: undefined,
			};
		}
	} catch {
		return {
			ref: null,
			status: "failed",
			executionId,
			observation: "unknown",
			error: new WorkstationDispatchUnknownError(executionId).message,
		};
	}
	const stage = `${WORKSTATION_DIR}/cache-restore-${crypto.randomUUID()}`;
	try {
		const created = await workstationExec(
			c.get("sandbox"),
			`umask 077; mkdir -- ${shellSingleQuote(stage)}`,
			{ timeout: 30000 },
		);
		if (created.exitCode !== 0)
			throw new Error("Cache staging directory unavailable");
		const targets = record.backups.map((entry, index) => ({
			staged: `${stage}/${index}`,
			target: entry.kind === "node_modules" ? nodeModulesDir : packageCacheDir,
			old: `${stage}/old-${index}`,
		}));
		if (new Set(targets.map((entry) => entry.target)).size !== targets.length)
			throw new Error("Duplicate dependency cache targets");
		for (let index = 0; index < record.backups.length; index++)
			await c.get("sandbox").restoreBackup({
				...record.backups[index]!.backup,
				dir: targets[index]!.staged,
			});
		const restoredAt = new Date().toISOString();
		const publish = String.raw`
const fs = require("node:fs"),
	path = require("node:path"),
	crypto = require("node:crypto");
const i = JSON.parse(process.argv[1]);
const target = i.lockfile || "package.json";
if (
	crypto
		.createHash("sha256")
		.update(fs.readFileSync(path.join(i.workdir, target)))
		.digest("hex") !== i.hash
)
	throw new Error("Checkout lockfile changed during cache staging");
const dev = fs.statSync(i.stage).dev;
for (const t of i.targets) {
	fs.mkdirSync(path.dirname(t.target), { recursive: true });
	if (
		!fs.lstatSync(t.staged).isDirectory() ||
		fs.lstatSync(t.staged).isSymbolicLink() ||
		fs.statSync(t.staged).dev !== dev ||
		fs.statSync(path.dirname(t.target)).dev !== dev
	)
		throw new Error(
			"Cache publication requires one filesystem and directory targets",
		);
	if (
		fs.existsSync(t.target) &&
		(!fs.lstatSync(t.target).isDirectory() ||
			fs.lstatSync(t.target).isSymbolicLink())
	)
		throw new Error("Unsafe cache destination");
}
let readyBytes;
for (const t of i.targets) {
	if (i.ready.startsWith(t.target + "/")) {
		const stagedReady = t.staged + i.ready.slice(t.target.length);
		if (fs.existsSync(stagedReady)) {
			if (
				!fs.lstatSync(stagedReady).isFile() ||
				fs.lstatSync(stagedReady).isSymbolicLink()
			)
				throw new Error("Unsafe staged readiness marker");
			readyBytes = fs.readFileSync(stagedReady);
			fs.unlinkSync(stagedReady);
		}
	}
}
fs.rmSync(i.ready, { force: true });
fs.rmSync(i.receipt, { force: true });
const moved = [];
try {
	for (const t of i.targets) {
		const had = fs.existsSync(t.target);
		if (had) fs.renameSync(t.target, t.old);
		moved.push({ t, had, published: false });
		fs.renameSync(t.staged, t.target);
		moved[moved.length - 1].published = true;
	}
	fs.writeFileSync(i.receipt, i.at + "\n");
	if (readyBytes !== undefined)
		fs.writeFileSync(i.ready, readyBytes, { flag: "wx", mode: 0o600 });
} catch (error) {
	fs.rmSync(i.ready, { force: true });
	for (const m of moved.reverse()) {
		if (m.published) fs.renameSync(m.t.target, m.t.staged);
		if (m.had) fs.renameSync(m.t.old, m.t.target);
	}
	throw error;
}
fs.rmSync(i.stage, { recursive: true, force: true });
`;
		const command = `bun -e ${shellSingleQuote(publish)} ${shellSingleQuote(
			JSON.stringify({
				stage,
				targets,
				workdir: input.workdir,
				lockfile: input.lockfile,
				hash: input.lockfileHash,
				ready: `${input.workdir}/${WORKSTATION_BOOTSTRAP_DEPENDENCY_MARKER}`,
				receipt: WORKSTATION_BOOTSTRAP_CACHE_RESTORED_AT_PATH,
				at: restoredAt,
			}),
		)}`;
		const operation = await startCheckoutOperation(c.get("sandbox"), {
			command: workstationOperationLockedInvocation(
				"dependency_cache",
				command,
			),
			timeout: 150000,
			executionId,
			metadata: {
				command: "restore dependency cache",
				cwd: input.workdir,
				context: { restoredAt, stage },
				timeoutMs: 150000,
			},
			authorize: () => assertCheckoutAuthority(c),
		});
		const published = await operation.process
			.output({ encoding: "utf8", timeout: 165000 })
			.catch(() => {
				throw new WorkstationDispatchUnknownError(executionId);
			});
		if (published.exitCode !== 0)
			throw new Error(
				published.stderr || "Dependency cache publication failed",
			);
		return {
			ref: workstationBootstrapCacheRefForKey(
				workstationBootstrapCacheRecordKey(
					c,
					packageManager,
					input.lockfileHash,
				),
			),
			restoredAt,
			status: "restored",
		};
	} catch (error) {
		return {
			error: errorMessage(error),
			ref: null,
			status: "failed",
			...(error instanceof WorkstationDispatchUnknownError
				? { executionId: error.executionId, observation: "unknown" as const }
				: {}),
		};
	}
}

export async function ensureBootstrapDependencyCacheBackup(
	c: Context<AppEnv>,
	input: {
		lockfile: string | null;
		lockfileHash: string | null;
		workdir: string;
	},
): Promise<WorkstationBootstrapCacheResult> {
	if (!input.lockfileHash) return { ref: null, status: "skipped" };
	const packageManager = packageManagerForLockfile(input.lockfile);
	const existingKey = workstationBootstrapCacheRecordKey(
		c,
		packageManager,
		input.lockfileHash,
	);
	const existing = await readBootstrapCacheRecord(
		c,
		packageManager,
		input.lockfileHash,
	);
	if (existing) {
		return {
			ref: workstationBootstrapCacheRefForKey(existingKey),
			status: "persisted",
		};
	}
	try {
		const lockfileHash = input.lockfileHash;
		const nodeModulesDir = `${input.workdir}/node_modules`;
		const packageCacheDir = packageManagerCacheDir(packageManager);
		const tediConfig = c.get("tediConfig");
		const backups = await withWorkstationOperationLock(
			c,
			"dependency_cache",
			async () => {
				await execInRuntimeBody(
					c,
					`mkdir -p ${shellSingleQuote(packageCacheDir)}`,
					{ cwd: input.workdir, timeout: 30_000 },
				);
				const targets = [
					{
						dir: packageCacheDir,
						kind: "package_manager_cache" as const,
					},
					{ dir: nodeModulesDir, kind: "node_modules" as const },
				];
				const entries: WorkstationBootstrapCacheBackupEntry[] = [];
				for (const target of targets) {
					const backup = await c.get("sandbox").createBackup({
						dir: target.dir,
						name: `tedix-${tediConfig.slug}-${ACTIVE_WORKSTATION_PROFILE_ID}-${packageManager}-${target.kind}-${lockfileHash.slice(0, 12)}`,
					});
					entries.push({ ...target, backup });
				}
				return entries;
			},
		);
		return await persistBootstrapCacheRecord(c, {
			version: WORKSTATION_BOOTSTRAP_CACHE_RECORD_VERSION,
			cacheKey: bootstrapCacheKey(packageManager, input.lockfileHash),
			profileId: ACTIVE_WORKSTATION_PROFILE_ID,
			profileVersion: WORKSTATION_BOOTSTRAP_CACHE_PROFILE_VERSION,
			packageManager,
			tediId: tediConfig.id,
			lockfile: input.lockfile,
			lockfileHash: input.lockfileHash,
			workdir: input.workdir,
			nodeModulesDir,
			backups,
			createdAt: new Date().toISOString(),
		});
	} catch (error) {
		return { error: errorMessage(error), ref: null, status: "failed" };
	}
}

/**
 * Reports whether the dependency cache exists without creating it on the
 * normal wake/exec response path. The durable provisioning fiber follows a
 * ready response with one synchronous, recoverable cache-backup phase.
 */
export async function readBootstrapDependencyCacheStatus(
	c: Context<AppEnv>,
	input: {
		lockfile: string | null;
		lockfileHash: string | null;
		workdir: string;
	},
): Promise<WorkstationBootstrapCacheResult> {
	if (!input.lockfileHash) return { ref: null, status: "skipped" };
	const packageManager = packageManagerForLockfile(input.lockfile);
	const recordKey = workstationBootstrapCacheRecordKey(
		c,
		packageManager,
		input.lockfileHash,
	);
	const existing = await readBootstrapCacheRecord(
		c,
		packageManager,
		input.lockfileHash,
	);
	if (existing) {
		return {
			ref: workstationBootstrapCacheRefForKey(recordKey),
			status: "persisted",
		};
	}

	return { ref: null, status: "pending" };
}

export function workstationProcessArtifactRefs(
	c: Context<AppEnv>,
	processId: string,
) {
	const baseKey = `${r2PrefixForTedi(c)}/workstations/${ACTIVE_WORKSTATION_PROFILE_ID}/processes/${processId}/terminal`;
	const evidenceKey = `${baseKey}/evidence.json`;
	const stdoutKey = `${baseKey}/stdout.log`;
	const stderrKey = `${baseKey}/stderr.log`;
	const refForKey = (key: string) =>
		`r2://${WORKSTATION_PROCESS_ARTIFACT_BUCKET_REF}/${key}`;
	return {
		evidence: { key: evidenceKey, ref: refForKey(evidenceKey) },
		stdout: { key: stdoutKey, ref: refForKey(stdoutKey) },
		stderr: { key: stderrKey, ref: refForKey(stderrKey) },
		refs: [refForKey(evidenceKey), refForKey(stdoutKey), refForKey(stderrKey)],
	};
}

export async function readPersistedProcessEvidence(
	c: Context<AppEnv>,
	processId: string,
	diagnostics?: JobObservationDiagnostics,
): Promise<WorkstationProcessEvidence | null> {
	if (!c.env.TEDI_STORAGE || typeof c.env.TEDI_STORAGE.get !== "function") {
		if (diagnostics) diagnostics.retainedEvidence = "binding_unavailable";
		return null;
	}
	const artifacts = workstationProcessArtifactRefs(c, processId);
	if (diagnostics) diagnostics.retainedEvidence = "pending";
	try {
		const obj = await c.env.TEDI_STORAGE.get(artifacts.evidence.key);
		if (!obj) {
			if (diagnostics) diagnostics.retainedEvidence = "absent";
			return null;
		}
		const text = await obj.text();
		let parsed: WorkstationProcessEvidence;
		try {
			parsed = JSON.parse(text) as WorkstationProcessEvidence;
		} catch {
			if (diagnostics) diagnostics.retainedEvidence = "invalid";
			return null;
		}
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			typeof parsed.processId !== "string" ||
			parsed.processId !== processId ||
			typeof parsed.workstationId !== "string" ||
			!parsed.workstationId ||
			!Array.isArray(parsed.artifactRefs) ||
			(!parsed.terminal && !parsed.canceled && !parsed.timedOut)
		) {
			if (diagnostics) diagnostics.retainedEvidence = "invalid";
			return null;
		}
		if (diagnostics) diagnostics.retainedEvidence = "valid";
		return parsed;
	} catch {
		if (diagnostics) diagnostics.retainedEvidence = "read_failed";
		return null;
	}
}

export function sanitizeArtifactIdPart(value: string): string {
	return (
		value
			.trim()
			.replace(/[^A-Za-z0-9._:-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 96) || "unknown"
	);
}

export function compactArtifactMetadata(
	input: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined || value === null || value === "") continue;
		out[key] = value;
	}
	return out;
}

export function workstationSourceArtifactRefs(
	refs: readonly string[],
): string[] {
	return Array.from(
		new Set(
			refs.map((ref) => ref.trim()).filter((ref) => ref.startsWith("r2://")),
		),
	);
}

export function resolveWorkstationArtifactScopeRunId(input: {
	kernelRunId?: string | null;
	workItemId?: string | null;
}): string | null {
	const kernelRunId = input.kernelRunId?.trim();
	if (kernelRunId) return kernelRunId;
	const workItemId = input.workItemId?.trim();
	return workItemId ? `work-item:${workItemId}` : null;
}

export function workstationArtifactDescriptor(
	ref: string,
	index: number,
): { idPart: string; mimeType: string; name: string; refType: string } {
	const fileName = ref.split(/[/?#]/).filter(Boolean).at(-1) ?? `log-${index}`;
	if (fileName === "evidence.json") {
		return {
			idPart: "evidence",
			mimeType: "application/json",
			name: "evidence.json",
			refType: "evidence",
		};
	}
	if (fileName === "stdout.log") {
		return {
			idPart: "stdout",
			mimeType: "text/plain; charset=utf-8",
			name: "stdout.log",
			refType: "stdout",
		};
	}
	if (fileName === "stderr.log") {
		return {
			idPart: "stderr",
			mimeType: "text/plain; charset=utf-8",
			name: "stderr.log",
			refType: "stderr",
		};
	}
	const idPart = sanitizeArtifactIdPart(fileName || `log-${index}`);
	return {
		idPart,
		mimeType: "application/octet-stream",
		name: fileName || `log-${index}`,
		refType: "other",
	};
}

export async function recordArtifactRow(
	c: Context<AppEnv>,
	input: RecordArtifactInput,
): Promise<void> {
	const tediConfig = c.get("tediConfig");
	const headers: Record<string, string> = {
		"X-Service-Binding": "true",
		"X-Tedix-Caller": "tedi-workstation-route",
		"X-Tedix-Tedi-Scopes": "tedis:write",
		"X-Tedix-Tedi-Id": tediConfig.id,
	};
	if (tediConfig.organizationId) {
		headers["X-Tedix-Org-Id"] = tediConfig.organizationId;
	}
	if (!c.env.API_SERVICE) throw new Error("api_service_binding_unavailable");
	await callRpc("cognitiveRuntime/recordArtifact", input, {
		apiUrl: "https://api",
		fetch: serviceBindingFetch(c.env.API_SERVICE),
		headers,
	});
}

export async function recordWorkstationProcessArtifactRows(
	c: Context<AppEnv>,
	job: WorkstationJobStatus,
	evidence: WorkstationProcessEvidence,
): Promise<NonNullable<WorkstationJobStatus["artifactRowPersistence"]>> {
	const refs = workstationSourceArtifactRefs(evidence.artifactRefs);
	if (refs.length === 0)
		return { reason: "no_artifact_refs", status: "skipped" };
	const runId = resolveWorkstationArtifactScopeRunId(evidence);
	if (!runId) {
		return {
			reason: "artifact_scope_unavailable",
			status: "skipped",
		};
	}
	if (!c.env.API_SERVICE) {
		return { reason: "api_service_binding_unavailable", status: "skipped" };
	}
	const conversationId = job.context?.conversationId?.trim();
	if (
		!conversationId ||
		!job.context?.kernelRunId ||
		job.context.kernelRunId !== runId ||
		evidence.kernelRunId !== runId ||
		evidence.conversationId !== conversationId ||
		job.context.participantTediId !== c.get("tediConfig").id
	) {
		return { reason: "conversation_provenance_unavailable", status: "skipped" };
	}

	const tediConfig = c.get("tediConfig");
	const safeProcessId = sanitizeArtifactIdPart(evidence.processId);
	const processArtifacts = workstationProcessArtifactRefs(
		c,
		evidence.processId,
	);
	const keyForRef = new Map([
		[processArtifacts.evidence.ref, processArtifacts.evidence.key],
		[processArtifacts.stdout.ref, processArtifacts.stdout.key],
		[processArtifacts.stderr.ref, processArtifacts.stderr.key],
	]);
	const existingPersistence = job.artifactRowPersistence;
	const trustedExistingIds = new Set(
		existingPersistence &&
			(existingPersistence.status === "persisted" ||
				existingPersistence.status === "failed") &&
			Array.isArray(existingPersistence.artifactIds)
			? existingPersistence.artifactIds
			: [],
	);
	const results = await Promise.all(
		refs.map(async (ref, index) => {
			const descriptor = workstationArtifactDescriptor(ref, index);
			const artifactId = `${runId}:artifact:workstation_process:${safeProcessId}:${descriptor.idPart}`;
			if (trustedExistingIds.has(artifactId)) return { artifactId };
			const metadata = compactArtifactMetadata({
				subKind: "workstation_process",
				producer: "workstation-adapter",
				source: "workstation_process",
				processId: evidence.processId,
				refType: descriptor.refType,
				eventType: evidence.eventType,
				workItemId: evidence.workItemId,
				kernelRunId: evidence.kernelRunId,
				traceId: evidence.traceId,
				traceBundleId: job.context?.traceBundleId,
				workstationId: evidence.workstationId,
				leaseId: evidence.leaseId,
				sessionId: evidence.sessionId,
				participantId: evidence.participantId,
				participantTediId: evidence.participantTediId,
				profileId: evidence.profileId,
				exitCode: evidence.exitCode,
				canceled: evidence.canceled,
				timedOut: evidence.timedOut,
				ref,
			});
			const inlineContent =
				descriptor.refType === "evidence"
					? `${JSON.stringify({ ...evidence, artifactRefs: refs }, null, 2)}\n`
					: (() => {
							const key = keyForRef.get(ref);
							return key && c.env.TEDI_STORAGE
								? readBoundedR2Text(
										c.env.TEDI_STORAGE,
										key,
										MAX_REVIEWER_OPENABLE_LOG_BYTES,
									)
								: Promise.resolve("");
						})();
			try {
				const content = await inlineContent;
				await recordArtifactRow(c, {
					id: artifactId,
					tediId: tediConfig.id,
					conversationId,
					runId,
					kind: "log",
					name: `workstation_process/${safeProcessId}/${descriptor.name}`,
					mimeType: descriptor.mimeType,
					// Publish the receipt body through the canonical artifact service so
					// an independent reviewer can open artifact://<id>. Keep stdout and
					// stderr as immutable R2-backed rows; the receipt links both logs.
					...(content
						? {
								content,
								contentEncoding: "utf8" as const,
							}
						: { uri: ref }),
					metadata,
				});
				return { artifactId };
			} catch (error) {
				return { error: errorMessage(error) };
			}
		}),
	);
	const artifactIds = results.flatMap((result) =>
		result.artifactId ? [result.artifactId] : [],
	);
	const recorded = artifactIds.length;
	const firstError = results.find((result) => result.error)?.error;
	return {
		artifactIds,
		recorded,
		skipped: refs.length - recorded,
		status: firstError ? "failed" : "persisted",
		...(firstError ? { error: firstError } : {}),
	};
}

export async function readBoundedR2Text(
	bucket: R2Bucket,
	key: string,
	maxBytes: number,
): Promise<string> {
	try {
		const obj = await bucket.get(key);
		if (!obj) return "";
		const size = obj.size ?? 0;
		const offset = size > maxBytes ? size - maxBytes : 0;
		const slice =
			offset > 0
				? await bucket.get(key, { range: { offset, length: maxBytes } })
				: obj;
		if (!slice) return "";
		return await slice.text();
	} catch {
		return "";
	}
}

export async function addWorkItemProcessComment(
	c: Context<AppEnv>,
	evidence: WorkstationProcessEvidence,
	outputPreview: { stdoutTail: string; stderrTail: string } | null,
): Promise<void> {
	const workItemId = evidence.workItemId?.trim();
	if (
		!workItemId ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			workItemId,
		)
	)
		return;
	if (!evidence.terminal && !evidence.canceled && !evidence.timedOut) return;
	if (!c.env.API_SERVICE) return;

	const tediConfig = c.get("tediConfig");
	const eventLabel = evidence.canceled
		? "canceled"
		: evidence.timedOut
			? "timed_out"
			: evidence.exitCode === 0
				? "completed"
				: "failed";

	const artifactCount = evidence.artifactRefs.length;
	const lines: string[] = [
		`Command: ${(evidence.command ?? "").slice(0, 200)}`,
		`Exit code: ${evidence.exitCode ?? "—"} (${eventLabel})`,
	];
	if (evidence.startedAt && evidence.endedAt) {
		const ms =
			new Date(evidence.endedAt).getTime() -
			new Date(evidence.startedAt).getTime();
		lines.push(`Duration: ${ms}ms`);
	}

	const stdoutPreview = outputPreview?.stdoutTail?.slice(-800) ?? "";
	const stderrPreview = outputPreview?.stderrTail?.slice(-400) ?? "";
	if (stdoutPreview) {
		lines.push(`\nstdout (tail):\n${stdoutPreview}`);
	}
	if (stderrPreview) {
		lines.push(`\nstderr (tail):\n${stderrPreview}`);
	}

	lines.push(`\nArtifacts: ${artifactCount}`);
	for (const ref of evidence.artifactRefs.slice(0, 3)) {
		lines.push(`  ${ref.slice(0, 300)}`);
	}
	if (artifactCount > 3)
		lines.push(`  (${artifactCount - 3} more refs in metadata.artifactRefs)`);

	const commentBody = lines.join("\n").slice(0, 5000);
	const metadata: Record<string, unknown> = {
		processId: evidence.processId,
		eventType: evidence.eventType,
		exitCode: evidence.exitCode,
		artifactCount,
		kernelRunId: evidence.kernelRunId,
		leaseId: evidence.leaseId,
		participantId: evidence.participantId,
		participantTediId: evidence.participantTediId,
		sessionId: evidence.sessionId,
		workstationId: evidence.workstationId,
	};
	if (artifactCount > 0)
		metadata.artifactRefs = evidence.artifactRefs.slice(0, 5);

	const headers: Record<string, string> = {
		"X-Service-Binding": "true",
		"X-Tedix-Caller": "tedi-workstation-route",
		"X-Tedix-Tedi-Id": tediConfig.id,
	};
	if (tediConfig.organizationId)
		headers["X-Tedix-Org-Id"] = tediConfig.organizationId;

	try {
		await callRpc(
			"workItems/addComment",
			{
				id: workItemId,
				authorType: "tedi",
				authorId: tediConfig.id,
				body: commentBody,
				eventType: `workstation.process.${eventLabel}`,
				metadata,
			},
			{
				apiUrl: "https://api",
				fetch: serviceBindingFetch(c.env.API_SERVICE),
				headers,
			},
		);
	} catch (error) {
		console.warn(
			"[workstation] addWorkItemProcessComment error:",
			error instanceof Error ? error.message : String(error),
		);
	}
}

export async function stageWorkstationSpool(
	body: WorkstationRuntimeBody,
	bucket: R2Bucket,
	path: string,
	key: string,
): Promise<void> {
	const file = await body.readFile(path, { encoding: "none" });
	const bytes =
		file.content instanceof Uint8Array
			? file.content
			: new TextEncoder().encode(file.content);
	await bucket.put(key, bytes, {
		httpMetadata: { contentType: "text/plain; charset=utf-8" },
	});
}

export async function writeWorkstationProcessArtifacts(
	c: Context<AppEnv>,
	job: WorkstationJobStatus,
	body: Record<string, unknown> | null,
): Promise<{
	artifactRefs: string[];
	evidence: WorkstationProcessEvidence;
	status: WorkstationJobStatus["artifactWriteStatus"];
}> {
	if (!job.terminal) {
		const evidence = buildWorkstationProcessEvidence(c, job, { body });
		return {
			artifactRefs: [],
			evidence,
			status: { reason: "process_not_terminal", status: "skipped" },
		};
	}
	if (!c.env.TEDI_STORAGE || typeof c.env.TEDI_STORAGE.put !== "function") {
		const evidence = buildWorkstationProcessEvidence(c, job, { body });
		return {
			artifactRefs: [],
			evidence,
			status: { reason: "storage_binding_unavailable", status: "skipped" },
		};
	}

	const artifacts = workstationProcessArtifactRefs(c, job.processId);
	const evidence = buildWorkstationProcessEvidence(c, job, {
		artifactRefs: artifacts.refs,
		body,
	});
	try {
		const uploads = await Promise.allSettled([
			stageWorkstationSpool(
				c.get("sandbox"),
				c.env.TEDI_STORAGE,
				job.stdoutPath,
				artifacts.stdout.key,
			),
			stageWorkstationSpool(
				c.get("sandbox"),
				c.env.TEDI_STORAGE,
				job.stderrPath,
				artifacts.stderr.key,
			),
		]);
		const failed = uploads.find((result) => result.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
		await c.env.TEDI_STORAGE.put(
			artifacts.evidence.key,
			`${JSON.stringify(evidence, null, 2)}\n`,
			{ httpMetadata: { contentType: "application/json" } },
		);
		return {
			artifactRefs: artifacts.refs,
			evidence,
			status: { status: "persisted" },
		};
	} catch (error) {
		const status = { error: errorMessage(error), status: "failed" as const };
		const partial = {
			...buildWorkstationProcessEvidence(c, job, { body }),
			artifactWriteStatus: status,
		};
		try {
			// Terminal truth survives failed log transport. Create-only prevents a
			// delayed failed upload from replacing a concurrent complete receipt.
			const written = await c.env.TEDI_STORAGE.put(
				artifacts.evidence.key,
				JSON.stringify(partial),
				{
					httpMetadata: { contentType: "application/json" },
					onlyIf: { etagDoesNotMatch: "*" },
				},
			);
			if (!written) {
				const retained = await readPersistedProcessEvidence(c, job.processId);
				if (retained)
					return {
						artifactRefs: retained.artifactRefs,
						evidence: retained,
						status: retained.artifactWriteStatus ?? { status: "persisted" },
					};
			}
		} catch (retentionError) {
			log.error("Terminal receipt retention failed", {
				event: "workstation.receipt_retention_failed",
				leaseId: c.get("workstationRuntimeSelection")?.leaseId ?? undefined,
				outcome: "unavailable",
				error: contentFreeTediException(retentionError),
			});
		}
		return { artifactRefs: [], evidence: partial, status };
	}
}

export function workstationProcessEvidenceMetadata(
	metadata: Record<string, JsonValue>,
	evidence: WorkstationProcessEvidence,
): Record<string, JsonValue> {
	return toJsonRecord({
		...metadata,
		lastWorkstationProcessEvidence: evidence,
		// Keep the hot lease receipt bounded. Full job history is represented by
		// immutable artifact refs and process evidence rows, not an ever-growing
		// JSON object rewritten on every poll.
		workstationProcessEvidence: {
			[evidence.processId]: evidence,
		},
	});
}

export async function persistWorkstationProcessEvidence(
	c: Context<AppEnv>,
	evidence: WorkstationProcessEvidence,
): Promise<
	NonNullable<WorkstationJobStatus["workstationEvidencePersistence"]>
> {
	if (evidence.artifactRefs.length === 0) {
		return { reason: "no_artifact_refs", status: "skipped" };
	}
	if (!c.env.DB) return { reason: "db_binding_unavailable", status: "skipped" };
	try {
		const db = createDbClient(c.env.DB);
		const bundle = await getWorkstationLeaseBundle(db, evidence.leaseId);
		if (!bundle) return { reason: "lease_not_found", status: "skipped" };
		const refs = evidence.artifactRefs;
		const existingSession = bundle.workstationLease.sessions.find(
			(session) => session.id === evidence.sessionId,
		);
		const terminalSession = existingSession
			? {
					...existingSession,
					artifactRefs: uniqueStrings([
						...existingSession.artifactRefs,
						...refs,
					]),
					endedAt: evidence.endedAt ?? new Date().toISOString(),
					metadata: workstationProcessEvidenceMetadata(
						existingSession.metadata,
						evidence,
					),
					status:
						evidence.canceled || evidence.timedOut
							? ("archived" as const)
							: evidence.exitCode === 0
								? ("ready" as const)
								: ("degraded" as const),
				}
			: null;
		const updated = {
			workstation: {
				...bundle.workstation,
				artifactRefs: uniqueStrings([
					...bundle.workstation.artifactRefs,
					...refs,
				]),
				metadata: workstationProcessEvidenceMetadata(
					bundle.workstation.metadata,
					evidence,
				),
			},
			workstationLease: {
				...bundle.workstationLease,
				artifactRefs: uniqueStrings([
					...bundle.workstationLease.artifactRefs,
					...refs,
				]),
				metadata: workstationProcessEvidenceMetadata(
					bundle.workstationLease.metadata,
					evidence,
				),
				// Persist only the session finalized by this job. Replaying the
				// complete lease history made job reads slower after every run.
				sessions: terminalSession ? [terminalSession] : [],
				updatedAt: new Date().toISOString(),
			},
		};
		await upsertWorkstationLeaseBundle(db, updated);
		return { status: "persisted" };
	} catch (error) {
		return { error: errorMessage(error), status: "failed" };
	}
}

export async function promoteWorkstationJobEvidence(
	c: Context<AppEnv>,
	job: WorkstationJobStatus,
	body: Record<string, unknown> | null,
): Promise<WorkstationJobStatus> {
	const artifactResult = await writeWorkstationProcessArtifacts(c, job, body);
	const artifactRowPersistence = await recordWorkstationProcessArtifactRows(
		c,
		job,
		artifactResult.evidence,
	);
	const evidence = {
		...artifactResult.evidence,
		artifactRefs: uniqueStrings([
			...artifactResult.evidence.artifactRefs,
			...(artifactRowPersistence.artifactIds ?? []).map(
				(artifactId) => `artifact://${artifactId}`,
			),
		]),
	};
	if (
		evidence.artifactRefs.length !==
			artifactResult.evidence.artifactRefs.length &&
		c.env.TEDI_STORAGE
	) {
		const artifacts = workstationProcessArtifactRefs(c, job.processId);
		try {
			await c.env.TEDI_STORAGE.put(
				artifacts.evidence.key,
				`${JSON.stringify(evidence, null, 2)}\n`,
				{ httpMetadata: { contentType: "application/json" } },
			);
		} catch (error) {
			console.warn(
				"[workstation] openable artifact refs could not be added to the persisted receipt:",
				errorMessage(error),
			);
		}
	}
	const persistence = await persistWorkstationProcessEvidence(c, evidence);
	await addWorkItemProcessComment(c, evidence, {
		stdoutTail: job.stdoutTail,
		stderrTail: job.stderrTail,
	});
	return {
		...job,
		artifactRefs: evidence.artifactRefs,
		artifactWriteStatus: artifactResult.status,
		artifactRowPersistence,
		evidence,
		workstationEvidencePersistence: persistence,
	};
}

/** Prepare the native body after registering its egress policy. */
export async function prepareWorkstationFast(
	c: {
		get: <K extends keyof AppEnv["Variables"]>(
			key: K,
		) => AppEnv["Variables"][K];
		set: <K extends keyof AppEnv["Variables"]>(
			key: K,
			value: AppEnv["Variables"][K],
		) => void;
	},
	preparation: WorkstationPreparation = "repository",
	phases: WorkstationRequestPhases = workstationRequestPhases(),
): Promise<WorkstationState> {
	const sandbox = c.get("sandbox");
	const tediConfig = c.get("tediConfig");
	// Registering egress policy is a DO-storage write and ordering is
	// LOAD-BEARING: a fresh container with no params is allow-ALL-public, so
	// the policy must be in storage before anything boots a body. It is cheap,
	// and it runs on every request for exactly that reason.
	await phases.time("prepare.egressPolicy", () =>
		ensureWorkstationEgressGuard(c),
	);
	await phases.time("prepare.egressGuardMarker", () =>
		writeWorkstationEgressGuardMarker(c),
	);
	await phases.time("prepare.bodyGeneration", () =>
		prepareWorkstationBodyGeneration(c),
	);
	await phases.time("prepare.bodyGenerationProof", () =>
		writeWorkstationBodyGenerationProof(c),
	);
	const exec = (command: string, options?: WorkstationExecOptions) =>
		execInRuntimeBody(c, command, options);
	await phases.time("prepare.mkdir", () =>
		exec(
			`mkdir -p ${WORKSTATION_DIR} ${WORKSTATION_REPOS_DIR} ${WORKSTATION_HOME}/.config/gh`,
			{ timeout: 5000 },
		),
	);
	const containerPlacementId = null;
	// Before anything can commit: the tedi commits as ITSELF. Sequential on
	// purpose — `git config --global` takes a lock on `~/.gitconfig`, and the
	// credential hydration below writes the same file.
	await phases.time("prepare.gitIdentity", () =>
		hydrateGitIdentity(sandbox, tediConfig),
	);
	const [hydratedCredentials, repoSync, tools] = await Promise.all([
		phases.time("prepare.githubCredentials", () =>
			hydrateGitHubCliCredentials(sandbox, tediConfig, {
				configDir: `${WORKSTATION_HOME}/.config/gh`,
				ghHostsPath: WORKSTATION_GH_HOSTS_PATH,
				gitCredentialsPath: WORKSTATION_GIT_CREDENTIALS_PATH,
			}),
		),
		preparation === "shell"
			? Promise.resolve<RepoSyncResult>({
					configured: false,
					strategy: ACTIVE_WORKSTATION_PROFILE.repoStrategy,
					status: "not_configured",
				})
			: phases.time("prepare.repoSyncStatus", () =>
					readRepoSyncStatus(sandbox, tediConfig, REPO_SYNC_OPTIONS),
				),
		phases.time("prepare.toolProbes", () => probeWorkstationTools(exec)),
	]);
	const credentials =
		hydratedCredentials.configured &&
		repoSync.configured &&
		repoSync.repoUrl &&
		repoSync.status === "failed"
			? {
					...hydratedCredentials,
					probe: await phases.time("prepare.githubCredentialProbe", () =>
						probeGitHubCliCredentials(
							sandbox,
							new URL(repoSync.repoUrl).pathname
								.replace(/^\/+|\/+$/g, "")
								.replace(/\.git$/, ""),
						),
					),
				}
			: hydratedCredentials;
	const toolsReady = Object.values(tools).every((tool) => tool.ok);
	return {
		preparation,
		containerPlacementId,
		credentials,
		repoSync,
		tools,
		toolsReady,
	};
}

export function scheduleRepoSync(c: Context<AppEnv>): void {
	const tediConfig = c.get("tediConfig");
	const key = tediConfig.id;
	if (repoSyncInFlight.has(key)) return;
	const task: Promise<void> = syncRepoIfConfigured(
		c.get("sandbox"),
		tediConfig,
		{
			...REPO_SYNC_OPTIONS,
			authorize: () => assertCheckoutAuthority(c),
		},
	)
		.then((result) => {
			if (result.configured && result.status === "failed") {
				console.warn(
					`[workstation] background repo sync failed for ${tediConfig.slug}:`,
					result.error ?? "repo sync failed",
				);
			}
		})
		.catch((err) => {
			const message = err instanceof Error ? err.message : String(err);
			console.warn(
				`[workstation] background repo sync failed for ${tediConfig.slug}:`,
				message,
			);
		})
		.finally(() => repoSyncInFlight.delete(key));
	repoSyncInFlight.set(key, task);
	try {
		c.executionCtx.waitUntil(task);
	} catch {
		// executionCtx not available in test environments — sync runs detached
	}
}

/**
 * Background self-bootstrap of workstation dependencies.
 *
 * The workstation previously never installed its own deps; it only
 * reported `nextAction:"start_install_process"` and waited for an external
 * caller to start a durable workstation job. Nobody reliably did, so the
 * dependency-cache chicken-and-egg never resolved (install never completes,
 * `ensureBootstrapDependencyCacheBackup` never seeds R2, every cold start is
 * `depsReady:false`). This launches the install itself, in the background,
 * deduped per tedi (mirrors {@link scheduleRepoSync}).
 *
 * Three layers keep it idempotent and safe:
 *  1. {@link bootstrapInstallInFlight} guards the same-isolate launch window.
 *  2. The OS-level `package_install` operation lock (woven by
 *     {@link buildJobCommand}) serializes installs across isolates/requests.
 *  3. The caller only invokes this when `installStatus === "missing"` (no job,
 *     not running), so a completed/failed/timed_out/stuck/canceled install is
 *     never auto-retried; those keep their explicit operator nextActions.
 *
 * `workstationStart` resolves once the execution is LAUNCHED (not when install
 * completes); the in-flight map therefore only guards the launch, while the OS
 * lock and the `installRunning` probe guard the rest.
 */
export function scheduleBootstrapInstall(
	c: Context<AppEnv>,
	input: {
		body: Record<string, unknown> | null;
		installProcessId: string;
		lockfile: string | null;
		lockfileHash: string;
		session?: WorkstationSessionSelection;
		workdir: string;
	},
): void {
	const tediConfig = c.get("tediConfig");
	const fallbackSession = workstationSessionSelection(
		tediConfig,
		input.body,
		"shell",
	);
	const session =
		input.session ?? (fallbackSession.ok ? fallbackSession.session : null);
	if (!session) return;
	const key = session.workstationId;
	if (bootstrapInstallInFlight.has(key)) return;
	// Back off after a launch FAILURE. If native dispatch itself rejects (bad body
	// state, duplicate-id rejection, resource limits), the wrapped command never
	// runs — so no job dir / no exit_code is written and the next readiness probe
	// still classifies installStatus as "missing", which would re-fire this launch
	// on every poll with no cooldown. The timestamp gate bounds that retry rate.
	const failedAt = bootstrapInstallLaunchFailedAt.get(key);
	if (
		failedAt !== undefined &&
		Date.now() - failedAt < WORKSTATION_BOOTSTRAP_INSTALL_LAUNCH_BACKOFF_MS
	) {
		return;
	}
	// Repo-presence guard: the caller's packageJson()
	// probe can pass on a warm FS and the job then run against a recycled cold
	// container whose fresh FUSE filesystem has no checkout yet — bun install
	// dies "ENOENT .../package.json" and that background failure fails the whole
	// delegated turn. Wait up to 2min for repo-sync to land the checkout, then
	// install; abort with a legible message (exit 90) if it never appears.
	const install = verifiedInstallCommandForLockfile(
		input.lockfile,
		input.lockfileHash,
	);
	const command = `i=0; while [ ! -f package.json ] && [ "$i" -lt 24 ]; do sleep 5; i=$((i+1)); done; if [ ! -f package.json ]; then echo 'bootstrap-install: repo checkout not present after 120s (repo-sync pending) — aborting install' >&2; exit 90; fi; ${install}`;
	const context = processContextFromBody(c, input.body, session, {
		kind: "package_install",
		source: "detected",
	});
	const { wrappedCommand, metadata } = buildJobCommand(
		input.installProcessId,
		command,
		input.workdir,
		context,
		WORKSTATION_BOOTSTRAP_INSTALL_TIMEOUT_MS,
		// Background dependency preparation must not hold the interactive shell
		// lock. The package_install operation lock still serializes installers.
		false,
	);
	const task: Promise<void> = startCheckoutOperation(c.get("sandbox"), {
		command: wrappedCommand,
		metadata,
		executionId: input.installProcessId,
		timeout: WORKSTATION_BOOTSTRAP_INSTALL_TIMEOUT_MS,
		mode: "shared",
		authorize: () => assertCheckoutAuthority(c),
	})
		.then(() => {
			// Launch succeeded — clear any prior failure backoff.
			bootstrapInstallLaunchFailedAt.delete(key);
		})
		.catch((err) => {
			// Record the launch failure so the backoff gate above throttles retries.
			bootstrapInstallLaunchFailedAt.set(key, Date.now());
			console.warn(
				`[workstation] background bootstrap install failed to start for ${tediConfig.slug}:`,
				err instanceof Error ? err.message : String(err),
			);
		})
		.finally(() => bootstrapInstallInFlight.delete(key));
	bootstrapInstallInFlight.set(key, task);
	try {
		c.executionCtx.waitUntil(task);
	} catch {
		// executionCtx not available in test environments; install runs detached.
	}
}

export async function prepareWorkstationFastSafe(
	c: {
		get: <K extends keyof AppEnv["Variables"]>(
			key: K,
		) => AppEnv["Variables"][K];
		set: <K extends keyof AppEnv["Variables"]>(
			key: K,
			value: AppEnv["Variables"][K],
		) => void;
	},
	preparation: WorkstationPreparation = "repository",
	phases: WorkstationRequestPhases = workstationRequestPhases(),
): Promise<WorkstationState> {
	try {
		return await prepareWorkstationFast(c, preparation, phases);
	} catch (error) {
		const message = errorMessage(error);
		// Computer owns replacement and reconnect. Destroying the sidecar here
		// races its native generation and can erase the checkout we are trying to
		// admit. Report a bounded blocked state; the next request re-enters
		// Computer's own readiness/recovery path.
		console.warn("[workstation] fast setup unavailable", message);
		return blockedSetupState(message);
	}
}

export function activeWorkstationSnapshot(
	tediConfig: TediConfig,
	state: WorkstationState | null,
	status: WorkstationStatus,
	readiness?: WorkstationBootstrapReadiness,
	workstationId?: string,
) {
	const metadata: Record<string, unknown> = {
		adapter: ACTIVE_WORKSTATION_BINDING.sessionAdapter,
		adapterKind: ACTIVE_WORKSTATION_BINDING.adapterKind,
		bodyAdapter: ACTIVE_WORKSTATION_BINDING.bodyAdapter,
		collaborationMode: "exclusive",
		// Durable record of the container placement observed on this probe. A
		// later probe observing a different id proves the platform replaced the
		// container (its repo tree, processes, and markers died with it) — see
		// observeContainerPlacement.
		containerPlacementId: state?.containerPlacementId ?? null,
		egressPolicy: workstationEgressPolicySummary(tediConfig),
		profileDefaultEnvironment:
			ACTIVE_WORKSTATION_BINDING.profile.defaultEnvironment,
		profileTitle: ACTIVE_WORKSTATION_BINDING.profile.title,
		repoStrategy:
			state?.repoSync.strategy ?? ACTIVE_WORKSTATION_PROFILE.repoStrategy,
		repoSyncStatus:
			state?.repoSync.status ??
			(tediConfig.repoConfig ? "pending" : "not_configured"),
		runtimeKind: tediConfig.runtimeKind ?? "agent",
		sandboxKind: ACTIVE_WORKSTATION_BINDING.adapterKind,
		workstationRoot: WORKSTATION_DIR,
		toolsReady: state?.toolsReady ?? false,
	};
	if (state) {
		metadata.credentials = state.credentials;
		metadata.repoSync = state.repoSync;
		metadata.tools = state.tools;
	}
	if (readiness) {
		metadata.bootstrapReadiness = readiness;
		metadata.environmentReady = readiness.environmentReady;
		metadata.depsReady = readiness.depsReady;
		metadata.installStatus = readiness.installStatus;
		metadata.repoReady = readiness.repoReady;
		metadata.secretsReady = readiness.secretsReady;
	}
	if (state?.setupError) {
		metadata.setupError = state.setupError;
	}
	return createWorkstationSnapshot({
		organizationId: tediConfig.organizationId,
		profileId: ACTIVE_WORKSTATION_BINDING.profile.id,
		seats: [
			{
				permissionScopes: [],
				role: "lead",
				slug: tediConfig.slug,
				tediId: tediConfig.id,
			},
		],
		status,
		workstationId,
		metadata,
	});
}

export function leaseStatusFromWorkstationStatus(
	status: WorkstationStatus,
): WorkstationLeaseStatus {
	if (status === "ready") return "active";
	if (status === "blocked") return "blocked";
	if (status === "degraded") return "degraded";
	if (status === "archived") return "released";
	return "provisioning";
}

export function workstationEnvelope(
	tediConfig: TediConfig,
	state: WorkstationState | null,
	status: WorkstationStatus,
	sessionKind: WorkstationSessionKind,
	input: {
		attemptId?: string | null;
		preparation?: WorkstationPreparation;
		executionId?: string | null;
		kernelRunId?: string | null;
		participantId?: string | null;
		readiness?: WorkstationBootstrapReadiness;
		session?: WorkstationSessionSelection;
		sessionId?: string | null;
		traceBundleId?: string | null;
		workItemId?: string | null;
	} = {},
) {
	const identity = activeWorkstationIdentity(
		tediConfig,
		input.executionId ?? input.workItemId ?? input.kernelRunId,
	);
	const snapshot = activeWorkstationSnapshot(
		tediConfig,
		state,
		status,
		input.readiness,
		identity.workstationId,
	);
	snapshot.metadata.preparation =
		input.preparation ??
		state?.preparation ??
		workstationPreparation(input.session);
	const selectedSession = input.session;
	if (selectedSession?.leaseBundle) {
		const now = new Date().toISOString();
		const existingWorkstation = selectedSession.leaseBundle.workstation;
		const existingLease = selectedSession.leaseBundle.workstationLease;
		const original = immutableLeasePreflight(existingLease);
		const observedRepo = snapshot.metadata.repoSync;
		if (
			original &&
			(!input.workItemId || input.workItemId === existingLease.workItemId) &&
			observedRepo &&
			typeof observedRepo === "object" &&
			!Array.isArray(observedRepo)
		) {
			snapshot.metadata.repoSync = {
				...observedRepo,
				treePreflight: toJsonRecord(original),
			};
		}

		const existingSession =
			existingLease.sessions.find(
				(session) => session.id === selectedSession.sessionId,
			) ?? null;
		const workstation: Workstation = {
			...existingWorkstation,
			status,
			metadata: {
				...existingWorkstation.metadata,
				...snapshot.metadata,
			},
		};
		const currentSession: WorkstationSession = {
			adapter: ACTIVE_WORKSTATION_BINDING.sessionAdapter,
			artifactRefs: existingSession?.artifactRefs ?? [],
			endedAt: status === "ready" ? null : now,
			externalId: existingSession?.externalId ?? null,
			id: selectedSession.sessionId,
			kind: selectedSession.sessionKind,
			leaseId: selectedSession.leaseId,
			metadata: existingSession?.metadata ?? {},
			organizationId: existingLease.organizationId,
			participantId: selectedSession.participantId,
			sessionKey: `${selectedSession.participantTediId}:${selectedSession.sessionKind}`,
			startedAt: existingSession?.startedAt ?? now,
			status,
		};
		const workstationLease: WorkstationLease = {
			...existingLease,
			metadata: { ...existingLease.metadata, ...snapshot.metadata },
			kernelRunId: input.kernelRunId ?? existingLease.kernelRunId,
			traceBundleId: input.traceBundleId ?? existingLease.traceBundleId,
			workItemId: input.workItemId ?? existingLease.workItemId,
			attemptId: input.attemptId ?? existingLease.attemptId,
			status: leaseStatusFromWorkstationStatus(status),
			// Operation receipts contain only the session touched by this request.
			// Historical sessions stay durable in D1 and are read through a bounded,
			// paginated history surface rather than replayed on every tool call.
			sessions: [currentSession],
			updatedAt: now,
		};
		return { workstation, workstationLease };
	}

	const workstation = snapshot;
	const sessionId =
		input.sessionId ??
		selectedSession?.sessionId ??
		(sessionKind === "shell"
			? identity.sessionId
			: `${workstation.id}_${sessionKind}`);
	const participantId =
		input.participantId ??
		selectedSession?.participantId ??
		identity.leadParticipantId;
	const lease = createWorkstationLease({
		kernelRunId: input.kernelRunId ?? null,
		leaseId: identity.leaseId,
		metadata: {
			...workstation.metadata,
			executionId: input.executionId ?? null,
		},
		organizationId: tediConfig.organizationId,
		profileId: ACTIVE_WORKSTATION_BINDING.profile.id,
		seats: workstation.seats,
		sessions: [
			{
				adapter: ACTIVE_WORKSTATION_BINDING.sessionAdapter,
				artifactRefs: [],
				endedAt: null,
				externalId: null,
				id: sessionId,
				kind: sessionKind,
				metadata: {},
				participantId,
				sessionKey: `${selectedSession?.participantTediId ?? tediConfig.id}:${sessionKind}`,
				status,
			},
		],
		status: leaseStatusFromWorkstationStatus(status),
		traceBundleId: input.traceBundleId ?? null,
		workItemId: input.workItemId ?? null,
		workstationId: workstation.id,
	});
	return {
		workstation,
		workstationLease: { ...lease, attemptId: input.attemptId ?? null },
	};
}

export async function persistentWorkstationEnvelope(
	c: Context<AppEnv>,
	state: WorkstationState | null,
	status: WorkstationStatus,
	sessionKind: WorkstationSessionKind,
	input: {
		attemptId?: string | null;
		bindRepositoryAuthority?: boolean;
		preparation?: WorkstationPreparation;
		executionId?: string | null;
		kernelRunId?: string | null;
		participantId?: string | null;
		readiness?: WorkstationBootstrapReadiness;
		session?: WorkstationSessionSelection;
		sessionId?: string | null;
		traceBundleId?: string | null;
		workItemId?: string | null;
	} = {},
): Promise<{
	workstation: Workstation;
	workstationLease: WorkstationLease;
	workstationPersistence: {
		error?: string;
		status: "failed" | "persisted" | "skipped";
	};
}> {
	const envelope = workstationEnvelope(
		c.get("tediConfig"),
		state,
		status,
		sessionKind,
		input,
	);
	if (!c.env.DB) {
		return {
			...envelope,
			workstationPersistence: { status: "skipped" },
		};
	}
	try {
		const persisted = await upsertWorkstationLeaseBundle(
			createDbClient(c.env.DB),
			envelope,
		);
		await persistWorkstationBodyGeneration(
			c,
			persisted.workstationLease.id,
			status,
		);
		const repo = state?.repoSync;
		const preflight = repo ? preparedPreflight({ repoSync: repo }) : null;
		const repositoryPath = (repo ? repoWorkdir(repo) : null)
			?.replace(/^\/home\/tedi\/workstation\/repos\//, "")
			.replace(/^\/workspace\/repos\//, "");
		const rowBundle = await getWorkstationLeaseRowBundle(
			createDbClient(c.env.DB),
			persisted.workstationLease.id,
		);
		if (
			input.bindRepositoryAuthority &&
			preflight?.authoritySource === "fresh_preparation" &&
			rowBundle?.workstationLease.attemptId &&
			rowBundle.workstationLease.orgId &&
			rowBundle.workstationLease.workItemId &&
			rowBundle.workstationLease.bodyGenerationId &&
			repositoryPath &&
			preflight.startSha &&
			repo &&
			repoReady(repo)
		) {
			await getAuthoritativeWorkItemAttempt(createDbClient(c.env.DB), {
				orgId: rowBundle.workstationLease.orgId,
				workItemId: rowBundle.workstationLease.workItemId,
				attemptId: rowBundle.workstationLease.attemptId,
				executor: { type: "tedi", id: c.get("tediConfig").id },
			});
			await bindWorkstationLeaseRepositoryAuthority(createDbClient(c.env.DB), {
				leaseId: persisted.workstationLease.id,
				orgId: rowBundle.workstationLease.orgId,
				workItemId: rowBundle.workstationLease.workItemId,
				attemptId: rowBundle.workstationLease.attemptId,
				generationId: rowBundle.workstationLease.bodyGenerationId,
				repositoryPath,
				repoStartSha: preflight.startSha,
				preparedStartSha: preflight.startSha,
			});
		}
		await persistWorkstationBodyInstance(c, persisted.workstationLease.id);
		return {
			...persisted,
			workstationPersistence: { status: "persisted" },
		};
	} catch (error) {
		const message = errorMessage(error);
		console.warn("[workstation] persistence failed", message);
		return {
			...envelope,
			workstationPersistence: { error: message, status: "failed" },
		};
	}
}

export async function persistWorkstationBodyGeneration(
	c: Context<AppEnv>,
	leaseId: string,
	status: WorkstationStatus,
): Promise<void> {
	const tediConfig = c.get("tediConfig");
	const generation =
		(await c
			.get("runtimeBodyLauncher")
			?.arm({ requireToken: true })
			.catch(() => null)) ?? null;
	const generationId =
		generation?.generationId ?? tediConfig.secrets?.TEDIX_BODY_GENERATION_ID;
	if (!(generationId && generation?.tokenHash)) return;
	if (typeof c.env.DB?.prepare !== "function") return;
	const runtimeSelection = c.get("workstationRuntimeSelection") ?? null;
	const leaseGenerationStatus =
		status === "ready" ? "ready" : status === "blocked" ? "failed" : "starting";
	const now = new Date().toISOString();
	await updateWorkstationLeaseBodyGeneration(createDbClient(c.env.DB), {
		leaseId,
		generationId,
		status: leaseGenerationStatus,
		tokenHash: generation.tokenHash,
		tokenExpiresAt: generation.tokenExpiresAt,
		externalId: runtimeSelection?.workstationId ?? tediConfig.id,
		heartbeatAt: now,
		updatedAt: now,
	});
}

/**
 * Stamp the resolved container body onto the lease.
 *
 * Deliberately separate from `persistWorkstationBodyGeneration`, which returns
 * early whenever a generation credential is absent. Container identity has
 * nothing to do with that credential, and a lease that could not be tied to its
 * instance is exactly the row that later strands a Running container nobody
 * dares stop.
 *
 * Failure is logged, never fatal: losing the join makes a container harder to
 * reap, while failing the request makes the workstation unusable.
 */
export async function persistWorkstationBodyInstance(
	c: Context<AppEnv>,
	leaseId: string,
): Promise<void> {
	const instance = c.get("workstationBodyInstance");
	if (!(instance && c.env.DB)) return;
	try {
		await recordWorkstationLeaseBodyInstance(createDbClient(c.env.DB), {
			instanceId: instance.id,
			instanceName: instance.name,
			leaseId,
			observedAt: new Date().toISOString(),
		});
	} catch (error) {
		console.warn(
			"[workstation] body instance identity not recorded",
			errorMessage(error),
		);
	}
}

export async function markWorkstationBodyStatus(
	c: Context<AppEnv>,
	status: WorkstationStatus,
): Promise<void> {
	const launcherStatus =
		status === "ready" ? "ready" : status === "blocked" ? "failed" : "starting";
	try {
		await c.get("runtimeBodyLauncher")?.status(launcherStatus);
	} catch (error) {
		console.warn(
			"[workstation] body generation status update failed",
			error instanceof Error ? error.message : error,
		);
	}
}

export const repoSyncInFlight = new Map<string, Promise<void>>();

/**
 * In-flight background bootstrap-install launches per workstation id. Guards the
 * same-isolate launch window so concurrent readiness probes don't each fire a
 * Computer execution for the install (the OS `package_install` lock + the
 * `installRunning` probe guard cross-isolate / post-launch). See
 * {@link scheduleBootstrapInstall}.
 */
export const bootstrapInstallInFlight = new Map<string, Promise<void>>();

/**
 * Last bootstrap-install LAUNCH failure time per workstation id. A failed Computer exec
 * writes no job dir, so the readiness probe keeps reporting installStatus
 * "missing"; this timestamp throttles the auto-start retry to once per
 * {@link WORKSTATION_BOOTSTRAP_INSTALL_LAUNCH_BACKOFF_MS}. Cleared on a successful
 * launch. See {@link scheduleBootstrapInstall}.
 */
export const bootstrapInstallLaunchFailedAt = new Map<string, number>();

export const REPO_SYNC_OPTIONS = {
	markerFile: ".git/tedix-workstation-repo.json",
	repoStrategy: ACTIVE_WORKSTATION_PROFILE.repoStrategy,
	reposRoot: WORKSTATION_REPOS_DIR,
	workdirSource: "derived",
} as const;

export function scheduleRepoSyncForExecution(
	c: Context<AppEnv>,
	state: WorkstationState,
): void {
	// Clone/fetch can legitimately outlive the request ceiling. Execution routes
	// must expose the probed `syncing` state and let the durable provisioning
	// loop poll `/wake`; they must never spend the caller's command budget waiting
	// for repository I/O. `scheduleRepoSync` deduplicates the background winner,
	// while repo-sync's durable failure marker makes errors visible on the next
	// probe. A ready checkout remains usable without an in-request fetch/pull.
	if (!state.setupError && state.repoSync.status === "syncing") {
		scheduleRepoSync(c);
	}
}
