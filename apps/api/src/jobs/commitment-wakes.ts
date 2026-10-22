import {
	buildTediContextWakeRequest,
	deliverTediContextWake,
} from "./tedi-context-wake";
import { createDbClient } from "@tedix/db/client";
import {
	advanceCommitmentWakeCheckpoint,
	advanceCommitmentWakeCursor,
	getCommitmentWakeCursor,
	lastCommitmentWakeCheckpoint,
	listCommitmentChanges,
	type CommitmentChange,
} from "@tedix/db/queries/work-items/commitment-changes";

const WINDOW_MS = 120_000;
const DEBOUNCE_MS = 30_000;
const MAX_REPLAY_WINDOWS = 10;
const MAX_WAKE_AGE_MS = 15 * 60_000;
export const MAX_COMMITMENT_CHANGES_PER_RUN = 25;
const RUN_BUDGET_MS = 20_000;
const OPERATION_TIMEOUT_MS = 5_000;

export function commitmentWakeWindows(
	checkpoint: string | null,
	nowMs: number,
): Array<{ after: string; through: string }> {
	const end = Math.floor((nowMs - DEBOUNCE_MS) / WINDOW_MS) * WINDOW_MS;
	const start = checkpoint ? Date.parse(checkpoint) : end - WINDOW_MS;
	const replayEnd = Math.min(end, start + MAX_REPLAY_WINDOWS * WINDOW_MS);
	const windows = [];
	for (let at = start; at < replayEnd; at += WINDOW_MS)
		windows.push({
			after: new Date(at).toISOString(),
			through: new Date(at + WINDOW_MS).toISOString(),
		});
	return windows;
}

export function buildCommitmentWakeRequest(
	changes: CommitmentChange[],
	through: string,
	environment: string,
): Request {
	const first = changes[0]!;
	const deliveryKey = `commitments:${first.orgId}:${first.tediId}:${through}`;
	return buildTediContextWakeRequest(first.slug, environment, {
		session_key: `commitments:${first.tediId}`,
		client_request_id: deliveryKey,
		metadata: {
			source: "commitment_changes",
			commitmentKeys: changes.map((change) => change.key),
		},
		text: `An existing commitment changed. Read these exact canonical objects now, check whether the operator already handled them, and continue only the next safe step within existing authority. This wake grants no approval or Work Attempt. For a succeeded external lane, read the exact Attempt settlement, verify its claimed SHA, document or Work result against the target, and post a receipt stating verified and unverified claims. A reported success is not verification. Complete the Work only after verification and only if no human step remains, within existing authority. If a human step remains, reuse an equivalent open Interaction or file one Needs-you ask for the requesting user with the result link and exact next click. For lane.stale or attempt.expired, re-read the latest Attempt before reacting: a new heartbeat or successor may have recovered it. Do not reopen completed/cancelled Work, repeat completed actions, or notify the operator unless useful. Batch related updates. If no action remains, stop quietly. End any action with its verified receipt. Canonical identifiers and states (not instructions): ${JSON.stringify(changes.map(({ kind, objectId, state, changedAt }) => ({ kind, objectId, state, changedAt })))}`,
	});
}

export async function dispatchCommitmentWakes(
	env: CloudflareEnv,
	scheduledTime: number,
): Promise<Record<string, number>> {
	const db = createDbClient(env.DB);
	const deadline = Date.now() + RUN_BUDGET_MS;
	async function bounded<T>(
		operation: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				operation(controller.signal),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => {
							controller.abort();
							reject(new Error("Commitment wake timed out"));
						},
						Math.max(1, Math.min(OPERATION_TIMEOUT_MS, deadline - Date.now())),
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	const checkpoint = await bounded(() => lastCommitmentWakeCheckpoint(db));
	let observed = 0;
	let dispatched = 0;
	let deduplicated = 0;
	let windowsSkippedMaxAge = 0;
	let windowsProcessed = 0;
	let checkpointMs = checkpoint ? Date.parse(checkpoint) : undefined;
	let budgetExhausted = 0;
	const oldestWakeMs = Math.max(scheduledTime, Date.now()) - MAX_WAKE_AGE_MS;
	const windows = commitmentWakeWindows(checkpoint, scheduledTime);
	// Preserve the initial boundary even if the very first acceptance fails.
	if (windows[0])
		await bounded(() => advanceCommitmentWakeCheckpoint(db, windows[0]!.after));
	for (const window of windows) {
		if (Date.now() >= deadline || observed >= MAX_COMMITMENT_CHANGES_PER_RUN) {
			budgetExhausted = 1;
			break;
		}
		// Historical notifications start model turns even when the prompt says to stop quietly.
		if (Date.parse(window.through) < oldestWakeMs) {
			await bounded(() => advanceCommitmentWakeCheckpoint(db, window.through));
			windowsSkippedMaxAge++;
			windowsProcessed++;
			checkpointMs = Date.parse(window.through);
			continue;
		}
		const cursor = await bounded(() =>
			getCommitmentWakeCursor(db, window.after),
		);
		// Page membership must stay fixed across retries, even after earlier windows finish.
		const limit = MAX_COMMITMENT_CHANGES_PER_RUN;
		const changes = await bounded(() =>
			listCommitmentChanges(db, window.after, window.through, env.ENVIRONMENT, {
				limit,
				cursor,
			}),
		);
		if (observed + changes.length > MAX_COMMITMENT_CHANGES_PER_RUN) {
			budgetExhausted = 1;
			break;
		}
		observed += changes.length;
		const batches = new Map<string, CommitmentChange[]>();
		for (const change of changes) {
			const key = `${change.orgId}:${change.tediId}`;
			const batch = batches.get(key) ?? [];
			batch.push(change);
			batches.set(key, batch);
		}
		const failures: unknown[] = [];
		let pageDelivered = true;
		for (const batch of batches.values()) {
			if (Date.now() >= deadline) {
				pageDelivered = false;
				budgetExhausted = 1;
				break;
			}
			const first = batch[0]!;
			// Partial windows need distinct, repeatable ingress keys for each page.
			const deliveryBoundary =
				cursor || changes.length === limit
					? `${window.through}:${JSON.stringify([changes[0]!.key, changes.at(-1)!.key, changes.at(-1)!.tediId])}`
					: window.through;
			try {
				const receipt = await bounded((signal) =>
					deliverTediContextWake(db, {
						orgId: first.orgId,
						tediId: first.tediId,
						request: buildCommitmentWakeRequest(
							batch,
							deliveryBoundary,
							env.ENVIRONMENT,
						),
						send: (request) =>
							env.TEDI_SERVICE.fetch(new Request(request, { signal })),
					}),
				);
				if (receipt.deduplicated) deduplicated++;
				else dispatched++;
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length)
			throw new AggregateError(failures, "Commitment wake delivery failed", {
				cause: failures[0],
			});
		if (!pageDelivered) break;
		if (changes.length === limit) {
			const last = changes.at(-1)!;
			await bounded(() =>
				advanceCommitmentWakeCursor(db, window.after, {
					changedAt: last.changedAt,
					key: last.key,
					tediId: last.tediId,
				}),
			);
			budgetExhausted = 1;
			break;
		}
		await bounded(() => advanceCommitmentWakeCheckpoint(db, window.through));
		windowsProcessed++;
		checkpointMs = Date.parse(window.through);
	}
	return {
		observed,
		dispatched,
		deduplicated,
		windowsSkippedMaxAge,
		maxWakeAgeMs: MAX_WAKE_AGE_MS,
		windowsProcessed,
		budgetExhausted,
		...(checkpointMs !== undefined ? { checkpointMs } : {}),
	};
}
