/**
 * The consumer side: turn a queue batch into projection writes.
 *
 * Messages are grouped per workspace and applied in `seq` order through
 * `applyWorkspaceChangeEvents`, which enforces the `(workspaceId, seq)`
 * idempotency key. A message the projection already holds is acknowledged;
 * one that arrives ahead of a missing predecessor is retried with a delay so
 * the queue redelivers it after the gap closes.
 */

import type { WorkspaceChangeEvent } from "@tedix/api-contract/schemas/workspace-feed";
import { applyWorkspaceChangeEvents } from "@tedix/db/queries/workspace-feed/projection";
import type { DbQueryClient } from "@tedix/db/query-client";
import { parseWorkspaceChangeMessage } from "./event";

/** The slice of a queue `Message` the consumer drives. */
export interface WorkspaceFeedMessage {
	body: unknown;
	ack(): void;
	retry(options?: { delaySeconds?: number }): void;
}

export type WorkspaceFeedMessageOutcome =
	| "applied"
	| "duplicate"
	| "gap"
	| "poison"
	| "failed";

export interface WorkspaceFeedConsumerResult {
	outcomes: WorkspaceFeedMessageOutcome[];
	applied: number;
}

/** How long a message waits for its missing predecessor before redelivery. */
export const WORKSPACE_FEED_GAP_RETRY_SECONDS = 5;

export interface WorkspaceFeedConsumer {
	/** Apply one batch. Every message is acked or retried before this resolves. */
	consume(
		messages: readonly WorkspaceFeedMessage[],
	): Promise<WorkspaceFeedConsumerResult>;
	/** Apply already-parsed events (tests, in-process replay). */
	applyEvents(
		events: readonly WorkspaceChangeEvent[],
	): Promise<Map<string, "applied" | "duplicate" | "gap">>;
}

export function createWorkspaceFeedConsumer(deps: {
	db: DbQueryClient;
	now?: () => Date;
	log?: (message: string, detail?: Record<string, unknown>) => void;
}): WorkspaceFeedConsumer {
	const log = deps.log ?? (() => {});
	const applyEvents: WorkspaceFeedConsumer["applyEvents"] = async (events) => {
		const byWorkspace = new Map<string, WorkspaceChangeEvent[]>();
		for (const event of events) {
			const list = byWorkspace.get(event.workspaceId) ?? [];
			list.push(event);
			byWorkspace.set(event.workspaceId, list);
		}
		const result = new Map<string, "applied" | "duplicate" | "gap">();
		const appliedAt = (deps.now?.() ?? new Date()).toISOString();
		for (const [workspaceId, group] of byWorkspace) {
			const applied = await applyWorkspaceChangeEvents(deps.db, group, {
				appliedAt,
			});
			for (const [seq, outcome] of applied.outcomes)
				result.set(`${workspaceId}:${seq}`, outcome);
		}
		return result;
	};

	return {
		applyEvents,
		async consume(messages) {
			const outcomes: WorkspaceFeedMessageOutcome[] = new Array(
				messages.length,
			).fill("poison");
			const parsed: { index: number; event: WorkspaceChangeEvent }[] = [];
			messages.forEach((message, index) => {
				const change = parseWorkspaceChangeMessage(message.body);
				if (!change) {
					log("[workspace-feed] poison message acked");
					message.ack();
					return;
				}
				parsed.push({ index, event: change.event });
			});
			let applied = 0;
			if (parsed.length > 0) {
				let result: Awaited<ReturnType<typeof applyEvents>> | null = null;
				try {
					result = await applyEvents(parsed.map((entry) => entry.event));
				} catch (error) {
					log("[workspace-feed] apply failed; retrying batch", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
				const seen = new Set<string>();
				for (const { index, event } of parsed) {
					const message = messages[index]!;
					const key = `${event.workspaceId}:${event.seq}`;
					// The same seq twice in one batch: the first copy carries the
					// projection's answer, every later copy is a duplicate.
					const outcome = seen.has(key) ? "duplicate" : result?.get(key);
					seen.add(key);
					if (!result || !outcome) {
						outcomes[index] = "failed";
						message.retry();
						continue;
					}
					outcomes[index] = outcome;
					if (outcome === "gap") {
						message.retry({ delaySeconds: WORKSPACE_FEED_GAP_RETRY_SECONDS });
						continue;
					}
					if (outcome === "applied") applied += 1;
					message.ack();
				}
			}
			return { outcomes, applied };
		},
	};
}
