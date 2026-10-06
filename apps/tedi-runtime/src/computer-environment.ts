import { workstationPreparationObservation } from "./workstation-provisioning-attempt";
import {
	AcquisitionDeadline,
	REPOSITORY_STARTING_INSTRUCTION,
	ComputerAcquisitionDeadline,
	beginComputerAcquisition,
	confirmComputerAcquisition,
	replaceComputerAcquisition,
	computerAcquisitionKey,
	withAcquisitionLock,
	type AcquisitionWorkAuthority,
	type ComputerAcquisition,
} from "./computer-acquisition";
import {
	COMPUTER_EXECUTION_STREAM_CHARS,
	computerExecutionModelOutput,
} from "./computer-execution-model-output";
import {
	buildCodeSearchCommand,
	CODE_SEARCH_TOOL_DESCRIPTION,
	codeSearchInputSchema,
	codeSearchResult,
	normalizeCodeSearchInput,
	parseCodeSearchOutput,
	shellQuote,
	type CodeSearchInput,
} from "./computer-code-search";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { createPatch } from "diff";
import type { DurableCodeWorkspace } from "./durable-codemode";
import { recordToolRead, refuseStaleWrite } from "./read-evidence";

export interface ComputerEnvironment {
	leaseId: string;
	workstationId?: string;
	cwd: string;
	preparation: "shell" | "repository";
	ready: boolean;
	checkedAt?: number;
	/** When this task acquired the lease; how long a cold start has had. */
	openedAt?: number;
	/** One bounded preparation window after a previously ready native body is revalidated. */
	revalidationStartedAt?: number;
	/** Stable within this acquisition until native refresh has proved ready. */
	revalidationId?: string;
}
interface Store {
	get<T>(key: string): Promise<T | undefined>;
	put<T>(key: string, value: T): Promise<unknown>;
	delete(key: string): Promise<unknown>;
}
interface Actions {
	open(
		preparation: ComputerEnvironment["preparation"],
		executionId: string,
		work: AcquisitionWorkAuthority | null,
		confirmed?: (receipt: unknown) => Promise<void>,
	): Promise<unknown>;
	close(environment: ComputerEnvironment): Promise<unknown>;
	status(
		environment: ComputerEnvironment,
		timeoutMs?: number,
		/** Existing selections need active same-lease reconciliation, not old D1 readiness. */
		refreshNative?: boolean,
	): Promise<unknown>;
	files(
		environment: ComputerEnvironment,
		operation: string,
		input: Record<string, unknown>,
	): Promise<unknown>;
	start(
		environment: ComputerEnvironment,
		input: {
			command: string;
			cwd: string;
			processId: string;
			timeoutMs?: number;
		},
	): Promise<unknown>;
	read(environment: ComputerEnvironment, id: string): Promise<unknown>;
	wait(
		environment: ComputerEnvironment,
		id: string,
		timeoutMs: number,
	): Promise<unknown>;
	cancel(environment: ComputerEnvironment, id: string): Promise<unknown>;
}
/**
 * The runtime retains ownership before dispatch, schedules a notification only
 * after detachment, and acknowledges terminal collection.
 *
 * The controller deliberately knows nothing about turns, schedules or
 * workflows: the Durable Object owns retention and the durable watcher
 * that turns a completion into a wake
 * (`computer-execution-wake.ts`). `collected` fires whenever the model already
 * holds the terminal receipt, so the watcher never delivers a notification for
 * something the model has just read.
 */
export interface DetachedExecutionWatch {
	/** Persist cleanup protection before native dispatch; do not notify yet. */
	retained?(execution: {
		executionId: string;
		command: string;
		environment: ComputerEnvironment;
	}): Promise<unknown>;
	detached(execution: {
		executionId: string;
		command: string;
		environment: ComputerEnvironment;
	}): Promise<unknown>;
	collected(executionId: string): Promise<unknown>;
}

const record = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

function safeGitHubCredentialStatus(
	value: unknown,
): Record<string, unknown> | undefined {
	const credentials = record(value);
	if (typeof credentials.configured !== "boolean") return;
	const status = credentials.status;
	if (status !== "missing" && status !== "brokered") return;
	const result: Record<string, unknown> = {
		configured: credentials.configured,
		status,
	};
	const probe = record(credentials.probe);
	if (
		probe.status !== "valid" &&
		probe.status !== "invalid" &&
		probe.status !== "rate_limited" &&
		probe.status !== "forbidden" &&
		probe.status !== "unavailable"
	)
		return result;
	const safeProbe: Record<string, unknown> = { status: probe.status };
	if (typeof probe.httpStatus === "number")
		safeProbe.httpStatus = probe.httpStatus;
	const headers = record(probe.responseHeaders);
	const safeHeaders = Object.fromEntries(
		[
			"retry-after",
			"server",
			"x-github-request-id",
			"x-ratelimit-limit",
			"x-ratelimit-remaining",
			"x-ratelimit-reset",
		]
			.filter((name) => typeof headers[name] === "string")
			.map((name) => [name, headers[name]]),
	);
	if (Object.keys(safeHeaders).length) safeProbe.responseHeaders = safeHeaders;
	result.probe = safeProbe;
	return result;
}
/**
 * Where a round trip actually went.
 *
 * Every receipt this file hands the model carries one, on every path: starting
 * a command, detaching from it, collecting it later, and cancelling it. That
 * completeness is the point. The last attempt to optimize this layer measured
 * nothing, because the only instrumented paths were the three exec exits — a
 * command collected by `read_execution` an hour later was structurally
 * unmeasurable, and so was the cost of collecting it.
 *
 * `dispatchMs`, `waitMs` and `readMs` are measured HERE, by the Durable
 * Object, and `totalMs` is their sum rather than a separate clock, so the parts
 * always add up to the whole. `containerWaitedMs` is the only number the
 * CONTAINER measured, carried through unchanged; the gap between it and
 * `waitMs` is the transport, which is exactly the thing a DO-side clock alone
 * cannot separate.
 */
export interface ExecRoundTrip {
	/**
	 * The request that precedes the wait: on exec, entering the tool until the
	 * workstation acknowledges the started command; on a collection, the first
	 * status read or the cancel.
	 */
	dispatchMs: number;
	/**
	 * The waiting segment as the DO measures it: on exec, the single
	 * container-side wait; on a collection, the bounded idle plus its refresh
	 * read, and 0 when the first read was already terminal.
	 */
	waitMs: number;
	/** Turning the result into the receipt handed to the model. */
	readMs: number;
	/**
	 * What the container itself reports having waited, when it reports one. It
	 * is absent whenever no container answered — a request that hit the
	 * transport deadline never reached one, and the budget it echoes back is not
	 * a measurement of anything.
	 */
	containerWaitedMs?: number;
	/**
	 * What the workstation measured serving the dispatch, phase by phase, with
	 * its own `totalMs`. `dispatchMs - workstation.totalMs` is the transport —
	 * the one share a DO-side clock can never see on its own, and the reason
	 * "dispatch dominates" used to be where the investigation stopped.
	 */
	workstation?: Record<string, number>;
	/** dispatchMs + waitMs + readMs. */
	totalMs: number;
}

const workstationTimings = (value: unknown): Record<string, number> | null => {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return null;
	const timings: Record<string, number> = {};
	for (const [phase, ms] of Object.entries(value as Record<string, unknown>))
		if (typeof ms === "number" && Number.isFinite(ms)) timings[phase] = ms;
	return Object.keys(timings).length ? timings : null;
};

