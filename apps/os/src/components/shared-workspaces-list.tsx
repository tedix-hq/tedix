import { UsersThree, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import {
	osQueryKeys,
	sharedWorkspacesQueryOptions,
} from "@/lib/os-query-options";
import { relativeTime } from "@/lib/time";

/**
 * Workspaces other people shared with you, listed after you first open one.
 * Dismissing hides an entry; it never changes access. An entry whose access
 * was revoked stays until dismissed and opens to an access-denied page.
 */
export function SharedWorkspacesList() {
	const shared = useQuery(sharedWorkspacesQueryOptions());
	const queryClient = useQueryClient();
	const dismiss = useMutation({
		mutationFn: (workspaceId: string) =>
			osApi.osCollaborators.dismissShared({ workspaceId }),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: osQueryKeys.collaborators() }),
	});
	const items = shared.data?.items ?? [];
	if (items.length === 0) return null;
	return (
		<section className="grid gap-2" aria-label="Shared with you">
			<Text as="h2" role="section" className="m-0">
				Shared with you
			</Text>
			<ul className="m-0 grid list-none divide-y divide-kumo-line p-0">
				{items.map((item) => (
					<li
						key={item.workspaceId}
						className="flex min-h-11 items-center gap-3 py-1"
					>
						<UsersThree size={16} className="shrink-0 text-kumo-subtle" />
						<span className="grid min-w-0 flex-1">
							<Link
								href={`/shared/workspace/${item.workspaceId}`}
								className="truncate"
							>
								{item.title}
							</Link>
							<Text
								as="span"
								role="label"
								tone="secondary"
								className="truncate"
							>
								{item.ownerName ? `${item.ownerName} · ` : ""}opened{" "}
								{relativeTime(item.lastOpenedAt)}
							</Text>
						</span>
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label={`Hide ${item.title}`}
							title="Hide from this list"
							disabled={dismiss.isPending}
							onClick={() => dismiss.mutate(item.workspaceId)}
						>
							<X size={14} />
						</Button>
					</li>
				))}
			</ul>
		</section>
	);
}
