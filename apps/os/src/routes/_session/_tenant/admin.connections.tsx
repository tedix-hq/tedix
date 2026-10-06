import { createFileRoute } from "@tanstack/react-router";
import { AdminConnectionsPage } from "@/components/admin-connections-page";
import { validateAdminConnectionsSearch } from "@/lib/admin-connections-search";
import { prefetchAdminConnectionsRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/admin/connections")({
	validateSearch: validateAdminConnectionsSearch,
	loader: ({ context }) => prefetchAdminConnectionsRoute(context.queryClient),
	component: AdminConnectionsRoute,
	pendingComponent: ListPending,
});

function AdminConnectionsRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<AdminConnectionsPage
			search={search}
			onSearchChange={(next) =>
				void navigate({
					search: (previous) => {
						const merged = { ...previous, ...next };
						return {
							// Empty defaults stay out of the URL so the canonical address
							// of the unfiltered page has no search string.
							...(merged.q ? { q: merged.q } : {}),
							...(merged.status !== "all" ? { status: merged.status } : {}),
							...(merged.connect ? { connect: merged.connect } : {}),
						};
					},
					replace: true,
				})
			}
		/>
	);
}
