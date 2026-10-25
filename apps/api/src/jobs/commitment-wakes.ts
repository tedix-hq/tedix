import {
	buildTediContextWakeRequest,
	deliverTediContextWake,
} from "./tedi-context-wake";
import { createDbClient } from "@tedix/db/client";
import {
	buildRuntimeRunId,
	buildTediConversationId,
} from "@tedix/api-contract/utils/runtime-identity";
import { listTediRuntimeEventsForRouter } from "@tedix/db/queries/cognitive-runtime";
import { listTediRuntimeEvents } from "@tedix/db/queries/kernel-runtime-events";
import { ensureCommitmentFollowup } from "../services/tedi-context-wake";
import { PlatformCronPathError } from "./platform-cron-receipts";
import {
	advanceCommitmentWakeCheckpoint,
	advanceCommitmentWakeCursor,
	getCommitmentWakeCursor,
	retainCommitmentWakePage,
	listCommitmentWakeRetryPages,
	removeCommitmentWakeRetryPage,
	lastCommitmentWakeCheckpoint,
	listCommitmentChanges,
	type CommitmentChange,
	type CommitmentWakeCursor,
} from "@tedix/db/queries/work-items/commitment-changes";

const WINDOW_MS = 120_000;
const DEBOUNCE_MS = 30_000;
const MAX_REPLAY_WINDOWS = 10;
const MAX_WAKE_AGE_MS = 15 * 60_000;
const COALESCE_ACTIVE_RUN_MS = 5 * 60_000;
export const MAX_COMMITMENT_CHANGES_PER_RUN = 25;
const RUN_BUDGET_MS = 40_000;
const DELIVERY_TIMEOUT_MS = 15_000;
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
	const deliveryDeadline = deadline - OPERATION_TIMEOUT_MS;
	async function bounded<T>(
		operation: (signal: AbortSignal) => Promise<T>,
		timeoutMs = OPERATION_TIMEOUT_MS,
		until = deadline,
	): Promise<T> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				operation(controller.signal),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => {
							reject(new Error("Commitment wake timed out"));
							controller.abort();
						},
						Math.max(1, Math.min(timeoutMs, until - Date.now())),
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
	let deferred = 0;
	let retried = 0;
	let failed = 0;
	let windowsSkippedMaxAge = 0;
	let windowsProcessed = 0;
	let checkpointMs = checkpoint ? Date.parse(checkpoint) : undefined;
	let budgetExhausted = 0;
	const counts = () => ({
		observed,
		dispatched,
		deduplicated,
		deferred,
		retried,
		failed,
		windowsSkippedMaxAge,
		maxWakeAgeMs: MAX_WAKE_AGE_MS,
		windowsProcessed,
		budgetExhausted,
		...(checkpointMs !== undefined ? { checkpointMs } : {}),
	});
	const oldestWakeMs = Math.max(scheduledTime, Date.now()) - MAX_WAKE_AGE_MS;
	const windows = commitmentWakeWindows(checkpoint, scheduledTime);
	// Preserve the initial boundary even if the very first acceptance fails.
	if (windows[0])
		await bounded(() => advanceCommitmentWakeCheckpoint(db, windows[0]!.after));
	// Fresh work runs first so a poison retry cannot consume every run's budget.
	const retryPages = await bounded(() => listCommitmentWakeRetryPages(db));
	const pages: Array<{
		after: string;
		through: string;
		retryId?: string;
		retryCursor?: CommitmentWakeCursor | null;
	}> = [
		...windows,
		...retryPages.map((page) => ({
			after: new Date(Date.parse(page.through) - WINDOW_MS).toISOString(),
			through: page.through,
			retryId: page.scheduleId,
			retryCursor: page.cursor,
		})),
	];
	const failures: unknown[] = [];
	for (const window of pages) {
		if (
			Date.now() >= deliveryDeadline ||
			observed >= MAX_COMMITMENT_CHANGES_PER_RUN
		) {
			budgetExhausted = 1;
			break;
		}
		// Historical notifications start model turns even when the prompt says to stop quietly.
		if (Date.parse(window.through) < oldestWakeMs) {
			if (window.retryId)
				await bounded(() => removeCommitmentWakeRetryPage(db, window.retryId!));
			else
				await bounded(() =>
					advanceCommitmentWakeCheckpoint(db, window.through),
				);
			windowsSkippedMaxAge++;
			windowsProcessed++;
			if (!window.retryId) checkpointMs = Date.parse(window.through);
			continue;
		}
		const cursor = window.retryId
			? (window.retryCursor ?? null)
			: await bounded(() => getCommitmentWakeCursor(db, window.after));
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
		const failuresBeforePage = failures.length;
		let pageDelivered = true;
		let pageDeferred = false;
		const deliverBatch = async (batch: CommitmentChange[]) => {
			if (Date.now() >= deliveryDeadline) {
				pageDelivered = false;
				budgetExhausted = 1;
				return;
			}
			const first = batch[0]!;
			// Partial windows need distinct, repeatable ingress keys for each page.
			const deliveryBoundary =
				cursor || changes.length === limit
					? `${window.through}:${JSON.stringify([changes[0]!.key, changes.at(-1)!.key, changes.at(-1)!.tediId])}`
					: window.through;
			try {
				const [started] = await bounded(() =>
					listTediRuntimeEventsForRouter(db, {
						tediId: first.tediId,
						conversationId: buildTediConversationId({
							tediRef: first.slug,
							sessionKey: `commitments:${first.tediId}`,
						}),
						kind: "run.started",
						order: "desc",
						limit: 1,
					}),
				);
				const activeRunId = started?.runId;
				if (
					started?.organizationId === first.orgId &&
					activeRunId &&
					Date.parse(started.createdAt) >
						Math.max(scheduledTime, Date.now()) - COALESCE_ACTIVE_RUN_MS &&
					activeRunId !==
						buildRuntimeRunId({
							tediId: first.tediId,
							surface: "mcp",
							turnKey: `commitments:${first.orgId}:${first.tediId}:${deliveryBoundary}`,
						})
				) {
					const terminal = await bounded(() =>
						listTediRuntimeEvents(db, {
							organizationId: first.orgId,
							tediId: first.tediId,
							runId: activeRunId,
							kinds: ["run.completed", "run.failed", "run.canceled"],
							limit: 1,
						}),
					);
					if (!terminal.length) {
						deferred++;
						pageDeferred = true;
						return;
					}
				}
				for (const change of batch)
					await bounded(() =>
						ensureCommitmentFollowup(
							db,
							change,
							new Date(scheduledTime).toISOString(),
						),
					);
				const deliver = () =>
					bounded(
						(signal) =>
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
						DELIVERY_TIMEOUT_MS,
						deliveryDeadline,
					);
				let receipt;
				try {
					receipt = await deliver();
				} catch (error) {
					if (Date.now() >= deliveryDeadline) throw error;
					retried++;
					receipt = await deliver();
				}
				if (receipt.deduplicated) deduplicated++;
				else dispatched++;
			} catch (error) {
				failed++;
				failures.push(error);
			}
		};
		const pendingBatches = batches.values();
		await Promise.all(
			Array.from({ length: Math.min(4, batches.size) }, async () => {
				for (const batch of pendingBatches) await deliverBatch(batch);
			}),
		);
		// A busy session has not seen these changes: retain both page and cursor.
		if (pageDeferred) {
			if (window.retryId) continue;
			break;
		}
		if (failures.length > failuresBeforePage || !pageDelivered)
			await bounded(() => retainCommitmentWakePage(db, window.through, cursor));
		if (window.retryId) {
			if (pageDelivered && failures.length === failuresBeforePage)
				await bounded(() => removeCommitmentWakeRetryPage(db, window.retryId!));
			continue;
		}
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
	if (failures.length)
		throw new PlatformCronPathError(
			failures,
			"Commitment wake delivery failed",
			counts(),
		);
	return counts();
}
