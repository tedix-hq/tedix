import { createFileRoute } from "@tanstack/react-router";
import { AdminConnectionsPage } from "@/components/admin-connections-page";
import { validateAdminConnectionsSearch } from "@/lib/admin-connections-search";
import { prefetchAdminConnectionsRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";
export const Route = createFileRoute("/_session/_tenant/account/connections")({
	validateSearch: validateAdminConnectionsSearch,
	loader: ({ context }) =>
		prefetchAdminConnectionsRoute(context.queryClient, "personal"),
	component: AccountConnectionsRoute,
	pendingComponent: ListPending,
});
function AccountConnectionsRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<AdminConnectionsPage
			scope="personal"
			search={search}
			onSearchChange={(next) =>
				void navigate({ search: (previous) => ({ ...previous, ...next }) })
			}
		/>
	);
}
