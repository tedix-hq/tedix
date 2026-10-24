import { createFileRoute, redirect } from "@tanstack/react-router";

// The gateway is how every app is reached, not a separate list: its old page
// now lands on Apps, which names the gateway in one line.
export const Route = createFileRoute("/_session/_tenant/gateways")({
	beforeLoad: () => {
		throw redirect({ to: "/apps", replace: true });
	},
});
