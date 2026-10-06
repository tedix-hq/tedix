import { createFileRoute } from "@tanstack/react-router";
import { TediAuthority } from "@/components/tedi-authority";
import { prefetchTediAuthorityRoute } from "@/lib/os-route-loaders";

export const Route = createFileRoute(
	"/_session/_tenant/team_/$tediId/authority",
)({
	loader: ({ context, params }) =>
		prefetchTediAuthorityRoute(context.queryClient, params.tediId),
	component: AuthorityRoute,
});

function AuthorityRoute() {
	return <TediAuthority tediId={Route.useParams().tediId} />;
}
