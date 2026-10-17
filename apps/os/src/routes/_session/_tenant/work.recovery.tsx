import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_session/_tenant/work/recovery")({
	beforeLoad: () => {
		throw redirect({
			to: "/work",
			search: { view: "feed", filter: "stalled" },
			replace: true,
		});
	},
});
