import { createFileRoute } from "@tanstack/react-router";
import { AdminApiKeysPage } from "@/components/admin-api-keys-page";
import { validateAdminApiKeysSearch } from "@/lib/admin-api-keys-search";
import { prefetchAdminApiKeysRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/admin/api-keys")({
	validateSearch: validateAdminApiKeysSearch,
	loaderDeps: ({ search }) => ({ page: search.page }),
	loader: ({ context, deps }) =>
		prefetchAdminApiKeysRoute(context.queryClient, deps),
	component: AdminApiKeysRoute,
	pendingComponent: ListPending,
});

function AdminApiKeysRoute() {
	const { page } = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<AdminApiKeysPage
			page={page}
			onPageChange={(nextPage) => void navigate({ search: { page: nextPage } })}
		/>
	);
}
