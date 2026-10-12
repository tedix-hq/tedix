import { createFileRoute, redirect } from "@tanstack/react-router";
import { workQueueSearch } from "@/components/work-factory-pages";

/** Work opens on the Portfolio; old queue links (`/work?disposition=…`) keep working. */
export const Route = createFileRoute("/_session/_tenant/work/")({
	validateSearch: workQueueSearch,
	beforeLoad: ({ search }) => {
		throw search.disposition
			? redirect({ to: "/work/queue", search })
			: redirect({ to: "/work/portfolio" });
	},
});
