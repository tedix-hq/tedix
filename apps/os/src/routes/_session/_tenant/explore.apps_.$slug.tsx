import { createFileRoute } from "@tanstack/react-router";
import { AppStoreDetailPage } from "@/components/app-store-detail-page";
import { prefetchCatalogDetailRoute } from "@/lib/os-route-loaders";
import { DetailPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/explore/apps_/$slug")({
	loader: ({ context, params }) =>
		prefetchCatalogDetailRoute(context.queryClient, params.slug),
	component: () => <AppStoreDetailPage slug={Route.useParams().slug} />,
	pendingComponent: DetailPending,
});