const roundTrip = (segments: {
	dispatchMs: number;
	waitMs: number;
	readMs: number;
	containerWaitedMs?: unknown;
	workstation?: unknown;
}): ExecRoundTrip => {
	const workstation = workstationTimings(segments.workstation);
	return {
		dispatchMs: segments.dispatchMs,
		waitMs: segments.waitMs,
		readMs: segments.readMs,
		...(typeof segments.containerWaitedMs === "number"
			? { containerWaitedMs: segments.containerWaitedMs }
			: {}),
		...(workstation ? { workstation } : {}),
		totalMs: segments.dispatchMs + segments.waitMs + segments.readMs,
	};
};

/**
 * The receipt for a command that outlived the tool call. Any deadline on this
 * path is a WAIT bound: the command keeps running on the computer and its
 * completion comes back on its own as a wake. Never present it as a failure —
 * the model reads `ok: false` as a killed command and re-runs it.
 */
function runningExecutionReceipt(
	executionId: string,
	detail: {
		startedAt?: unknown;
		observation?: "unavailable";
		roundTrip: ExecRoundTrip;
	},
): Record<string, unknown> {
	return {
		ok: true,
		status: "running",
		running: true,
		terminal: false,
		executionId,
		...(detail.observation ? { observation: detail.observation } : {}),
		roundTrip: detail.roundTrip,
		...(typeof detail.startedAt === "string"
			? { startedAt: detail.startedAt }
			: {}),
		hint: `the process keeps running on this computer and you will be woken once with its exit code and output when it finishes; do not poll read_execution({ executionId: "${executionId}" })`,
	};
}
/**
 * Lease states a body can never leave on its own. There is nothing left to wait
 * for, so a replacement is the only move.
 *
 * `blocked` is deliberately NOT here. It is not terminal in D1 and nothing ever
 * retried it — which is the strand this recovery path exists for — but it is
 * also the status every cold start reports, so it is classified by
 * `failedLeaseFromStatus` with the startup grace rather than on sight.
 */
const DEAD_LEASE_STATUSES = new Set([
	"canceled",
	"expired",
	"failed",
	"released",
]);

/**
 * How long a body that has not yet reported readiness is waited for before its
 * `blocked` lease is read as a failure rather than a slow start.
 *
 * `blocked` alone proves nothing. apps/tedi derives the workstation status from
 * readiness dimensions — `workstationStatusForReadiness` returns `blocked` for
 * ANY body whose tools, secrets or repo are not ready yet, and
 * `leaseStatusFromWorkstationStatus` copies that onto the lease — so a
 * container that is merely still booting is indistinguishable, by status, from
 * one that is stuck forever. Replacing on `blocked` alone churns through
 * leases and fails the turn while the replaced bodies would have reached
 * active/ready by themselves.
 *
 * Six minutes is comfortably past the slowest bootstrap observed there, and it
 * does not weaken the strand fix: a lease stranded by an earlier turn is older
 * than this on the first status read of the next one.
 */
const LEASE_STARTUP_GRACE_MS = 6 * 60_000;

/**
 * How long this task has been waiting for the selected body to come up.
 *
 * A selection persisted before `openedAt` existed is by definition carried over
 * from an earlier turn — the stranded-lease shape — so it is eligible for
 * replacement immediately.
 */
function leaseWaitedMs(environment: ComputerEnvironment): number {
	const startedAt = environment.revalidationStartedAt ?? environment.openedAt;
	return typeof startedAt === "number"
		? Date.now() - startedAt
		: Number.POSITIVE_INFINITY;
}

/**
 * How many replacement leases one task may open automatically.
 *
 * Two, because the observed failure replayed forever while one fresh lease was
 * always enough, and a body failing for a genuinely environmental reason must
 * stop rather than churn containers on every turn.
 */
const MAX_AUTOMATIC_LEASE_RECOVERIES = 2;

/**
 * Does this status prove the selected lease can no longer serve work?
 *
 * Reads the LEASE, and the workstation status only as a fallback. A dead lease
 * is a failure on sight; a `blocked` one is a failure only once the body proves
 * it is not coming up — either because apps/tedi reports a `setupError`, the one
 * field it sets only when the body itself refused to start, or because the
 * startup grace has run out.
 *
 * The body's `lastBootstrapError` is carried as a diagnostic and is
 * deliberately never the verdict: that string is the last readiness text the
 * body wrote, it persists long after the condition it described, and it is also
 * populated by an in-flight repo sync. Taking it at face value is what sent
 * operators to re-check a GitHub credential that was already correct.
 */
function failedLeaseFromStatus(
	status: Record<string, unknown>,
	waitedMs: number,
): { leaseStatus: string; bodyError: string | null } | null {
	const bootstrap = record(status.bootstrap);
	const bodyError =
		typeof bootstrap.lastBootstrapError === "string"
			? bootstrap.lastBootstrapError
			: null;
	const leaseStatus = String(record(status.workstationLease).status ?? "");
	if (DEAD_LEASE_STATUSES.has(leaseStatus)) {
		return { bodyError, leaseStatus };
	}
	const workstationStatus = String(status.status ?? "");
	if (leaseStatus !== "blocked" && workstationStatus !== "blocked") return null;
	const setupError =
		typeof status.setupError === "string" && status.setupError
			? status.setupError
			: null;
	if (!setupError && waitedMs < LEASE_STARTUP_GRACE_MS) return null;
	return {
		bodyError: setupError ?? bodyError,
		leaseStatus: leaseStatus || workstationStatus,
	};
}

type PendingOpen = Promise<unknown> & {
	ownerRunId?: string;
	preparation?: ComputerEnvironment["preparation"];
	callId?: string;
};
interface OpenContext {
	lastObservation?: ReturnType<typeof workstationPreparationObservation>;
	refreshNative?: boolean;
	deadline: AcquisitionDeadline;
	generation?: string;
	intent?: ComputerAcquisition;
	confirmed?: ComputerEnvironment;
	replay?: boolean;
	scopeOwner?: string;
	retained?: { leaseId: string; leaseStatus: string };
	work?: AcquisitionWorkAuthority | null;
}
const openings = new WeakMap<Store, Map<string, PendingOpen>>();
const closings = new WeakMap<Store, Map<string, Promise<unknown>>>();
export interface ComputerEffect {
	scopeKey: string;
	executionId: string;
	environment: ComputerEnvironment;
	inputHash: string;
}
export const computerEffectKey = (toolCallId: string) =>
	`computer-effect:${toolCallId}`;
const executions = new WeakMap<Store, Map<string, Promise<unknown>>>();
const fileOperations = new Set([
	"read",
	"write",
	"edit",
	"delete",
	"ls",
	"find",
	"grep",
]);
const scratchOnly = new Set([
	"repo_load",
	"clone_repo",
	"run_git",
	"workspace_snapshot",
]);

/** One explicit filesystem selection per immutable conversation/Work scope. */
export class ComputerEnvironmentController {
	/** Stable identity of this filesystem selection; keys its read evidence. */
	get scopeKey(): string {
		return this.key;
	}
	constructor(
		private readonly store: Store,
		private readonly key: string,
		private readonly actions: Actions,
		private readonly wait: (ms: number) => Promise<void> = (ms) =>
			new Promise((resolve) => setTimeout(resolve, ms)),
		private readonly ownerRunId?: string,
		private readonly watch?: DetachedExecutionWatch,
		private readonly acquisition: {
			budgetMs?: number;
			captureAuthority?: () => Promise<AcquisitionWorkAuthority | null>;
		} = {},
	) {}
	async hasEffect(toolCallId: string): Promise<boolean> {
		return Boolean(await this.store.get(computerEffectKey(toolCallId)));
	}

