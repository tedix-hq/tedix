import { createFileRoute } from "@tanstack/react-router";
import { ShareLinkPage } from "@/components/share-link-page";

/** A permanent share link with a readable suffix; the suffix is ignored. */
export const Route = createFileRoute("/s/$id/$slug")({
	component: function ShareLinkSlugRoute() {
		const { id } = Route.useParams();
		return <ShareLinkPage key={id} id={id} />;
	},
});
