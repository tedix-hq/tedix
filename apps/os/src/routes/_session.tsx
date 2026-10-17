import { createFileRoute, Outlet } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { Toaster } from "@/components/kumo/toast";
import { SessionBoundary } from "@/components/session-boundary";

const BrokerLoginPage = lazy(() =>
	import("@/account/account-login").then((module) => ({
		default: module.BrokerLoginPage,
	})),
);

export const Route = createFileRoute("/_session")({
	component: ProductSessionLayout,
});

function ProductSessionLayout() {
	return (
		<SessionBoundary
			renderLogin={(brokerPrefix) => (
				<Suspense fallback={null}>
					<BrokerLoginPage brokerPrefix={brokerPrefix} />
				</Suspense>
			)}
		>
			<Outlet />
			{/* One toast outlet for the product session; mutation feedback from the
			    ported app-management surfaces lands here. */}
			<Toaster />
		</SessionBoundary>
	);
}