	async selected(): Promise<ComputerEnvironment | undefined> {
		await openings.get(this.store)?.get(this.key);
		const environment = await this.store.get<ComputerEnvironment>(this.key);
		if (!environment && (await this.store.get(`${this.key}:generation`)))
			throw new Error(
				"Computer provisioning outcome is unresolved. Reconcile the original outcome before accessing files; do not reprovision.",
			);
		return environment;
	}
	async open(
		preparation?: ComputerEnvironment["preparation"],
		callId?: string,
	): Promise<unknown> {
		let pending = openings.get(this.store);
		if (!pending) {
			pending = new Map();
			openings.set(this.store, pending);
		}
		const existing = pending.get(this.key);
		if (existing) {
			if (
				existing.ownerRunId !== this.ownerRunId ||
				existing.preparation !== preparation ||
				existing.callId !== callId
			)
				throw new Error(
					"A different Computer acquisition is already in progress",
				);
			return existing;
		}
		const context: OpenContext = {
			deadline: new AcquisitionDeadline(this.acquisition.budgetMs ?? 20_000),
		};
		const operation = (async () => {
			await closings.get(this.store)?.get(this.key);
			context.deadline.check();
			let environment = await this.store.get<ComputerEnvironment>(this.key);
			context.refreshNative = Boolean(environment);
			context.deadline.check();
			const mode = preparation ?? environment?.preparation ?? "shell";
			if (environment && environment.preparation !== mode)
				return {
					ok: false,
					error:
						"This task already has a computer with another preparation mode.",
				};
			const work = (await this.acquisition.captureAuthority?.()) ?? null;
			context.work = work;
			context.deadline.check();
			const previous = callId
				? await this.store.get<ComputerAcquisition>(
						computerAcquisitionKey(callId),
					)
				: undefined;
			context.deadline.check();
			if (
				previous &&
				(previous.scopeKey !== this.key ||
					previous.ownerRunId !== (this.ownerRunId ?? null) ||
					previous.preparation !== mode ||
					JSON.stringify(previous.work) !== JSON.stringify(work))
			)
				throw new Error("Conflicting Computer acquisition identity");
			if (previous && !previous.confirmed)
				throw new Error(
					"Computer provisioning outcome is unknown; do not reprovision",
				);
			context.replay = Boolean(previous);
			await withAcquisitionLock(this.store, this.key, async () => {
				context.deadline.check();
				let generation = await this.store.get<string>(`${this.key}:generation`);
				const selected = await this.store.get<ComputerEnvironment>(this.key);
				context.deadline.check();
				if (selected?.leaseId !== environment?.leaseId)
					throw new Error("Computer selection changed during acquisition");
				if (!environment && generation)
					throw new Error(
						"Computer provisioning outcome is unknown; do not reprovision",
					);
				if (environment && !generation)
					throw new Error("Selected Computer has no acquisition generation");
				if (
					previous &&
					(previous.generation !== generation ||
						previous.confirmed?.leaseId !== environment?.leaseId ||
						(await this.store.get(`${this.key}:owner`)) !== this.ownerRunId)
				)
					throw new Error("Computer acquisition owner or generation changed");
				context.deadline.check();
				generation ??= `computer-${crypto.randomUUID()}`;
				context.generation = generation;
				context.scopeOwner =
					this.ownerRunId ??
					(await this.store.get<string>(`${this.key}:owner`));
				if (callId)
					context.intent = await beginComputerAcquisition(this.store, {
						callId,
						scopeKey: this.key,
						ownerRunId: this.ownerRunId ?? null,
						generation,
						preparation: mode,
						work,
					});
				context.deadline.check();
				await this.store.put(`${this.key}:generation`, generation);
				context.deadline.check();
				if (this.ownerRunId)
					await this.store.put(`${this.key}:owner`, this.ownerRunId);
			});
			let result = record(await this.acquire(mode, context));
			while (result.ok === true && result.ready === false) {
				await this.wait(Math.min(1_000, context.deadline.remaining()));
				context.deadline.check();
				result = record(await this.acquire(mode, context));
			}
			return context.retained
				? {
						...result,
						retainedLeaseId: context.retained.leaseId,
						retainedLeaseStatus: context.retained.leaseStatus,
						recoveryNotice:
							"The failed environment is retained; uncheckpointed files were not copied to the replacement.",
					}
				: result;
		})();
		const opening = Object.assign(
			(async () => {
				try {
					return await context.deadline.run(operation);
				} catch (error) {
					if (!(error instanceof ComputerAcquisitionDeadline)) throw error;
					if (!context.confirmed)
						throw new Error(
							context.generation
								? "Computer provisioning outcome is unknown after the foreground deadline; do not reprovision"
								: "Computer acquisition did not start before the foreground deadline",
						);
					// The expired budget cannot authorize another storage read. Keep
					// the durable acquisition, but do not claim its current ownership.
					return {
						ok: false,
						ready: false,
						...(context.lastObservation?.leaseId === context.confirmed.leaseId
							? { lastObservation: context.lastObservation }
							: {}),
						error:
							"Computer readiness and ownership are unconfirmed after the foreground deadline; reopen this same acquisition, do not reprovision",
					};
				}
			})(),
			{ ownerRunId: this.ownerRunId, preparation, callId },
		);
		pending.set(this.key, opening);
		try {
			return await opening;
		} finally {
			if (pending.get(this.key) === opening) pending.delete(this.key);
		}
	}

	private async assertOpenScope(context: OpenContext) {
		context.deadline.check();
		const [owner, generation] = await Promise.all([
			this.store.get<string>(`${this.key}:owner`),
			this.store.get<string>(`${this.key}:generation`),
		]);
		context.deadline.check();
		if (owner !== context.scopeOwner || generation !== context.generation)
			throw new Error("Computer acquisition owner or generation changed");
	}

	private async confirmOpen(
		context: OpenContext,
		preparation: ComputerEnvironment["preparation"],
		value: unknown,
	) {
		const receipt = record(value);
		const rootId = receipt.leaseId;
		const nestedId = record(receipt.workstationLease).id;
		if (receipt.ok !== true) return;
		if (rootId !== undefined && nestedId !== undefined && rootId !== nestedId)
			throw new Error("Computer acquisition returned conflicting leases");
		const leaseId = rootId ?? nestedId;
		if (typeof leaseId !== "string" || !leaseId.trim())
			throw new Error("Computer acquisition lacks a confirmed lease");
		await withAcquisitionLock(this.store, this.key, async () => {
			await this.assertOpenScope(context);
			if (context.confirmed && context.confirmed.leaseId !== leaseId)
				throw new Error("Computer acquisition returned conflicting leases");
			const environment: ComputerEnvironment = {
				leaseId,
				workstationId:
					typeof receipt.workstationId === "string"
						? receipt.workstationId
						: undefined,
				cwd: "/home/tedi/workstation",
				preparation,
				ready: false,
				openedAt: Date.now(),
			};
			context.deadline.check();
			await this.store.put(this.key, environment);
			context.deadline.check();
			if (context.intent)
				await confirmComputerAcquisition(
					this.store,
					context.intent,
					environment,
				);
			context.deadline.check();
			context.confirmed = environment;
		});
	}

