import { Button } from "@/components/kumo/button";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import { osQuery } from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";

/** Only file changes and agent actions are shown; chat steps stay in their conversation. */
const WORKSPACE_ACTIVITY_KINDS = ["output", "run"] as const;

/** The API filters each record and linked revision for the current viewer. */
export function WorkspaceActivity({ workspaceId }: { workspaceId: string }) {
	const activity = useInfiniteQuery({
		...osQuery.osWorkspaces.workspaces.activity.infiniteOptions({
			input: (before: string | undefined) => ({
				workspaceId,
				kinds: [...WORKSPACE_ACTIVITY_KINDS],
				limit: 50,
				...(before ? { before } : {}),
			}),
			initialPageParam: undefined as string | undefined,
			getNextPageParam: (page) => page.next ?? undefined,
		}),
		refetchInterval: 15_000,
	});
	const items = (activity.data?.pages ?? [])
		.flatMap((page) => page.items)
		.filter(
			(item) =>
				item.workspaceId === workspaceId &&
				(item.kind === "output"
					? Boolean(item.artifact)
					: item.kind === "run" && Boolean(item.action)),
		);
	return (
		<div className="grid min-w-0 gap-2 px-4 py-3">
			<Text as="p" className="m-0" role="caption" tone="secondary">
				Recent recorded file changes and agent actions in this workspace. This
				list may be incomplete; conversation steps are shown in their
				conversation.
			</Text>
			{activity.isError ? (
				<Text role="label" tone="error">
					Workspace activity could not be loaded. Try again later.
				</Text>
			) : activity.isPending ? (
				<Text role="label" tone="secondary">
					Loading workspace activity…
				</Text>
			) : items.length === 0 ? (
				<Text role="label" tone="secondary">
					{activity.hasNextPage
						? "Nothing recent you can see. Load more to look further back."
						: "No recorded activity to show."}
				</Text>
			) : (
				<ol aria-label="Workspace activity" className="m-0 grid list-none p-0">
					{items.map((item) => {
						const label = item.action
							? `${item.action.resource}.${item.action.operation} · ${item.action.outcome}`
							: (item.title ?? "File change");
						return (
							<li
								className="grid gap-1 border-b border-kumo-hairline py-2 last:border-b-0"
								key={item.id}
							>
								{item.artifact ? (
									<Link
										href={`/outputs/${encodeURIComponent(item.artifact.outputId)}`}
									>
										{sanitizeUntrustedText(label)}
									</Link>
								) : (
									<Text as="span" role="label">
										{sanitizeUntrustedText(label)}
									</Text>
								)}
								<Text as="span" role="caption" tone="secondary">
									{item.kind === "output" ? `Revision ${item.revision} · ` : ""}
									<time
										dateTime={item.occurredAt}
										title={absoluteTime(item.occurredAt)}
									>
										{relativeTime(item.occurredAt)}
									</time>
								</Text>
								<Text as="span" role="caption" tone="secondary">
									{item.actor.kind}: {sanitizeUntrustedText(item.actor.id)} ·
									Record {sanitizeUntrustedText(item.changeRecordId)}
								</Text>
							</li>
						);
					})}
				</ol>
			)}
			{activity.hasNextPage && (
				<Button
					variant="secondary"
					disabled={activity.isFetchingNextPage}
					onClick={() => void activity.fetchNextPage()}
				>
					{activity.isFetchingNextPage ? "Loading…" : "Load more"}
				</Button>
			)}
		</div>
	);
}
