import { createFileRoute } from "@tanstack/react-router";
import { WorkAttentionPage } from "@/components/work-attention-page";
import { workAttentionQueryOptions } from "@/lib/os-query-options";
import { ListPending } from "@/routes/-pending";
export const Route = createFileRoute("/_session/_tenant/work/attention")({
	loader: ({ context }) =>
		context.queryClient
			.ensureQueryData(workAttentionQueryOptions())
			.catch(() => undefined),
	component: WorkAttentionPage,
	pendingComponent: ListPending,
});