	/**
	 * Retain a prior body and clear the selection so the next acquire opens fresh.
	 *
	 * Its execution receipts and uncheckpointed files are KEPT. A replacement
	 * never inherits them, including when a successor Attempt requires a new lease.
	 */
	private async retainPriorEnvironment(
		prior: ComputerEnvironment,
		leaseStatus: string,
	): Promise<void> {
		await this.store.put(`${this.key}:retained:${prior.leaseId}`, {
			environment: prior,
			status: leaseStatus,
			retainedAt: Date.now(),
		});
		await this.store.delete(`${this.key}:generation`);
		await this.store.delete(this.key);
	}

	/**
	 * Replace a lease that can no longer serve work.
	 *
	 * Why this is automatic: a lease that reached `blocked` was never retried,
	 * never expired and never released, and the selection lives in Durable Object
	 * storage keyed by the Work Item — so every later delegation of that Work Item
	 * re-read the same dead lease and replayed its last readiness text forever. In
	 * production that text was "GitHub credentials are required before the repo
	 * can be prepared", which sent operators to fix a credential that was already
	 * correct: the same tedi in the same minute opened a computer successfully
	 * without the Work Item, and the same task against a NEW Work Item ran fine.
	 * The credential was never the problem; the stranded lease was.
	 *
	 * BOUNDED, because a body that fails for a real environmental reason would
	 * otherwise replace itself on every turn. Past the bound the refusal names the
	 * lease and how many replacements were already tried, and demotes the body's
	 * own message to a diagnostic rather than presenting it as the cause.
	 */
	private async prepareReplacement(
		prior: ComputerEnvironment,
		failure: { leaseStatus: string; bodyError: string | null },
		context: OpenContext,
	): Promise<Record<string, unknown> | undefined> {
		const recoveryKey = `${this.key}:recoveries`;
		const attempts = (await this.store.get<number>(recoveryKey)) ?? 0;
		if (attempts >= MAX_AUTOMATIC_LEASE_RECOVERIES) {
			return {
				ok: false,
				ready: false,
				blockedLeaseId: prior.leaseId,
				blockedLeaseStatus: failure.leaseStatus,
				recoveryAttempts: attempts,
				bodyError: failure.bodyError,
				error:
					`Computer lease ${prior.leaseId} is ${failure.leaseStatus}, and ${attempts} automatic replacement lease(s) for this task also failed. ` +
					`This is a workstation lease problem, not a missing credential. The last message from the body was: ${failure.bodyError ?? "none"}`,
			};
		}
		context.deadline.check();
		const generation = `computer-${crypto.randomUUID()}`;
		// Clear the current call's confirmed proof before changing the selection or
		// issuing any replacement provision. A reset here is deliberately fenced.
		context.confirmed = undefined;
		if (context.intent)
			context.intent = await replaceComputerAcquisition(
				this.store,
				context.intent,
				generation,
			);
		context.deadline.check();
		await this.retainPriorEnvironment(prior, failure.leaseStatus);
		context.deadline.check();
		context.generation = generation;
		await this.store.put(`${this.key}:generation`, generation);
		context.deadline.check();
		await this.store.put(recoveryKey, attempts + 1);
		context.retained ??= {
			leaseId: prior.leaseId,
			leaseStatus: failure.leaseStatus,
		};
		return undefined;
	}
	private async acquire(
		preparation: ComputerEnvironment["preparation"],
		context: OpenContext,
	): Promise<unknown> {
		let preparedStartSha: string | undefined;
		let environment = await this.store.get<ComputerEnvironment>(this.key);
		if (environment && environment.preparation !== preparation) {
			return {
				ok: false,
				error:
					"This task already has a computer. Use its shell to prepare additional files or repositories; opening another environment would change the filesystem.",
			};
		}
		await this.assertOpenScope(context);
		if (!environment) {
			const receipt = await this.actions.open(
				preparation,
				context.generation!,
				context.intent?.work ?? null,
				(value) => this.confirmOpen(context, preparation, value),
			);
			await this.assertOpenScope(context);
			if (!context.confirmed)
				await this.confirmOpen(context, preparation, receipt);
			if (!context.confirmed) return receipt;
			environment = context.confirmed;
		} else if (!context.confirmed) {
			await withAcquisitionLock(this.store, this.key, async () => {
				await this.assertOpenScope(context);
				if (context.intent)
					await confirmComputerAcquisition(
						this.store,
						context.intent,
						environment!,
					);
				context.deadline.check();
				context.confirmed = environment;
				// A selected lease can outlive its container. An explicit open must
				// observe current readiness, even for a recently ready selection.
				// Clear the cache first so a failed refresh cannot leave it usable.
				if (environment!.ready) {
					environment = { ...environment!, ready: false };
					await this.store.put(this.key, environment);
					context.deadline.check();
				}
			});
		}
		if (!environment.ready) {
			let status = record(
				await this.actions.status(
					{ ...environment },
					context.deadline.remaining(),
					false,
				),
			);
			await this.assertOpenScope(context);
			if (context.refreshNative && context.work) {
				const lease = record(status.workstationLease);
				if (lease.workItemId !== context.work.workItemId) {
					return {
						ok: false,
						ready: false,
						error: "Selected Computer lease is not owned by this Work Item",
					};
				}
				if (lease.attemptId !== context.work.attemptId) {
					if (typeof lease.attemptId !== "string" || !lease.attemptId) {
						return {
							ok: false,
							ready: false,
							error:
								"Selected Computer lease has no confirmed Attempt authority",
						};
					}
					if (context.replay) {
						return {
							ok: false,
							ready: false,
							error:
								"Confirmed Computer acquisition belongs to a prior Attempt",
						};
					}
					await withAcquisitionLock(this.store, this.key, async () => {
						await this.assertOpenScope(context);
						const generation = `computer-${crypto.randomUUID()}`;
						context.confirmed = undefined;
						if (context.intent)
							context.intent = await replaceComputerAcquisition(
								this.store,
								context.intent,
								generation,
							);
						await this.retainPriorEnvironment(
							environment!,
							"superseded_attempt",
						);
						context.generation = generation;
						context.refreshNative = false;
						await this.store.put(`${this.key}:generation`, generation);
					});
					return this.acquire(preparation, context);
				}
			}
			const reportedLease = record(status.workstationLease).id;
			if (
				(reportedLease === undefined ||
					reportedLease === environment.leaseId) &&
				(context.lastObservation?.leaseId !== environment.leaseId ||
					context.lastObservation.source !== "native_refresh")
			) {
				context.lastObservation = workstationPreparationObservation({
					leaseId: environment.leaseId,
					source: "persisted_status",
					receipt: status,
				});
			}
			// Work with a copy so a late result cannot mutate an object retained by a store.
			environment = { ...environment };
			let repoSync = record(status.repoSync);
			let credentials = safeGitHubCredentialStatus(status.credentials);
			if (
				context.refreshNative &&
				preparation === "repository" &&
				repoSync.status === "failed" &&
				repoSync.executionState === "terminal" &&
				!record(credentials?.probe).status
			) {
				if (!environment.revalidationId) {
					environment.revalidationId = `${context.generation}:${crypto.randomUUID()}`;
					await withAcquisitionLock(this.store, this.key, async () => {
						await this.assertOpenScope(context);
						await this.store.put(this.key, { ...environment });
					});
				}
				status = record(
					await this.actions.status(
						{ ...environment },
						context.deadline.remaining(),
						true,
					),
				);
				await this.assertOpenScope(context);
				if (status.ok === true && status.ready === false) return status;
				repoSync = record(status.repoSync);
				credentials = safeGitHubCredentialStatus(status.credentials);
			}
			// A completed, failed clone is not a cold start. Keep this lease so
			// repeated opens cannot retry an external failure (such as GitHub 429)
			// by allocating new containers. Historical bootstrap text alone is not
			// evidence of failure, and shell-only work does not require a repo.
			if (
				preparation === "repository" &&
				!DEAD_LEASE_STATUSES.has(
					String(record(status.workstationLease).status ?? ""),
				) &&
				repoSync.status === "failed" &&
				repoSync.executionState === "terminal"
			) {
				return {
					ok: false,
					ready: false,
					environment: "linux",
					leaseId: environment.leaseId,
					...(credentials ? { credentials } : {}),
					repoSync,
					error:
						typeof repoSync.error === "string" && repoSync.error
							? repoSync.error
							: "Repository preparation failed after its clone execution finished.",
					instruction:
						"Repository preparation failed. This computer is retained; resolve the reported failure before retrying repository work.",
				};
			}
			// Classified BEFORE the envelope check: a dead lease very often reports
			// `ok: false`, and refusing to look at it there is what made a blocked
			// lease unrecoverable in the first place.
			const failure = failedLeaseFromStatus(status, leaseWaitedMs(environment));
			if (failure) {
				if (context.replay)
					return {
						ok: false,
						ready: false,
						leaseId: environment.leaseId,
						error: `Acquired Computer lease is ${failure.leaseStatus}; this call will not replace its confirmed acquisition`,
						bodyError: failure.bodyError,
					};
				const refusal = await withAcquisitionLock(
					this.store,
					this.key,
					async () => {
						await this.assertOpenScope(context);
						const refused = await this.prepareReplacement(
							environment!,
							failure,
							context,
						);
						if (refused) return refused;
						return undefined;
					},
				);
				return refusal ?? this.acquire(preparation, context);
			}
			if (status.ok === false) return status;
			if (context.refreshNative) {
				if (!environment.revalidationId) {
					environment.revalidationId = `${context.generation}:${crypto.randomUUID()}`;
					await withAcquisitionLock(this.store, this.key, async () => {
						await this.assertOpenScope(context);
						await this.store.put(this.key, { ...environment });
					});
				}
				const prior = record(status.readiness ?? status.bootstrap);
				const previouslyReady =
					environment.preparation === "shell"
						? prior.toolsReady === true || status.ready === true
						: prior.toolsReady === true && prior.repoReady === true;
				if (
					previouslyReady &&
					environment.revalidationStartedAt === undefined
				) {
					// An old lease is not an old cold start. Persist one fresh grace
					// window before activation, retaining it across timeout/reopen.
					environment.revalidationStartedAt = Date.now();
					await withAcquisitionLock(this.store, this.key, async () => {
						await this.assertOpenScope(context);
						await this.store.put(this.key, { ...environment });
					});
				}
				// Passive status above preserves terminal-lease classification even
				// when /wake is forbidden for an inactive participant. Its ready bit
				// is not native evidence: an eligible existing lease must reconcile.
				status = record(
					await this.actions.status(
						{ ...environment },
						context.deadline.remaining(),
						true,
					),
				);
				await this.assertOpenScope(context);
				const observation = record(status.lastObservation);
				if (
					observation.leaseId === environment.leaseId &&
					observation.refreshId === environment.revalidationId
				) {
					context.lastObservation = workstationPreparationObservation({
						leaseId: environment.leaseId,
						refreshId: environment.revalidationId,
						source: "native_refresh",
						receipt: observation,
						fiber: record(observation.provisioningFiber) as {
							fiberId: string;
							status: string;
						},
					});
				}
				if (status.ok === false) return status;
				repoSync = record(status.repoSync);
			}
			const readiness = record(status.readiness ?? status.bootstrap);
			environment.ready =
				preparation === "shell"
					? readiness.toolsReady === true || status.ready === true
					: readiness.repoReady === true && readiness.toolsReady === true;
			if (context.refreshNative && environment.ready) {
				delete environment.revalidationStartedAt;
				delete environment.revalidationId;
			}
			const startSha = record(repoSync.treePreflight).startSha;
			if (typeof startSha === "string" && /^[0-9a-f]{40}$/.test(startSha))
				preparedStartSha = startSha;
			const workdir = record(status.repoSync).workdir;
			if (preparation === "repository" && typeof workdir === "string")
				environment.cwd = workdir;
			environment.checkedAt = Date.now();
			const updated = environment;
			await withAcquisitionLock(this.store, this.key, async () => {
				await this.assertOpenScope(context);
				await this.store.put(this.key, updated);
				context.deadline.check();
				if (updated.ready) await this.store.delete(`${this.key}:recoveries`);
			});
			// A body that came up clears the replacement budget, so a long task that
			// later meets an unrelated failure is not refused on a count it earned
			// hours earlier.
		}
		return {
			ok: true,
			ready: environment.ready,
			environment: "linux",
			...(environment.ready || preparation === "shell"
				? { cwd: environment.cwd }
				: { instruction: REPOSITORY_STARTING_INSTRUCTION }),
			...(environment.ready && preparation === "repository"
				? {
						...(preparedStartSha ? { preparedStartSha } : {}),
						instruction:
							"Repository readiness covers the configured checkout, not complete Git history; initial clones are shallow. Before coding for publication, inspect preparedStartSha (or read git config --get tedix.preparedStartSha): governed pushes must descend from that recorded start. Within existing task authority, fetch bounded history from origin if needed to verify the exact task base and required ancestry. Report an incompatible task base or denied remote access; do not change preparation metadata, substitute another base, or retry denied access.",
					}
				: {}),
			...(!environment.ready
				? {
						message:
							"Computer is starting. Your next file or exec call will check readiness automatically.",
					}
				: {}),
		};
	}
	async finish(runId: string): Promise<unknown> {
		return this.close(runId);
	}
	async close(expectedOwner?: string): Promise<unknown> {
		let pending = closings.get(this.store);
		if (!pending) {
			pending = new Map();
			closings.set(this.store, pending);
		}
		const existing = pending.get(this.key);
		if (existing) return existing;
		const closing = (async () => {
			const environment = await this.selected();
			if (
				expectedOwner &&
				(await this.store.get(`${this.key}:owner`)) !== expectedOwner
			)
				return { ok: true, closed: false };
			if (!environment)
				return {
					ok: true,
					closed: false,
					message: "No open computer for this scope",
				};
			const receipt = record(await this.actions.close(environment));
			if (receipt.ok !== true) return receipt;
			const leaseId = receipt.leaseId;
			if (
				typeof leaseId !== "string" ||
				!["released", "expired", "blocked"].includes(
					String(receipt.leaseStatus),
				)
			)
				return {
					ok: true,
					closed: false,
					leaseId: environment.leaseId,
					message: "Computer lease was not confirmed terminal",
				};
			await withAcquisitionLock(this.store, this.key, async () => {
				const selected = await this.store.get<ComputerEnvironment>(this.key);
				const owner = await this.store.get(`${this.key}:owner`);
				if (
					selected?.leaseId !== environment.leaseId ||
					(expectedOwner && owner !== expectedOwner)
				)
					throw new Error("Computer selection changed during release");
				await this.store.delete(this.key);
				await this.store.delete(`${this.key}:generation`);
				await this.store.delete(`${this.key}:owner`);
				await this.store.delete(`${this.key}:search-engine`);
			});
			return { ok: true, closed: true, leaseId };
		})();
		pending.set(this.key, closing);
		try {
			return await closing;
		} finally {
			pending.delete(this.key);
		}
	}

