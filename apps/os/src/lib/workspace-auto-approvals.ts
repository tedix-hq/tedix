import { useSyncExternalStore } from "react";
import type {
	AutoApprovalKind,
	AutoApprovalRule,
} from "./workspace-chat-protocol";

/**
 * The open workspace chat's "Always approve" rules. The rules live in the
 * workspace object and reach the browser over the chat's connection, so the
 * chat publishes them here for the Activity and approvals panel to list and
 * turn off.
 */
export type PublishedAutoApprovals = {
	workspaceId: string;
	rules: readonly AutoApprovalRule[];
	/** Null while the chat is not connected. */
	setRule: ((kind: AutoApprovalKind, enabled: boolean) => void) | null;
};

let current: PublishedAutoApprovals | null = null;
const listeners = new Set<() => void>();

export function publishWorkspaceAutoApprovals(
	next: PublishedAutoApprovals | null,
): void {
	if (
		next === current ||
		(next &&
			current &&
			next.workspaceId === current.workspaceId &&
			next.rules === current.rules &&
			next.setRule === current.setRule)
	)
		return;
	current = next;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useWorkspaceAutoApprovals(
	workspaceId: string,
): PublishedAutoApprovals | null {
	const published = useSyncExternalStore(
		subscribe,
		() => current,
		() => current,
	);
	return published?.workspaceId === workspaceId ? published : null;
}
