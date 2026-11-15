import { createFileRoute, redirect } from "@tanstack/react-router";
import { legacyWorkQueueSearch } from "@/shared/work-redirects";

export const Route = createFileRoute("/_session/_tenant/work/queue")({
	validateSearch: (search: Record<string, unknown>) =>
		search.disposition === "completed"
			? { disposition: "completed" as const }
			: {},
	beforeLoad: ({ search }) => {
		throw redirect({
			to: "/work",
			search: legacyWorkQueueSearch(search),
			replace: true,
		});
	},
});
