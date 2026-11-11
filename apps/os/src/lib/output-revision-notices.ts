import type { WorkspaceOutputRevisionNotice } from "@tedix/api-contract/utils/workspace-room";

/**
 * Change notices for the files of the workspace on screen.
 *
 * The API tells the workspace's live room when a file gets a new revision;
 * the room connection every open workspace tab already holds
 * (`useWorkspacePresence`) hands each notice to `publishOutputRevisionNotice`.
 * An open editor listens here, so it learns of someone else's save at once
 * and fetches only what changed. A connection that comes back after a gap
 * publishes a `resync`, because notices sent meanwhile are gone.
 */
export type OutputRevisionEvent =
	| ({ type: "revision"; workspaceId: string } & WorkspaceOutputRevisionNotice)
	| { type: "resync"; workspaceId: string };

type Listener = (event: OutputRevisionEvent) => void;
const listeners = new Map<string, Set<Listener>>();

export function subscribeOutputRevisionNotices(
	workspaceId: string,
	listener: Listener,
): () => void {
	const set = listeners.get(workspaceId) ?? new Set<Listener>();
	listeners.set(workspaceId, set);
	set.add(listener);
	return () => {
		set.delete(listener);
		if (set.size === 0) listeners.delete(workspaceId);
	};
}

export function publishOutputRevisionNotice(event: OutputRevisionEvent): void {
	for (const listener of [...(listeners.get(event.workspaceId) ?? [])])
		listener(event);
}

/** Listeners across all workspaces; tests assert nothing is left behind. */
export function outputRevisionListenerCount(): number {
	let count = 0;
	for (const set of listeners.values()) count += set.size;
	return count;
}
