import { createFileRoute } from "@tanstack/react-router";
import { AppStorePage } from "@/components/app-store-page";
import { OsRouteError } from "@/components/os-route-boundaries";
import { catalogSearchSchema } from "@/lib/catalog-route-search";
import { prefetchCatalogRoute } from "@/lib/os-route-loaders";
import { DetailPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/explore/apps")({
	validateSearch: catalogSearchSchema,
	loaderDeps: ({ search }) => search,
	loader: ({ context, deps, cause }) =>
		cause === "stay"
			? undefined
			: prefetchCatalogRoute(context.queryClient, deps),
	component: ExploreAppsRoute,
	pendingComponent: DetailPending,
	errorComponent: OsRouteError,
});
function ExploreAppsRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<AppStorePage
			search={search}
			updateSearch={(patch) =>
				void navigate({
					search: (previous) => ({ ...previous, ...patch }),
					replace: "search" in patch,
					resetScroll: false,
				})
			}
		/>
	);
}
