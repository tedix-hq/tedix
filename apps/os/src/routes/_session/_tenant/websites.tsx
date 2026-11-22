import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/_session/_tenant/websites")({
	beforeLoad: () => {
		throw redirect({ to: "/sites", replace: true });
	},
});
