import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState } from "react";
import { osApi } from "@/lib/api";
import { reconcileLiveWorkspace } from "@/lib/live-workspace-projection";
import { osQuery } from "@/lib/os-query-options";
import { isWorkspaceAccessDenied } from "@/lib/workspace-verification";

/** Longest the server holds one request before answering "nothing new". */
const WAIT_MS = 20_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 15_000;

/**
 * How often workspace reads recheck while the event stream is open. Events
 * normally refresh them at once; this only covers a hint that never arrived.
 */
export const WORKSPACE_STREAM_FALLBACK_MS = 60_000;

const WorkspaceEventStreamOpenContext = createContext(false);
export const WorkspaceEventStreamProvider =
	WorkspaceEventStreamOpenContext.Provider;

/** True while this workspace's server event stream is connected. */
export function useWorkspaceEventStreamOpen(): boolean {
	return useContext(WorkspaceEventStreamOpenContext);
}

/**
 * The interval a workspace read polls at: its own fast cadence until the
 * stream is open, then the slow fallback. `false` stays `false`.
 */
export function workspacePollMs(
	streamOpen: boolean,
	fastMs: number | false,
): number | false {
	if (fastMs === false) return false;
	return streamOpen ? WORKSPACE_STREAM_FALLBACK_MS : fastMs;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * Follows one workspace's server events: access, proposals, runs and drafts.
 * Each hint refetches the canonical reads; it never carries data. A broken
 * stream reports closed (readers return to their fast polling), retries with
 * backoff, and refetches everything once it reconnects because events may
 * have been missed. A refused stream means access changed, so the access
 * check reruns at once.
 */
export function useWorkspaceEventStream(workspaceId: string): boolean {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const controller = new AbortController();
		void followWorkspaceEvents({
			queryClient,
			workspaceId,
			signal: controller.signal,
			setOpen,
		});
		return () => {
			controller.abort();
			setOpen(false);
		};
	}, [queryClient, workspaceId]);
	return open;
}

export async function followWorkspaceEvents(params: {
	queryClient: QueryClient;
	workspaceId: string;
	signal: AbortSignal;
	setOpen: (open: boolean) => void;
}): Promise<void> {
	const { queryClient, workspaceId, signal } = params;
	let cursor: number | undefined;
	let retryMs = RETRY_MIN_MS;
	let gap = false;
	while (!signal.aborted) {
		try {
			if (cursor === undefined) {
				cursor = (
					await osApi.osCollaborators.events({ workspaceId }, { signal })
				).cursor;
				params.setOpen(true);
				retryMs = RETRY_MIN_MS;
				if (gap) reconcileLiveWorkspace(queryClient, { workspaceId });
				gap = false;
				continue;
			}
			const next = await osApi.osCollaborators.events(
				{ workspaceId, after: cursor, waitMs: WAIT_MS },
				{ signal },
			);
			if (signal.aborted) return;
			cursor = next.cursor;
			if (next.kinds.length > 0) {
				reconcileLiveWorkspace(queryClient, { workspaceId });
			}
		} catch (error) {
			if (signal.aborted) return;
			params.setOpen(false);
			gap = true;
			cursor = undefined;
			if (isWorkspaceAccessDenied(error)) {
				void queryClient.invalidateQueries({
					queryKey: osQuery.osCollaborators.access.key({
						type: "query",
						input: { workspaceId },
					}),
				});
			}
			await sleep(retryMs, signal);
			retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
		}
	}
}