	async file(
		operation: string,
		input: Record<string, unknown>,
	): Promise<unknown> {
		const ready = await this.ready();
		if (!ready.environment) return { ...record(ready.result), operation };
		return this.fileIn(ready.environment, operation, input);
	}
	async fileIn(
		environment: ComputerEnvironment,
		operation: string,
		input: Record<string, unknown>,
	): Promise<unknown> {
		const path = typeof input.path === "string" ? input.path : environment.cwd;
		return {
			...record(
				await this.actions.files(environment, operation, {
					...input,
					path: path.startsWith("/") ? path : `${environment.cwd}/${path}`,
				}),
			),
			operation,
		};
	}
	private async ready(): Promise<{
		environment?: ComputerEnvironment;
		result?: unknown;
	}> {
		await closings.get(this.store)?.get(this.key);
		let environment = await this.selected();
		if (!environment)
			return { result: { ok: false, error: "Open a computer first." } };
		const owner = await this.store.get(`${this.key}:owner`);
		if (this.ownerRunId && owner !== this.ownerRunId) {
			await new AcquisitionDeadline(this.acquisition.budgetMs ?? 20_000).run(
				Promise.resolve(this.acquisition.captureAuthority?.()),
			);
		}
		environment = await withAcquisitionLock(this.store, this.key, async () => {
			const current = await this.store.get<ComputerEnvironment>(this.key);
			if (
				current?.leaseId !== environment!.leaseId ||
				(await this.store.get(`${this.key}:owner`)) !== owner
			)
				throw new Error("Computer selection changed before operation");
			if (this.ownerRunId)
				await this.store.put(`${this.key}:owner`, this.ownerRunId);
			const selected = { ...current };
			if (selected.ready && Date.now() - (selected.checkedAt ?? 0) > 30_000) {
				selected.ready = false;
				await this.store.put(this.key, selected);
			}
			return selected;
		});
		if (!environment.ready) {
			const result = record(await this.open(environment.preparation));
			if (result.ready !== true)
				return {
					result: {
						...result,
						ok: false,
						executed: false,
						...(result.ok === true
							? {
									pending: true,
									instruction:
										"Computer is still starting. This operation was NOT performed. Call open_computer until ready, then retry this operation.",
								}
							: {}),
					},
				};
		}
		return { environment: (await this.selected())! };
	}
	/** One structured search pass over the selected computer's files. */
	async codeSearch(input: CodeSearchInput): Promise<unknown> {
		const search = normalizeCodeSearchInput(input);
		const ready = await this.ready();
		if (!ready.environment) return record(ready.result);
		const result = record(
			await this.exec({
				command: buildCodeSearchCommand(search),
				cwd: ready.environment.cwd,
				timeoutMs: 120_000,
			}),
		);
		if (result.terminal !== true) return { ...result, engine: "rg" };
		if (result.ok === false) return { ...result, engine: "rg" };
		return codeSearchResult(
			search,
			parseCodeSearchOutput(
				String(result.stdout ?? ""),
				String(result.stderr ?? ""),
				search.limit,
			),
		);
	}

