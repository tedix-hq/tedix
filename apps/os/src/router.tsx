import "@/lib/zod-jitless";
import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { OsRouteError, OsRoutePending } from "@/components/os-route-boundaries";
import { routeTree } from "@/routeTree.gen";

export const osQueryClient = new QueryClient({
	defaultOptions: {
		queries: { staleTime: 30_000, retry: 2 },
	},
});

export const osRouter = createRouter({
	routeTree,
	context: { queryClient: osQueryClient },
	defaultPreload: "intent",
	defaultPendingComponent: OsRoutePending,
	defaultErrorComponent: OsRouteError,
	defaultPendingMs: 300,
	defaultPendingMinMs: 200,
	scrollRestoration: true,
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof osRouter;
	}
}
