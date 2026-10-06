import { createFileRoute } from "@tanstack/react-router";
import {
	WorkInteractionsRoute,
	workInteractionsSearch,
} from "@/components/work-operations-pages";
import { workInteractionsQueryOptions } from "@/lib/os-query-options";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/work/interactions")({
	validateSearch: workInteractionsSearch,
	loaderDeps: ({ search }) => search,
	loader: ({ context, deps }) =>
		context.queryClient
			.ensureQueryData(
				workInteractionsQueryOptions(
					undefined,
					deps.view,
					deps.state === "open" ? ["open"] : undefined,
				),
			)
			.catch(() => undefined),
	component: WorkInteractionsRoute,
	pendingComponent: ListPending,
});
