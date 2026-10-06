import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { OsRouteNotFound } from "@/components/os-route-boundaries";

export const Route = createRootRouteWithContext<{
	queryClient: QueryClient;
}>()({
	component: Outlet,
	notFoundComponent: OsRouteNotFound,
});
