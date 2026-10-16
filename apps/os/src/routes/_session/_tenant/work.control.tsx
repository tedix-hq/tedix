import { createFileRoute, redirect } from "@tanstack/react-router";

/** Attention merged into Needs you; old links land there. */
export const Route = createFileRoute("/_session/_tenant/work/control")({
	beforeLoad: () => {
		throw redirect({ to: "/work/needs-you" });
	},
});
