import { createFileRoute } from "@tanstack/react-router";
import { OutboundPage } from "@/components/outbound-card";
import { osQuery } from "@/lib/os-query-options";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/work/outbound")({
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(
			osQuery.workInteractions.outbound.list.queryOptions({
				input: { limit: 50 },
			}),
		),
	component: OutboundPage,
	pendingComponent: ListPending,
});
