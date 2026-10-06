import { serializeException } from "@tedix/worker-kit/logger";

/** Recheck cancellation immediately before inference, including delayed recovery.
 * This intentionally does not inspect remaining budget: fresh admission may
 * have reserved the last available tokens. Storage/RPC failures propagate.
 */
export async function assertTediChatNotCanceled(
	runId: string | null | undefined,
	isCanceled: (runId: string) => Promise<boolean>,
): Promise<void> {
	if (!runId?.trim()) throw new Error("Chat inference requires a run identity");
	if (await isCanceled(runId)) {
		throw new Error(
			`Chat inference denied for canceled or stopped run: ${runId}`,
		);
	}
}

export interface NativeRecoveryObservation {
	/** Durable admission timestamp, never a new timestamp on each wake. */
	createdAt: number;
	/** Version of real native progress (entry/task ledger), not heartbeat time. */
	progress: string;
	oom?: boolean;
	now?: number;
}
export interface NativeRecoveryBudget {
	createdAt: number;
	lastProgressAt: number;
	progress: string;
	work: number;
	oomRetries: number;
}
export type NativeRecoveryAdmission =
	| { allowed: true; budget: NativeRecoveryBudget }
	| {
			allowed: false;
			reason:
				| "identity_missing"
				| "age"
				| "no_progress"
				| "work"
				| "oom"
				| "authority"
				| "unavailable";
			budget?: NativeRecoveryBudget;
	  };

/** Finite native Pi recovery admission, retaining the original run's partials.
 * Wire at every resumed generation/tool task before it may do fresh work.
 * Actual cancellation/budget/registry authorization remains the caller's gate. */
export async function admitTediNativeRecovery(
	storage: Pick<DurableObjectStorage, "transaction">,
	runId: string | null | undefined,
	observation: NativeRecoveryObservation,
	canContinue: (runId: string) => Promise<boolean>,
): Promise<NativeRecoveryAdmission> {
	if (!runId?.trim()) return { allowed: false, reason: "identity_missing" };
	try {
		const now = observation.now ?? Date.now();
		if (
			!Number.isFinite(observation.createdAt) ||
			observation.createdAt > now ||
			!observation.progress ||
			observation.progress.length > 8192
		)
			throw new Error("Invalid native recovery observation");
		const key = `pi-recovery-budget:v1:${runId}`;
		const admission = await storage.transaction<NativeRecoveryAdmission>(
			async (transaction) => {
				const prior = await transaction.get<NativeRecoveryBudget>(key);
				if (prior && prior.createdAt !== observation.createdAt)
					throw new Error("Native recovery run timestamp changed");
				const budget: NativeRecoveryBudget = prior ?? {
					createdAt: observation.createdAt,
					lastProgressAt: observation.createdAt,
					progress: observation.progress,
					work: 0,
					oomRetries: 0,
				};
				if (budget.progress !== observation.progress) {
					budget.progress = observation.progress;
					budget.lastProgressAt = now;
				}
				if (now - budget.createdAt >= 900_000)
					return { allowed: false, reason: "age", budget };
				if (now - budget.lastProgressAt >= 300_000)
					return { allowed: false, reason: "no_progress", budget };
				if (budget.work >= 200)
					return { allowed: false, reason: "work", budget };
				if (observation.oom && budget.oomRetries >= 3)
					return { allowed: false, reason: "oom", budget };
				budget.work++;
				if (observation.oom) budget.oomRetries++;
				await transaction.put(key, budget);
				return { allowed: true, budget };
			},
		);
		if (!admission.allowed) return admission;
		// Authority is checked after the atomic local budget reservation; no external
		// RPC runs inside a storage transaction that the SDK may retry.
		if (!(await canContinue(runId)))
			return { allowed: false, reason: "authority", budget: admission.budget };
		return admission;
	} catch (error) {
		console.error("[pi-recovery] admission failed; preserving partial only", {
			runId,
			error: serializeException(error),
		});
		return { allowed: false, reason: "unavailable" };
	}
}
