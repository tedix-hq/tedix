import { createFileRoute, redirect } from "@tanstack/react-router";
import { WorkHome } from "@/components/work-home";
import { workQueueSearch } from "@/lib/work-route-search";

/** The existing Work entry selects installed workspace apps; legacy queue links survive. */
export const Route = createFileRoute("/_session/_tenant/work/")({
	validateSearch: (
		search,
	): { disposition?: "completed"; view?: "feed" | "deck" } => ({
		...workQueueSearch(search),
		...(search.view === "feed" ? { view: "feed" as const } : {}),
	}),
	component: WorkLanding,
	beforeLoad: ({ search }) => {
		if (search.disposition)
			throw redirect({
				to: "/work/queue",
				search: { disposition: search.disposition },
			});
	},
});

function WorkLanding() {
	return <WorkHome view={Route.useSearch().view} />;
}
