import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_session/_tenant/work/needs-you")({
	beforeLoad: () => {
		throw redirect({ to: "/work", search: { view: "deck" }, replace: true });
	},
});
