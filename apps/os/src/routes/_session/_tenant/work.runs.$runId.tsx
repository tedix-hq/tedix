import { createFileRoute } from "@tanstack/react-router";
import { RunDetailPage } from "@/components/run-detail";

export const Route = createFileRoute("/_session/_tenant/work/runs/$runId")({
	component: RunDetailPage,
});