	async exec(
		input: {
			command: string;
			env?: Record<string, string>;
			cwd?: string;
			timeoutMs?: number;
		},
		toolCallId = crypto.randomUUID(),
	): Promise<unknown> {
		let pending = executions.get(this.store);
		if (!pending) {
			pending = new Map();
			executions.set(this.store, pending);
		}
		const key = computerEffectKey(toolCallId);
		const existing = pending.get(key);
		if (existing) {
			await existing;
			return this.executeOnce(input, key);
		}
		const execution = this.executeOnce(input, key);
		pending.set(key, execution);
		try {
			return await execution;
		} finally {
			pending.delete(key);
		}
	}
	private async executeOnce(
		input: {
			command: string;
			env?: Record<string, string>;
			cwd?: string;
			timeoutMs?: number;
		},
		effectKey: string,
	): Promise<unknown> {
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(
				JSON.stringify({
					command: input.command,
					cwd: input.cwd,
					timeoutMs: input.timeoutMs,
					env: input.env
						? Object.fromEntries(
								Object.entries(input.env).sort(([a], [b]) =>
									a.localeCompare(b),
								),
							)
						: undefined,
				}),
			),
		);
		const inputHash = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		const effect = await this.store.get<ComputerEffect>(effectKey);
		if (effect) {
			if (effect.scopeKey !== this.key || effect.inputHash !== inputHash)
				throw new Error(
					"Computer tool-call identity cannot be reused for another scope or command",
				);
			return this.execution(effect.executionId, false);
		}
		const ready = await this.ready();
		if (!ready.environment) return ready.result;
		const environment = ready.environment;
		const id = crypto.randomUUID();
		// Persist ownership before dispatch. A transport failure must never cause command replay.
		await this.store.put(`${this.key}:execution:${id}`, environment);
		await this.store.put<ComputerEffect>(effectKey, {
			scopeKey: this.key,
			executionId: id,
			environment,
			inputHash,
		});
		const dispatchedAt = Date.now();
		try {
			// Cleanup must see this identity even if dispatch or its inline wait is
			// interrupted. Notification scheduling still belongs to detach below.
			await this.watch?.retained?.({
				command: input.command,
				environment,
				executionId: id,
			});
			const started = record(
				await this.actions.start(environment, {
					...input,
					command:
						input.env && Object.keys(input.env).length
							? `env ${Object.entries(input.env)
									.map(([key, value]) => shellQuote(`${key}=${value}`))
									.join(" ")} sh -c ${shellQuote(input.command)}`
							: input.command,
					cwd: input.cwd ?? environment.cwd,
					processId: id,
				}),
			);
			const dispatchedUntil = Date.now();
			const dispatchMs = dispatchedUntil - dispatchedAt;
			// A dispatch that never reached the workstation carries no phases, so
			// the transport share of THAT trip is the whole of it.
			const workstation = started.timings;
			// The start request stopped waiting at the transport deadline. The
			// command was dispatched under this id and the workstation never kills
			// on that deadline, so detach: hand back the polling handle.
			if (started.ok === false && started.requestTimedOut === true)
				return await this.detached(id, input.command, environment, {
					roundTrip: roundTrip({
						dispatchMs,
						readMs: 0,
						waitMs: 0,
						workstation,
					}),
				});
			if (started.ok === false) {
				// HTTP 400 and workstation setup errors reject before process launch.
				// Neither may leave a nonexistent execution in a later segment.
				if (started.status === 400 || started.setupError)
					await this.watch?.collected(id);
				return { ...started, executionId: id };
			}
			// Container-side waiting avoids Durable Object polling. The wait transport
			// adds 5s to this budget; neither deadline kills the process.
			const result = record(await this.actions.wait(environment, id, 90_000));
			const waitedUntil = Date.now();
			const waitMs = waitedUntil - dispatchedUntil;
			if (result.requestTimedOut === true || result.terminal !== true)
				return await this.detached(id, input.command, environment, {
					startedAt: result.startedAt,
					...(result.observation === "unavailable"
						? { observation: "unavailable" as const }
						: {}),
					roundTrip: roundTrip({
						// A wait that hit the transport deadline never reached a
						// container, so its `waitedMs` is this Worker's own budget
						// echoed back, not a measurement.
						containerWaitedMs:
							result.requestTimedOut === true ? undefined : result.waitedMs,
						dispatchMs,
						readMs: 0,
						waitMs,
						workstation,
					}),
				});
			// The model holds the terminal receipt, so no wake is owed for it.
			await this.watch?.collected(id);
			return this.result(id, result, {
				segments: {
					containerWaitedMs: result.waitedMs,
					dispatchMs,
					startedAt: waitedUntil,
					waitMs,
					workstation,
				},
			});
		} catch (error) {
			return {
				ok: false,
				executionId: id,
				outcome: "unknown",
				error: String(error),
				instruction:
					"Read this execution ID before deciding what to do. Do not repeat the command.",
			};
		}
	}
	/**
	 * Hand back a running receipt AND arm the completion wake.
	 *
	 * Arming before returning is what lets the receipt promise a notification:
	 * an arm that throws would otherwise leave the model told to wait for a wake
	 * that nothing will send, so the failure is loud here rather than silent
	 * hours later.
	 */
	private async detached(
		executionId: string,
		command: string,
		environment: ComputerEnvironment,
		detail: {
			startedAt?: unknown;
			observation?: "unavailable";
			roundTrip: ExecRoundTrip;
		},
	): Promise<Record<string, unknown>> {
		await this.watch?.detached({ command, environment, executionId });
		return runningExecutionReceipt(executionId, detail);
	}

	/**
	 * Turn a workstation result into the receipt the model reads, and stamp what
	 * the trip cost onto EVERY shape it can produce.
	 *
	 * `segments.startedAt` is when receipt assembly began, so `readMs` is
	 * measured here rather than guessed by the caller.
	 */
	private result(
		executionId: string,
		result: Record<string, unknown>,
		options: {
			cancel?: boolean;
			segments: {
				dispatchMs: number;
				waitMs: number;
				startedAt: number;
				containerWaitedMs?: unknown;
				workstation?: unknown;
			};
		},
	): unknown {
		const trip = roundTrip({
			containerWaitedMs: options.segments.containerWaitedMs,
			dispatchMs: options.segments.dispatchMs,
			readMs: Date.now() - options.segments.startedAt,
			waitMs: options.segments.waitMs,
			workstation: options.segments.workstation,
		});
		if (result.found === false)
			return {
				ok: false,
				executionId,
				outcome: "unknown",
				roundTrip: trip,
				instruction: "Read this execution ID; do not repeat the command.",
			};
		// A status read that hit the transport deadline says nothing about the
		// command, which is still running on the computer. A cancel that timed
		// out is different: the cancel is unconfirmed, so keep the failure.
		if (
			!options.cancel &&
			result.ok === false &&
			result.requestTimedOut === true
		)
			return runningExecutionReceipt(executionId, { roundTrip: trip });
		const { stdoutTail, stderrTail, ...receipt } = result;
		const running =
			result.running === true &&
			result.terminal !== true &&
			result.ok !== false;
		return {
			...receipt,
			...(running
				? runningExecutionReceipt(executionId, {
						roundTrip: trip,
						startedAt: result.startedAt,
					})
				: {}),
			executionId,
			roundTrip: trip,
			stdout: stdoutTail ?? result.stdout ?? "",
			stderr: stderrTail ?? result.stderr ?? "",
		};
	}
	async execution(id: string, cancel: boolean): Promise<unknown> {
		const environment = await this.store.get<ComputerEnvironment>(
			`${this.key}:execution:${id}`,
		);
		if (!environment)
			return {
				ok: false,
				error: "Execution does not belong to this computer.",
			};
		// Collecting a command costs real time too — a status read, and sometimes
		// a bounded idle — and none of it used to be measured. A detached command
		// collected later was invisible to every stopwatch this file kept.
		const dispatchedAt = Date.now();
		let result = record(
			await (cancel
				? this.actions.cancel(environment, id)
				: this.actions.read(environment, id)),
		);
		const dispatchedUntil = Date.now();
		let waitMs = 0;
		if (
			!cancel &&
			result.running === true &&
			result.terminal !== true &&
			result.ok !== false
		) {
			// Keep an unchanged running process from consuming a model round every
			// few seconds. One bounded wait and one refresh, never an API busy loop.
			await this.wait(15_000);
			result = record(await this.actions.read(environment, id));
			waitMs = Date.now() - dispatchedUntil;
		}
		// A collected terminal command, and a confirmed cancel, both settle the
		// promised notification here: the model already has the answer.
		if (result.terminal === true || (cancel && result.ok !== false))
			await this.watch?.collected(id);
		return this.result(id, result, {
			cancel,
			segments: {
				containerWaitedMs:
					result.requestTimedOut === true ? undefined : result.waitedMs,
				dispatchMs: dispatchedUntil - dispatchedAt,
				startedAt: Date.now(),
				waitMs,
			},
		});
	}
}

