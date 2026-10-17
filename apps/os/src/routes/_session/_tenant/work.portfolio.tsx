import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_session/_tenant/work/portfolio")({
	beforeLoad: () => {
		throw redirect({
			to: "/work",
			search: { app: "portfolio" },
			replace: true,
		});
	},
});
