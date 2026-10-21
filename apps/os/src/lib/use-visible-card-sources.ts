import { useQuery } from "@tanstack/react-query";
import { workRefreshOptions } from "@/lib/work-refresh";
import { activeWorkspacesQueryOptions } from "@/lib/os-query-options";

/** A shared app can bind several people's factories. Read only the viewer's spaces. */
export function useVisibleCardSources<T>(
	sources: readonly T[],
	workspaceId: (source: T) => string,
) {
	const workspaces = useQuery({
		...activeWorkspacesQueryOptions(),
		...workRefreshOptions,
		enabled: sources.length > 0,
	});
	const names = new Map(
		workspaces.data?.items.map((space) => [space.id, space.name]),
	);
	return {
		sources: sources.filter((source) => names.has(workspaceId(source))),
		workspaceName: (id: string) => names.get(id),
		pending: sources.length > 0 && workspaces.isPending,
		failed: sources.length > 0 && workspaces.isError,
		refetch: () =>
			sources.length > 0 ? workspaces.refetch() : Promise.resolve(),
	};
}