const execInputSchema = z.strictObject({
	command: z.string().min(1),
	env: z
		.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())
		.optional(),
	cwd: z.string().optional(),
	killAfterMs: z
		.number()
		.int()
		.min(1000)
		.max(21_600_000)
		.optional()
		.describe(
			"Optional hard execution deadline that kills the command on the computer (exit 124, timedOut: true). This is the ONLY way a command gets killed by time; omit it for ordinary work. It is not how long to wait for a response: long commands detach and return executionId automatically.",
		),
});

export function createComputerEnvironmentTools(
	nativeTools: ToolSet,
	computer: ComputerEnvironmentController,
): ToolSet {
	const tools: ToolSet = {};
	for (const [name, definition] of Object.entries(nativeTools)) {
		if (definition.type === "provider" || !definition.execute) {
			tools[name] = definition;
			continue;
		}
		const execute = definition.execute;
		tools[name] = {
			...definition,
			...(definition.toModelOutput
				? {
						toModelOutput: (
							input: Parameters<
								NonNullable<typeof definition.toModelOutput>
							>[0],
						) =>
							record(input.output).operation
								? { type: "text" as const, value: JSON.stringify(input.output) }
								: definition.toModelOutput!(input),
					}
				: {}),
			execute: async (input, options) => {
				const environment = await computer.selected();
				const scope = computer.scopeKey;
				// Read evidence is recorded and enforced on BOTH filesystems from the
				// one chokepoint: a compaction that summarized a read away must not
				// license a write, whichever surface holds the file.
				const cwd = environment?.cwd;
				const refusal = refuseStaleWrite(scope, name, cwd, input);
				if (refusal) return refusal;
				const note = (output: unknown) => {
					recordToolRead(scope, name, cwd, input, output);
					return output;
				};
				if (!environment) return note(await execute(input, options));
				if (fileOperations.has(name))
					return note(await computer.file(name, record(input)));
				if (scratchOnly.has(name))
					return {
						ok: false,
						error:
							"Your files are in the Linux computer. Use read/edit and exec with Git there; this operation addresses the separate scratch workspace.",
					};
				return note(await execute(input, options));
			},
		};
	}
	return {
		...tools,
		open_computer: tool({
			description:
				"Open or reuse this task's full Linux computer. File tools and exec then operate on that computer for all subsequent turns. Choose repository only to prepare the configured checkout; shell starts without cloning or installing anything. Scratch files are separate and are not copied. Open before writing coding files. Acquisition, ownership, and replacement of a failed lease are all automatic. If opening returns an uncertainty error, reopen this same acquisition. After a confirmed open, run relative exec commands with cwd omitted so the next call checks readiness and selects the checkout. Use returned repository cwd only when ready:true.",
			inputSchema: z.object({
				repository: z.boolean().optional(),
			}),
			execute: ({ repository }, options) =>
				computer.open(
					repository === undefined
						? undefined
						: repository
							? "repository"
							: "shell",
					options.toolCallId,
				),
		}),
		exec: tool({
			toModelOutput: computerExecutionModelOutput,
			description: `Execute a shell command in the selected computer. Before open_computer, this is a lightweight text shell without native processes or network. After open_computer, this is full Linux with Node, Bun, Python and Git. Short commands return terminal results. Returned stdout/stderr over ${COMPUTER_EXECUTION_STREAM_CHARS} characters show only the first and last ${COMPUTER_EXECUTION_STREAM_CHARS / 2}; use native read with continuations for complete source and instruction files. A command that outlives the wait is DETACHED, never killed: you get { status: "running", executionId } and the process keeps running. You will be woken exactly once with its exit code and output tail when it finishes, so do not predict how long a command takes and do not poll for completion — carry on with other work, or end the turn. Typecheck, test, install and build commands are expected to take this path. Use cancel_execution to stop a detached command. Never repeat a command with an unknown or running outcome.`,
			inputSchema: execInputSchema,
			execute: async (input, options) => {
				// Facet proxies invoke execute directly, including retained descriptors.
				// Validate before inspecting or dispatching either filesystem.
				const { killAfterMs, ...command } = execInputSchema.parse(input);
				const normalized = {
					...command,
					...(killAfterMs === undefined ? {} : { timeoutMs: killAfterMs }),
				};
				if (
					(await computer.hasEffect(options.toolCallId)) ||
					(await computer.selected())
				)
					return computer.exec(normalized, options.toolCallId);
				return nativeTools.exec?.execute?.(normalized, options);
			},
		}),
		code_search: tool({
			toModelOutput: computerExecutionModelOutput,
			description: CODE_SEARCH_TOOL_DESCRIPTION,
			inputSchema: codeSearchInputSchema,
			execute: (input) => computer.codeSearch(input),
		}),
		close_computer: tool({
			description:
				"Close this task computer when finished. Stops its processes and releases the environment; publish source changes and artifacts first. Completed execution results remain readable.",
			inputSchema: z.object({}),
			execute: () => computer.close(),
		}),
		read_execution: tool({
			toModelOutput: computerExecutionModelOutput,
			description:
				'Read a command from this computer on demand — to look at a detached command\'s progress early, or to re-read one you already collected. You do NOT need this to learn that a detached command finished: that arrives on its own as a completion notification. A finished command returns immediately with exitCode and the tail of stdout/stderr (full logs stay in artifactRefs). A still-running command waits briefly for an update and returns { status: "running", executionId }; it is still running and its notification is still owed, so never call this in a loop and never re-run the command.',
			inputSchema: z.object({ executionId: z.string().min(1) }),
			execute: ({ executionId }) => computer.execution(executionId, false),
		}),
		cancel_execution: tool({
			toModelOutput: computerExecutionModelOutput,
			description: "Cancel a running command in this computer.",
			inputSchema: z.object({ executionId: z.string().min(1) }),
			execute: ({ executionId }) => computer.execution(executionId, true),
		}),
	};
}

