import { createFileRoute } from "@tanstack/react-router";
import { ShareLinkPage } from "@/components/share-link-page";

/** A permanent share link: outside every session layout; the page asks for sign-in when the link needs it. */
export const Route = createFileRoute("/s/$id")({
	component: function ShareLinkRoute() {
		const { id } = Route.useParams();
		return <ShareLinkPage key={id} id={id} />;
	},
});
