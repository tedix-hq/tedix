import { useQuery } from "@tanstack/react-query";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import { canvasOutputsQueryOptions, osQuery } from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";

/** Recent projected changes, limited to files the person can also list. */
export function WorkspaceActivity({ workspaceId }: { workspaceId: string }) {
	const activity = useQuery({
		...osQuery.osWorkspaces.workspaces.activity.queryOptions({
			input: { workspaceId, kinds: ["output"], limit: 50 },
		}),
		refetchInterval: 15_000,
	});
	const outputs = useQuery(canvasOutputsQueryOptions(workspaceId));
	const visibleOutputs = new Map(
		(outputs.data?.items ?? []).map((output) => [output.id, output]),
	);
	const items = (activity.data?.items ?? []).filter(
		(item) =>
			item.workspaceId === workspaceId && visibleOutputs.has(item.entityId),
	);
	return (
		<div className="grid min-w-0 gap-2 px-4 py-3">
			<Text as="p" className="m-0" role="caption" tone="secondary">
				Recent recorded file changes in this workspace. This list may be
				incomplete; conversation steps are shown in their conversation.
			</Text>
			{activity.isError || outputs.isError ? (
				<Text role="label" tone="error">
					Workspace activity could not be loaded. Try again later.
				</Text>
			) : activity.isPending || outputs.isPending ? (
				<Text role="label" tone="secondary">
					Loading workspace activity…
				</Text>
			) : items.length === 0 ? (
				<Text role="label" tone="secondary">
					No recorded file changes to show.
				</Text>
			) : (
				<ol
					aria-label="Workspace file activity"
					className="m-0 grid list-none p-0"
				>
					{items.map((item) => {
						const output = visibleOutputs.get(item.entityId)!;
						return (
							<li
								className="grid gap-1 border-b border-kumo-hairline py-2 last:border-b-0"
								key={item.id}
							>
								<Link href={`/outputs/${encodeURIComponent(output.id)}`}>
									{sanitizeUntrustedText(output.title)}
								</Link>
								<Text as="span" role="caption" tone="secondary">
									Revision {item.revision} ·{" "}
									<time
										dateTime={item.occurredAt}
										title={absoluteTime(item.occurredAt)}
									>
										{relativeTime(item.occurredAt)}
									</time>
								</Text>
							</li>
						);
					})}
				</ol>
			)}
		</div>
	);
}
