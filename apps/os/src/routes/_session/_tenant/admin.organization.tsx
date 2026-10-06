import { createFileRoute } from "@tanstack/react-router";
import { AdminOrganizationPage } from "@/components/admin-organization-page";
import { prefetchAdminOrganizationRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/admin/organization")({
	loader: ({ context }) => prefetchAdminOrganizationRoute(context.queryClient),
	component: AdminOrganizationPage,
	pendingComponent: ListPending,
});
