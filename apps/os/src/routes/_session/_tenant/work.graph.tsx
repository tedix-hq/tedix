import { createFileRoute } from "@tanstack/react-router";
import { WorkGraphPage } from "@/components/work-factory-pages";
import { prefetchWorkGraphRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/work/graph")({
	loader: ({ context }) => prefetchWorkGraphRoute(context.queryClient),
	component: WorkGraphPage,
	pendingComponent: ListPending,
});
