import { RpcCallError } from "@tedix/api-client/internal";
import type { TediSessionModelIdentity } from "@tedix/tedi-session/session-harness";
import type { PlatformClient } from "./brain/platform-client";
import type { ChatTurnParams } from "./chat-turn-input";
import type { OperatorConsentAttestation } from "./operator-consent";

export type FacetWorkflowTurnInput = Omit<ChatTurnParams, "clientRequestId"> & {
	clientRequestId?: string;
	/** Actual native instance ID supplied by ChatTurnWorkflow, never reconstructed. */
	workflowInstanceId?: string;
	operatorConsent?: OperatorConsentAttestation;
	/** Native command continuation within the same admitted run; zero is initial. */
	computerContinuation?: number;
};

export interface FacetWorkflowTurnResult {
	text: string;
	stopReason: string;
	toolCalls: Array<{ name: string; ok: boolean }>;
	modelIdentity?: TediSessionModelIdentity;
	pendingComputerExecutions?: string[];
}

type Binding = { workItemId: string; attemptId: string };
type LeaseClient = Pick<
	PlatformClient,
	"listWorkAttempts" | "heartbeatWorkAttempt"
>;

/**
 * Terminal `work_attempts.runtime_state` values that mean THIS run's Work
 * authority ended on purpose — the Attempt was settled mid-turn and is now
 * `finished` or `failed` with a `finished_at`.
 *
 * `expired` and `cancelled` are deliberately NOT here: they are authority taken
 * away (lease lapsed / operator cancel), which must still fence the run.
 */
const SELF_SETTLED_ATTEMPT_STATES: ReadonlySet<string> = new Set([
	"finished",
	"failed",
]);

/**
 * The retained Work fence for a run. Written once and never rewritten: a
 * replacement Attempt is never new authority for the same run, even after a
 * failed heartbeat.
 */
export const delegatedWorkLeaseKey = (runId: string) => `worklease:${runId}`;

/**
 * What the durable renewal alarm needs to keep one run's Work authority alive.
 *
 * Present exactly while renewal is OWED. Its absence is the release signal, so
 * an alarm that fires after the turn let go is a no-op rather than a heartbeat
 * on work nobody is doing.
 */
export const delegatedWorkLeaseRenewalKey = (runId: string) =>
	`workleaserenew:${runId}`;

export const delegatedWorkLeaseTerminalKey = (runId: string) =>
	`workleaseterminal:${runId}`;

export interface DelegatedWorkLeaseRenewal {
	runId: string;
	workflowInstanceId?: string;
	/** Conversation the turn settles into; how the alarm reads "already settled". */
	sessionKey: string;
	workItemId: string;
	attemptId: string;
	/**
	 * When renewal was FIRST owed for this run. Preserved across re-drives, so
	 * the deadline below measures the run, not the current invocation.
	 */
	armedAt: number;
}

/**
 * Renewal cadence, against the Work Attempt's five-minute lease: four
 * consecutive missed alarms before authority lapses.
 */
export const DELEGATED_WORK_LEASE_RENEWAL_INTERVAL_SECONDS = 60;

/** Native intervals recur after callback completion; identical one-shots do not. */
export async function scheduleDelegatedWorkLeaseRenewal(
	runId: string,
	scheduleEvery: (
		seconds: number,
		callback: "onDelegatedWorkLeaseRenewal",
		payload: { runId: string },
		options: { idempotent: true; retry: { maxAttempts: number } },
	) => Promise<unknown>,
): Promise<void> {
	await scheduleEvery(
		DELEGATED_WORK_LEASE_RENEWAL_INTERVAL_SECONDS,
		"onDelegatedWorkLeaseRenewal",
		{ runId },
		{ idempotent: true, retry: { maxAttempts: 3 } },
	);
}

/**
 * How long a run may hold its Work Attempt on renewal alone.
 *
 * Every ordinary ending — settlement, terminal failure (which also writes an
 * assistant row), cancellation, self-settlement — stops renewal on its own.
 * This is the backstop for the one case none of them cover: a run whose
 * dispatch context disappeared entirely. Six hours matches the exec tool's
 * maximum `timeoutMs`, which is the longest a turn can legitimately be quiet
 * (`COMPUTER_EXECUTION_WAKE_DEADLINE_MS`). Past it the Attempt expires on its
 * own lease, exactly as it does today.
 */
