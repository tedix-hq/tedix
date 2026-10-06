import { createFileRoute } from "@tanstack/react-router";
import { SitesPage } from "@/components/sites-page";

export const Route = createFileRoute("/_session/_tenant/sites")({
	component: SitesPage,
});
