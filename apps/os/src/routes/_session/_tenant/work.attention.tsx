import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_session/_tenant/work/attention")({
	beforeLoad: () => {
		throw redirect({
			to: "/work",
			search: { view: "feed", filter: "attention" },
			replace: true,
		});
	},
});
