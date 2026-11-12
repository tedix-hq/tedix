import { createFileRoute, Outlet } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { SessionBoundary } from "@/components/session-boundary";

const BrokerLoginPage = lazy(() =>
	import("@/account/account-login").then((module) => ({
		default: module.BrokerLoginPage,
	})),
);

const InstalledAppSupport = lazy(() =>
	import("@/components/installed-app-support").then((module) => ({
		default: module.InstalledAppSupport,
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
			{/* After the page: the install notice and icon badge never hold up
			    first paint. */}
			<Suspense fallback={null}>
				<InstalledAppSupport />
			</Suspense>
		</SessionBoundary>
	);
}
