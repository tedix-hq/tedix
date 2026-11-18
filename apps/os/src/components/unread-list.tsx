import { Checks } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { WorkspaceUnreadItem } from "@tedix/api-contract/schemas/workspace-unread";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Empty } from "@/components/kumo/empty";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import { absoluteTime, relativeTime } from "@/lib/time";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";
import {
	unreadListQueryOptions,
	useMarkAllRead,
	useMarkWorkspaceRead,
} from "@/lib/workspace-unread";

const CHAT_LABELS: Record<
	Exclude<WorkspaceUnreadItem["kind"], "file">,
	string
> = {
	message: "New chat message",
	agent_reply: "An agent replied in chat",
	agent_stopped: "An agent run stopped before it finished",
	needs_decision: "An agent is waiting for your decision",
};

/** Where an unread row opens: the conversation it happened in, or the file. */
export function unreadItemHref(
	workspaceId: string,
	item: WorkspaceUnreadItem,
): string {
	const search = new URLSearchParams();
	if (item.kind === "file" && item.outputId) {
		search.set("workpiece", `output:${item.outputId}`);
		search.set("pane", "workpiece");
	} else {
		if (item.conversationId) search.set("conversation", item.conversationId);
		search.set("pane", "chat");
	}
	return `/workspace/${workspaceId}?${search}`;
}

export function unreadItemLabel(item: WorkspaceUnreadItem): string {
	if (item.kind !== "file") return CHAT_LABELS[item.kind];
	const title = sanitizeUntrustedText(item.title ?? "A file");
	return `${title} was changed`;
}

export type UnreadRow = {
	/** The newest unread item of the conversation or file. */
	item: WorkspaceUnreadItem;
	/** How many unread items the row stands for. */
	count: number;
};

/**
 * One row per conversation and per file, newest first. Chat items that name
 * no conversation stay separate rows.
 */
export function unreadRows(items: readonly WorkspaceUnreadItem[]): UnreadRow[] {
	const rows: UnreadRow[] = [];
	const byConversation = new Map<string, UnreadRow>();
	for (const item of items) {
		const conversationId =
			item.kind === "file" ? undefined : item.conversationId;
		const known = conversationId && byConversation.get(conversationId);
		if (known) {
			known.count += 1;
			continue;
		}
		const row = { item, count: 1 };
		if (conversationId) byConversation.set(conversationId, row);
		rows.push(row);
	}
	return rows;
}

/** The second line of a row on the Inbox page: what kind of thing is new. */
export function unreadRowPreview({ item, count }: UnreadRow): string {
	if (item.kind === "file")
		return `File · changed by ${item.byAgent ? "an agent" : "a teammate"}`;
	return `Conversation · ${count} new`;
}

function MarkWorkspaceRead({
	workspaceId,
	workspaceName,
}: {
	workspaceId: string;
	workspaceName: string;
}) {
	const mark = useMarkWorkspaceRead();
	return (
		<Button
			aria-label={`Mark ${workspaceName} as read`}
			className="ml-auto shrink-0"
			disabled={mark.isPending}
			onClick={() => mark.mutate({ workspaceId, target: { type: "all" } })}
			size="sm"
			variant="ghost"
		>
			Mark as read
		</Button>
	);
}

/**
 * Everything new across the person's workspaces, newest first, grouped by
 * workspace. `page` is the full Inbox page: one row per conversation and
 * file with a second line, and "Mark as read" on each workspace.
 */
export function UnreadList({
	onNavigate,
	page = false,
}: {
	onNavigate?: () => void;
	page?: boolean;
}) {
	const list = useQuery(unreadListQueryOptions());
	const markAll = useMarkAllRead();
	if (list.isPending)
		return (
			<Text className="m-0 px-4 py-6" role="label" tone="secondary">
				Checking what is new…
			</Text>
		);
	if (list.isError)
		return (
			<div className="grid justify-items-start gap-2 px-4 py-6">
				<Text className="m-0" role="label" tone="error">
					Unread items could not be loaded.
				</Text>
				<Button onClick={() => void list.refetch()} size="sm">
					Try again
				</Button>
			</div>
		);
	if (list.data.groups.length === 0)
		return (
			<Empty
				appearance="inline"
				className="px-4! py-6!"
				icon={<Checks aria-hidden className="text-kumo-subtle" size={24} />}
				title={page ? "All caught up" : "You're all caught up"}
				description="New chat messages, agent results and file changes in workspaces you have opened show up here."
			/>
		);
	return (
		<div className="grid grid-cols-[minmax(0,1fr)]">
			<div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-4 pt-3">
				<Text as="p" className="m-0" role="label" tone="secondary">
					{list.data.total} unread
				</Text>
				<Button
					disabled={markAll.isPending}
					onClick={() => markAll.mutate({})}
					size="sm"
					variant="ghost"
				>
					{page ? "Mark all as read" : "Mark all read"}
				</Button>
			</div>
			{list.data.groups.map((group) => (
				<section
					aria-label={`${group.workspaceName}: ${group.items.length} unread`}
					className="border-b border-kumo-hairline last:border-b-0"
					key={group.workspaceId}
				>
					<h3 className="m-0 flex min-w-0 items-center gap-2 wrap-anywhere px-4 pb-1 pt-3 text-kumo-subtle type-tedix-caption font-semibold">
						{sanitizeUntrustedText(group.workspaceName)}
						<span className="shrink-0 tabular-nums font-normal">
							{group.items.length}
						</span>
						{page ? (
							<MarkWorkspaceRead
								workspaceId={group.workspaceId}
								workspaceName={sanitizeUntrustedText(group.workspaceName)}
							/>
						) : null}
					</h3>
					<ul className="m-0 grid grid-cols-[minmax(0,1fr)] list-none p-0 pb-1">
						{(page
							? unreadRows(group.items)
							: group.items.map((item) => ({ item, count: 1 }))
						).map(({ item, count }) => (
							<li key={`${item.kind}:${item.id}`}>
								<Link
									className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-none px-4 py-1.5 text-kumo-default type-tedix-control max-sm:min-h-11"
									href={unreadItemHref(group.workspaceId, item)}
									onClick={onNavigate}
									variant="collection"
								>
									{page ? (
										<span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)]">
											<span className="truncate" title={unreadItemLabel(item)}>
												{unreadItemLabel(item)}
											</span>
											<span className="truncate text-kumo-subtle type-tedix-label">
												{unreadRowPreview({ item, count })}
											</span>
										</span>
									) : (
										<span
											className="min-w-0 flex-1 truncate"
											title={unreadItemLabel(item)}
										>
											{unreadItemLabel(item)}
										</span>
									)}
									{item.byAgent ? (
										<Badge className="shrink-0" variant="secondary">
											Agent
										</Badge>
									) : null}
									<time
										className="shrink-0 text-kumo-subtle type-tedix-label"
										dateTime={item.occurredAt}
										title={absoluteTime(item.occurredAt)}
									>
										{relativeTime(item.occurredAt)}
									</time>
								</Link>
							</li>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}
