import {
	type WorkstationProfileId,
	type WorkstationSessionKind,
	type WorkstationOperationLock,
	type WorkstationSeatRole,
	type WorkstationPackageManager,
	type WorkstationCacheBackupStatus,
} from "@tedix/api-contract/schemas/workstation";
import { hydrateGitHubCliCredentials } from "../../../workstation/github-credentials";
import { type RepoSyncResult } from "../../../workstation/repo-sync";
import { workstationExec } from "../../../workstation/computer-body";
import type { AppEnv } from "../../../types";
import { type PushPublicationProof } from "../../../workstation/push-publication";
import { type WorkstationLeaseBundle } from "../../../workstation/persistence";
import type { DirectoryBackupRecord } from "@cloudflare/sandbox";
import {
	WORKSTATION_BOOTSTRAP_CACHE_RECORD_VERSION,
	WORKSTATION_BOOTSTRAP_CACHE_PROFILE_VERSION,
} from "./constants";

export type ToolProbe = {
	ok: boolean;
	version?: string;
	error?: string;
};

export type WorkstationPreparation = "shell" | "repository";

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
