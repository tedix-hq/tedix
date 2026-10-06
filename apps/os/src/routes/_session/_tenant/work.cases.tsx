import { createFileRoute } from "@tanstack/react-router";
import { WorkCasesPage } from "@/components/work-operations-pages";
import { prefetchWorkCasesRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/work/cases")({
	loader: ({ context }) => prefetchWorkCasesRoute(context.queryClient),
	component: WorkCasesPage,
	pendingComponent: ListPending,
});
