import { createFileRoute } from "@tanstack/react-router";
import { prefetchWorkspacesRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";
import { WorkspaceLibraryPage } from "@/components/workspace-library-page";

export const Route = createFileRoute("/_session/_tenant/workspaces")({
	// `?view=archived` opens the Archived list; anything else is the active one.
	validateSearch: (search: Record<string, unknown>): { view?: "archived" } =>
		search.view === "archived" ? { view: "archived" } : {},
	loader: ({ context }) => prefetchWorkspacesRoute(context.queryClient),
	component: WorkspacesRoute,
	pendingComponent: ListPending,
});

function WorkspacesRoute() {
	const { view } = Route.useSearch();
	return <WorkspaceLibraryPage key={view} initialView={view} />;
}
