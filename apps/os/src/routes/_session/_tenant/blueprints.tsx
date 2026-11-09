import { createFileRoute } from "@tanstack/react-router";
import { prefetchBlueprintsRoute } from "@/lib/os-route-loaders";
import { ListPending } from "@/routes/-pending";
import { BlueprintsPage } from "@/components/blueprints-page";

/** `?install=<id>` arrives from a shared blueprint page's "Use this blueprint". */
function validateBlueprintsSearch(search: Record<string, unknown>): {
	install?: string;
	view?: "explore";
} {
	return {
		...(typeof search.install === "string" && search.install
			? { install: search.install }
			: {}),
		...(search.view === "explore" ? { view: "explore" as const } : {}),
	};
}

export const Route = createFileRoute("/_session/_tenant/blueprints")({
	validateSearch: validateBlueprintsSearch,
	loader: ({ context }) => prefetchBlueprintsRoute(context.queryClient),
	component: function BlueprintsRoute() {
		const { install, view } = Route.useSearch();
		return (
			<BlueprintsPage
				key={`${install ?? ""}:${view ?? ""}`}
				install={install}
				initialView={view}
			/>
		);
	},
	pendingComponent: ListPending,
});
