/**
 * Durable workstation-provisioning reconcile engine.
 *
 * `open_computer` persists a lease receipt at the Tedi edge without
 * booting a Sandbox; the Agent DO then drives this reconcile-until-settled
 * loop inside a named durable fiber (`workstation-provisioning-attempt.ts`
 * owns the fiber identity/retry-key coordination). The DO keeps the fiber
 * wiring — `startFiber`, `onFiberRecovered`, fiber inspection — plus a thin
 * wrapper that resolves tedi identity; this module owns the checkpoint
 * shapes, the receipt/recovery parsers, the poll loop with its cache-backup
 * phase and repo-sync stall settlement, and the liveness probe. Deps are
 * injected (env + resolved identity) in the same ports-injected idiom as the
 * other DO-extracted siblings (`repo-commit-drain.ts`, `chat-turn-steps.ts`).
 */

import type { FiberRecoveryContext } from "agents";
import {
	execWorkstation,
	reconcileWorkstation,
	type WorkstationEnv,
	type WorkstationIdentity,
	type WorkstationRequestInput,
	type WorkstationStatusInput,
} from "./workstation";

export const WORKSTATION_PROVISION_RECONCILE_INTERVAL_MS = 5_000;
export const WORKSTATION_PROVISION_RECONCILE_TIMEOUT_MS = 30 * 60_000;
export const WORKSTATION_CACHE_BACKUP_TIMEOUT_MS = 15 * 60_000;
/** Consecutive polls allowed before a clone has a retained Computer exec. */
export const WORKSTATION_REPO_SYNC_ADMISSION_POLLS = 3;
/**
 * Consecutive polls confirming a terminal install before settling. A
 * failed/timed_out/canceled install is deliberately never auto-retried (the
 * edge scopes self-bootstrap to `installStatus === "missing"`), so the lease
 * can never become ready without operator action — two confirming polls
 * guard against one transient probe misread, nothing more.
 */
export const WORKSTATION_INSTALL_TERMINAL_POLLS = 2;

export type WorkstationProvisionSettleReason =
	| {
			kind: "repo_sync_not_admitted";
			consecutiveMissingPolls: number;
			probe: "alive" | "unreachable";
			probeDetail?: string;
	  }
	| {
			kind: "install_terminal";
			installStatus: string;
			lastBootstrapError: string | null;
	  };

export type WorkstationProvisioningCheckpoint = WorkstationStatusInput & {
	attempt: number;
	phase: "cache-backup" | "provision";
	startedAt: number;
	refreshId?: string;
	refreshReceipt?: Record<string, unknown>;
	/** Set when reconcile settled early instead of waiting out a stall. */
	settleReason?: WorkstationProvisionSettleReason;
};

/** Env + resolved tedi identity the DO wires into the reconcile loop. */
export interface WorkstationProvisioningDeps {
	env: WorkstationEnv;
	identity: WorkstationIdentity;
}

function unknownRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function workstationProvisioningStatusInput(
	receipt: unknown,
	request: WorkstationRequestInput,
): WorkstationStatusInput | null {
	const record = unknownRecord(receipt);
	if (record?.accepted !== true || record.ok === false) return null;
	const lease = unknownRecord(record.workstationLease);
	const workstation = unknownRecord(record.workstation);
	const leaseId =
		typeof record.leaseId === "string"
			? record.leaseId
			: typeof lease?.id === "string"
				? lease.id
				: null;
	if (!leaseId) return null;
	const workstationId =
		typeof record.workstationId === "string"
			? record.workstationId
			: typeof workstation?.id === "string"
				? workstation.id
				: undefined;
	return {
		kernelRunId: request.kernelRunId,
		leaseId,
		traceBundleId: request.traceBundleId,
		workItemId: request.workItemId,
		workstationId,
	};
}

export function workstationProvisioningRecoveryInput(
	ctx: FiberRecoveryContext,
): WorkstationProvisioningCheckpoint | null {
	const snapshot = unknownRecord(ctx.snapshot);
	const leaseId = snapshot?.leaseId;
	if (typeof leaseId !== "string" || !leaseId) return null;
	return {
		refreshId:
			typeof snapshot.refreshId === "string" ? snapshot.refreshId : undefined,
		refreshReceipt: unknownRecord(snapshot.refreshReceipt) ?? undefined,
		attempt:
			typeof snapshot.attempt === "number" &&
			Number.isInteger(snapshot.attempt) &&
			snapshot.attempt >= 0
				? snapshot.attempt
				: 0,
		kernelRunId:
			typeof snapshot.kernelRunId === "string"
				? snapshot.kernelRunId
				: undefined,
		leaseId,
		phase: snapshot?.phase === "cache-backup" ? "cache-backup" : "provision",
		startedAt:
			typeof snapshot.startedAt === "number" &&
			Number.isFinite(snapshot.startedAt)
				? snapshot.startedAt
				: ctx.createdAt,
		traceBundleId:
			typeof snapshot.traceBundleId === "string"
				? snapshot.traceBundleId
				: undefined,
		traceId:
			typeof snapshot.traceId === "string" ? snapshot.traceId : undefined,
		workItemId:
			typeof snapshot.workItemId === "string" ? snapshot.workItemId : undefined,
		workstationId:
			typeof snapshot.workstationId === "string"
				? snapshot.workstationId
				: undefined,
	};
}

