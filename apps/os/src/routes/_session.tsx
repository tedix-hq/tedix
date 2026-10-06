import { createFileRoute, Outlet } from "@tanstack/react-router";
import { BrokerLoginPage } from "@/account/account-login";
import { Toaster } from "@/components/kumo/toast";
import { SessionBoundary } from "@/components/session-boundary";

export const Route = createFileRoute("/_session")({
	component: ProductSessionLayout,
});

function ProductSessionLayout() {
	return (
		<SessionBoundary
			renderLogin={(brokerPrefix) => (
				<BrokerLoginPage brokerPrefix={brokerPrefix} />
			)}
		>
			<Outlet />
			{/* One toast outlet for the product session; mutation feedback from the
			    ported app-management surfaces lands here. */}
			<Toaster />
		</SessionBoundary>
	);
}
