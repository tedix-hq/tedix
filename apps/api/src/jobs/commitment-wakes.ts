import {
	buildTediContextWakeRequest,
	deliverTediContextWake,
} from "./tedi-context-wake";
import { createDbClient } from "@tedix/db/client";
import {
	advanceCommitmentWakeCheckpoint,
	lastCommitmentWakeCheckpoint,
	listCommitmentChanges,
	type CommitmentChange,
} from "@tedix/db/queries/work-items/commitment-changes";

const WINDOW_MS = 120_000;
const DEBOUNCE_MS = 30_000;
const MAX_REPLAY_WINDOWS = 10;
const MAX_WAKE_AGE_MS = 15 * 60_000;

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
	const checkpoint = await lastCommitmentWakeCheckpoint(db);
	let observed = 0;
	let dispatched = 0;
	let deduplicated = 0;
	let windowsSkippedMaxAge = 0;
	const oldestWakeMs = Math.max(scheduledTime, Date.now()) - MAX_WAKE_AGE_MS;
	const windows = commitmentWakeWindows(checkpoint, scheduledTime);
	// Preserve the initial boundary even if the very first acceptance fails.
	if (checkpoint === null && windows[0])
		await advanceCommitmentWakeCheckpoint(db, windows[0].after);
	for (const window of windows) {
		// Historical notifications start model turns even when the prompt says to stop quietly.
		if (Date.parse(window.through) < oldestWakeMs) {
			await advanceCommitmentWakeCheckpoint(db, window.through);
			windowsSkippedMaxAge++;
			continue;
		}
		const changes = await listCommitmentChanges(
			db,
			window.after,
			window.through,
			env.ENVIRONMENT,
		);
		observed += changes.length;
		const batches = new Map<string, CommitmentChange[]>();
		for (const change of changes) {
			const key = `${change.orgId}:${change.tediId}`;
			const batch = batches.get(key) ?? [];
			batch.push(change);
			batches.set(key, batch);
		}
		for (const batch of batches.values()) {
			const first = batch[0]!;
			const receipt = await deliverTediContextWake(db, {
				orgId: first.orgId,
				tediId: first.tediId,
				request: buildCommitmentWakeRequest(
					batch,
					window.through,
					env.ENVIRONMENT,
				),
				send: (request) => env.TEDI_SERVICE.fetch(request),
			});
			if (receipt.deduplicated) deduplicated++;
			else dispatched++;
		}
		await advanceCommitmentWakeCheckpoint(db, window.through);
	}
	const lastWindow = windows.at(-1);
	return {
		observed,
		dispatched,
		deduplicated,
		windowsSkippedMaxAge,
		maxWakeAgeMs: MAX_WAKE_AGE_MS,
		windowsProcessed: windows.length,
		...(lastWindow ? { checkpointMs: Date.parse(lastWindow.through) } : {}),
	};
}