export async function waitForWorkstationReconcile(
	ms: number,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	await new Promise<void>((resolve, reject) => {
		let onAbort: (() => void) | undefined;
		const timer = setTimeout(() => {
			if (onAbort) signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		if (!signal) return;
		onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export async function reconcileWorkstationUntilSettled(
	deps: WorkstationProvisioningDeps,
	input: WorkstationStatusInput | WorkstationProvisioningCheckpoint,
	options: {
		checkpoint: (value: WorkstationProvisioningCheckpoint) => void;
		signal?: AbortSignal;
	},
): Promise<WorkstationProvisioningCheckpoint> {
	const startedAt = "startedAt" in input ? input.startedAt : Date.now();
	let attempt = "attempt" in input ? input.attempt : 0;
	let phase = "phase" in input ? input.phase : "provision";
	let consecutiveMissingRepoExecutions = 0;
	let consecutiveTerminalInstallPolls = 0;

	while (true) {
		const checkpoint: WorkstationProvisioningCheckpoint = {
			...input,
			attempt,
			phase,
			startedAt,
		};
		options.checkpoint(checkpoint);
		const result = await reconcileWorkstation(
			deps.env,
			deps.identity,
			{
				...checkpoint,
				cacheBackupMode: phase === "cache-backup" ? "synchronous" : undefined,
			},
			phase === "cache-backup"
				? { timeoutMs: WORKSTATION_CACHE_BACKUP_TIMEOUT_MS }
				: undefined,
		);
		const record = unknownRecord(result);
		if (record?.ok === false) {
			if (phase === "cache-backup") {
				console.warn(
					"[workstation] fail-soft dependency cache phase did not complete",
					typeof record.error === "string" ? record.error : "unknown error",
				);
				const settled = { ...checkpoint, attempt: attempt + 1 };
				options.checkpoint(settled);
				return settled;
			}
			throw new Error(
				typeof record.error === "string"
					? record.error
					: "Workstation provisioning reconciliation failed",
			);
		}
		const persistence = unknownRecord(record?.workstationPersistence);
		if (persistence?.status !== "persisted") {
			if (phase === "cache-backup") {
				console.warn(
					"[workstation] fail-soft dependency cache persistence did not complete",
					typeof persistence?.error === "string"
						? persistence.error
						: "unknown error",
				);
				const settled = { ...checkpoint, attempt: attempt + 1 };
				options.checkpoint(settled);
				return settled;
			}
			throw new Error(
				typeof persistence?.error === "string"
					? `Workstation provisioning persistence failed: ${persistence.error}`
					: "Workstation provisioning did not persist its reconciliation result",
			);
		}
		if (checkpoint.refreshId) {
			checkpoint.refreshReceipt = workstationRefreshReceipt(record ?? {});
			options.checkpoint(checkpoint);
		}
		const workstation = unknownRecord(record?.workstation);
		const bootstrap = unknownRecord(record?.bootstrap);
		const status = workstation?.status;
		if (
			!checkpoint.refreshId &&
			phase === "provision" &&
			(record?.ready === true || status === "ready") &&
			bootstrap?.cacheBackupStatus === "pending"
		) {
			phase = "cache-backup";
			attempt += 1;
			continue;
		}
		if (
			record?.ready === true ||
			status === "ready" ||
			(status === "blocked" &&
				bootstrap?.nextAction !== "wait_for_repo_sync") ||
			status === "archived"
		) {
			const settled = { ...checkpoint, attempt: attempt + 1 };
			options.checkpoint(settled);
			return settled;
		}
		// Terminal install: the edge never auto-retries a failed/timed_out/
		// canceled install (self-bootstrap is scoped to "missing"), so once the
		// probe confirms one, no amount of polling makes this lease ready.
		// Without this settle the loop burned its full 30-minute ceiling and the
		// fiber ended in `error` — a state the successor predicate ignores — so
		// the lease sat `degraded`/`starting` forever with no legible outcome.
		const installStatus = bootstrap?.installStatus;
		if (
			phase === "provision" &&
			(installStatus === "failed" ||
				installStatus === "timed_out" ||
				installStatus === "canceled")
		) {
			consecutiveTerminalInstallPolls += 1;
			if (
				consecutiveTerminalInstallPolls >= WORKSTATION_INSTALL_TERMINAL_POLLS
			) {
				const settled: WorkstationProvisioningCheckpoint = {
					...checkpoint,
					attempt: attempt + 1,
					settleReason: {
						kind: "install_terminal",
						installStatus,
						lastBootstrapError:
							typeof bootstrap?.lastBootstrapError === "string"
								? bootstrap.lastBootstrapError
								: null,
					},
				};
				console.warn(
					"[workstation] provisioning settled on a terminal install — operator action required",
					{
						installStatus,
						lastBootstrapError: bootstrap?.lastBootstrapError ?? null,
						leaseId: checkpoint.leaseId,
						workstationId: checkpoint.workstationId ?? null,
					},
				);
				options.checkpoint(settled);
				return settled;
			}
		} else {
			consecutiveTerminalInstallPolls = 0;
		}
		if (
			status === "blocked" &&
			bootstrap?.nextAction === "wait_for_repo_sync"
		) {
			const repoSync = unknownRecord(record?.repoSync);
			const executionState = repoSync?.executionState;
			if (
				executionState === "admitting" ||
				executionState === "running" ||
				executionState === "terminal"
			) {
				consecutiveMissingRepoExecutions = 0;
			} else {
				consecutiveMissingRepoExecutions += 1;
			}
			if (
				consecutiveMissingRepoExecutions >=
				WORKSTATION_REPO_SYNC_ADMISSION_POLLS
			) {
				const probe = await probeWorkstationLiveness(deps, checkpoint);
				const settled: WorkstationProvisioningCheckpoint = {
					...checkpoint,
					attempt: attempt + 1,
					settleReason: {
						kind: "repo_sync_not_admitted",
						consecutiveMissingPolls: consecutiveMissingRepoExecutions,
						...probe,
					},
				};
				console.warn(
					"[workstation] repo clone was not admitted to Computer's retained execution registry",
					{
						consecutiveMissingPolls: consecutiveMissingRepoExecutions,
						leaseId: checkpoint.leaseId,
						probe: probe.probe,
						probeDetail: probe.probeDetail ?? null,
						workstationId: checkpoint.workstationId ?? null,
					},
				);
				options.checkpoint(settled);
				return settled;
			}
		} else {
			consecutiveMissingRepoExecutions = 0;
		}
		if (Date.now() - startedAt >= WORKSTATION_PROVISION_RECONCILE_TIMEOUT_MS) {
			throw new Error(
				`Workstation provisioning did not settle within ${WORKSTATION_PROVISION_RECONCILE_TIMEOUT_MS}ms`,
			);
		}
		attempt += 1;
		await waitForWorkstationReconcile(
			WORKSTATION_PROVISION_RECONCILE_INTERVAL_MS,
			options.signal,
		);
	}
}

/**
 * Bounded liveness probe for a lease stuck in `wait_for_repo_sync`: proves
 * whether the container still executes commands at all (and what the repos
 * dir contains) so the stall settle reason distinguishes a dead container
 * from a stuck sync. Deliberately raw `execWorkstation` — not the DO's
 * `execWorkstationTool` — so a diagnostic probe never records turn-bound
 * run evidence. Fail-soft: never throws.
 */
async function probeWorkstationLiveness(
	deps: WorkstationProvisioningDeps,
	input: WorkstationStatusInput,
): Promise<{ probe: "alive" | "unreachable"; probeDetail?: string }> {
	try {
		const result = await execWorkstation(
			deps.env,
			deps.identity,
			{
				command:
					"echo tedix-repo-sync-probe && ls /home/tedi/workstation/repos",
				leaseId: input.leaseId,
				timeoutMs: 20_000,
				workstationId: input.workstationId,
			},
			{ timeoutMs: 25_000 },
		);
		const record = unknownRecord(result);
		if (record?.ok === false) {
			return {
				probe: "unreachable",
				probeDetail:
					typeof record.error === "string"
						? record.error.slice(0, 300)
						: "exec failed",
			};
		}
		const stdout =
			typeof record?.stdout === "string" ? record.stdout.trim() : "";
		return {
			probe: "alive",
			...(stdout ? { probeDetail: stdout.slice(0, 300) } : {}),
		};
	} catch (error) {
		return {
			probe: "unreachable",
			probeDetail:
				error instanceof Error
					? error.message.slice(0, 300)
					: String(error).slice(0, 300),
		};
	}
}

/** Only readiness and repository identity cross the retained fiber boundary. */
function workstationRefreshReceipt(
	value: Record<string, unknown>,
): Record<string, unknown> {
	const pick = (v: unknown, keys: string[]) => {
		const r = unknownRecord(v) ?? {};
		return Object.fromEntries(
			keys.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]),
		);
	};
	const repo = unknownRecord(value.repoSync);
	return {
		...pick(value, ["ok", "ready", "status", "error", "setupError"]),
		observedAt: new Date().toISOString(),
		readiness: pick(value.readiness ?? value.bootstrap, [
			"toolsReady",
			"repoReady",
		]),
		bootstrap: pick(value.bootstrap, ["nextAction", "lastBootstrapError"]),
		repoSync: {
			...pick(repo, [
				"configured",
				"status",
				"workdir",
				"error",
				"executionState",
				"executionId",
			]),
			treePreflight: pick(repo?.treePreflight, ["startSha"]),
		},
		workstationLease: pick(value.workstationLease, ["id", "status"]),
	};
}
