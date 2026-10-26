import { createFileRoute } from "@tanstack/react-router";
import { prefetchBlueprintsRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";
import { BlueprintsPage } from "@/components/blueprints-page";

/** `?install=<id>` arrives from a shared blueprint page's "Use this blueprint". */
function validateBlueprintsSearch(search: Record<string, unknown>): {
	install?: string;
} {
	return typeof search.install === "string" && search.install
		? { install: search.install }
		: {};
}

export const Route = createFileRoute("/_session/_tenant/blueprints")({
	validateSearch: validateBlueprintsSearch,
	loader: ({ context }) => prefetchBlueprintsRoute(context.queryClient),
	component: function BlueprintsRoute() {
		const { install } = Route.useSearch();
		return <BlueprintsPage key={install ?? ""} install={install} />;
	},
	pendingComponent: ListPending,
});
