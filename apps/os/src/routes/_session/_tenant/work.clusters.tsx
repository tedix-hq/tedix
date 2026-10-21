import { createFileRoute } from "@tanstack/react-router";
import { WorkClustersPage } from "@/components/work-clusters-page";

export const Route = createFileRoute("/_session/_tenant/work/clusters")({
	component: WorkClustersPage,
});
