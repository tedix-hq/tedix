import type { AppEnv } from "../../../types";
import {
	WORKSTATION_DIR,
	WORKSTATION_REPOS_DIR,
	WORKSTATION_HOME,
	WORKSTATION_GH_HOSTS_PATH,
	WORKSTATION_GIT_CREDENTIALS_PATH,
} from "../../../workstation/paths";
import {
	hydrateGitIdentity,
	hydrateGitHubCliCredentials,
	probeGitHubCliCredentials,
} from "../../../workstation/github-credentials";
import {
	type RepoSyncResult,
	readRepoSyncStatus,
	syncRepoIfConfigured,
} from "../../../workstation/repo-sync";
import type { Context } from "hono";
import { startCheckoutOperation } from "../../../workstation/checkout-lock";
import { errorMessage } from "@tedix/worker-kit/error-message";
import {
	type WorkstationPreparation,
	type WorkstationRequestPhases,
	type WorkstationState,
	type WorkstationExecOptions,
	type WorkstationSessionSelection,
} from "./types";
import { workstationRequestPhases } from "./timings";
import {
	ensureWorkstationEgressGuard,
	writeWorkstationEgressGuardMarker,
	prepareWorkstationBodyGeneration,
	writeWorkstationBodyGenerationProof,
	execInRuntimeBody,
	assertCheckoutAuthority,
	blockedSetupState,
	repoReady,
	shellSingleQuote,
} from "./shared";
import {
	ACTIVE_WORKSTATION_PROFILE,
	REPO_SYNC_OPTIONS,
	WORKSTATION_BOOTSTRAP_INSTALL_LAUNCH_BACKOFF_MS,
	WORKSTATION_BOOTSTRAP_INSTALL_TIMEOUT_MS,
} from "./constants";
import {
	probeWorkstationTools,
	workstationSessionSelection,
	processContextFromBody,
	buildJobCommand,
} from "./process-runtime";
import {
	repoSyncInFlight,
	bootstrapInstallInFlight,
	bootstrapInstallLaunchFailedAt,
} from "./in-flight";
import { verifiedInstallCommandForLockfile } from "./bootstrap-install";

const WORKSTATION_PLACEMENT_MARKER = `${WORKSTATION_HOME}/.tedix-container-placement`;
const READINESS_CACHE_MAX_ENTRIES = 32;

type ReadinessCacheEntry = {
	bodyGenerationKey: string;
	containerPlacementId: string;
	preparation: WorkstationPreparation;
	repoConfig: string;
	repoFingerprint: string;
	repoSync: RepoSyncResult;
	tools: WorkstationState["tools"];
};

const readinessCache = new Map<string, ReadinessCacheEntry>();

export function clearWorkstationReadinessCache(): void {
	readinessCache.clear();
}

function readinessCacheKey(c: {
	get: <K extends keyof AppEnv["Variables"]>(key: K) => AppEnv["Variables"][K];
}): string {
	const config = c.get("tediConfig");
	return `${config.id}:${c.get("workstationRuntimeSelection")?.workstationId ?? c.get("workstationBodyInstance")?.name ?? "default"}`;
}

function repoConfigKey(config: AppEnv["Variables"]["tediConfig"]): string {
	return JSON.stringify(config.repoConfig ?? null);
}

function configuredRepoWorkdir(
	config: AppEnv["Variables"]["tediConfig"],
): string | null {
	if (!config.repoConfig?.repoUrl) return null;
	try {
		const parts = new URL(config.repoConfig.repoUrl).pathname
			.replace(/^\/+|\/+$/g, "")
			.replace(/\.git$/i, "")
			.split("/")
			.filter(Boolean);
		const owner = parts.at(-2);
		const repo = parts.at(-1);
		if (
			!owner ||
			!repo ||
			!/^[A-Za-z0-9._-]+$/.test(owner) ||
			!/^[A-Za-z0-9._-]+$/.test(repo)
		) {
			return null;
		}
		return `${WORKSTATION_REPOS_DIR}/${owner}/${repo}`;
	} catch {
		return null;
	}
}

