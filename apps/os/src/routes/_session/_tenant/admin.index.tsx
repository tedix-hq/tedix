import { createFileRoute } from "@tanstack/react-router";
import { AdminPage } from "@/components/admin-page";

export const Route = createFileRoute("/_session/_tenant/admin/")({
	component: AdminPage,
});