export const DELEGATED_WORK_LEASE_RENEWAL_DEADLINE_MS = 21_600_000;

type WorkAttempt = Awaited<
	ReturnType<LeaseClient["listWorkAttempts"]>
>["data"][number];

async function readBoundAttempt(
	client: LeaseClient,
	bound: Binding,
): Promise<WorkAttempt | null> {
	try {
		let cursor: { at: string; id: string } | undefined;
		do {
			const page = await client.listWorkAttempts({
				workItemId: bound.workItemId,
				cursor,
			});
			const attempt = page.data.find((row) => row.id === bound.attemptId);
			if (attempt) return attempt;
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		return null;
	} catch {
		return null;
	}
}

function isSelfSettledAttempt(
	attempt: WorkAttempt | null,
	runId: string,
): boolean {
	return Boolean(
		attempt &&
		attempt.runId === runId &&
		SELF_SETTLED_ATTEMPT_STATES.has(attempt.runtimeState) &&
		attempt.finishedAt,
	);
}

/**
 * Did the bound Attempt go terminal because this very run settled it?
 *
 * A renewal failure is ambiguous: `heartbeatAttempt` answers `STALE_ATTEMPT`
 * (409) both when authority was taken away AND when the run's Attempt was
 * settled while the delegated tedi was still composing the reply that reports
 * the outcome. Treating the second case as a cancel destroyed
 * completed work — the run was fenced by a permanent tombstone and settled
 * with no assistant output at all. Read the row before deciding.
 *
 * Fails CLOSED: an unreadable Attempt list is not proof of self-settlement.
 */
async function settledItsOwnAttempt(
	client: LeaseClient,
	bound: Binding,
	runId: string,
): Promise<boolean> {
	return isSelfSettledAttempt(await readBoundAttempt(client, bound), runId);
}

/** A concurrent newer heartbeat can produce this same error; it is not terminal proof. */
function isStaleBoundHeartbeat(error: unknown, bound: Binding): boolean {
	if (
		!(error instanceof RpcCallError) ||
		error.path !== "workItems/heartbeatAttempt" ||
		error.status !== 409
	)
		return false;
	try {
		const detail = JSON.parse(error.detail);
		return (
			detail?.json?.code === "CONFLICT" &&
			detail.json.message ===
				`STALE_ATTEMPT: Attempt ${bound.attemptId} is no longer authoritative`
		);
	} catch {
		return false;
	}
}

export interface DelegatedWorkLeaseRenewalDeps {
	storage: Pick<DurableObjectStorage, "get" | "delete">;
	getClient: () => Promise<LeaseClient | null>;
	isSettled: (record: DelegatedWorkLeaseRenewal) => boolean | Promise<boolean>;
	validateWorkflow?: (record: DelegatedWorkLeaseRenewal) => Promise<unknown>;
	observeWorkflow?: (record: DelegatedWorkLeaseRenewal) => Promise<boolean>;
	assertActive: (runId: string) => Promise<void>;
	cancel: (runId: string) => Promise<void>;
	rearm: (delaySeconds: number) => Promise<void>;
	now?: () => number;
}

class DelegatedWorkflowIdentityError extends Error {}

/** A missing legacy mapping is unknown; a foreign retained mapping is invalid authority. */
export async function validateDelegatedWorkLeaseWorkflow(
	record: DelegatedWorkLeaseRenewal,
	deps: {
		storage: Pick<DurableObjectStorage, "get">;
	},
): Promise<boolean> {
	if (!record.workflowInstanceId) return false;
	const context = await deps.storage.get<{
		runId: string;
		workItemId?: string;
		sessionKey: string;
	}>(`wfctx:${record.workflowInstanceId}`);
	if (!context) return false;
	if (
		context.runId !== record.runId ||
		context.workItemId !== record.workItemId ||
		context.sessionKey !== record.sessionKey
	)
		throw new DelegatedWorkflowIdentityError(
			"Delegated workflow mapping does not own this renewal",
		);
	return true;
}

export async function observeDelegatedWorkLeaseWorkflow(
	record: DelegatedWorkLeaseRenewal,
	deps: {
		storage: Pick<DurableObjectStorage, "get">;
		reconcile: (workflowInstanceId: string) => Promise<boolean>;
	},
): Promise<boolean> {
	if (!(await validateDelegatedWorkLeaseWorkflow(record, deps))) return false;
	return deps.reconcile(record.workflowInstanceId!);
}

/**
 * One durable renewal tick for a delegated run's Work Attempt.
 *
 * Why this is not a timer: renewal used to be a `setTimeout` inside the Durable
 * Object, which made a run's Work authority depend on the isolate that happened
 * to be executing it. A turn that went quiet across an eviction — waiting on a
 * long command, between two workflow re-drives — simply stopped heartbeating,
 * and five minutes later the Attempt expired. The damage was PERMANENT: the
 * retained `worklease:<runId>` binding is deliberately never rebound, so every
 * later re-drive heartbeats the dead Attempt, reads 409, and fences the run,
 * losing even a completed result.
 *
 * So the ticker is the same durable schedule that already watches Workflow
 * terminality and detached commands: an alarm, a storage read, and either a
 * heartbeat plus a re-arm or a clean stop. It survives eviction, redeploy and
 * the gap between two workflow attempts, because none of those are its isolate.
 *
 * Returns whether renewal is still owed. The schedule callback cancels its
 * native interval on false; the missing record also makes stray ticks inert.
 */
export async function renewDelegatedWorkLease(
	runId: string,
	deps: DelegatedWorkLeaseRenewalDeps,
): Promise<boolean> {
	const key = delegatedWorkLeaseRenewalKey(runId);
	const record = await deps.storage.get<DelegatedWorkLeaseRenewal>(key);
	// Nothing is owed: the turn released the lease, or a previous tick stopped.
	if (!record) return false;
	if (await deps.storage.get(delegatedWorkLeaseTerminalKey(runId))) {
		await deps.storage.delete(key);
		return false;
	}
	const now = deps.now?.() ?? Date.now();
	if (now - record.armedAt >= DELEGATED_WORK_LEASE_RENEWAL_DEADLINE_MS) {
		await deps.storage.delete(key);
		return false;
	}
	// The turn produced its answer (including the terminal failure notice that
	// `settleWorkflowFailure` always writes). Authority is no longer owed.
	if (await deps.isSettled(record)) {
		await deps.storage.delete(key);
		return false;
	}
	try {
		await deps.assertActive(runId);
	} catch {
		// Already fenced — by a kernel cancel or by an earlier tick's own fence.
		// Re-fencing would be a no-op write; stop instead.
		await deps.storage.delete(key);
		return false;
	}
	try {
		await deps.validateWorkflow?.(record);
	} catch (error) {
		if (error instanceof DelegatedWorkflowIdentityError) {
			await deps.cancel(runId);
			await deps.storage.delete(key);
			return false;
		}
		// A transient local read failure is not proof the run ended. Retry next tick.
		console.warn("[work-lease] workflow identity read failed", {
			runId,
			error: String(error),
		});
		await deps.rearm(DELEGATED_WORK_LEASE_RENEWAL_INTERVAL_SECONDS);
		return true;
	}
	const client = await deps.getClient();
	// An unavailable client is not evidence about authority. Keep the alarm.
	if (!client) {
		await deps.rearm(DELEGATED_WORK_LEASE_RENEWAL_INTERVAL_SECONDS);
		return true;
	}
	try {
		await client.heartbeatWorkAttempt({
			workItemId: record.workItemId,
			attemptId: record.attemptId,
		});
	} catch {
		await deps.storage.delete(key);
		// Self-settlement ENDS the lease; it is not lease loss. No cancellation
		// fence — the turn still owes an answer.
		if (await settledItsOwnAttempt(client, record, runId)) return false;
		// The existing durable cancellation fence blocks subsequent tools and
		// assistant settlement, which is what a lost lease has to stop.
		await deps.cancel(runId);
		return false;
	}
	// The heartbeat RPC may have overlapped final settlement or cancellation.
	if (await deps.storage.get(delegatedWorkLeaseTerminalKey(runId))) {
		await deps.storage.delete(key);
		return false;
	}
	try {
		await deps.assertActive(runId);
	} catch {
		await deps.storage.delete(key);
		return false;
	}
	if (deps.observeWorkflow) {
		try {
			if (await deps.observeWorkflow(record)) {
				await deps.storage.delete(key);
				return false;
			}
		} catch (error) {
			if (error instanceof DelegatedWorkflowIdentityError) {
				await deps.cancel(runId);
				await deps.storage.delete(key);
				return false;
			}
			// A failed status read or projection cannot establish terminality.
			console.warn("[work-lease] workflow observation failed", {
				runId,
				error: String(error),
			});
		}
		// Final settlement is recorded before fallible assistant/projection writes.
		if (await deps.storage.get(delegatedWorkLeaseTerminalKey(runId))) {
			await deps.storage.delete(key);
			return false;
		}
	}

	await deps.rearm(DELEGATED_WORK_LEASE_RENEWAL_INTERVAL_SECONDS);
	return true;
}

export interface DelegatedWorkLeaseDeps {
	storage: Pick<DurableObjectStorage, "get" | "put" | "delete">;
	getClient: () => Promise<LeaseClient | null>;
	tediId: string;
	isSettled: () => boolean;
	assertActive: () => Promise<void>;
	/** Arm the durable renewal alarm for this run. */
	arm: () => Promise<void>;
	now?: () => number;
	/** Status reads and continuations may never reuse a self-settled Attempt. */
	requireActiveAttempt?: boolean;
	/** A returned pending segment still owns its exact renewal alarm. */
	keepRenewal?: (result: unknown) => boolean;
}

/** Own the exact Work fence for this run, renewed by a durable alarm. */
export async function withDelegatedWorkLease<T>(
	input: {
		runId: string;
		workflowInstanceId?: string;
		sessionKey: string;
		workItemId?: string;
		homeRunId?: string;
	},
	deps: DelegatedWorkLeaseDeps,
	operation: () => Promise<T>,
): Promise<T> {
	if (!input.workItemId || !input.homeRunId) return operation();
	await deps.assertActive();
	if (await deps.storage.get(delegatedWorkLeaseTerminalKey(input.runId)))
		throw new Error("Delegated workflow is terminal");
	const renewalKey = delegatedWorkLeaseRenewalKey(input.runId);
	const priorRenewal =
		await deps.storage.get<DelegatedWorkLeaseRenewal>(renewalKey);
	if (
		priorRenewal?.workflowInstanceId &&
		input.workflowInstanceId &&
		priorRenewal.workflowInstanceId !== input.workflowInstanceId
	)
		throw new DelegatedWorkflowIdentityError(
			"Delegated workflow mapping changed",
		);
	const client = await deps.getClient();
	if (!client) throw new Error("Delegated Work lease client is unavailable");
	const key = delegatedWorkLeaseKey(input.runId);
	let binding = await deps.storage.get<Binding>(key);
	if (!binding) {
		let cursor: { at: string; id: string } | undefined;
		const matches = [];
		do {
			const page = await client.listWorkAttempts({
				workItemId: input.workItemId,
				cursor,
			});
			matches.push(
				...page.data.filter(
					(attempt) =>
						attempt.runId === input.runId &&
						attempt.executorType === "tedi" &&
						attempt.executorId === deps.tediId &&
						attempt.runtimeState === "running",
				),
			);
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		if (matches.length !== 1)
			throw new Error("Delegated run has no unique active Work Attempt");
		binding = { workItemId: input.workItemId, attemptId: matches[0]!.id };
		// Retain across retries: a replacement attempt is never a new authority
		// for this same run, even if the previous heartbeat failed.
		await deps.storage.put(key, binding);
	}
	if (binding.workItemId !== input.workItemId)
		throw new Error("Delegated Work binding changed");
	const bound = binding;
	// The entry heartbeat is the authority check: a run whose Attempt is gone
	// must not execute at all.
	let released = false;
	try {
		if (!deps.isSettled()) {
			await deps.assertActive();
			await client.heartbeatWorkAttempt(bound);
		}
	} catch (error) {
		// A workflow re-drive after the turn settled its own Work finds a terminal
		// Attempt. The Work is done; let the re-drive finish the reply instead of
		// failing the run forever on its own completed settlement.
		const staleHeartbeat = isStaleBoundHeartbeat(error, bound);
		const attempt =
			!deps.requireActiveAttempt || staleHeartbeat
				? await readBoundAttempt(client, bound)
				: null;
		if (
			!deps.requireActiveAttempt &&
			isSelfSettledAttempt(attempt, input.runId)
		) {
			released = true;
		} else {
			await deps.storage.delete(renewalKey);
			if (
				staleHeartbeat &&
				attempt &&
				attempt.workItemId === bound.workItemId &&
				attempt.runId === input.runId &&
				attempt.executorType === "tedi" &&
				attempt.executorId === deps.tediId &&
				["finished", "failed", "expired", "cancelled"].includes(
					attempt.runtimeState,
				) &&
				attempt.finishedAt
			) {
				// Only this local typed error plus fresh exact-row evidence earns the
				// marker that survives RPC serialization into the Workflow catch.
				throw new Error(
					`delegated_work_authority_lost: run=${input.runId} attempt=${bound.attemptId} work=${bound.workItemId}`,
				);
			}
			throw error;
		}
	}
	if (released) {
		await deps.storage.delete(renewalKey);
	} else {
		const existing =
			await deps.storage.get<DelegatedWorkLeaseRenewal>(renewalKey);
		if (
			existing?.workflowInstanceId &&
			input.workflowInstanceId &&
			existing.workflowInstanceId !== input.workflowInstanceId
		)
			throw new DelegatedWorkflowIdentityError(
				"Delegated workflow mapping changed",
			);
		if (
			existing &&
			(deps.now?.() ?? Date.now()) - existing.armedAt >=
				DELEGATED_WORK_LEASE_RENEWAL_DEADLINE_MS
		) {
			await deps.storage.delete(renewalKey);
			throw new Error(
				"computer_continuation_failed: Work renewal deadline exceeded",
			);
		}
		await deps.storage.put<DelegatedWorkLeaseRenewal>(renewalKey, {
			attemptId: bound.attemptId,
			armedAt: existing?.armedAt ?? deps.now?.() ?? Date.now(),
			runId: input.runId,
			workflowInstanceId:
				existing?.workflowInstanceId ?? input.workflowInstanceId,
			sessionKey: input.sessionKey,
			workItemId: bound.workItemId,
		});
		await deps.arm();
	}
	if (await deps.storage.get(delegatedWorkLeaseTerminalKey(input.runId))) {
		await deps.storage.delete(renewalKey);
		throw new Error("Delegated workflow is terminal");
	}
	const result = await operation();
	// Release only on a produced answer. A THROWN turn is a re-drive, not an
	// ending: the workflow's `facet-turn` retry backs off up to 240s against a
	// 300s lease, so clearing renewal here would reopen the same expiry window
	// this alarm exists to close. Everything that genuinely ends the run —
	// settlement, the terminal failure notice, a cancel — stops the alarm from
	// inside `renewDelegatedWorkLease`.
	if (!deps.keepRenewal?.(result)) await deps.storage.delete(renewalKey);
	await deps.assertActive();
	return result;
}

/** Concurrent watchdog and lease observations share one native reconciliation. */
export async function reconcileWorkflowOnce(
	pending: Map<string, Promise<boolean>>,
	workflowInstanceId: string,
	reconcile: () => Promise<boolean>,
): Promise<boolean> {
	const existing = pending.get(workflowInstanceId);
	if (existing) return existing;
	const operation = reconcile();
	pending.set(workflowInstanceId, operation);
	try {
		return await operation;
	} finally {
		if (pending.get(workflowInstanceId) === operation)
			pending.delete(workflowInstanceId);
	}
}
