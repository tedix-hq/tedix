import { createFileRoute, redirect } from "@tanstack/react-router";
import { workQueueSearch } from "@/lib/work-route-search";

export const Route = createFileRoute("/_session/_tenant/work/queue")({
	validateSearch: workQueueSearch,
	beforeLoad: ({ search }) => {
		throw redirect({
			to: "/work",
			search: {
				view: "feed",
				filter: search.disposition === "completed" ? "history" : "queue",
			},
			replace: true,
		});
	},
});
