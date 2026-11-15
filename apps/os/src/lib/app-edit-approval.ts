import { useSyncExternalStore } from "react";

/**
 * A chat agent's request to revise an app's source (`apps.revise`): the app,
 * the full next file set, and the revision number it was written against.
 */
export type AppEditRequest = {
	appId: string;
	files: Record<string, string>;
	expectedRevision: number;
};

export function appEditRequestFrom(input: unknown): AppEditRequest | null {
	if (!input || typeof input !== "object") return null;
	const { appId, files, expectedRevision } = input as Record<string, unknown>;
	if (typeof appId !== "string" || !appId) return null;
	if (typeof expectedRevision !== "number") return null;
	if (!files || typeof files !== "object" || Array.isArray(files)) return null;
	const entries = Object.entries(files);
	if (!entries.every(([, text]) => typeof text === "string")) return null;
	return { appId, files: Object.fromEntries(entries), expectedRevision };
}

export type PendingAppEdit = AppEditRequest & {
	workspaceId: string;
	approvalId: string;
	decide: (decision: "approve" | "deny") => void;
};

/**
 * Edits waiting for a decision in the workspace chat. The chat publishes them
 * so the open app tab can show the same change with the same buttons.
 */
let pending: readonly PendingAppEdit[] = [];
const listeners = new Set<() => void>();

export function publishPendingAppEdits(next: readonly PendingAppEdit[]): void {
	const same =
		next.length === pending.length &&
		next.every(
			(edit, index) =>
				edit.approvalId === pending[index]?.approvalId &&
				edit.decide === pending[index]?.decide,
		);
	if (same) return;
	pending = next;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function usePendingAppEdits(
	workspaceId: string,
	appId: string,
): PendingAppEdit[] {
	const all = useSyncExternalStore(
		subscribe,
		() => pending,
		() => pending,
	);
	return all.filter(
		(edit) => edit.workspaceId === workspaceId && edit.appId === appId,
	);
}
