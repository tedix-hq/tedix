import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_session/_chrome-free")({
	component: Outlet,
});
