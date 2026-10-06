import { createFileRoute } from "@tanstack/react-router";
import {
	WorkInteractionsRoute,
	workInteractionsSearch,
} from "@/components/work-operations-pages";
import {
	workInteractionsQueryOptions,
	workUrgentInteractionsQueryOptions,
} from "@/lib/os-query-options";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/work/interactions")({
	validateSearch: workInteractionsSearch,
	loaderDeps: ({ search }) => search,
	loader: ({ context, deps }) =>
		Promise.all([
			context.queryClient
				.ensureQueryData(
					workInteractionsQueryOptions(
						undefined,
						deps.view,
						deps.state === "open" ? ["open"] : undefined,
					),
				)
				.catch(() => undefined),
			deps.view === "inbox"
				? context.queryClient
						.ensureQueryData(workUrgentInteractionsQueryOptions())
						.catch(() => undefined)
				: undefined,
		]),
	component: WorkInteractionsRoute,
	pendingComponent: ListPending,
});
