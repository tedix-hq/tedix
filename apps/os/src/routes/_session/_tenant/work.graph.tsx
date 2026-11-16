import { createFileRoute, redirect } from "@tanstack/react-router";

/** The dependency list grew into the Work Map app. */
export const Route = createFileRoute("/_session/_tenant/work/graph")({
	beforeLoad: () => {
		throw redirect({ to: "/work", search: { app: "map" }, replace: true });
	},
});
