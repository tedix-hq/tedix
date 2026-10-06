import { createFileRoute } from "@tanstack/react-router";
import { WorkRecoveryPage } from "@/components/work-factory-pages";
import { prefetchWorkRecoveryRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/work/recovery")({
	loader: ({ context }) => prefetchWorkRecoveryRoute(context.queryClient),
	component: WorkRecoveryPage,
	pendingComponent: ListPending,
});
