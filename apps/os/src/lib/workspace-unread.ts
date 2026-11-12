import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { WorkspaceUnreadState } from "@tedix/api-contract/schemas/workspace-unread";
import { osQuery } from "@/lib/os-query-options";
import { subscribeOutputRevisionNotices } from "@/lib/output-revision-notices";

/**
 * What is new for the signed-in person: chat messages, agent results and file
 * changes by others, per workspace.
 *
 * Counts arrive live for the workspace on screen (its room and its chat
 * connection tell this tab when to look again). Everything else is checked
 * when the person comes back to the tab and on a slow timer while it is
 * visible, never in a hidden tab.
 */

/** How often a visible tab re-reads counts for workspaces it has no live connection to. */
export const UNREAD_RECHECK_MS = 60_000;
/** The activity feed trails a write by a moment; wait before re-reading. */
const UNREAD_REFRESH_DELAY_MS = 1_200;

export const unreadSummaryQueryOptions = () => ({
	...osQuery.workspaceUnread.summary.queryOptions({ input: {} }),
	staleTime: 15_000,
	refetchInterval: UNREAD_RECHECK_MS,
	refetchIntervalInBackground: false,
	refetchOnWindowFocus: true,
});

export const workspaceUnreadQueryOptions = (workspaceId: string) => ({
	...osQuery.workspaceUnread.workspace.queryOptions({ input: { workspaceId } }),
	staleTime: 15_000,
	refetchOnWindowFocus: true,
});

export const unreadListQueryOptions = () => ({
	...osQuery.workspaceUnread.list.queryOptions({ input: {} }),
	staleTime: 0,
});

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Re-read every unread query once, shortly after something changed. */
export function refreshUnread(
	queryClient: QueryClient,
	delay = UNREAD_REFRESH_DELAY_MS,
) {
	if (refreshTimer) clearTimeout(refreshTimer);
	refreshTimer = setTimeout(() => {
		refreshTimer = null;
		void queryClient.invalidateQueries({
			queryKey: osQuery.workspaceUnread.key(),
		});
	}, delay);
}

/**
 * The total number of unread items across the person's workspaces, or 0
 * while it is loading or unavailable. Use this for an app icon badge.
 */
export function useUnreadTotal(): number {
	return useQuery(unreadSummaryQueryOptions()).data?.total ?? 0;
}

/** Unread counts for one workspace, from the shared summary. */
export function useWorkspaceUnreadCount(workspaceId: string): number {
	const summary = useQuery(unreadSummaryQueryOptions());
	return (
		summary.data?.workspaces.find((entry) => entry.workspaceId === workspaceId)
			?.total ?? 0
	);
}

export function useMarkWorkspaceRead() {
	const queryClient = useQueryClient();
	return useMutation({
		...osQuery.workspaceUnread.markRead.mutationOptions(),
		onSuccess: (state: WorkspaceUnreadState) => {
			queryClient.setQueryData(
				osQuery.workspaceUnread.workspace.queryKey({
					input: { workspaceId: state.workspaceId },
				}),
				state,
			);
			void queryClient.invalidateQueries({
				queryKey: osQuery.workspaceUnread.summary.key(),
			});
			void queryClient.invalidateQueries({
				queryKey: osQuery.workspaceUnread.list.key(),
			});
		},
	});
}

export function useMarkAllRead() {
	const queryClient = useQueryClient();
	return useMutation({
		...osQuery.workspaceUnread.markAllRead.mutationOptions(),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: osQuery.workspaceUnread.key(),
			}),
	});
}

function lookingAtTab(): boolean {
	return document.visibilityState === "visible" && document.hasFocus();
}

/**
 * Unread state of the workspace on screen. It re-reads when a file in the
 * workspace is saved, when the room connection returns, and when `signal`
 * changes (the page passes a value that moves with chat activity).
 *
 * `viewing` names what the person has in front of them. Anything unread there
 * is marked read while the tab is visible and focused, so a message that
 * arrives in the open conversation never becomes a badge.
 */
export function useWorkspaceUnread(
	workspaceId: string,
	options: {
		/** False while no workspace is selected; nothing is read or marked. */
		enabled?: boolean;
		signal?: unknown;
		viewing?: { conversationId?: string | null; outputId?: string | null };
	} = {},
): WorkspaceUnreadState | undefined {
	const queryClient = useQueryClient();
	const enabled = options.enabled ?? true;
	const unread = useQuery({
		...workspaceUnreadQueryOptions(workspaceId),
		enabled,
	}).data;
	const { mutate, isPending } = useMarkWorkspaceRead();

	useEffect(() => {
		if (!enabled) return;
		return subscribeOutputRevisionNotices(workspaceId, () =>
			refreshUnread(queryClient),
		);
	}, [enabled, queryClient, workspaceId]);

	const firstSignal = useRef(true);
	const { signal } = options;
	useEffect(() => {
		if (firstSignal.current) {
			firstSignal.current = false;
			return;
		}
		refreshUnread(queryClient);
	}, [queryClient, signal]);

	const conversationId = options.viewing?.conversationId ?? null;
	const outputId = options.viewing?.outputId ?? null;
	// The first visit starts the person's marker; nothing older is ever unread.
	const started = useRef<string | null>(null);
	useEffect(() => {
		if (!enabled || started.current === workspaceId) return;
		started.current = workspaceId;
		mutate({ workspaceId, target: { type: "visit" } });
	}, [enabled, mutate, workspaceId]);

	const unreadHere =
		enabled && unread?.workspaceId === workspaceId ? unread : undefined;
	const chatUnread =
		conversationId !== null &&
		!!unreadHere?.conversations.some(
			(entry) =>
				entry.conversationId === conversationId || entry.conversationId === "",
		);
	const fileUnread =
		outputId !== null && !!unreadHere?.fileIds.includes(outputId);
	useEffect(() => {
		if (isPending || (!chatUnread && !fileUnread)) return;
		const mark = () => {
			if (!lookingAtTab()) return;
			if (chatUnread && conversationId)
				mutate({ workspaceId, target: { type: "chat", conversationId } });
			else if (fileUnread && outputId)
				mutate({ workspaceId, target: { type: "file", outputId } });
		};
		mark();
		window.addEventListener("focus", mark);
		document.addEventListener("visibilitychange", mark);
		return () => {
			window.removeEventListener("focus", mark);
			document.removeEventListener("visibilitychange", mark);
		};
	}, [
		chatUnread,
		conversationId,
		fileUnread,
		isPending,
		mutate,
		outputId,
		workspaceId,
	]);

	return unreadHere;
}
