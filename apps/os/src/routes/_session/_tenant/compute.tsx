import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_session/_tenant/compute")({
	beforeLoad: () => {
		throw redirect({ to: "/usage", search: {}, replace: true });
	},
});
