import { createFileRoute } from "@tanstack/react-router";
import { WorkPortfolioPage } from "@/components/work-factory-pages";
import { prefetchWorkPortfolioRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/work/portfolio")({
	loader: ({ context }) => prefetchWorkPortfolioRoute(context.queryClient),
	component: WorkPortfolioPage,
	pendingComponent: ListPending,
});