/** Code Mode uses the selected computer too; bounded raw reads never publish partial files. */
export function computerEnvironmentWorkspace(
	scratch: DurableCodeWorkspace,
	computer: ComputerEnvironmentController,
	bound?: ComputerEnvironment | null,
): DurableCodeWorkspace {
	const checked = async (operation: string, input: Record<string, unknown>) => {
		const result = record(
			bound
				? await computer.fileIn(bound, operation, input)
				: await computer.file(operation, input),
		);
		if (result.ok !== true || result.truncated)
			throw new Error(
				String(result.error ?? "Computer file operation did not complete"),
			);
		return result;
	};
	const readFile = async (path: string): Promise<string | null> => {
		if (!(bound === undefined ? await computer.selected() : bound))
			return scratch.readFile(path);
		const result = await checked("read_file", { path });
		if (result.content === null) return null;
		if (typeof result.content !== "string")
			throw new Error("Computer did not return complete file content");
		return result.content;
	};
	return {
		readFile,
		writeReversibleFile: async (path, content) => {
			if (!(bound === undefined ? await computer.selected() : bound)) {
				if (!scratch.writeReversibleFile)
					throw new Error(
						"Workspace does not support owner-guarded reversible writes",
					);
				return scratch.writeReversibleFile(path, content);
			}
			const result = await checked("reversible_write", { path, content });
			if (
				result.previousContent !== null &&
				typeof result.previousContent !== "string"
			)
				throw new Error(
					"Computer returned an invalid reversible write receipt",
				);
			return { previousContent: result.previousContent as string | null };
		},
		restoreFile: async (path, expectedContent, previousContent) => {
			if (!(bound === undefined ? await computer.selected() : bound)) {
				if (!scratch.restoreFile)
					throw new Error("Workspace does not support owner-guarded rollback");
				return scratch.restoreFile(path, expectedContent, previousContent);
			}
			await checked("guarded_restore", {
				path,
				expectedContent,
				previousContent,
			});
		},
		writeFile: async (path, content) => {
			if (!(bound === undefined ? await computer.selected() : bound))
				return scratch.writeFile(path, content);
			await checked("write", { path, content });
		},
		deleteFile: async (path) => {
			if (!(bound === undefined ? await computer.selected() : bound))
				return scratch.deleteFile(path);
			await checked("delete", { path });
			return true;
		},
		diffContent: async (path, content) =>
			createPatch(path, (await readFile(path)) ?? "", content),
	};
}

export function computerRepositoryReader(
	scratch: DurableCodeWorkspace,
	computer: ComputerEnvironmentController,
): (path: string) => Promise<string | null> {
	return async (path) => {
		const environment = await computer.selected();
		if (!environment) return scratch.readFile(path);
		if (environment.preparation !== "repository")
			throw new Error(
				"This computer has no configured repository checkout. Open repository mode before coding a repository.",
			);
		const relative = path.startsWith("repo/") ? path.slice(5) : path;
		return computerEnvironmentWorkspace(scratch, computer).readFile(
			`${environment.cwd}/${relative}`,
		);
	};
}

/** The one-shot state API is explicitly scratch-only. Never let it write behind Linux tools. */
export function computerScratchState<T extends object>(
	scratch: T,
	computer: ComputerEnvironmentController,
): T {
	return new Proxy(scratch, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			if (typeof value !== "function") return value;
			return async (...args: unknown[]) => {
				if (await computer.selected())
					throw new Error(
						"state.* addresses scratch storage. Use Computer file tools or durable Code Mode for the open Linux computer.",
					);
				return Reflect.apply(value, target, args);
			};
		},
	});
}

export async function reconcileComputerEffect(
	store: Pick<Store, "get">,
	toolCallId: string,
	read: (
		environment: ComputerEnvironment,
		executionId: string,
	) => Promise<unknown>,
) {
	const effect = await store.get<ComputerEffect>(computerEffectKey(toolCallId));
	if (!effect) return null;
	const result = record(await read(effect.environment, effect.executionId));
	const running =
		result.ok === true &&
		result.found === true &&
		result.running === true &&
		result.terminal === false;
	if (result.terminal !== true && !running) return null;
	return {
		executionId: effect.executionId,
		terminal: result.terminal === true,
		...(running ? { running: true as const } : {}),
		exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
		canceled: result.canceled === true,
		timedOut: result.timedOut === true,
	};
}
