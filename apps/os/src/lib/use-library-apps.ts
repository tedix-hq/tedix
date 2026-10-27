import { useQueries, useQuery } from "@tanstack/react-query";
import {
	activeWorkspacesQueryOptions,
	canvasGadgetsQueryOptions,
	userProfileQueryOptions,
} from "@/lib/os-query-options";

export function useLibraryApps() {
	const workspaces = useQuery(activeWorkspacesQueryOptions());
	const profile = useQuery(userProfileQueryOptions());
	const lists = useQueries({
		queries: (workspaces.data?.items ?? []).map((workspace) =>
			canvasGadgetsQueryOptions(workspace.id),
		),
	});
	return {
		items: lists.flatMap((list, index) =>
			(list.data?.items ?? []).map((gadget) => ({
				gadget,
				workspace: (workspaces.data?.items ?? [])[index]!,
				scope:
					gadget.createdByKind === "user" &&
					gadget.createdById === profile.data?.id
						? "mine"
						: "organization",
			})),
		),
		pending:
			workspaces.isPending ||
			profile.isPending ||
			lists.some((list) => list.isPending),
		failed:
			workspaces.isError ||
			profile.isError ||
			lists.some((list) => list.isError),
		truncated: Boolean(
			workspaces.data?.truncated || lists.some((list) => list.data?.truncated),
		),
		retry: () => {
			void workspaces.refetch();
			void profile.refetch();
			for (const list of lists) void list.refetch();
		},
	};
}
