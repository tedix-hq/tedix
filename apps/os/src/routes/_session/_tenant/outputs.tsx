import { createFileRoute } from "@tanstack/react-router";
import { prefetchOutputsRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";
import { OutputsPage } from "@/components/outputs-page";

export const Route = createFileRoute("/_session/_tenant/outputs")({
	loader: ({ context }) => prefetchOutputsRoute(context.queryClient),
	component: OutputsPage,
	pendingComponent: ListPending,
});
