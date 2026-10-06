import { createFileRoute } from "@tanstack/react-router";
import { SharedResourcePage } from "@/components/shared-resource-page";
import { DetailPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_chrome-free/shared")({
	component: SharedResourcePage,
	pendingComponent: DetailPending,
});
