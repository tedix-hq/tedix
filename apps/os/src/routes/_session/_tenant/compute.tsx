import { createFileRoute } from "@tanstack/react-router";
import { ComputePage } from "@/components/compute-page";
import { DetailPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/compute")({
	component: ComputePage,
	pendingComponent: DetailPending,
});