function cacheReadiness(key: string, entry: ReadinessCacheEntry): void {
	readinessCache.delete(key);
	readinessCache.set(key, entry);
	if (readinessCache.size > READINESS_CACHE_MAX_ENTRIES) {
		const oldest = readinessCache.keys().next().value;
		if (oldest) readinessCache.delete(oldest);
	}
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
	const bodyGeneration = await phases.time("prepare.bodyGeneration", () =>
		prepareWorkstationBodyGeneration(c),
	);
	await phases.time("prepare.bodyGenerationProof", () =>
		writeWorkstationBodyGenerationProof(c),
	);
	const exec = (command: string, options?: WorkstationExecOptions) =>
		execInRuntimeBody(c, command, options);
	const repoWorkdir = configuredRepoWorkdir(tediConfig);
	const placement = await phases.time("prepare.mkdir", () =>
		exec(
			`set -eu; mkdir -p ${WORKSTATION_DIR} ${WORKSTATION_REPOS_DIR} ${WORKSTATION_HOME}/.config/gh; marker=${shellSingleQuote(WORKSTATION_PLACEMENT_MARKER)}; if [ ! -s "$marker" ]; then cat /proc/sys/kernel/random/uuid > "$marker"; fi; printf 'placement=%s\\n' "$(cat "$marker")"; ${repoWorkdir ? `printf 'repo=%s:%s\\n' "$(git -C ${shellSingleQuote(repoWorkdir)} rev-parse HEAD 2>/dev/null || true)" "$(cksum ${shellSingleQuote(`${repoWorkdir}.sync-process.json`)} 2>/dev/null | cut -d ' ' -f 1,2 || true)"` : "printf 'repo=\\n'"}`,
			{ timeout: 5000 },
		),
	);
	const observations = Object.fromEntries(
		placement.stdout
			.split(/\r?\n/)
			.map((line) => line.split("=", 2))
			.filter((pair): pair is [string, string] => pair.length === 2),
	);
	const containerPlacementId = observations.placement || null;
	const repoFingerprint = observations.repo ?? "";
	const bodyGenerationKey = bodyGeneration
		? `${bodyGeneration.generationId}:${bodyGeneration.tokenHash}`
		: null;
	const cacheKey = readinessCacheKey(c);
	const cached = readinessCache.get(cacheKey);
	const reusable =
		cached &&
		bodyGenerationKey &&
		containerPlacementId &&
		cached.bodyGenerationKey === bodyGenerationKey &&
		cached.containerPlacementId === containerPlacementId &&
		cached.preparation === preparation &&
		cached.repoConfig === repoConfigKey(tediConfig) &&
		cached.repoFingerprint === repoFingerprint
			? cached
			: null;
	// Before anything can commit: the tedi commits as ITSELF. Sequential on
	// purpose — `git config --global` takes a lock on `~/.gitconfig`, and the
	// credential hydration below writes the same file.
	await phases.time("prepare.gitIdentity", () =>
		hydrateGitIdentity(sandbox, tediConfig),
	);
	const [hydratedCredentials, readiness] = await Promise.all([
		phases.time("prepare.githubCredentials", () =>
			hydrateGitHubCliCredentials(sandbox, tediConfig, {
				configDir: `${WORKSTATION_HOME}/.config/gh`,
				ghHostsPath: WORKSTATION_GH_HOSTS_PATH,
				gitCredentialsPath: WORKSTATION_GIT_CREDENTIALS_PATH,
			}),
		),
		reusable
			? phases.time("prepare.readinessCacheHit", async () => ({
					repoSync: reusable.repoSync,
					tools: reusable.tools,
				}))
			: Promise.all([
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
				]).then(([repoSync, tools]) => ({ repoSync, tools })),
	]);
	const { repoSync, tools } = readiness;
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
	if (
		!reusable &&
		bodyGenerationKey &&
		containerPlacementId &&
		toolsReady &&
		(!repoSync.configured || repoReady(repoSync))
	) {
		cacheReadiness(cacheKey, {
			bodyGenerationKey,
			containerPlacementId,
			preparation,
			repoConfig: repoConfigKey(tediConfig),
			repoFingerprint,
			repoSync,
			tools,
		});
	}
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
	readinessCache.delete(readinessCacheKey(c));
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
