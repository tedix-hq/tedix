import { useQuery } from "@tanstack/react-query";
import { activeWorkspacesQueryOptions } from "@/lib/os-query-options";

/** A shared app can bind several people's factories. Read only the viewer's spaces. */
export function useVisibleCardSources<T>(
	sources: readonly T[],
	workspaceId: (source: T) => string,
) {
	const workspaces = useQuery({
		...activeWorkspacesQueryOptions(),
		enabled: sources.length > 0,
	});
	const visible = new Set(workspaces.data?.items.map((space) => space.id));
	return {
		sources: sources.filter((source) => visible.has(workspaceId(source))),
		pending: sources.length > 0 && workspaces.isPending,
		failed: sources.length > 0 && workspaces.isError,
	};
}
