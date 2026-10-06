import { createFileRoute } from "@tanstack/react-router";
import { OutputDetailPage } from "@/components/output-detail";
import { prefetchOutputRoute } from "@/lib/os-route-loaders";
import { DetailPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/outputs_/$outputId")({
	loader: ({ context, params }) =>
		prefetchOutputRoute(context.queryClient, params.outputId),
	component: OutputDetailPage,
	pendingComponent: DetailPending,
});
