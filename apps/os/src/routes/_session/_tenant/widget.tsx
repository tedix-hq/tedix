import { createFileRoute } from "@tanstack/react-router";
import { WidgetManagementPage } from "@/components/widget-management-page";
import { DetailPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/widget")({
	component: WidgetManagementPage,
	pendingComponent: DetailPending,
});
