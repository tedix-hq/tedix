import {
	type WorkstationPackageManager,
	createWorkstationEpisodeIds,
	createWorkstationLease,
} from "@tedix/api-contract/schemas/workstation";
import { WORKSTATION_DIR, WORKSTATION_HOME } from "../../../workstation/paths";
import { WORKSTATION_EGRESS_GUARD_VERSION } from "../../../workstation/egress-guard";
import { type RepoSyncResult } from "../../../workstation/repo-sync";
import {
	workstationExec,
	type WorkstationExecResult,
	WorkstationDispatchUnknownError,
	withWorkstationObservationDeadline,
	WorkstationObservationTimeoutError,
} from "../../../workstation/computer-body";
import type { AppEnv, TediConfig } from "../../../types";
import { getWorkstationLeaseBundle } from "../../../workstation/persistence";
import type { Context } from "hono";
import { createDbClient } from "@tedix/db/client";
import { startCheckoutOperation } from "../../../workstation/checkout-lock";
import {
	type RuntimeBodyGeneration,
	attachBodyGenerationSecrets,
} from "../../../runtime/generation";
import { createWorkstationOutboundHandlerParams } from "../../../runtime/workstation-egress";
import {
	WORKSTATION_HEADER,
	ACTIVE_WORKSTATION_PROFILE_ID,
	ACTIVE_WORKSTATION_PROFILE,
	WORKSTATION_JOBS_DIR,
	WORKSTATION_BOOTSTRAP_PACKAGE_CACHE_DIR,
	WORKSTATION_BOOTSTRAP_CACHE_PROFILE_VERSION,
	WORKSTATION_PATHS,
	WORKSTATION_EGRESS_GUARD_MARKER,
	WORKSTATION_EGRESS_GUARD_BOOT_TIMEOUT_MS,
} from "./constants";
import type {
	WorkstationPreparation,
	WorkstationState,
	WorkstationExecOptions,
	ProofWritingLauncher,
	WorkstationSessionSelection,
} from "./types";

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

export function workstationPreparation(
	session?: WorkstationSessionSelection,
): WorkstationPreparation {
	return session?.leaseBundle?.workstation.metadata.preparation === "shell"
		? "shell"
		: "repository";
}

export function workstationErrorStatus(
	status: number | undefined,
): 400 | 403 | 404 | 503 {
	if (status === 403) return 403;
	if (status === 404) return 404;
	if (status === 503) return 503;
	return 400;
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
