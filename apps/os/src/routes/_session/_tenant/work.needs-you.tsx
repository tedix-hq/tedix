import { createFileRoute } from "@tanstack/react-router";
import { WorkNeedsYouPage } from "@/components/work-needs-you";
import { prefetchWorkNeedsYouRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/work/needs-you")({
	loader: ({ context }) => prefetchWorkNeedsYouRoute(context.queryClient),
	component: WorkNeedsYouPage,
	pendingComponent: ListPending,
});
