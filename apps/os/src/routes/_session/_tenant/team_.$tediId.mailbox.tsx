import { createFileRoute } from "@tanstack/react-router";
import { TediMailbox } from "@/components/tedi-mailbox";
import { prefetchTediMailboxRoute } from "@/lib/os-route-loaders";

export const Route = createFileRoute("/_session/_tenant/team_/$tediId/mailbox")(
	{
		loader: ({ context, params }) =>
			prefetchTediMailboxRoute(context.queryClient, params.tediId),
		component: MailboxRoute,
	},
);

function MailboxRoute() {
	return <TediMailbox tediId={Route.useParams().tediId} />;
}
