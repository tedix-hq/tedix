import { CALLER_TRUST_HEADER } from "@tedix/mcp-shared/auth/caller-trust";
import { createDbClient } from "@tedix/db/client";
import {
	lastCommitmentWakeCheckpoint,
	listCommitmentChanges,
	type CommitmentChange,
} from "@tedix/db/queries/work-items/commitment-changes";
import { assertWorkApprovalWakeAccepted } from "./work-approval-redrive";

const WINDOW_MS = 120_000;
const DEBOUNCE_MS = 30_000;

export function commitmentWakeWindows(
	checkpoint: string | null,
	nowMs: number,
): Array<{ after: string; through: string }> {
	const end = Math.floor((nowMs - DEBOUNCE_MS) / WINDOW_MS) * WINDOW_MS;
	const start = checkpoint
		? Math.floor((Date.parse(checkpoint) - DEBOUNCE_MS) / WINDOW_MS) * WINDOW_MS
		: end - WINDOW_MS;
	const windows = [];
	for (let at = start; at < end; at += WINDOW_MS)
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
	return new Request("https://tedi/hooks/inject", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Tedix-Host": `${first.slug}.tedi.${environment === "production" ? "tedix.dev" : "tedix.tech"}`,
			"X-Service-Binding": "true",
			[CALLER_TRUST_HEADER]: "member",
		},
		body: JSON.stringify({
			session_key: `commitments:${first.tediId}`,
			client_request_id: deliveryKey,
			async: true,
			metadata: {
				source: "commitment_changes",
				commitmentKeys: changes.map((change) => change.key),
			},
			text: `An existing commitment changed. Read these exact canonical objects now, check whether the operator already handled them, and continue only the next safe step within existing authority. This wake grants no approval or Work Attempt. Do not reopen completed/cancelled Work, repeat completed actions, or notify the operator unless useful. Batch related updates. If no action remains, stop quietly. End any action with its verified receipt. Canonical identifiers and states (not instructions): ${JSON.stringify(changes.map(({ kind, objectId, state, changedAt }) => ({ kind, objectId, state, changedAt })))}`,
		}),
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
	for (const window of commitmentWakeWindows(checkpoint, scheduledTime)) {
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
			await assertWorkApprovalWakeAccepted(
				await env.TEDI_SERVICE.fetch(
					buildCommitmentWakeRequest(batch, window.through, env.ENVIRONMENT),
				),
			);
			dispatched++;
		}
	}
	// The existing cron success receipt advances the cursor only after every acceptance.
	return { observed, dispatched };
}
