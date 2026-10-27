import {
	type WorkstationProfileId,
	type WorkstationAdapter,
	getWorkstationProfile,
	type WorkstationSessionKind,
	type WorkstationOperationLock,
	type WorkstationSeatRole,
	type WorkstationPackageManager,
	type WorkstationCacheBackupStatus,
	createWorkstationEpisodeIds,
	createWorkstationLease,
} from "@tedix/api-contract/schemas/workstation";
import {
	WORKSTATION_DIR,
	WORKSTATION_HOME,
	WORKSTATION_REPOS_DIR,
} from "../../../workstation/paths";
import { WORKSTATION_EGRESS_GUARD_VERSION } from "../../../workstation/egress-guard";
import { hydrateGitHubCliCredentials } from "../../../workstation/github-credentials";
import { type RepoSyncResult } from "../../../workstation/repo-sync";
import {
	workstationExec,
	type WorkstationExecResult,
	WorkstationDispatchUnknownError,
	withWorkstationObservationDeadline,
	WorkstationObservationTimeoutError,
} from "../../../workstation/computer-body";
import type { AppEnv, TediConfig } from "../../../types";
import { type PushPublicationProof } from "../../../workstation/push-publication";
import {
	type WorkstationLeaseBundle,
	getWorkstationLeaseBundle,
} from "../../../workstation/persistence";
import type { DirectoryBackupRecord } from "@cloudflare/sandbox";
import { tracing } from "cloudflare:workers";
import type { Context } from "hono";
import { createDbClient } from "@tedix/db/client";
import { startCheckoutOperation } from "../../../workstation/checkout-lock";
import {
	type RuntimeBodyGeneration,
	attachBodyGenerationSecrets,
} from "../../../runtime/body-launcher";
import { createWorkstationOutboundHandlerParams } from "../../../runtime/workstation-egress";

export const WORKSTATION_HEADER = "X-Tedix-Workstation";
export const WORKSTATION_CONVERSATION_HEADER =
	"X-Tedix-Workstation-Conversation-Id";
export const WORKSTATION_RUN_HEADER = "X-Tedix-Workstation-Run-Id";

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
	/** Opaque filesystem marker that changes when Computer replaces the container. */
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

export function repoWorkdir(repoSync: RepoSyncResult): string | null {
	return repoSync.configured && repoSync.workdir ? repoSync.workdir : null;
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

export function jobPaths(processId: string) {
	const logDir = `${WORKSTATION_JOBS_DIR}/${processId}`;
	return {
		logDir,
		stderrPath: `${logDir}/stderr.log`,
		stdoutPath: `${logDir}/stdout.log`,
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

export function stringBodyValue(
	body: Record<string, unknown> | null,
	key: string,
): string | null {
	const value = body?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function r2PrefixForTedi(c: Context<AppEnv>): string {
	const configured = c.get("r2Prefix");
	if (typeof configured === "string" && configured) return configured;
	const tediConfig = c.get("tediConfig");
	return tediConfig.organizationId
		? `orgs/${tediConfig.organizationId}/tedis/${tediConfig.id}`
		: `tedis/${tediConfig.id}`;
}

export const REPO_SYNC_OPTIONS = {
	markerFile: ".git/tedix-workstation-repo.json",
	repoStrategy: ACTIVE_WORKSTATION_PROFILE.repoStrategy,
	reposRoot: WORKSTATION_REPOS_DIR,
	workdirSource: "derived",
} as const;
