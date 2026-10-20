import {
	type WorkstationBootstrapReadiness,
	type WorkstationStatus,
} from "@tedix/api-contract/schemas/workstation";
import { isWorkstationPath, WORKSTATION_DIR } from "../../../workstation/paths";
import type { Context } from "hono";
import type { AppEnv } from "../../../types";
import {
	workstationExecutionStatus,
	WorkstationDispatchUnknownError,
} from "../../../workstation/computer-body";
import { errorMessage } from "@tedix/worker-kit/error-message";
import { type RepoSyncResult } from "../../../workstation/repo-sync";
import {
	type WorkstationState,
	repoReady,
	WORKSTATION_BOOTSTRAP_INSTALL_PROCESS_ID,
	parseProcessId,
	type WorkstationSessionSelection,
	repoWorkdir,
	execInRuntimeBody,
	packageManagerForLockfile,
	bootstrapCacheKey,
	type WorkstationBootstrapCacheResult,
	WORKSTATION_BOOTSTRAP_CACHE_BACKUP_ENABLED,
	WORKSTATION_BOOTSTRAP_INSTALL_STUCK_MS,
} from "./shared";
import {
	bootstrapProbeCommand,
	parseBootstrapProbeOutput,
	installStatusFromProbe,
	ensureBootstrapInstallProcessId,
	verifiedInstallCommandForLockfile,
	installCommandForLockfile,
} from "./bootstrap-install";
import {
	restoreBootstrapDependencyCache,
	ensureBootstrapDependencyCacheBackup,
	readBootstrapDependencyCacheStatus,
} from "./bootstrap-cache";
import { readJobStatus } from "./process-runtime";
import { promoteWorkstationJobEvidence } from "./process-evidence";
import { scheduleBootstrapInstall } from "./prepare";

export function secretsReady(state: WorkstationState): boolean {
	if (!state.repoSync.configured) return true;
	return (
		state.credentials.configured &&
		state.credentials.status === "brokered" &&
		state.repoSync.status !== "skipped_credentials"
	);
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
