import { Eye } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Text } from "@/components/kumo/text";
import { osQuery } from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";

/**
 * "An organization admin inspected this workspace", for its members in the
 * workspace's activity and for the inspector on the inspection page.
 */
export function WorkspaceInspectionHistory({
	workspaceId,
	query = osQuery,
}: {
	workspaceId: string;
	/** The inspection page reads through its own inspection client. */
	query?: typeof osQuery;
}) {
	const history = useQuery(
		query.osWorkspaces.inspections.history.queryOptions({
			input: { workspaceId },
			staleTime: 60_000,
			retry: false,
		}),
	);
	const items = history.data?.items ?? [];
	if (items.length === 0) return null;
	return (
		<section
			aria-label="Inspections by organization admins"
			className="grid gap-1"
			data-workspace-inspections=""
		>
			<ol className="m-0 grid list-none p-0">
				{items.map((item) => (
					<li
						key={item.id}
						className="flex min-w-0 items-start gap-2 border-b border-kumo-hairline py-2 last:border-b-0"
					>
						<Eye aria-hidden className="mt-0.5 shrink-0" size={14} />
						<div className="grid min-w-0 gap-0.5">
							<Text as="p" role="label" className="m-0 wrap-anywhere">
								An organization admin
								{item.inspectorName
									? ` (${sanitizeUntrustedText(item.inspectorName)})`
									: ""}{" "}
								inspected this workspace
							</Text>
							<Text as="span" role="caption" tone="secondary">
								<time dateTime={item.at} title={absoluteTime(item.at)}>
									{relativeTime(item.at)}
								</time>
							</Text>
						</div>
					</li>
				))}
			</ol>
		</section>
	);
}
