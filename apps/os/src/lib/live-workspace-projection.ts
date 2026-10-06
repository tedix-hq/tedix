import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { ConversationStreamStatus } from "@/lib/conversation-stream";
import {
	activeWorkspacesQueryOptions,
	canvasGadgetDetailQueryOptions,
	canvasGadgetsQueryOptions,
	canvasOutputsQueryOptions,
	outputDetailQueryOptions,
} from "@/lib/os-query-options";

/**
 * A workspace event is only actionable when the server names its workspace.
 * D1/API remains canonical; this projection never invents rows from an event.
 */
export type LiveWorkspaceReference = {
	workspaceId: string;
	gadgetId?: string;
	outputId?: string;
};

export type LiveWorkspaceScope = LiveWorkspaceReference;

type WorkspaceEventListener = (event: RuntimeStreamEvent) => void;

const listeners = new Map<string, Set<WorkspaceEventListener>>();

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Reads the identifiers canonical producers put on the event payload. Artifact
 * events carry their domain identifiers in `artifact.metadata`; direct domain
 * events may carry them at the payload root or inside their resource row.
 */
export function workspaceReferenceFromEvent(
	event: RuntimeStreamEvent,
): LiveWorkspaceReference | null {
	const payload = record(event.payload);
	if (!payload) return null;
	const output = record(payload.output);
	const gadget = record(payload.gadget);
	const workspace = record(payload.workspace);
	const resource = record(payload.resource);
	const artifact = record(payload.artifact);
	const metadata = record(artifact?.metadata);
	const workspaceId =
		text(payload.workspaceId) ??
		text(output?.workspaceId) ??
		text(gadget?.workspaceId) ??
		text(workspace?.id) ??
		text(resource?.workspaceId) ??
		text(metadata?.workspaceId);
	if (!workspaceId) return null;
	return {
		workspaceId,
		gadgetId:
			text(payload.gadgetId) ??
			text(gadget?.id) ??
			text(resource?.gadgetId) ??
			text(metadata?.gadgetId),
		outputId:
			text(payload.outputId) ??
			text(output?.id) ??
			text(resource?.outputId) ??
			text(metadata?.outputId),
	};
}

export function subscribeLiveWorkspace(
	workspaceId: string,
	listener: WorkspaceEventListener,
): () => void {
	const workspaceListeners = listeners.get(workspaceId) ?? new Set();
	workspaceListeners.add(listener);
	listeners.set(workspaceId, workspaceListeners);
	return () => {
		workspaceListeners.delete(listener);
		if (workspaceListeners.size === 0) listeners.delete(workspaceId);
	};
}

/** Called once at the shared stream pump, before fan-out reaches any surface. */
export function publishLiveWorkspaceEvent(event: RuntimeStreamEvent): void {
	const reference = workspaceReferenceFromEvent(event);
	if (!reference) return;
	for (const listener of listeners.get(reference.workspaceId) ?? []) {
		listener(event);
	}
}

function workspaceQueryKeys(scope: LiveWorkspaceScope): QueryKey[] {
	const keys: QueryKey[] = [
		activeWorkspacesQueryOptions().queryKey,
		canvasGadgetsQueryOptions(scope.workspaceId).queryKey,
		canvasOutputsQueryOptions(scope.workspaceId).queryKey,
	];
	if (scope.gadgetId) {
		keys.push(
			canvasGadgetDetailQueryOptions(scope.workspaceId, scope.gadgetId)
				.queryKey,
		);
	}
	if (scope.outputId) {
		keys.push(outputDetailQueryOptions(scope.outputId).queryKey);
	}
	return keys;
}

/** Refetches only the active workspace projection from its D1/API owners. */
export function reconcileLiveWorkspace(
	queryClient: QueryClient,
	scope: LiveWorkspaceScope,
): void {
	for (const queryKey of workspaceQueryKeys(scope)) {
		void queryClient.invalidateQueries({ queryKey, exact: true });
	}
}

export function reconcileLiveWorkspaceEvent(
	queryClient: QueryClient,
	workspaceId: string,
	event: RuntimeStreamEvent,
): boolean {
	const reference = workspaceReferenceFromEvent(event);
	if (!reference || reference.workspaceId !== workspaceId) return false;
	reconcileLiveWorkspace(queryClient, reference);
	return true;
}

/**
 * Reconnect recovery is deliberately a canonical read, not replay projection:
 * Workspace mutations can originate outside the followed Home conversation.
 */
export function createWorkspaceReconnectReconciler(
	queryClient: QueryClient,
	getScope: () => LiveWorkspaceScope,
): (status: ConversationStreamStatus) => void {
	let gapObserved = false;
	return (status) => {
		if (status === "connecting" || status === "reconnecting") {
			gapObserved = true;
			return;
		}
		if (status !== "open" || !gapObserved) return;
		gapObserved = false;
		reconcileLiveWorkspace(queryClient, getScope());
	};
}

/** Clears workspace listeners when browser capabilities are torn down. */
export function resetLiveWorkspaceSubscribers(): void {
	listeners.clear();
}

/** Observable ownership invariant used by lifecycle tests and diagnostics. */
/** @internal */
export function liveWorkspaceSubscriberCount(): number {
	let count = 0;
	for (const workspaceListeners of listeners.values()) {
		count += workspaceListeners.size;
	}
	return count;
}
