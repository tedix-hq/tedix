import { createFileRoute } from "@tanstack/react-router";
import { WorkAdmissionPage } from "@/components/work-operations-pages";
import { ListPending } from "@/routes/-pending";

export const Route = createFileRoute("/_session/_tenant/work/admission")({
	component: WorkAdmissionPage,
	pendingComponent: ListPending,
});
