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
import { unreadListQueryOptions, useMarkAllRead } from "@/lib/workspace-unread";

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

/** Everything new across the person's workspaces, newest first, grouped by workspace. */
export function UnreadList({ onNavigate }: { onNavigate?: () => void }) {
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
				title="You're all caught up"
				description="New chat messages, agent results and file changes in workspaces you have opened show up here."
			/>
		);
	return (
		<div className="grid">
			<div className="flex items-center justify-between gap-2 px-4 pt-3">
				<Text as="p" className="m-0" role="label" tone="secondary">
					{list.data.total} unread
				</Text>
				<Button
					disabled={markAll.isPending}
					onClick={() => markAll.mutate({})}
					size="sm"
					variant="ghost"
				>
					Mark all read
				</Button>
			</div>
			{list.data.groups.map((group) => (
				<section
					aria-label={`${group.workspaceName}: ${group.items.length} unread`}
					className="border-b border-kumo-hairline last:border-b-0"
					key={group.workspaceId}
				>
					<h3 className="m-0 flex min-w-0 items-center gap-2 break-words px-4 pb-1 pt-3 text-kumo-subtle type-tedix-caption font-semibold">
						{sanitizeUntrustedText(group.workspaceName)}
						<span className="tabular-nums font-normal">
							{group.items.length}
						</span>
					</h3>
					<ul className="m-0 grid list-none p-0 pb-1">
						{group.items.map((item) => (
							<li key={`${item.kind}:${item.id}`}>
								<Link
									className="flex min-h-9 items-center gap-2 px-4 py-1.5 text-kumo-default no-underline type-tedix-control hover:bg-kumo-tint max-sm:min-h-11"
									href={unreadItemHref(group.workspaceId, item)}
									onClick={onNavigate}
								>
									<span className="min-w-0 flex-1 truncate">
										{unreadItemLabel(item)}
									</span>
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
