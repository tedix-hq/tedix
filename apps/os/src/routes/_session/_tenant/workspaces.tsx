import { createFileRoute } from "@tanstack/react-router";
import { prefetchWorkspacesRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";
import { WorkspaceLibraryPage } from "@/components/workspace-library-page";

export const Route = createFileRoute("/_session/_tenant/workspaces")({
	loader: ({ context }) => prefetchWorkspacesRoute(context.queryClient),
	component: WorkspaceLibraryPage,
	pendingComponent: ListPending,
});
