import { createFileRoute } from "@tanstack/react-router";
import { WorkApprovalsPage } from "@/components/work-operations-pages";
import { prefetchWorkApprovalsRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/work/approvals")({
	loader: ({ context }) => prefetchWorkApprovalsRoute(context.queryClient),
	component: WorkApprovalsPage,
	pendingComponent: ListPending,
});
