import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_session/_tenant/")({
	beforeLoad: () => {
		throw redirect({ to: "/work" });
	},
});
