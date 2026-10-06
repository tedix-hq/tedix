import { createFileRoute } from "@tanstack/react-router";
import { prefetchBlueprintsRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";
import { BlueprintsPage } from "@/components/blueprints-page";

export const Route = createFileRoute("/_session/_tenant/blueprints")({
	loader: ({ context }) => prefetchBlueprintsRoute(context.queryClient),
	component: BlueprintsPage,
	pendingComponent: ListPending,
});
