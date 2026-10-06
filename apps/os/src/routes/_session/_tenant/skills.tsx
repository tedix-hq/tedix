import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_session/_tenant/skills")({
	component: Outlet,
});
