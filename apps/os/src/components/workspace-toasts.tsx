import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { osToastManager } from "@/components/kumo/toast";
import { unreadItemHref } from "@/components/unread-list";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";
import {
	askedConversations,
	conversationOnScreen,
	rememberHandled,
	shownEvents,
	waitingForReplyElsewhere,
	type WorkspaceToast,
	workspaceToasts,
} from "@/lib/workspace-toasts";
import {
	UNREAD_RECHECK_MS,
	unreadListQueryOptions,
	unreadSummaryQueryOptions,
} from "@/lib/workspace-unread";

/** How often to look for a reply the person asked for a few minutes ago. */
const REPLY_RECHECK_MS = 10_000;
const TOAST_MS = 10_000;

/** Show one notice with a button that opens the conversation it is about. */
export function showWorkspaceToast(
	toast: WorkspaceToast,
	open: (href: string) => void,
) {
	const name = sanitizeUntrustedText(toast.workspaceName);
	osToastManager.add({
		id: toast.key,
		title:
			toast.kind === "reply"
				? `${name}: reply ready`
				: `${name}: needs your approval`,
		variant: "info",
		timeout: TOAST_MS,
		actions: [
			{
				children: toast.kind === "reply" ? "Open" : "Review",
				onClick: () => {
					osToastManager.close(toast.key);
					open(unreadItemHref(toast.workspaceId, toast.item));
				},
			},
		],
	});
}

/**
 * Tells the person, wherever they are in Tedix OS, that an agent finished a
 * reply they asked for or is waiting for their approval in a workspace
 * conversation they are not looking at.
 *
 * It follows the unread counts the shell already keeps fresh and reads the
 * unread list only when the chat counts change. What was already unread when
 * the page loaded is never announced.
 */
export function WorkspaceToasts() {
	const router = useRouter();
	const queryClient = useQueryClient();
	// Re-render on navigation: leaving a conversation with a question open
	// switches the counts to the shorter recheck below.
	useRouterState({ select: (state) => state.location.href });
	const summary = useQuery({
		...unreadSummaryQueryOptions(),
		refetchInterval: () =>
			waitingForReplyElsewhere() ? REPLY_RECHECK_MS : UNREAD_RECHECK_MS,
	});
	const chatCounts = summary.data
		? summary.data.workspaces
				.filter((entry) => entry.chat > 0)
				.map((entry) => `${entry.workspaceId}:${entry.chat}`)
				.join(",")
		: null;
	const loaded = useRef(false);
	useEffect(() => {
		if (chatCounts === null) return;
		if (chatCounts === "") {
			loaded.current = true;
			return;
		}
		let stale = false;
		void queryClient
			.fetchQuery(unreadListQueryOptions())
			.then((list) => {
				if (stale) return;
				const found = workspaceToasts(list, {
					shown: shownEvents(),
					asked: askedConversations(),
					viewing: conversationOnScreen(),
				});
				rememberHandled(found.events, found.answered);
				if (loaded.current)
					for (const toast of found.toasts)
						showWorkspaceToast(toast, (href) => router.history.push(href));
				loaded.current = true;
			})
			// The next change in the counts looks again.
			.catch(() => undefined);
		return () => {
			stale = true;
		};
	}, [chatCounts, queryClient, router]);
	return null;
}
