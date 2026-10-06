import { createFileRoute, Outlet } from "@tanstack/react-router";
import { BrokerLoginPage } from "@/account/account-login";
import { SessionBoundary } from "@/components/session-boundary";

export const Route = createFileRoute("/_cli-session")({
	component: CliSessionLayout,
});

function CliSessionLayout() {
	return (
		<SessionBoundary
			broker="cli"
			renderLogin={(brokerPrefix) => (
				<BrokerLoginPage brokerPrefix={brokerPrefix} />
			)}
		>
			<Outlet />
		</SessionBoundary>
	);
}
