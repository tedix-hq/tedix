import { createFileRoute } from "@tanstack/react-router";
import { AdminPaymentsPage } from "@/components/admin-payments-page";
import {
	type AdminPaymentsSearch,
	validateAdminPaymentsSearch,
} from "@/lib/admin-payments-search";
import { prefetchAdminPaymentsRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/admin/payments")({
	validateSearch: validateAdminPaymentsSearch,
	// The receipt param opens a sheet over already-loaded rows and is
	// deliberately not a loader dep — only the ledger inputs re-run the loader.
	loaderDeps: ({ search }) => ({
		hours: search.hours,
		status: search.status,
		app: search.app,
		tool: search.tool,
		tedi: search.tedi,
	}),
	loader: ({ context, deps }) =>
		prefetchAdminPaymentsRoute(context.queryClient, deps),
	component: AdminPaymentsRoute,
	pendingComponent: ListPending,
});

function AdminPaymentsRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<AdminPaymentsPage
			search={search}
			onSearchChange={(next: Partial<AdminPaymentsSearch>) =>
				void navigate({ search: (previous) => ({ ...previous, ...next }) })
			}
		/>
	);
}
