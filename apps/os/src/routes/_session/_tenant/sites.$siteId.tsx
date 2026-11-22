import { createFileRoute } from "@tanstack/react-router";
import { SitePage } from "@/components/site-page";
export const Route = createFileRoute("/_session/_tenant/sites/$siteId")({
	component: SiteRoute,
});
function SiteRoute() {
	const { siteId } = Route.useParams();
	return <SitePage key={siteId} siteId={siteId} />;
}
