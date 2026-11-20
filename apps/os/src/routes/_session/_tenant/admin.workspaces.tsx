import { createFileRoute } from "@tanstack/react-router";
import { AdminWorkspacesPage } from "@/components/workspace-inspection";

export const Route = createFileRoute("/_session/_tenant/admin/workspaces")({
	component: AdminWorkspacesPage,
});
