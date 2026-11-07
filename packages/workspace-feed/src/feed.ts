/**
 * The producer side: what a workspace object calls after each write.
 *
 * `emit` records the change in the ledger and sends it on the queue. The
 * ledger write is the durable part; a failed send is recovered by
 * `replayFrom`, and the consumer's `(workspaceId, seq)` cursor makes a
 * repeated send harmless.
 */

import type {
	WorkspaceChangeEvent,
	WorkspaceChangeInput,
	WorkspaceChangeQueueMessage,
	WorkspaceFeedSnapshot,
} from "@tedix/api-contract/schemas/workspace-feed";
import { toWorkspaceChangeMessage } from "./event";

/** The slice of a Cloudflare Queue binding the feed uses. */
export interface WorkspaceFeedQueue {
	send(
		message: WorkspaceChangeQueueMessage,
		options?: { contentType?: "json" },
	): Promise<void>;
	sendBatch?(
		messages: Iterable<{ body: WorkspaceChangeQueueMessage }>,
	): Promise<void>;
}

/** Any ledger: the object's SQLite ledger or the core-side one. */
export interface WorkspaceFeedSource {
	append(
		input: WorkspaceChangeInput,
	): WorkspaceChangeEvent | Promise<WorkspaceChangeEvent>;
	listFrom(
		fromSeq: number,
		limit?: number,
	): WorkspaceChangeEvent[] | Promise<WorkspaceChangeEvent[]>;
	snapshot(): WorkspaceFeedSnapshot | Promise<WorkspaceFeedSnapshot>;
}

export interface WorkspaceFeed {
	/** Record and send one change; returns the event with its `seq`. */
	emit(input: WorkspaceChangeInput): Promise<WorkspaceChangeEvent>;
	/** Re-send every ledger entry from `fromSeq`; returns how many went out. */
	replayFrom(
		fromSeq: number,
		options?: { limit?: number },
	): Promise<{ sent: number; lastSeq: number }>;
	/** The object's side of the reconciler comparison. */
	snapshot(): Promise<WorkspaceFeedSnapshot>;
}

const REPLAY_PAGE = 100;

export function createWorkspaceFeed(deps: {
	ledger: WorkspaceFeedSource;
	queue: WorkspaceFeedQueue;
}): WorkspaceFeed {
	const sendAll = async (events: readonly WorkspaceChangeEvent[]) => {
		if (events.length === 0) return;
		if (deps.queue.sendBatch) {
			await deps.queue.sendBatch(
				events.map((event) => ({ body: toWorkspaceChangeMessage(event) })),
			);
			return;
		}
		for (const event of events) {
			await deps.queue.send(toWorkspaceChangeMessage(event), {
				contentType: "json",
			});
		}
	};
	return {
		async emit(input) {
			const event = await deps.ledger.append(input);
			await deps.queue.send(toWorkspaceChangeMessage(event), {
				contentType: "json",
			});
			return event;
		},
		async replayFrom(fromSeq, options = {}) {
			let sent = 0;
			let lastSeq = Math.max(fromSeq - 1, 0);
			let cursor = Math.max(fromSeq, 1);
			const limit = options.limit ?? Number.POSITIVE_INFINITY;
			while (sent < limit) {
				const page = await deps.ledger.listFrom(
					cursor,
					Math.min(REPLAY_PAGE, limit - sent),
				);
				if (page.length === 0) break;
				await sendAll(page);
				sent += page.length;
				lastSeq = page[page.length - 1]!.seq;
				cursor = lastSeq + 1;
			}
			return { sent, lastSeq };
		},
		snapshot: () => Promise.resolve(deps.ledger.snapshot()),
	};
}
