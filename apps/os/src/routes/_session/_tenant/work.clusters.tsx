import { createFileRoute } from "@tanstack/react-router";
import { WorkClustersPage } from "@/components/work-operations-pages";

export const Route = createFileRoute("/_session/_tenant/work/clusters")({
	component: WorkClustersPage,
});
