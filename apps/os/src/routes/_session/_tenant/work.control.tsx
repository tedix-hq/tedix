import { createFileRoute } from "@tanstack/react-router";
import { WorkControlPage } from "@/components/work-operations-pages";
import { prefetchWorkControlRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/work/control")({
	loader: ({ context }) => prefetchWorkControlRoute(context.queryClient),
	component: WorkControlPage,
	pendingComponent: ListPending,
});
