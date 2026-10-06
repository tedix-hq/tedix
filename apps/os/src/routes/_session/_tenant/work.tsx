import { createFileRoute } from "@tanstack/react-router";
import { WorkShell } from "@/components/work-shell";

export const Route = createFileRoute("/_session/_tenant/work")({
	component: WorkShell,
});
